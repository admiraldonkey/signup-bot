import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { advanceOrganiserEscalation } from "../../../src/organisers/organiser-escalation-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "940000000000000001";
const ADMIN_USER_ID = "940000000000000002";
const PRIMARY_USER_ID = "940000000000000003";
const BACKUP_USER_ID = "940000000000000004";
const COVER_USER_ID = "940000000000000005";
const EVENT_ADMIN_CHANNEL_ID = "940000000000000006";

describe("organiser escalation service", () => {
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

  it("activates a dormant backup and creates its response actions", async () => {
    // Arrange
    const fixture = await createEscalationFixture(pool, {
      withBackup: true,
    });

    if (!fixture.backupAssignmentId) {
      throw new Error("Expected the fixture to include a dormant backup.");
    }

    // Act
    const result = await advanceOrganiserEscalation({
      eventId: fixture.eventId,

      failedAssignmentId: fixture.failedAssignmentId,

      trigger: "declined",
    });

    // Assert
    expect(result).toMatchObject({
      kind: "backup_activated",

      event: {
        id: fixture.eventId,

        name: "Organiser Escalation Service Test",

        guildDatabaseId: fixture.guildId,

        eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

        organiserDmsEnabled: false,
      },

      assignment: {
        id: fixture.backupAssignmentId,

        discordUserId: BACKUP_USER_ID,
      },
    });

    if (result.kind !== "backup_activated") {
      throw new Error(`Expected backup activation, received "${result.kind}".`);
    }

    expect(result.assignment.responseDeadlineAt).toBeInstanceOf(Date);

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
      [fixture.backupAssignmentId],
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
     * This fixture explicitly configures a 40-minute backup response window.
     */
    expect(
      assignment!.response_deadline_at!.getTime() -
        assignment!.activated_at!.getTime(),
    ).toBe(40 * 60 * 1000);

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

    const warningAction = actionResult.rows.find(
      (action) =>
        action.action_key === `organiser_warning:${fixture.backupAssignmentId}`,
    );

    const timeoutAction = actionResult.rows.find(
      (action) =>
        action.action_key === `organiser_timeout:${fixture.backupAssignmentId}`,
    );

    expect(warningAction).toBeDefined();
    expect(timeoutAction).toBeDefined();

    expect(warningAction?.status).toBe("pending");
    expect(timeoutAction?.status).toBe("pending");

    expect(timeoutAction?.due_at.getTime()).toBe(
      assignment!.response_deadline_at!.getTime(),
    );

    /*
     * The configured warning is fifteen minutes before the response timeout.
     */
    expect(
      timeoutAction!.due_at.getTime() - warningAction!.due_at.getTime(),
    ).toBe(15 * 60 * 1000);
  });

  it("queues exactly one durable cover request when no backup remains", async () => {
    // Arrange
    const fixture = await createEscalationFixture(pool);

    // Act
    const firstResult = await advanceOrganiserEscalation({
      eventId: fixture.eventId,

      failedAssignmentId: fixture.failedAssignmentId,

      trigger: "declined",
    });

    /*
     * Repeating the same authoritative transition must not create duplicate
     * durable scheduler work.
     */
    const secondResult = await advanceOrganiserEscalation({
      eventId: fixture.eventId,

      failedAssignmentId: fixture.failedAssignmentId,

      trigger: "declined",
    });

    // Assert
    expect(firstResult).toMatchObject({
      kind: "cover_queued",

      event: {
        id: fixture.eventId,

        guildDatabaseId: fixture.guildId,

        eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

        organiserDmsEnabled: false,
      },
    });

    expect(secondResult).toMatchObject({
      kind: "cover_queued",
    });

    const actionResult = await pool.query<{
      action_key: string;
      status: string;
      attempt_count: number;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
        SELECT
          "action_key",
          "status",
          "attempt_count",
          "completed_at",
          "last_error"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        action_key: `organiser_cover_request:${fixture.failedAssignmentId}`,

        status: "pending",

        attempt_count: 0,

        completed_at: null,

        last_error: null,
      },
    ]);
  });

  it("supports timeout-triggered cover escalation", async () => {
    // Arrange
    const fixture = await createEscalationFixture(pool, {
      failureStatus: "timed_out",
    });

    // Act
    const result = await advanceOrganiserEscalation({
      eventId: fixture.eventId,

      failedAssignmentId: fixture.failedAssignmentId,

      trigger: "timed_out",
    });

    // Assert
    expect(result.kind).toBe("cover_queued");

    const actionResult = await pool.query<{
      action_key: string;
      status: string;
    }>(
      `
        SELECT
          "action_key",
          "status"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        action_key: `organiser_cover_request:${fixture.failedAssignmentId}`,

        status: "pending",
      },
    ]);
  });

  it("does nothing when organiser ownership has already been restored", async () => {
    // Arrange
    const fixture = await createEscalationFixture(pool, {
      withActiveReplacement: true,
    });

    // Act
    const result = await advanceOrganiserEscalation({
      eventId: fixture.eventId,

      failedAssignmentId: fixture.failedAssignmentId,

      trigger: "declined",
    });

    // Assert
    expect(result).toEqual({
      kind: "already_resolved",
    });

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

    const activeResult = await pool.query<{
      discord_user_id: string;
      slot: string;
      status: string;
      is_current: boolean;
    }>(
      `
        SELECT
          "discord_user_id",
          "slot",
          "status",
          "is_current"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "is_current" = true
      `,
      [fixture.eventId],
    );

    expect(activeResult.rows).toEqual([
      {
        discord_user_id: COVER_USER_ID,

        slot: "cover",

        status: "confirmed",

        is_current: true,
      },
    ]);
  });

  it("does not escalate a cancelled event", async () => {
    // Arrange
    const fixture = await createEscalationFixture(pool, {
      withBackup: true,

      eventStatus: "cancelled",
    });

    if (!fixture.backupAssignmentId) {
      throw new Error("Expected the fixture to include a dormant backup.");
    }

    // Act
    const result = await advanceOrganiserEscalation({
      eventId: fixture.eventId,

      failedAssignmentId: fixture.failedAssignmentId,

      trigger: "declined",
    });

    // Assert
    expect(result).toEqual({
      kind: "event_inactive",
    });

    const backupResult = await pool.query<{
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
      [fixture.backupAssignmentId],
    );

    expect(backupResult.rows).toEqual([
      {
        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
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
});

async function createEscalationFixture(
  pool: Pool,
  options: {
    withBackup?: boolean;

    failureStatus?: "declined" | "timed_out";

    eventStatus?: "open" | "cancelled";

    withActiveReplacement?: boolean;
  } = {},
): Promise<{
  guildId: number;

  eventId: number;

  failedAssignmentId: number;

  backupAssignmentId: number | null;
}> {
  const failureStatus = options.failureStatus ?? "declined";

  const eventStatus = options.eventStatus ?? "open";

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
    [DISCORD_GUILD_ID, "Organiser Escalation Service Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  /*
   * Use explicit response timings rather than relying on schema defaults so
   * the service contract remains obvious in the assertions below.
   */
  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "event_admin_channel_id",
        "organiser_dms_enabled",
        "organiser_backup_response_minutes",
        "organiser_warning_minutes_before"
      )
      VALUES (
        $1,
        $2,
        false,
        40,
        15
      )
    `,
    [guildId, EVENT_ADMIN_CHANNEL_ID],
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
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '2 hours',
        true,
        NOW(),
        $4,
        $5
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Organiser Escalation Service Test",
      eventStatus,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const respondedAt = failureStatus === "declined" ? new Date() : null;

  /*
   * The fixture begins at the point immediately after primary failure.
   * Therefore the failed assignment is historical rather than current and
   * has no outstanding scheduled response work.
   */
  const failedAssignmentResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_organiser_assignments" (
        "event_id",
        "slot",
        "discord_user_id",
        "display_name_snapshot",
        "status",
        "is_current",
        "assigned_by_user_id",
        "activated_at",
        "response_deadline_at",
        "responded_at",
        "ended_at"
      )
      VALUES (
        $1,
        'primary',
        $2,
        'Failed Primary Organiser',
        $3,
        false,
        $4,
        NOW() - INTERVAL '1 hour',
        NOW() - INTERVAL '5 minutes',
        $5,
        NOW()
      )
      RETURNING "id"
    `,
    [eventId, PRIMARY_USER_ID, failureStatus, ADMIN_USER_ID, respondedAt],
  );

  const failedAssignmentId = failedAssignmentResult.rows[0]?.id;

  if (!failedAssignmentId) {
    throw new Error(
      "The failed integration-test organiser assignment was not created.",
    );
  }

  let backupAssignmentId: number | null = null;

  if (options.withBackup) {
    const backupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO "event_organiser_assignments" (
          "event_id",
          "slot",
          "discord_user_id",
          "display_name_snapshot",
          "status",
          "is_current",
          "assigned_by_user_id",
          "activated_at",
          "response_deadline_at"
        )
        VALUES (
          $1,
          'backup',
          $2,
          'Dormant Backup Organiser',
          'pending',
          true,
          $3,
          NULL,
          NULL
        )
        RETURNING "id"
      `,
      [eventId, BACKUP_USER_ID, ADMIN_USER_ID],
    );

    backupAssignmentId = backupResult.rows[0]?.id ?? null;

    if (!backupAssignmentId) {
      throw new Error(
        "The integration-test backup assignment was not created.",
      );
    }
  }

  if (options.withActiveReplacement) {
    await pool.query(
      `
        INSERT INTO "event_organiser_assignments" (
          "event_id",
          "slot",
          "discord_user_id",
          "display_name_snapshot",
          "status",
          "is_current",
          "assigned_by_user_id",
          "activated_at",
          "responded_at"
        )
        VALUES (
          $1,
          'cover',
          $2,
          'Replacement Cover Organiser',
          'confirmed',
          true,
          $3,
          NOW(),
          NOW()
        )
      `,
      [eventId, COVER_USER_ID, ADMIN_USER_ID],
    );
  }

  return {
    guildId,

    eventId,

    failedAssignmentId,

    backupAssignmentId,
  };
}
