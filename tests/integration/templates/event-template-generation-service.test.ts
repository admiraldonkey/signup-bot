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

const FIXED_PUBLICATION_CHANNEL_ID = "989000000000000010";

const UPDATED_DEFAULT_ATTENDANCE_CHANNEL_ID = "989000000000000011";

const OTHER_DISCORD_GUILD_ID = "989000000000000099";

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

  it("distinguishes manual and immediate publication without scheduling publish actions inside generation", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        withPreset: false,
      },
    );

    const manualStartsAt = futureStart();

    await pool.query(
      `
        UPDATE "event_templates"
        SET
          "publication_mode" = 'manual',
          "publish_minutes_before_start" = NULL
        WHERE "id" = $1
      `,
      [fixture.templateId],
    );

    // Act: manual
    const manualResult = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: manualStartsAt,

      generatedByUserId: ADMIN_USER_ID,
    });

    // Assert: manual
    expect(manualResult.kind).toBe("generated");

    if (manualResult.kind !== "generated") {
      throw new Error(
        `Expected manual template generation to succeed, received "${manualResult.kind}".`,
      );
    }

    expect(manualResult.publicationMode).toBe("manual");

    expect(manualResult.requiresImmediatePublication).toBe(false);

    /*
     * Reuse the same template for an immediate occurrence.
     *
     * Immediate publication is deliberately a post-commit Discord side effect,
     * so authoritative generation itself must still create an unpublished
     * ordinary event without a publish_event scheduled action.
     */
    await pool.query(
      `
        UPDATE "event_templates"
        SET
          "publication_mode" = 'immediate',
          "publish_minutes_before_start" = NULL
        WHERE "id" = $1
      `,
      [fixture.templateId],
    );

    const immediateResult = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: addMinutes(manualStartsAt, 60),

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(immediateResult.kind).toBe("generated");

    if (immediateResult.kind !== "generated") {
      throw new Error(
        `Expected immediate template generation to succeed, received "${immediateResult.kind}".`,
      );
    }

    expect(immediateResult.publicationMode).toBe("immediate");

    expect(immediateResult.requiresImmediatePublication).toBe(true);

    const publicationState = await pool.query<{
      id: number;

      published_at: Date | null;

      publish_minutes_before_start: number | null;

      status: string;

      has_publish_action: boolean;
    }>(
      `
        SELECT
          event."id",
          event."published_at",
          event."publish_minutes_before_start",
          event."status",
          EXISTS (
            SELECT 1
            FROM "scheduled_actions" AS action
            WHERE
              action."event_id" = event."id"
              AND action."action_key" = 'publish_event'
          ) AS "has_publish_action"
        FROM "events" AS event
        WHERE event."id" IN ($1, $2)
      `,
      [manualResult.event.id, immediateResult.event.id],
    );

    expect(publicationState.rows).toHaveLength(2);

    expect(publicationState.rows).toEqual(
      expect.arrayContaining([
        {
          id: manualResult.event.id,

          published_at: null,

          publish_minutes_before_start: null,

          status: "scheduled",

          has_publish_action: false,
        },
        {
          id: immediateResult.event.id,

          published_at: null,

          publish_minutes_before_start: null,

          status: "scheduled",

          has_publish_action: false,
        },
      ]),
    );
  });

  it("prefers a fixed template publication channel over the current guild default and snapshots it into inherited reminders", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        withPreset: false,
      },
    );

    await pool.query(
      `
        UPDATE "guild_settings"
        SET "default_attendance_channel_id" = $1
        WHERE "guild_id" = $2
      `,
      [UPDATED_DEFAULT_ATTENDANCE_CHANNEL_ID, fixture.guildId],
    );

    await pool.query(
      `
        UPDATE "event_templates"
        SET "publication_channel_id" = $1
        WHERE "id" = $2
      `,
      [FIXED_PUBLICATION_CHANNEL_ID, fixture.templateId],
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

    const event = await pool.query<{
      publication_channel_id: string | null;
    }>(
      `
        SELECT "publication_channel_id"
        FROM "events"
        WHERE "id" = $1
      `,
      [result.event.id],
    );

    expect(event.rows).toEqual([
      {
        publication_channel_id: FIXED_PUBLICATION_CHANNEL_ID,
      },
    ]);

    const reminders = await pool.query<{
      timing_reference: string;

      channel_id: string;
    }>(
      `
        SELECT
          "timing_reference",
          "channel_id"
        FROM "event_reminders"
        WHERE "event_id" = $1
        ORDER BY "timing_reference"
      `,
      [result.event.id],
    );

    expect(reminders.rows).toEqual([
      {
        timing_reference: "event_start",

        channel_id: FIXED_PUBLICATION_CHANNEL_ID,
      },
      {
        timing_reference: "signup_close",

        channel_id: FIXED_REMINDER_CHANNEL_ID,
      },
    ]);
  });

  it("treats a template belonging to another guild as not found", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        withPreset: false,
      },
    );

    const secondary = await createSecondarySourceRecords(pool);

    // Act
    const result = await generateEventFromTemplate({
      guildDatabaseId: secondary.guildId,

      templateId: fixture.templateId,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "template_not_found",
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

  it("rejects inactive or cross-guild event-type and audience source records", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        withPreset: false,
      },
    );

    const secondary = await createSecondarySourceRecords(pool);

    const startsAt = futureStart();

    // Act / Assert: inactive event type
    await pool.query(
      `
        UPDATE "event_types"
        SET "active" = false
        WHERE "id" = $1
      `,
      [fixture.eventTypeId],
    );

    expect(
      await generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        startsAt,

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "event_type_unavailable",
    });

    await pool.query(
      `
        UPDATE "event_types"
        SET "active" = true
        WHERE "id" = $1
      `,
      [fixture.eventTypeId],
    );

    // Act / Assert: event type owned by another guild
    await pool.query(
      `
        UPDATE "event_templates"
        SET "event_type_id" = $1
        WHERE "id" = $2
      `,
      [secondary.eventTypeId, fixture.templateId],
    );

    expect(
      await generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        startsAt,

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "event_type_unavailable",
    });

    await pool.query(
      `
        UPDATE "event_templates"
        SET "event_type_id" = $1
        WHERE "id" = $2
      `,
      [fixture.eventTypeId, fixture.templateId],
    );

    // Act / Assert: inactive audience
    await pool.query(
      `
        UPDATE "event_audiences"
        SET "active" = false
        WHERE "id" = $1
      `,
      [fixture.audienceId],
    );

    expect(
      await generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        startsAt,

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "audience_unavailable",
    });

    await pool.query(
      `
        UPDATE "event_audiences"
        SET "active" = true
        WHERE "id" = $1
      `,
      [fixture.audienceId],
    );

    // Act / Assert: audience owned by another guild
    await pool.query(
      `
        UPDATE "event_templates"
        SET "audience_id" = $1
        WHERE "id" = $2
      `,
      [secondary.audienceId, fixture.templateId],
    );

    expect(
      await generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        startsAt,

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "audience_unavailable",
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

  it("keeps generated event state independent from later template, preset and guild-default edits", async () => {
    // Arrange
    const fixture = await createTemplateFixture(pool);

    if (fixture.presetId === null) {
      throw new Error(
        "Expected the snapshot-independence fixture to include a preset.",
      );
    }

    const result = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(result.kind).toBe("generated");

    if (result.kind !== "generated") {
      throw new Error(
        `Expected template generation to succeed, received "${result.kind}".`,
      );
    }

    // Act: mutate every reusable source represented in the assertions below.
    await pool.query(
      `
        UPDATE "event_templates"
        SET
          "name" = 'Edited Template Name',
          "description" = 'Edited template description',
          "publication_channel_id" = $1
        WHERE "id" = $2
      `,
      [FIXED_PUBLICATION_CHANNEL_ID, fixture.templateId],
    );

    await pool.query(
      `
        UPDATE "event_template_ping_roles"
        SET "role_name_snapshot" = 'Edited Naval Role'
        WHERE
          "template_id" = $1
          AND "discord_role_id" = $2
      `,
      [fixture.templateId, PING_ROLE_ONE_ID],
    );

    await pool.query(
      `
        UPDATE "event_template_organiser_defaults"
        SET "display_name_snapshot" = 'Edited Primary Organiser'
        WHERE
          "template_id" = $1
          AND "slot" = 'primary'
      `,
      [fixture.templateId],
    );

    await pool.query(
      `
        UPDATE "event_template_reminders"
        SET "message" = 'Edited reminder message.'
        WHERE
          "template_id" = $1
          AND "timing_reference" = 'event_start'
      `,
      [fixture.templateId],
    );

    await pool.query(
      `
        UPDATE "role_request_preset_options"
        SET "display_name" = 'Edited Captain'
        WHERE
          "preset_id" = $1
          AND "key" = 'captain'
      `,
      [fixture.presetId],
    );

    await pool.query(
      `
        UPDATE "guild_settings"
        SET "default_attendance_channel_id" = $1
        WHERE "guild_id" = $2
      `,
      [UPDATED_DEFAULT_ATTENDANCE_CHANNEL_ID, fixture.guildId],
    );

    /*
     * First prove the reusable sources really changed. Without this check the
     * snapshot assertion could pass merely because an UPDATE matched nothing.
     */
    const editedSource = await pool.query<{
      template_name: string;

      ping_role_name: string;

      organiser_name: string;

      reminder_message: string;

      preset_option_name: string;

      default_attendance_channel_id: string;
    }>(
      `
        SELECT
          (
            SELECT "name"
            FROM "event_templates"
            WHERE "id" = $1
          ) AS "template_name",
          (
            SELECT "role_name_snapshot"
            FROM "event_template_ping_roles"
            WHERE
              "template_id" = $1
              AND "discord_role_id" = $2
          ) AS "ping_role_name",
          (
            SELECT "display_name_snapshot"
            FROM "event_template_organiser_defaults"
            WHERE
              "template_id" = $1
              AND "slot" = 'primary'
          ) AS "organiser_name",
          (
            SELECT "message"
            FROM "event_template_reminders"
            WHERE
              "template_id" = $1
              AND "timing_reference" = 'event_start'
          ) AS "reminder_message",
          (
            SELECT "display_name"
            FROM "role_request_preset_options"
            WHERE
              "preset_id" = $3
              AND "key" = 'captain'
          ) AS "preset_option_name",
          (
            SELECT "default_attendance_channel_id"
            FROM "guild_settings"
            WHERE "guild_id" = $4
          ) AS "default_attendance_channel_id"
      `,
      [fixture.templateId, PING_ROLE_ONE_ID, fixture.presetId, fixture.guildId],
    );

    expect(editedSource.rows).toEqual([
      {
        template_name: "Edited Template Name",

        ping_role_name: "Edited Naval Role",

        organiser_name: "Edited Primary Organiser",

        reminder_message: "Edited reminder message.",

        preset_option_name: "Edited Captain",

        default_attendance_channel_id: UPDATED_DEFAULT_ATTENDANCE_CHANNEL_ID,
      },
    ]);

    // Assert: the generated event retains its original snapshots.
    const generatedSnapshot = await pool.query<{
      event_name: string;

      event_description: string | null;

      publication_channel_id: string | null;

      ping_role_name: string;

      organiser_name: string;

      reminder_message: string;

      reminder_channel_id: string;

      role_option_name: string;
    }>(
      `
        SELECT
          event."name" AS "event_name",
          event."description" AS "event_description",
          event."publication_channel_id",
          (
            SELECT ping_role."role_name"
            FROM "event_ping_roles" AS ping_role
            WHERE
              ping_role."event_id" = event."id"
              AND ping_role."discord_role_id" = $2
          ) AS "ping_role_name",
          (
            SELECT organiser."display_name_snapshot"
            FROM "event_organiser_assignments" AS organiser
            WHERE
              organiser."event_id" = event."id"
              AND organiser."slot" = 'primary'
          ) AS "organiser_name",
          (
            SELECT reminder."message"
            FROM "event_reminders" AS reminder
            WHERE
              reminder."event_id" = event."id"
              AND reminder."timing_reference" = 'event_start'
          ) AS "reminder_message",
          (
            SELECT reminder."channel_id"
            FROM "event_reminders" AS reminder
            WHERE
              reminder."event_id" = event."id"
              AND reminder."timing_reference" = 'event_start'
          ) AS "reminder_channel_id",
          (
            SELECT role_option."display_name"
            FROM "event_role_options" AS role_option
            WHERE
              role_option."event_id" = event."id"
              AND role_option."key" = 'captain'
          ) AS "role_option_name"
        FROM "events" AS event
        WHERE event."id" = $1
      `,
      [result.event.id, PING_ROLE_ONE_ID],
    );

    expect(generatedSnapshot.rows).toEqual([
      {
        event_name: "Sunday Naval",

        event_description: "Reusable naval event",

        publication_channel_id: DEFAULT_ATTENDANCE_CHANNEL_ID,

        ping_role_name: "Naval",

        organiser_name: "Primary Organiser",

        reminder_message: "Event starts in thirty minutes.",

        reminder_channel_id: DEFAULT_ATTENDANCE_CHANNEL_ID,

        role_option_name: "Captain",
      },
    ]);
  });

  it("holds the template source lock until generation commits so a parent-locked edit cannot interleave with the snapshot", async () => {
    // Arrange
    const fixture = await createTemplateFixture(
      pool,

      {
        withPreset: false,
      },
    );

    const blockerClient = await pool.connect();

    const editorClient = await pool.connect();

    let blockerTransactionOpen = false;

    let editorTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let editorLockPromise: Promise<unknown> | null = null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

      /*
       * Generation reads event_types only after taking FOR SHARE on the
       * template parent.
       *
       * ACCESS EXCLUSIVE therefore pauses generation at a deterministic point
       * while that template parent lock remains held.
       */
      await blockerClient.query(`
        LOCK TABLE "event_types"
        IN ACCESS EXCLUSIVE MODE
      `);

      generationPromise = generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        startsAt: futureStart(),

        generatedByUserId: ADMIN_USER_ID,
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_types"%',
      );

      await editorClient.query("BEGIN");

      editorTransactionOpen = true;

      let editorLockResolved = false;

      /*
       * Future template mutation services must take FOR UPDATE on this parent
       * before mutating either parent metadata or child source collections.
       */
      editorLockPromise = editorClient
        .query(
          `
            SELECT "id"
            FROM "event_templates"
            WHERE "id" = $1
            FOR UPDATE
          `,
          [fixture.templateId],
        )
        .then((result) => {
          editorLockResolved = true;

          return result;
        });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_templates"%for update%',
      );

      expect(editorLockResolved).toBe(false);

      /*
       * Allow generation to continue. It must complete the old source snapshot
       * and commit before the editor can obtain FOR UPDATE.
       */
      await blockerClient.query("COMMIT");

      blockerTransactionOpen = false;

      const generationResult = await generationPromise;

      expect(generationResult.kind).toBe("generated");

      if (generationResult.kind !== "generated") {
        throw new Error(
          `Expected template generation to succeed, received "${generationResult.kind}".`,
        );
      }

      await editorLockPromise;

      expect(editorLockResolved).toBe(true);

      await editorClient.query(
        `
          UPDATE "event_templates"
          SET "name" = 'Edited After Generation'
          WHERE "id" = $1
        `,
        [fixture.templateId],
      );

      await editorClient.query(
        `
          UPDATE "event_template_ping_roles"
          SET "role_name_snapshot" = 'Edited After Generation'
          WHERE
            "template_id" = $1
            AND "discord_role_id" = $2
        `,
        [fixture.templateId, PING_ROLE_ONE_ID],
      );

      await editorClient.query("COMMIT");

      editorTransactionOpen = false;

      const generatedSnapshot = await pool.query<{
        event_name: string;

        ping_role_name: string;
      }>(
        `
          SELECT
            event."name" AS "event_name",
            ping_role."role_name" AS "ping_role_name"
          FROM "events" AS event
          INNER JOIN "event_ping_roles" AS ping_role
            ON ping_role."event_id" = event."id"
          WHERE
            event."id" = $1
            AND ping_role."discord_role_id" = $2
        `,
        [generationResult.event.id, PING_ROLE_ONE_ID],
      );

      expect(generatedSnapshot.rows).toEqual([
        {
          event_name: "Sunday Naval",

          ping_role_name: "Naval",
        },
      ]);

      const editedSource = await pool.query<{
        template_name: string;

        ping_role_name: string;
      }>(
        `
          SELECT
            template."name" AS "template_name",
            ping_role."role_name_snapshot" AS "ping_role_name"
          FROM "event_templates" AS template
          INNER JOIN "event_template_ping_roles" AS ping_role
            ON ping_role."template_id" = template."id"
          WHERE
            template."id" = $1
            AND ping_role."discord_role_id" = $2
        `,
        [fixture.templateId, PING_ROLE_ONE_ID],
      );

      expect(editedSource.rows).toEqual([
        {
          template_name: "Edited After Generation",

          ping_role_name: "Edited After Generation",
        },
      ]);
    } finally {
      /*
       * Always release the artificial table blocker first. Otherwise a failed
       * assertion could leave generation waiting while the test itself waits
       * for generation to settle.
       */
      if (blockerTransactionOpen) {
        await blockerClient.query("ROLLBACK").catch(() => undefined);

        blockerTransactionOpen = false;
      }

      if (generationPromise) {
        await Promise.allSettled([generationPromise]);
      }

      if (editorLockPromise) {
        await Promise.allSettled([editorLockPromise]);
      }

      if (editorTransactionOpen) {
        await editorClient.query("ROLLBACK").catch(() => undefined);
      }

      blockerClient.release();

      editorClient.release();
    }
  });

  it("rejects generation when the inspected template revision changed before the source lock", async () => {
    // Arrange
    const fixture = await createTemplateFixture(pool);

    const originalRevision = await pool.query<{
      updated_at: Date;
    }>(
      `
            SELECT
              "updated_at"
            FROM "event_templates"
            WHERE "id" = $1
          `,
      [fixture.templateId],
    );

    const inspectedUpdatedAt = originalRevision.rows[0]?.updated_at;

    if (!inspectedUpdatedAt) {
      throw new Error("Expected template fixture to expose its revision.");
    }

    /*
     * Deterministically move the source revision rather than relying on
     * wall-clock timing between two writes.
     */
    await pool.query(
      `
          UPDATE "event_templates"
          SET
            "name" = 'Changed Template',
            "updated_at" =
              "updated_at" +
              INTERVAL '1 second'
          WHERE "id" = $1
        `,
      [fixture.templateId],
    );

    // Act
    const result = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,

      expectedTemplateUpdatedAt: inspectedUpdatedAt,
    });

    // Assert
    expect(result).toEqual({
      kind: "template_changed",
    });

    const generatedEvents = await pool.query<{
      count: number;
    }>(
      `
            SELECT
              COUNT(*)::int AS "count"
            FROM "events"
            WHERE "template_id" = $1
          `,
      [fixture.templateId],
    );

    expect(generatedEvents.rows).toEqual([
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

async function createSecondarySourceRecords(pool: Pool): Promise<{
  guildId: number;

  eventTypeId: number;

  audienceId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, 'Other Template Test Guild')
      RETURNING "id"
    `,
    [OTHER_DISCORD_GUILD_ID],
  );

  const guildId = requireReturnedId(
    guildResult.rows[0]?.id,

    "secondary guild",
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
      VALUES (
        $1,
        'foreign_naval',
        'Foreign Naval',
        true,
        true
      )
      RETURNING "id"
    `,
    [guildId],
  );

  const eventTypeId = requireReturnedId(
    eventTypeResult.rows[0]?.id,

    "secondary event type",
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
        'foreign_eu',
        'Foreign EU',
        'Europe/London',
        true
      )
      RETURNING "id"
    `,
    [guildId],
  );

  const audienceId = requireReturnedId(
    audienceResult.rows[0]?.id,

    "secondary audience",
  );

  return {
    guildId,

    eventTypeId,

    audienceId,
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

async function waitForBlockedDatabaseQuery(
  pool: Pool,

  queryPattern: string,
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM "pg_stat_activity"
          WHERE
            "datname" = current_database()
            AND "state" = 'active'
            AND "wait_event_type" = 'Lock'
            AND "query" ILIKE $1
        ) AS "blocked"
      `,
      [queryPattern],
    );

    if (result.rows[0]?.blocked) {
      return;
    }

    /*
     * Poll only to observe PostgreSQL's real lock state.
     *
     * Test correctness is not based on this delay.
     */
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for blocked PostgreSQL query matching ${queryPattern}.`,
  );
}
