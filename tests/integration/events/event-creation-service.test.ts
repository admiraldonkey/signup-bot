import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import {
  createStoredEvent,
  type CreateStoredEventInput,
} from "../../../src/events/event-creation-service.js";
import { setGuildOrganisersEnabled } from "../../../src/organisers/organiser-feature-service.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "972000000000000001";

const ADMIN_USER_ID = "972000000000000002";

const PRIMARY_USER_ID = "972000000000000003";

const BACKUP_USER_ID = "972000000000000004";

const ATTENDANCE_CHANNEL_ID = "972000000000000005";

const PING_ROLE_ONE_ID = "972000000000000006";

const PING_ROLE_TWO_ID = "972000000000000007";

describe("event creation service", () => {
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

  it("creates an unpublished event with snapshotted roles, dormant organisers and core scheduled work", async () => {
    // Arrange
    const fixture = await createCreationFixture(pool);

    const startsAt = new Date(Date.now() + 4 * 60 * 60 * 1000);

    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);

    const attendanceClosesAt = new Date(startsAt.getTime() - 60 * 60_000);

    const scheduledPublicationAt = new Date(startsAt.getTime() - 120 * 60_000);

    // Act
    const result = await createStoredEvent({
      guildDatabaseId: fixture.guildId,

      templateId: null,

      eventTypeId: fixture.eventTypeId,

      audienceId: fixture.audienceId,

      timezone: "Europe/London",

      showDetailedDeadline: true,

      name: "Creation Service Test Event",

      description: "Created through the reusable event service.",

      startsAt,

      endsAt,

      signupsEnabled: true,

      attendanceClosesAt,

      publishMinutesBeforeStart: 120,

      publicationChannelId: ATTENDANCE_CHANNEL_ID,

      scheduledPublicationAt,

      createdByUserId: ADMIN_USER_ID,

      pingRoles: [
        {
          discordRoleId: PING_ROLE_ONE_ID,

          roleName: "Naval",
        },

        {
          discordRoleId: PING_ROLE_TWO_ID,

          roleName: "Announcements",
        },
      ],

      primaryOrganiser: {
        discordUserId: PRIMARY_USER_ID,

        displayNameSnapshot: "Primary Organiser",
      },

      backupOrganiser: {
        discordUserId: BACKUP_USER_ID,

        displayNameSnapshot: "Backup Organiser",
      },
    });

    // Assert
    expect(result.kind).toBe("created");

    if (result.kind !== "created") {
      throw new Error(
        `Expected event creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.event).toMatchObject({
      name: "Creation Service Test Event",

      timezone: "Europe/London",

      showDetailedDeadline: true,

      signupsEnabled: true,
    });

    expect(result.event.startsAt).toEqual(startsAt);

    expect(result.event.attendanceClosesAt).toEqual(attendanceClosesAt);

    const storedEvent = await pool.query<{
      template_id: number | null;

      owner_guild_id: number;

      event_type_id: number;

      audience_id: number | null;

      status: string;

      published_at: Date | null;

      attendance_opens_at: Date | null;

      role_requests_open_at: Date | null;

      publication_channel_id: string | null;

      publish_minutes_before_start: number | null;

      created_by_user_id: string;
    }>(
      `
            SELECT
              "template_id",
              "owner_guild_id",
              "event_type_id",
              "audience_id",
              "status",
              "published_at",
              "attendance_opens_at",
              "role_requests_open_at",
              "publication_channel_id",
              "publish_minutes_before_start",
              "created_by_user_id"
            FROM
              "events"
            WHERE
              "id" = $1
          `,
      [result.event.id],
    );

    expect(storedEvent.rows).toEqual([
      {
        template_id: null,

        owner_guild_id: fixture.guildId,

        event_type_id: fixture.eventTypeId,

        audience_id: fixture.audienceId,

        status: "scheduled",

        published_at: null,

        attendance_opens_at: null,

        role_requests_open_at: null,

        publication_channel_id: ATTENDANCE_CHANNEL_ID,

        publish_minutes_before_start: 120,

        created_by_user_id: ADMIN_USER_ID,
      },
    ]);

    const pingRoles = await pool.query<{
      discord_role_id: string;

      role_name: string;

      sort_order: number;
    }>(
      `
            SELECT
              "discord_role_id",
              "role_name",
              "sort_order"
            FROM
              "event_ping_roles"
            WHERE
              "event_id" = $1
            ORDER BY
              "sort_order"
          `,
      [result.event.id],
    );

    expect(pingRoles.rows).toEqual([
      {
        discord_role_id: PING_ROLE_ONE_ID,

        role_name: "Naval",

        sort_order: 0,
      },

      {
        discord_role_id: PING_ROLE_TWO_ID,

        role_name: "Announcements",

        sort_order: 1,
      },
    ]);

    const assignments = await pool.query<{
      slot: string;

      discord_user_id: string;

      display_name_snapshot: string;

      status: string;

      is_current: boolean;

      activated_at: Date | null;

      response_deadline_at: Date | null;
    }>(
      `
            SELECT
              "slot",
              "discord_user_id",
              "display_name_snapshot",
              "status",
              "is_current",
              "activated_at",
              "response_deadline_at"
            FROM
              "event_organiser_assignments"
            WHERE
              "event_id" = $1
            ORDER BY
              "id"
          `,
      [result.event.id],
    );

    expect(assignments.rows).toEqual([
      {
        slot: "primary",

        discord_user_id: PRIMARY_USER_ID,

        display_name_snapshot: "Primary Organiser",

        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
      },

      {
        slot: "backup",

        discord_user_id: BACKUP_USER_ID,

        display_name_snapshot: "Backup Organiser",

        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
      },
    ]);

    const actions = await pool.query<{
      action_key: string;

      due_at: Date;

      status: string;

      attempt_count: number;
    }>(
      `
            SELECT
              "action_key",
              "due_at",
              "status",
              "attempt_count"
            FROM
              "scheduled_actions"
            WHERE
              "event_id" = $1
            ORDER BY
              "action_key"
          `,
      [result.event.id],
    );

    expect(actions.rows).toEqual([
      {
        action_key: "close_attendance",

        due_at: attendanceClosesAt,

        status: "pending",

        attempt_count: 0,
      },

      {
        action_key: "complete_event",

        due_at: endsAt,

        status: "pending",

        attempt_count: 0,
      },

      {
        action_key: "publish_event",

        due_at: scheduledPublicationAt,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });

  it("rejects organiser defaults when the organiser feature is disabled", async () => {
    // Arrange
    const fixture = await createCreationFixture(pool);

    await pool.query(
      `
      UPDATE "guild_settings"
      SET
        "organisers_enabled" = false,
        "updated_at" = NOW()
      WHERE
        "guild_id" = $1
    `,
      [fixture.guildId],
    );

    // Act
    const result = await createStoredEvent(
      buildMinimalCreationInput(fixture, true),
    );

    // Assert
    expect(result).toEqual({
      kind: "organisers_disabled",
    });

    const eventCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "events"
        WHERE
          "owner_guild_id" = $1
      `,
      [fixture.guildId],
    );

    expect(eventCount.rows).toEqual([
      {
        count: 0,
      },
    ]);

    const assignmentCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "event_organiser_assignments"
      `,
    );

    expect(assignmentCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("still creates events without organiser defaults when organisers are disabled", async () => {
    // Arrange
    const fixture = await createCreationFixture(pool);

    await pool.query(
      `
      UPDATE "guild_settings"
      SET
        "organisers_enabled" = false,
        "updated_at" = NOW()
      WHERE
        "guild_id" = $1
    `,
      [fixture.guildId],
    );

    // Act
    const result = await createStoredEvent(
      buildMinimalCreationInput(fixture, false),
    );

    // Assert
    expect(result.kind).toBe("created");

    if (result.kind !== "created") {
      throw new Error(
        `Expected organiser-free event creation to succeed, received "${result.kind}".`,
      );
    }

    const assignments = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "event_organiser_assignments"
        WHERE
          "event_id" = $1
      `,
      [result.event.id],
    );

    expect(assignments.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("lets in-flight event creation finish before organiser disable retires its dormant organiser", async () => {
    // Arrange
    const fixture = await createCreationFixture(pool);

    /*
     * Prevent the event INSERT from completing.
     *
     * Once the service is hardened, createStoredEvent() should already hold
     * FOR SHARE on this guild's organiser-feature row by the time it blocks
     * here.
     */
    const blocker = await pool.connect();

    let blockerOpen = false;

    try {
      await blocker.query("BEGIN");

      blockerOpen = true;

      await blocker.query(
        `
        LOCK TABLE "events"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      const creationPromise = createStoredEvent(
        buildMinimalCreationInput(fixture, true),
      );

      await waitForBlockedDatabaseQuery(pool, 'insert into "events"');

      /*
       * Disabling organisers requires FOR UPDATE on guild_settings.
       *
       * If creation acquired FOR SHARE first, disable must now wait rather
       * than overtaking creation.
       */
      const disablePromise = setGuildOrganisersEnabled({
        guildDatabaseId: fixture.guildId,

        enabled: false,
      });

      await waitForBlockedDatabaseQuery(pool, "guild_settings");

      await blocker.query("COMMIT");

      blockerOpen = false;

      const creationResult = await creationPromise;

      expect(creationResult.kind).toBe("created");

      if (creationResult.kind !== "created") {
        throw new Error(
          `Expected in-flight event creation to succeed, received "${creationResult.kind}".`,
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

        affectedEventIds: [creationResult.event.id],
      });

      const settings = await pool.query<{
        organisers_enabled: boolean;
      }>(
        `
          SELECT
            "organisers_enabled"
          FROM
            "guild_settings"
          WHERE
            "guild_id" = $1
        `,
        [fixture.guildId],
      );

      expect(settings.rows).toEqual([
        {
          organisers_enabled: false,
        },
      ]);

      const assignments = await pool.query<{
        status: string;

        is_current: boolean;

        ended_at: Date | null;
      }>(
        `
          SELECT
            "status",
            "is_current",
            "ended_at"
          FROM
            "event_organiser_assignments"
          WHERE
            "event_id" = $1
        `,
        [creationResult.event.id],
      );

      expect(assignments.rows).toHaveLength(1);

      expect(assignments.rows[0]).toMatchObject({
        status: "removed",

        is_current: false,
      });

      expect(assignments.rows[0]?.ended_at).toBeInstanceOf(Date);
    } finally {
      if (blockerOpen) {
        await blocker.query("ROLLBACK").catch(() => undefined);
      }

      blocker.release();
    }
  });
});

async function createCreationFixture(pool: Pool): Promise<{
  guildId: number;

  eventTypeId: number;

  audienceId: number;
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
    [DISCORD_GUILD_ID, "Event Creation Service Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  /*
   * The creation service does not consume organiser feature settings yet,
   * but create the settings row now because the next hardening slice will
   * make that feature policy authoritative here.
   */
  await pool.query(
    `
      INSERT INTO
        "guild_settings" (
          "guild_id",
          "organisers_enabled",
          "default_attendance_channel_id"
        )
      VALUES (
        $1,
        true,
        $2
      )
    `,
    [guildId, ATTENDANCE_CHANNEL_ID],
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

  const audienceResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_audiences" (
            "owner_guild_id",
            "code",
            "name",
            "default_timezone"
          )
        VALUES (
          $1,
          $2,
          $3,
          $4
        )
        RETURNING
          "id"
      `,
    [guildId, "uk", "UK", "Europe/London"],
  );

  const audienceId = audienceResult.rows[0]?.id;

  if (!audienceId) {
    throw new Error("The integration-test event audience was not created.");
  }

  return {
    guildId,

    eventTypeId,

    audienceId,
  };
}

function buildMinimalCreationInput(
  fixture: {
    guildId: number;

    eventTypeId: number;

    audienceId: number;
  },
  includeOrganiser: boolean,
): CreateStoredEventInput {
  const startsAt = new Date(Date.now() + 4 * 60 * 60 * 1000);

  return {
    guildDatabaseId: fixture.guildId,

    templateId: null,

    eventTypeId: fixture.eventTypeId,

    audienceId: fixture.audienceId,

    timezone: "Europe/London",

    showDetailedDeadline: false,

    name: "Creation Hardening Test Event",

    description: null,

    startsAt,

    endsAt: new Date(startsAt.getTime() + 60 * 60_000),

    signupsEnabled: false,

    attendanceClosesAt: null,

    publishMinutesBeforeStart: null,

    publicationChannelId: ATTENDANCE_CHANNEL_ID,

    scheduledPublicationAt: null,

    createdByUserId: ADMIN_USER_ID,

    pingRoles: [],

    primaryOrganiser: includeOrganiser
      ? {
          discordUserId: PRIMARY_USER_ID,

          displayNameSnapshot: "Primary Organiser",
        }
      : null,

    backupOrganiser: null,
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
          SELECT
            COUNT(*)::int AS "count"
          FROM
            "pg_stat_activity"
          WHERE
            "datname" =
              current_database()
            AND
            "pid" <>
              pg_backend_pid()
            AND
            "state" =
              'active'
            AND
            "wait_event_type" =
              'Lock'
            AND
            "query" ILIKE $1
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
