import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import { openOrganiserCoverAtSafetyDeadline } from "../../../src/organisers/organiser-safety-service.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "971000000000000001";

const ADMIN_USER_ID = "971000000000000002";

const PRIMARY_USER_ID = "971000000000000003";

const BACKUP_USER_ID = "971000000000000004";

const EVENT_ADMIN_CHANNEL_ID = "971000000000000005";

const EVENT_ORGANISER_ROLE_ID = "971000000000000006";

describe("organiser safety service", () => {
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

  it("retires unresolved nominated organisers and requires general cover at the safety deadline", async () => {
    // Arrange
    const fixture = await createSafetyFixture(pool, {
      organisersEnabled: true,

      confirmedPrimary: false,

      existingCoverRequest: false,
    });

    // Act
    const result = await openOrganiserCoverAtSafetyDeadline({
      eventId: fixture.eventId,
    });

    // Assert
    expect(result.kind).toBe("cover_required");

    if (result.kind !== "cover_required") {
      throw new Error(`Expected cover_required, received "${result.kind}".`);
    }

    expect(result.event).toEqual({
      id: fixture.eventId,

      name: "Organiser Safety Test Event",

      guildDatabaseId: fixture.guildId,

      discordGuildId: DISCORD_GUILD_ID,

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

      eventOrganiserRoleId: EVENT_ORGANISER_ROLE_ID,
    });

    expect(result.retiredAssignmentIds.sort((a, b) => a - b)).toEqual(
      [fixture.primaryAssignmentId, fixture.backupAssignmentId].sort(
        (a, b) => a - b,
      ),
    );

    const assignments = await pool.query<{
      id: number;

      status: string;

      is_current: boolean;

      ended_at: Date | null;
    }>(
      `
            SELECT
              "id",
              "status",
              "is_current",
              "ended_at"
            FROM
              "event_organiser_assignments"
            WHERE
              "event_id" = $1
            ORDER BY
              "id"
          `,
      [fixture.eventId],
    );

    expect(assignments.rows).toHaveLength(2);

    for (const assignment of assignments.rows) {
      expect(assignment).toMatchObject({
        status: "removed",

        is_current: false,
      });

      expect(assignment.ended_at).toBeInstanceOf(Date);
    }

    const actions = await pool.query<{
      action_key: string;

      status: string;
    }>(
      `
            SELECT
              "action_key",
              "status"
            FROM
              "scheduled_actions"
            WHERE
              "event_id" = $1
            ORDER BY
              "action_key"
          `,
      [fixture.eventId],
    );

    expect(actions.rows).toEqual([
      {
        action_key: `organiser_timeout:${fixture.primaryAssignmentId}`,

        status: "cancelled",
      },

      {
        action_key: `organiser_warning:${fixture.primaryAssignmentId}`,

        status: "cancelled",
      },
    ]);
  });

  it("does nothing when a current organiser is already confirmed", async () => {
    // Arrange
    const fixture = await createSafetyFixture(pool, {
      organisersEnabled: true,

      confirmedPrimary: true,

      existingCoverRequest: false,
    });

    // Act
    const result = await openOrganiserCoverAtSafetyDeadline({
      eventId: fixture.eventId,
    });

    // Assert
    expect(result).toEqual({
      kind: "already_resolved",
    });

    const assignment = await pool.query<{
      status: string;

      is_current: boolean;
    }>(
      `
            SELECT
              "status",
              "is_current"
            FROM
              "event_organiser_assignments"
            WHERE
              "id" = $1
          `,
      [fixture.primaryAssignmentId],
    );

    expect(assignment.rows).toEqual([
      {
        status: "confirmed",

        is_current: true,
      },
    ]);

    const liveActions = await pool.query<{
      count: number;
    }>(
      `
            SELECT
              COUNT(*)::int AS
                "count"
            FROM
              "scheduled_actions"
            WHERE
              "event_id" = $1
              AND
              "status" = 'pending'
          `,
      [fixture.eventId],
    );

    expect(liveActions.rows).toEqual([
      {
        count: 2,
      },
    ]);
  });

  it("does not apply a stale cover deadline after the event has been moved later", async () => {
    // Arrange
    const fixture = await createSafetyFixture(pool, {
      organisersEnabled: true,

      confirmedPrimary: false,

      existingCoverRequest: false,
    });

    /*
     * The fixture normally represents an event at its safety deadline.
     *
     * Move it far enough into the future that a previously-claimed scheduler
     * action is now stale relative to authoritative event state.
     */
    await pool.query(
      `
      UPDATE "events"
      SET
        "starts_at" =
          NOW() +
            INTERVAL '2 hours',
        "updated_at" =
          NOW()
      WHERE
        "id" = $1
    `,
      [fixture.eventId],
    );

    // Act
    const result = await openOrganiserCoverAtSafetyDeadline({
      eventId: fixture.eventId,
    });

    // Assert
    expect(result).toEqual({
      kind: "not_due",
    });

    const assignments = await pool.query<{
      status: string;

      is_current: boolean;
    }>(
      `
        SELECT
          "status",
          "is_current"
        FROM
          "event_organiser_assignments"
        WHERE
          "event_id" = $1
        ORDER BY
          "id"
      `,
      [fixture.eventId],
    );

    expect(assignments.rows).toEqual([
      {
        status: "pending",

        is_current: true,
      },

      {
        status: "pending",

        is_current: true,
      },
    ]);

    const actions = await pool.query<{
      action_key: string;

      status: string;
    }>(
      `
        SELECT
          "action_key",
          "status"
        FROM
          "scheduled_actions"
        WHERE
          "event_id" = $1
        ORDER BY
          "action_key"
      `,
      [fixture.eventId],
    );

    expect(actions.rows).toEqual([
      {
        action_key: `organiser_timeout:${fixture.primaryAssignmentId}`,

        status: "pending",
      },

      {
        action_key: `organiser_warning:${fixture.primaryAssignmentId}`,

        status: "pending",
      },
    ]);
  });

  it("does nothing when organisers are disabled", async () => {
    // Arrange
    const fixture = await createSafetyFixture(pool, {
      organisersEnabled: false,

      confirmedPrimary: false,

      existingCoverRequest: false,
    });

    // Act
    const result = await openOrganiserCoverAtSafetyDeadline({
      eventId: fixture.eventId,
    });

    // Assert
    expect(result).toEqual({
      kind: "organisers_disabled",
    });

    const assignments = await pool.query<{
      status: string;

      is_current: boolean;
    }>(
      `
            SELECT
              "status",
              "is_current"
            FROM
              "event_organiser_assignments"
            WHERE
              "event_id" = $1
            ORDER BY
              "id"
          `,
      [fixture.eventId],
    );

    expect(assignments.rows).toEqual([
      {
        status: "pending",

        is_current: true,
      },

      {
        status: "pending",

        is_current: true,
      },
    ]);
  });

  it("does not request duplicate cover when ordinary escalation has already queued it", async () => {
    // Arrange
    const fixture = await createSafetyFixture(pool, {
      organisersEnabled: true,

      confirmedPrimary: false,

      existingCoverRequest: true,
    });

    // Act
    const result = await openOrganiserCoverAtSafetyDeadline({
      eventId: fixture.eventId,
    });

    // Assert
    expect(result.kind).toBe("cover_already_requested");

    if (result.kind !== "cover_already_requested") {
      throw new Error(
        `Expected cover_already_requested, received "${result.kind}".`,
      );
    }

    expect(result.retiredAssignmentIds.sort((a, b) => a - b)).toEqual(
      [fixture.primaryAssignmentId, fixture.backupAssignmentId].sort(
        (a, b) => a - b,
      ),
    );

    const coverActions = await pool.query<{
      action_key: string;

      status: string;
    }>(
      `
            SELECT
              "action_key",
              "status"
            FROM
              "scheduled_actions"
            WHERE
              "event_id" = $1
              AND
              "action_key" LIKE
                'organiser_cover_request:%'
          `,
      [fixture.eventId],
    );

    expect(coverActions.rows).toEqual([
      {
        action_key: `organiser_cover_request:${fixture.primaryAssignmentId}`,

        status: "pending",
      },
    ]);
  });
});

