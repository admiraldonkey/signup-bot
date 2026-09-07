import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { assignEventOrganiser } from "../../../src/organisers/organiser-assignment-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "930000000000000001";
const ADMIN_USER_ID = "930000000000000002";
const PRIMARY_USER_ID = "930000000000000003";
const REPLACEMENT_USER_ID = "930000000000000004";
const BACKUP_USER_ID = "930000000000000005";
const PUBLICATION_CHANNEL_ID = "930000000000000006";

describe("organiser assignment service", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  it("creates a dormant primary assignment for an unpublished event", async () => {
    // Arrange
    const fixture = await createEvent(pool, {
      published: false,
    });

    // Act
    const result = await assignEventOrganiser({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      slot: "primary",

      organiserUserId: PRIMARY_USER_ID,

      displayNameSnapshot: "Primary Organiser",

      assignedByUserId: ADMIN_USER_ID,

      primaryResponseMinutes: 80,

      warningMinutesBefore: 15,
    });

    // Assert
    expect(result).toMatchObject({
      kind: "assigned",

      event: {
        id: fixture.eventId,
        name: "Organiser Service Test Event",
      },

      assignment: {
        activatedAt: null,
      },

      replacedAssignmentIds: [],
    });

    if (result.kind !== "assigned") {
      throw new Error(
        `Expected organiser assignment to succeed, received "${result.kind}".`,
      );
    }

    const assignmentResult = await pool.query<{
      slot: string;
      discord_user_id: string;
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
        SELECT
          "slot",
          "discord_user_id",
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [result.assignment.id],
    );

    expect(assignmentResult.rows).toEqual([
      {
        slot: "primary",

        discord_user_id: PRIMARY_USER_ID,

        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
      },
    ]);

    /*
     * An unpublished organiser has not begun their response lifecycle.
     */
    const actionResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("activates a primary and creates its response actions for a published event", async () => {
    // Arrange
    const fixture = await createEvent(pool, {
      published: true,
    });

    // Act
    const result = await assignEventOrganiser({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      slot: "primary",

      organiserUserId: PRIMARY_USER_ID,

      displayNameSnapshot: "Primary Organiser",

      assignedByUserId: ADMIN_USER_ID,

      primaryResponseMinutes: 80,

      warningMinutesBefore: 15,
    });

    // Assert
    expect(result.kind).toBe("assigned");

    if (result.kind !== "assigned") {
      throw new Error(
        `Expected organiser assignment to succeed, received "${result.kind}".`,
      );
    }

    expect(result.assignment.activatedAt).toBeInstanceOf(Date);

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [result.assignment.id],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    const assignment = assignmentResult.rows[0];

    expect(assignment).toMatchObject({
      status: "pending",
      is_current: true,
    });

    expect(assignment?.activated_at).toBeInstanceOf(Date);
    expect(assignment?.response_deadline_at).toBeInstanceOf(Date);

    /*
     * The service owns the primary response deadline calculation.
     */
    expect(
      assignment!.response_deadline_at!.getTime() -
        assignment!.activated_at!.getTime(),
    ).toBe(80 * 60 * 1000);

    const actionResult = await pool.query<{
      action_key: string;
      status: string;
      due_at: Date;
    }>(
      `
        SELECT
          "action_key",
          "status",
          "due_at"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
        ORDER BY "action_key"
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toHaveLength(2);

    const timeoutAction = actionResult.rows.find(
      (action) =>
        action.action_key === `organiser_timeout:${result.assignment.id}`,
    );

    const warningAction = actionResult.rows.find(
      (action) =>
        action.action_key === `organiser_warning:${result.assignment.id}`,
    );

    expect(timeoutAction).toBeDefined();
    expect(warningAction).toBeDefined();

    expect(timeoutAction?.status).toBe("pending");
    expect(warningAction?.status).toBe("pending");

    /*
     * Timeout is due at the response deadline and the warning is due
     * fifteen minutes beforehand.
     */
    expect(timeoutAction?.due_at.getTime()).toBe(
      assignment!.response_deadline_at!.getTime(),
    );

    expect(
      timeoutAction!.due_at.getTime() - warningAction!.due_at.getTime(),
    ).toBe(15 * 60 * 1000);
  });

  it("rejects a backup assignment when there is no active primary", async () => {
    // Arrange
    const fixture = await createEvent(pool, {
      published: false,
    });

    // Act
    const result = await assignEventOrganiser({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      slot: "backup",

      organiserUserId: BACKUP_USER_ID,

      displayNameSnapshot: "Backup Organiser",

      assignedByUserId: ADMIN_USER_ID,

      primaryResponseMinutes: 80,

      warningMinutesBefore: 15,
    });

    // Assert
    expect(result).toEqual({
      kind: "backup_requires_primary",
    });

    const assignmentResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_organiser_assignments"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        count: 0,
      },
    ]);

    const actionResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("replaces the current primary and returns the superseded assignment ID", async () => {
    // Arrange
    const fixture = await createEvent(pool, {
      published: false,
    });

    const original = await assignEventOrganiser({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      slot: "primary",

      organiserUserId: PRIMARY_USER_ID,

      displayNameSnapshot: "Original Primary Organiser",

      assignedByUserId: ADMIN_USER_ID,

      primaryResponseMinutes: 80,

      warningMinutesBefore: 15,
    });

    if (original.kind !== "assigned") {
      throw new Error(
        `Expected original organiser assignment to succeed, received "${original.kind}".`,
      );
    }

    // Act
    const replacement = await assignEventOrganiser({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      slot: "primary",

      organiserUserId: REPLACEMENT_USER_ID,

      displayNameSnapshot: "Replacement Primary Organiser",

      assignedByUserId: ADMIN_USER_ID,

      primaryResponseMinutes: 80,

      warningMinutesBefore: 15,
    });

    // Assert
    expect(replacement).toMatchObject({
      kind: "assigned",

      replacedAssignmentIds: [original.assignment.id],
    });

    if (replacement.kind !== "assigned") {
      throw new Error(
        `Expected replacement organiser assignment to succeed, received "${replacement.kind}".`,
      );
    }

    const assignmentResult = await pool.query<{
      id: number;
      discord_user_id: string;
      status: string;
      is_current: boolean;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "id",
          "discord_user_id",
          "status",
          "is_current",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "event_id" = $1
        ORDER BY "id"
      `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toHaveLength(2);

    expect(assignmentResult.rows[0]).toMatchObject({
      id: original.assignment.id,

      discord_user_id: PRIMARY_USER_ID,

      status: "replaced",

      is_current: false,
    });

    expect(assignmentResult.rows[0]?.ended_at).toBeInstanceOf(Date);

    expect(assignmentResult.rows[1]).toMatchObject({
      id: replacement.assignment.id,

      discord_user_id: REPLACEMENT_USER_ID,

      status: "pending",

      is_current: true,

      ended_at: null,
    });
  });
});

async function createEvent(
  pool: Pool,
  input: {
    published: boolean;
  },
): Promise<{
  guildId: number;
  eventId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, $2)
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID, "Organiser Service Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id"
      )
      VALUES ($1)
    `,
    [guildId],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name"
      )
      VALUES ($1, $2, $3)
      RETURNING "id"
    `,
    [guildId, "naval", "Naval Event"],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("The integration-test event type was not created.");
  }

  const publishedAt = input.published
    ? new Date(Date.now() - 5 * 60 * 1000)
    : null;

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "owner_guild_id",
        "event_type_id",
        "name",
        "starts_at",
        "signups_enabled",
        "published_at",
        "publication_channel_id",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        true,
        $5,
        $6,
        $7,
        $8
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Organiser Service Test Event",
      new Date(Date.now() + 24 * 60 * 60 * 1000),
      publishedAt,
      PUBLICATION_CHANNEL_ID,
      input.published ? "open" : "scheduled",
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  return {
    guildId,
    eventId,
  };
}
