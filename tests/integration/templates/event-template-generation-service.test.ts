import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { generateEventFromTemplate } from "../../../src/templates/event-template-generation-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "989000000000000001";

const ADMIN_USER_ID = "989000000000000002";

const DEFAULT_ATTENDANCE_CHANNEL_ID = "989000000000000003";

const DEFAULT_ROLE_REQUEST_CHANNEL_ID = "989000000000000004";

const FIXED_REMINDER_CHANNEL_ID = "989000000000000005";

const PRIMARY_ORGANISER_ID = "989000000000000006";

const BACKUP_ORGANISER_ID = "989000000000000007";

const PING_ROLE_ONE_ID = "989000000000000008";

const PING_ROLE_TWO_ID = "989000000000000009";

describe("event template generation service", () => {
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

  it("atomically generates an ordinary event with the complete template snapshot", async () => {
    // Arrange
    const fixture = await createTemplateFixture(pool);

    const startsAt = futureStart();

    const expectedEndsAt = addMinutes(startsAt, 90);

    const expectedAttendanceClosesAt = subtractMinutes(startsAt, 60);

    const expectedPublicationAt = subtractMinutes(startsAt, 180);

    // Act
    const result = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt,

      generatedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result.kind).toBe("generated");

    if (result.kind !== "generated") {
      throw new Error(
        `Expected template generation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.templateId).toBe(fixture.templateId);

    expect(result.publicationMode).toBe("scheduled");

    expect(result.requiresImmediatePublication).toBe(false);

    const event = await pool.query<{
      template_id: number | null;

      owner_guild_id: number;

      event_type_id: number;

      audience_id: number | null;

      timezone: string;

      show_detailed_deadline: boolean;

      name: string;

      description: string | null;

      starts_at: Date;

      ends_at: Date;

      signups_enabled: boolean;

      attendance_closes_at: Date | null;

      published_at: Date | null;

      publish_minutes_before_start: number | null;

      publication_channel_id: string | null;

      status: string;

      created_by_user_id: string;
    }>(
      `
        SELECT
          "template_id",
          "owner_guild_id",
          "event_type_id",
          "audience_id",
          "timezone",
          "show_detailed_deadline",
          "name",
          "description",
          "starts_at",
          "ends_at",
          "signups_enabled",
          "attendance_closes_at",
          "published_at",
          "publish_minutes_before_start",
          "publication_channel_id",
          "status",
          "created_by_user_id"
        FROM "events"
        WHERE "id" = $1
      `,
      [result.event.id],
    );

    expect(event.rows).toEqual([
      {
        template_id: fixture.templateId,

        owner_guild_id: fixture.guildId,

        event_type_id: fixture.eventTypeId,

        audience_id: fixture.audienceId,

        timezone: "Europe/London",

        show_detailed_deadline: true,

        name: "Sunday Naval",

        description: "Reusable naval event",

        starts_at: startsAt,

        ends_at: expectedEndsAt,

        signups_enabled: true,

        attendance_closes_at: expectedAttendanceClosesAt,

        published_at: null,

        publish_minutes_before_start: 180,

        publication_channel_id: DEFAULT_ATTENDANCE_CHANNEL_ID,

        status: "scheduled",

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
        FROM "event_ping_roles"
        WHERE "event_id" = $1
        ORDER BY "sort_order", "discord_role_id"
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

        role_name: "Events",

        sort_order: 1,
      },
    ]);

    const organisers = await pool.query<{
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
        FROM "event_organiser_assignments"
        WHERE "event_id" = $1
        ORDER BY
          CASE "slot"
            WHEN 'primary' THEN 0
            WHEN 'backup' THEN 1
            ELSE 2
          END
      `,
      [result.event.id],
    );

    expect(organisers.rows).toEqual([
      {
        slot: "primary",

        discord_user_id: PRIMARY_ORGANISER_ID,

        display_name_snapshot: "Primary Organiser",

        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
      },
      {
        slot: "backup",

        discord_user_id: BACKUP_ORGANISER_ID,

        display_name_snapshot: "Backup Organiser",

        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
      },
    ]);

    const reminders = await pool.query<{
      timing_reference: string;

      minutes_before: number;

      message: string;

      channel_id: string;

      ping_event_roles: boolean;

      due_at: Date;
    }>(
      `
        SELECT
          r."timing_reference",
          r."minutes_before",
          r."message",
          r."channel_id",
          r."ping_event_roles",
          a."due_at"
        FROM "event_reminders" AS r
        INNER JOIN "scheduled_actions" AS a
          ON a."event_id" = r."event_id"
          AND a."action_key" = (
            'event_reminder:' || r."id"::text
          )
        WHERE r."event_id" = $1
        ORDER BY r."timing_reference"
      `,
      [result.event.id],
    );

    expect(reminders.rows).toEqual([
      {
        timing_reference: "event_start",

        minutes_before: 30,

        message: "Event starts in thirty minutes.",

        channel_id: DEFAULT_ATTENDANCE_CHANNEL_ID,

        ping_event_roles: true,

        due_at: subtractMinutes(startsAt, 30),
      },
      {
        timing_reference: "signup_close",

        minutes_before: 15,

        message: "Signups close in fifteen minutes.",

        channel_id: FIXED_REMINDER_CHANNEL_ID,

        ping_event_roles: false,

        due_at: subtractMinutes(expectedAttendanceClosesAt, 15),
      },
    ]);

    const presetSnapshot = await pool.query<{
      application_count: number;

      option_count: number;

      group_count: number;

      mapping_count: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM "event_role_request_preset_applications"
            WHERE "event_id" = $1
          ) AS "application_count",
          (
            SELECT COUNT(*)::int
            FROM "event_role_options"
            WHERE "event_id" = $1
          ) AS "option_count",
          (
            SELECT COUNT(*)::int
            FROM "role_request_groups"
            WHERE "event_id" = $1
          ) AS "group_count",
          (
            SELECT COUNT(*)::int
            FROM "role_request_group_options" AS mapping
            INNER JOIN "role_request_groups" AS request_group
              ON request_group."id" = mapping."group_id"
            WHERE request_group."event_id" = $1
          ) AS "mapping_count"
      `,
      [result.event.id],
    );

    expect(presetSnapshot.rows).toEqual([
      {
        application_count: 1,

        option_count: 1,

        group_count: 1,

        mapping_count: 1,
      },
    ]);

    const roleRequestGroup = await pool.query<{
      channel_id: string;
    }>(
      `
        SELECT "channel_id"
        FROM "role_request_groups"
        WHERE "event_id" = $1
      `,
      [result.event.id],
    );

    expect(roleRequestGroup.rows).toEqual([
      {
        channel_id: DEFAULT_ROLE_REQUEST_CHANNEL_ID,
      },
    ]);

    const scheduledActions = await pool.query<{
      action_key: string;

      due_at: Date;
    }>(
      `
        SELECT
          "action_key",
          "due_at"
        FROM "scheduled_actions"
        WHERE "event_id" = $1
        ORDER BY "action_key"
      `,
      [result.event.id],
    );

    expect(scheduledActions.rows).toHaveLength(7);

    expect(scheduledActions.rows).toEqual(
      expect.arrayContaining([
        {
          action_key: "publish_event",

          due_at: expectedPublicationAt,
        },
        {
          action_key: "close_attendance",

          due_at: expectedAttendanceClosesAt,
        },
        {
          action_key: "complete_event",

          due_at: expectedEndsAt,
        },
      ]),
    );

    expect(
      scheduledActions.rows.filter((action) =>
        action.action_key.startsWith("event_reminder:"),
      ),
    ).toHaveLength(2);

    expect(
      scheduledActions.rows.filter((action) =>
        action.action_key.startsWith("role_request_group_open:"),
      ),
    ).toHaveLength(1);

    expect(
      scheduledActions.rows.filter((action) =>
        action.action_key.startsWith("role_request_group_close:"),
      ),
    ).toHaveLength(1);
  });

  it("still generates the event without organiser assignments when organisers are disabled", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        organisersEnabled: false,

        withPreset: false,
      },
    );

    // Act
    const result = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result.kind).toBe("generated");

    if (result.kind !== "generated") {
      throw new Error(
        `Expected template generation to succeed, received "${result.kind}".`,
      );
    }

    const organiserCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_organiser_assignments"
        WHERE "event_id" = $1
      `,
      [result.event.id],
    );

    expect(organiserCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("rolls back all generated event state when preset application fails", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        presetActive: false,
      },
    );

    // Act
    const result = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_application_failed",

      result: {
        kind: "preset_inactive",
      },
    });

    const generatedState = await pool.query<{
      event_count: number;

      ping_role_count: number;

      organiser_count: number;

      reminder_count: number;

      preset_application_count: number;

      event_role_option_count: number;

      role_request_group_count: number;

      scheduled_action_count: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM "events"
          ) AS "event_count",
          (
            SELECT COUNT(*)::int
            FROM "event_ping_roles"
          ) AS "ping_role_count",
          (
            SELECT COUNT(*)::int
            FROM "event_organiser_assignments"
          ) AS "organiser_count",
          (
            SELECT COUNT(*)::int
            FROM "event_reminders"
          ) AS "reminder_count",
          (
            SELECT COUNT(*)::int
            FROM "event_role_request_preset_applications"
          ) AS "preset_application_count",
          (
            SELECT COUNT(*)::int
            FROM "event_role_options"
          ) AS "event_role_option_count",
          (
            SELECT COUNT(*)::int
            FROM "role_request_groups"
          ) AS "role_request_group_count",
          (
            SELECT COUNT(*)::int
            FROM "scheduled_actions"
          ) AS "scheduled_action_count"
      `,
    );

    expect(generatedState.rows).toEqual([
      {
        event_count: 0,

        ping_role_count: 0,

        organiser_count: 0,

        reminder_count: 0,

        preset_application_count: 0,

        event_role_option_count: 0,

        role_request_group_count: 0,

        scheduled_action_count: 0,
      },
    ]);
  });

  it("does not generate an event from an inactive template", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        templateActive: false,

        withPreset: false,
      },
    );

    // Act
    const result = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "template_inactive",
    });

    const eventCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "events"
      `,
    );

    expect(eventCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });
});

