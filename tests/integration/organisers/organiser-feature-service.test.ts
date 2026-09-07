import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { setGuildOrganisersEnabled } from "../../../src/organisers/organiser-feature-service.js";
import { assignEventOrganiser } from "../../../src/organisers/organiser-assignment-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "970000000000000001";

const ADMIN_USER_ID = "970000000000000002";

const PRIMARY_USER_ID = "970000000000000003";

const BACKUP_USER_ID = "970000000000000004";

describe("organiser feature service", () => {
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

  it("disables organisers, retires current assignments and cancels organiser actions", async () => {
    // Arrange
    const fixture = await createOrganiserFeatureFixture(pool, {
      organisersEnabled: true,

      organiserDmsEnabled: false,
    });

    // Act
    const result = await setGuildOrganisersEnabled({
      guildDatabaseId: fixture.guildId,

      enabled: false,
    });

    // Assert
    expect(result).toMatchObject({
      kind: "updated",

      enabled: false,

      previousValue: true,

      affectedEventIds: [fixture.eventId],
    });

    if (result.kind !== "updated") {
      throw new Error(
        `Expected organiser feature transition to succeed, received "${result.kind}".`,
      );
    }

    expect(
      result.retiredAssignments
        .map((assignment) => assignment.id)
        .sort((a, b) => a - b),
    ).toEqual(
      [fixture.primaryAssignmentId, fixture.backupAssignmentId].sort(
        (a, b) => a - b,
      ),
    );

    const settingsResult = await pool.query<{
      organisers_enabled: boolean;
      organiser_dms_enabled: boolean;
    }>(
      `
          SELECT
            "organisers_enabled",
            "organiser_dms_enabled"
          FROM "guild_settings"
          WHERE "guild_id" = $1
        `,
      [fixture.guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organisers_enabled: false,

        /*
         * The child preference survives the parent being disabled.
         */
        organiser_dms_enabled: false,
      },
    ]);

    const assignmentResult = await pool.query<{
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
          FROM "event_organiser_assignments"
          WHERE "event_id" = $1
          ORDER BY "id"
        `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toHaveLength(2);

    for (const assignment of assignmentResult.rows) {
      expect(assignment).toMatchObject({
        status: "removed",

        is_current: false,
      });

      expect(assignment.ended_at).toBeInstanceOf(Date);
    }

    const actionResult = await pool.query<{
      action_key: string;
      status: string;
      locked_at: Date | null;
    }>(
      `
          SELECT
            "action_key",
            "status",
            "locked_at"
          FROM "scheduled_actions"
          WHERE "event_id" = $1
          ORDER BY "action_key"
        `,
      [fixture.eventId],
    );

    expect(actionResult.rows).toEqual([
      {
        action_key: `organiser_cover_request:${fixture.primaryAssignmentId}`,

        status: "cancelled",

        locked_at: null,
      },
      {
        action_key: `organiser_timeout:${fixture.primaryAssignmentId}`,

        status: "cancelled",

        locked_at: null,
      },
      {
        action_key: `organiser_warning:${fixture.primaryAssignmentId}`,

        status: "cancelled",

        locked_at: null,
      },
    ]);
  });

  it("re-enables organisers without resurrecting retired assignments or changing DM preferences", async () => {
    // Arrange
    const fixture = await createOrganiserFeatureFixture(pool, {
      organisersEnabled: true,

      organiserDmsEnabled: false,
    });

    const disabled = await setGuildOrganisersEnabled({
      guildDatabaseId: fixture.guildId,

      enabled: false,
    });

    if (disabled.kind !== "updated") {
      throw new Error(
        "The organiser feature could not be disabled for the fixture.",
      );
    }

    // Act
    const result = await setGuildOrganisersEnabled({
      guildDatabaseId: fixture.guildId,

      enabled: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      enabled: true,

      previousValue: false,

      retiredAssignments: [],

      affectedEventIds: [],
    });

    const settingsResult = await pool.query<{
      organisers_enabled: boolean;
      organiser_dms_enabled: boolean;
    }>(
      `
          SELECT
            "organisers_enabled",
            "organiser_dms_enabled"
          FROM "guild_settings"
          WHERE "guild_id" = $1
        `,
      [fixture.guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organisers_enabled: true,

        organiser_dms_enabled: false,
      },
    ]);

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
    }>(
      `
          SELECT
            "status",
            "is_current"
          FROM "event_organiser_assignments"
          WHERE "event_id" = $1
          ORDER BY "id"
        `,
      [fixture.eventId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "removed",

        is_current: false,
      },
      {
        status: "removed",

        is_current: false,
      },
    ]);
  });

  it("lets an in-flight organiser assignment finish before disabling organisers retires its ownership", async () => {
    // Arrange
    const fixture = await createOrganiserFeatureFixture(pool, {
      organisersEnabled: true,

      organiserDmsEnabled: true,
    });

    /*
     * Hold the current primary row so replacement can acquire its shared
     * organiser-feature lock and then block while trying to replace this
     * assignment.
     */
    const blocker = await pool.connect();

    let blockerOpen = false;

    try {
      await blocker.query("BEGIN");

      blockerOpen = true;

      await blocker.query(
        `
        SELECT "id"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
        FOR UPDATE
      `,
        [fixture.primaryAssignmentId],
      );

      /*
       * This operation should:
       *
       * 1. acquire FOR SHARE on guild_settings;
       * 2. observe organisers as enabled;
       * 3. block while replacing the primary row held above.
       */
      const assignmentPromise = assignEventOrganiser({
        guildDatabaseId: fixture.guildId,

        eventId: fixture.eventId,

        slot: "primary",

        organiserUserId: "970000000000000005",

        displayNameSnapshot: "Replacement Primary",

        assignedByUserId: ADMIN_USER_ID,

        primaryResponseMinutes: 80,

        warningMinutesBefore: 15,
      });

      await waitForBlockedDatabaseQuery(pool, "event_organiser_assignments");

      /*
       * Disabling now requires FOR UPDATE on the same guild_settings row.
       *
       * It must therefore wait for the in-flight assignment's FOR SHARE lock
       * rather than overtaking the operation.
       */
      const disablePromise = setGuildOrganisersEnabled({
        guildDatabaseId: fixture.guildId,

        enabled: false,
      });

      await waitForBlockedDatabaseQuery(pool, "guild_settings");

      /*
       * Release the assignment-row blocker.
       *
       * The assignment should commit first, release its shared feature lock,
       * and then the waiting disable transition should acquire the exclusive
       * feature lock and retire the newly-created ownership.
       */
      await blocker.query("COMMIT");

      blockerOpen = false;

      const assignmentResult = await assignmentPromise;

      expect(assignmentResult.kind).toBe("assigned");

      if (assignmentResult.kind !== "assigned") {
        throw new Error(
          `Expected the in-flight organiser assignment to succeed, received "${assignmentResult.kind}".`,
        );
      }

      const disableResult = await disablePromise;

      expect(disableResult.kind).toBe("updated");

      if (disableResult.kind !== "updated") {
        throw new Error(
          `Expected organiser disable to succeed, received "${disableResult.kind}".`,
        );
      }

      expect(disableResult).toMatchObject({
        enabled: false,

        previousValue: true,

        affectedEventIds: [fixture.eventId],
      });

      /*
       * The newly-created primary and the still-current dormant backup should
       * both be retired by the disable transition.
       *
       * The original primary was already replaced by the assignment operation,
       * so it is historical state rather than part of the disable sweep.
       */
      expect(
        disableResult.retiredAssignments
          .map((assignment) => assignment.id)
          .sort((a, b) => a - b),
      ).toEqual(
        [fixture.backupAssignmentId, assignmentResult.assignment.id].sort(
          (a, b) => a - b,
        ),
      );

      const settingsResult = await pool.query<{
        organisers_enabled: boolean;
      }>(
        `
          SELECT "organisers_enabled"
          FROM "guild_settings"
          WHERE "guild_id" = $1
        `,
        [fixture.guildId],
      );

      expect(settingsResult.rows).toEqual([
        {
          organisers_enabled: false,
        },
      ]);

      const assignmentRows = await pool.query<{
        id: number;
        status: string;
        is_current: boolean;
      }>(
        `
          SELECT
            "id",
            "status",
            "is_current"
          FROM "event_organiser_assignments"
          WHERE "event_id" = $1
          ORDER BY "id"
        `,
        [fixture.eventId],
      );

      expect(assignmentRows.rows).toEqual([
        {
          id: fixture.primaryAssignmentId,

          status: "replaced",

          is_current: false,
        },
        {
          id: fixture.backupAssignmentId,

          status: "removed",

          is_current: false,
        },
        {
          id: assignmentResult.assignment.id,

          status: "removed",

          is_current: false,
        },
      ]);

      const currentAssignmentResult = await pool.query<{
        count: number;
      }>(
        `
          SELECT COUNT(*)::int AS "count"
          FROM "event_organiser_assignments"
          WHERE
            "event_id" = $1
            AND "is_current" = true
        `,
        [fixture.eventId],
      );

      expect(currentAssignmentResult.rows).toEqual([
        {
          count: 0,
        },
      ]);

      const liveOrganiserActionResult = await pool.query<{
        count: number;
      }>(
        `
          SELECT COUNT(*)::int AS "count"
          FROM "scheduled_actions"
          WHERE
            "event_id" = $1
            AND "status" IN (
              'pending',
              'processing'
            )
            AND (
              "action_key" LIKE
                'organiser_warning:%'
              OR
              "action_key" LIKE
                'organiser_timeout:%'
              OR
              "action_key" LIKE
                'organiser_cover_request:%'
            )
        `,
        [fixture.eventId],
      );

      expect(liveOrganiserActionResult.rows).toEqual([
        {
          count: 0,
        },
      ]);
    } finally {
      if (blockerOpen) {
        await blocker.query("ROLLBACK").catch(() => undefined);
      }

      blocker.release();
    }
  });
});

async function createOrganiserFeatureFixture(
  pool: Pool,
  input: {
    organisersEnabled: boolean;

    organiserDmsEnabled: boolean;
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
        INSERT INTO "discord_guilds" (
          "discord_guild_id",
          "name"
        )
        VALUES ($1, $2)
        RETURNING "id"
      `,
    [DISCORD_GUILD_ID, "Organiser Feature Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "organisers_enabled",
        "organiser_dms_enabled"
      )
      VALUES ($1, $2, $3)
    `,
    [guildId, input.organisersEnabled, input.organiserDmsEnabled],
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
          'open',
          $4
        )
        RETURNING "id"
      `,
    [guildId, eventTypeId, "Organiser Feature Test Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const primaryResult = await pool.query<{
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
          'primary',
          $2,
          'Primary Organiser',
          'pending',
          true,
          $3,
          NOW(),
          NOW() + INTERVAL '80 minutes'
        )
        RETURNING "id"
      `,
    [eventId, PRIMARY_USER_ID, ADMIN_USER_ID],
  );

  const primaryAssignmentId = primaryResult.rows[0]?.id;

  if (!primaryAssignmentId) {
    throw new Error("The primary assignment was not created.");
  }

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
          'Backup Organiser',
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

  const backupAssignmentId = backupResult.rows[0]?.id;

  if (!backupAssignmentId) {
    throw new Error("The backup assignment was not created.");
  }

  await pool.query(
    `
      INSERT INTO "scheduled_actions" (
        "event_id",
        "action_key",
        "due_at",
        "status"
      )
      VALUES
        (
          $1,
          $2,
          NOW() + INTERVAL '65 minutes',
          'pending'
        ),
        (
          $1,
          $3,
          NOW() + INTERVAL '80 minutes',
          'pending'
        ),
        (
          $1,
          $4,
          NOW() + INTERVAL '5 minutes',
          'pending'
        )
    `,
    [
      eventId,

      `organiser_warning:${primaryAssignmentId}`,

      `organiser_timeout:${primaryAssignmentId}`,

      `organiser_cover_request:${primaryAssignmentId}`,
    ],
  );

  return {
    guildId,

    eventId,

    primaryAssignmentId,

    backupAssignmentId,
  };
}

async function waitForBlockedDatabaseQuery(
  pool: Pool,
  queryFragment: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await pool.query<{
      count: number;
    }>(
      `
          SELECT COUNT(*)::int AS "count"
          FROM "pg_stat_activity"
          WHERE
            "datname" = current_database()
            AND "pid" <> pg_backend_pid()
            AND "state" = 'active'
            AND "wait_event_type" = 'Lock'
            AND "query" ILIKE $1
        `,
      [`%${queryFragment}%`],
    );

    if ((result.rows[0]?.count ?? 0) > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(
    `Timed out waiting for a blocked database query containing "${queryFragment}".`,
  );
}