async function createSafetyFixture(
  pool: Pool,
  input: {
    organisersEnabled: boolean;

    confirmedPrimary: boolean;

    existingCoverRequest: boolean;
  },
): Promise<{
  guildId: number;

  eventId: number;

  primaryAssignmentId: number;

  backupAssignmentId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "discord_guilds" (
            "discord_guild_id",
            "name"
          )
        VALUES (
          $1,
          $2
        )
        RETURNING
          "id"
      `,
    [DISCORD_GUILD_ID, "Organiser Safety Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO
        "guild_settings" (
          "guild_id",
          "organisers_enabled",
          "event_admin_channel_id",
          "event_organiser_role_id"
        )
      VALUES (
        $1,
        $2,
        $3,
        $4
      )
    `,
    [
      guildId,

      input.organisersEnabled,

      EVENT_ADMIN_CHANNEL_ID,

      EVENT_ORGANISER_ROLE_ID,
    ],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_types" (
            "owner_guild_id",
            "code",
            "name"
          )
        VALUES (
          $1,
          $2,
          $3
        )
        RETURNING
          "id"
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
        INSERT INTO
          "events" (
            "owner_guild_id",
            "event_type_id",
            "name",
            "starts_at",
            "published_at",
            "status",
            "created_by_user_id"
          )
        VALUES (
          $1,
          $2,
          $3,
          NOW() +
            INTERVAL '15 minutes',
          NOW(),
          'open',
          $4
        )
        RETURNING
          "id"
      `,
    [guildId, eventTypeId, "Organiser Safety Test Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const primaryResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_organiser_assignments" (
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
          'primary',
          $2,
          'Primary Organiser',
          $3,
          true,
          $4,
          NOW(),
          NOW() +
            INTERVAL '70 minutes'
        )
        RETURNING
          "id"
      `,
    [
      eventId,

      PRIMARY_USER_ID,

      input.confirmedPrimary ? "confirmed" : "pending",

      ADMIN_USER_ID,
    ],
  );

  const primaryAssignmentId = primaryResult.rows[0]?.id;

  if (!primaryAssignmentId) {
    throw new Error("The primary assignment was not created.");
  }

  const backupResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_organiser_assignments" (
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
          'Backup Organiser',
          'pending',
          true,
          $3,
          NULL,
          NULL
        )
        RETURNING
          "id"
      `,
    [eventId, BACKUP_USER_ID, ADMIN_USER_ID],
  );

  const backupAssignmentId = backupResult.rows[0]?.id;

  if (!backupAssignmentId) {
    throw new Error("The backup assignment was not created.");
  }

  await pool.query(
    `
      INSERT INTO
        "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status"
        )
      VALUES
        (
          $1,
          $2,
          NOW() +
            INTERVAL '5 minutes',
          'pending'
        ),
        (
          $1,
          $3,
          NOW() +
            INTERVAL '10 minutes',
          'pending'
        )
    `,
    [
      eventId,

      `organiser_warning:${primaryAssignmentId}`,

      `organiser_timeout:${primaryAssignmentId}`,
    ],
  );

  if (input.existingCoverRequest) {
    await pool.query(
      `
        INSERT INTO
          "scheduled_actions" (
            "event_id",
            "action_key",
            "due_at",
            "status"
          )
        VALUES (
          $1,
          $2,
          NOW(),
          'pending'
        )
      `,
      [eventId, `organiser_cover_request:${primaryAssignmentId}`],
    );
  }

  return {
    guildId,

    eventId,

    primaryAssignmentId,

    backupAssignmentId,
  };
}