type FixtureOptions = {
  organisersEnabled?: boolean;

  presetActive?: boolean;

  templateActive?: boolean;

  withPreset?: boolean;
};

async function createTemplateFixture(
  pool: Pool,

  options: FixtureOptions = {},
): Promise<{
  guildId: number;

  eventTypeId: number;

  audienceId: number;

  presetId: number | null;

  templateId: number;
}> {
  const organisersEnabled = options.organisersEnabled ?? true;

  const presetActive = options.presetActive ?? true;

  const templateActive = options.templateActive ?? true;

  const withPreset = options.withPreset ?? true;

  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, 'Template Generation Test Guild')
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildId = requireReturnedId(
    guildResult.rows[0]?.id,

    "guild",
  );

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "organisers_enabled",
        "default_attendance_channel_id",
        "default_role_request_channel_id"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      guildId,

      organisersEnabled,

      DEFAULT_ATTENDANCE_CHANNEL_ID,

      DEFAULT_ROLE_REQUEST_CHANNEL_ID,
    ],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name",
        "role_requests_enabled",
        "active"
      )
      VALUES ($1, 'naval', 'Naval', true, true)
      RETURNING "id"
    `,
    [guildId],
  );

  const eventTypeId = requireReturnedId(
    eventTypeResult.rows[0]?.id,

    "event type",
  );

  const audienceResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_audiences" (
        "owner_guild_id",
        "code",
        "name",
        "default_timezone",
        "active"
      )
      VALUES (
        $1,
        'eu',
        'EU',
        'Europe/London',
        true
      )
      RETURNING "id"
    `,
    [guildId],
  );

  const audienceId = requireReturnedId(
    audienceResult.rows[0]?.id,

    "audience",
  );

  let presetId: number | null = null;

  if (withPreset) {
    const presetResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO "role_request_presets" (
          "owner_guild_id",
          "name",
          "active",
          "created_by_user_id"
        )
        VALUES ($1, 'Naval Roles', $2, $3)
        RETURNING "id"
      `,
      [guildId, presetActive, ADMIN_USER_ID],
    );

    presetId = requireReturnedId(
      presetResult.rows[0]?.id,

      "role-request preset",
    );

    const optionResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO "role_request_preset_options" (
          "preset_id",
          "key",
          "display_name",
          "request_restriction",
          "sort_order",
          "active"
        )
        VALUES (
          $1,
          'captain',
          'Captain',
          'open',
          0,
          true
        )
        RETURNING "id"
      `,
      [presetId],
    );

    const presetOptionId = requireReturnedId(
      optionResult.rows[0]?.id,

      "preset option",
    );

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO "role_request_preset_groups" (
          "preset_id",
          "name",
          "channel_id",
          "requires_positive_signup",
          "open_minutes_before_start",
          "close_minutes_before_start",
          "sort_order",
          "active"
        )
        VALUES (
          $1,
          'Command Roles',
          NULL,
          false,
          120,
          0,
          0,
          true
        )
        RETURNING "id"
      `,
      [presetId],
    );

    const presetGroupId = requireReturnedId(
      groupResult.rows[0]?.id,

      "preset group",
    );

    await pool.query(
      `
        INSERT INTO "role_request_preset_group_options" (
          "group_id",
          "preset_option_id",
          "sort_order"
        )
        VALUES ($1, $2, 0)
      `,
      [presetGroupId, presetOptionId],
    );
  }

  const templateResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_templates" (
        "owner_guild_id",
        "event_type_id",
        "audience_id",
        "role_request_preset_id",
        "name",
        "description",
        "timezone",
        "duration_minutes",
        "signups_enabled",
        "attendance_close_minutes_before",
        "show_detailed_deadline",
        "publication_mode",
        "publish_minutes_before_start",
        "publication_channel_id",
        "active",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'Sunday Naval',
        'Reusable naval event',
        'Europe/London',
        90,
        true,
        60,
        true,
        'scheduled',
        180,
        NULL,
        $5,
        $6
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, audienceId, presetId, templateActive, ADMIN_USER_ID],
  );

  const templateId = requireReturnedId(
    templateResult.rows[0]?.id,

    "event template",
  );

  await pool.query(
    `
      INSERT INTO "event_template_ping_roles" (
        "template_id",
        "discord_role_id",
        "role_name_snapshot",
        "sort_order"
      )
      VALUES
        ($1, $2, 'Naval', 10),
        ($1, $3, 'Events', 20)
    `,
    [templateId, PING_ROLE_ONE_ID, PING_ROLE_TWO_ID],
  );

  await pool.query(
    `
      INSERT INTO "event_template_organiser_defaults" (
        "template_id",
        "slot",
        "discord_user_id",
        "display_name_snapshot"
      )
      VALUES
        (
          $1,
          'primary',
          $2,
          'Primary Organiser'
        ),
        (
          $1,
          'backup',
          $3,
          'Backup Organiser'
        )
    `,
    [templateId, PRIMARY_ORGANISER_ID, BACKUP_ORGANISER_ID],
  );

  await pool.query(
    `
      INSERT INTO "event_template_reminders" (
        "template_id",
        "timing_reference",
        "minutes_before",
        "message",
        "channel_id",
        "ping_event_roles"
      )
      VALUES
        (
          $1,
          'event_start',
          30,
          'Event starts in thirty minutes.',
          NULL,
          true
        ),
        (
          $1,
          'signup_close',
          15,
          'Signups close in fifteen minutes.',
          $2,
          false
        )
    `,
    [templateId, FIXED_REMINDER_CHANNEL_ID],
  );

  return {
    guildId,

    eventTypeId,

    audienceId,

    presetId,

    templateId,
  };
}

function futureStart(): Date {
  return new Date(Date.now() + 6 * 60 * 60_000);
}

function addMinutes(
  date: Date,

  minutes: number,
): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function subtractMinutes(
  date: Date,

  minutes: number,
): Date {
  return new Date(date.getTime() - minutes * 60_000);
}

function requireReturnedId(
  value: number | undefined,

  description: string,
): number {
  if (value === undefined) {
    throw new Error(
      `Expected ${description} fixture creation to return an ID.`,
    );
  }

  return value;
}
