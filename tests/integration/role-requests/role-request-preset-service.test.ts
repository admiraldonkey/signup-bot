import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import { applyRoleRequestPresetToEvent } from "../../../src/role-requests/role-request-preset-service.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "983000000000000001";

const ADMIN_USER_ID = "983000000000000002";

const DEFAULT_ROLE_REQUEST_CHANNEL_ID = "983000000000000003";

const COMMAND_CHANNEL_ID = "983000000000000004";

const NOTIFY_ROLE_ID = "983000000000000005";

const CAPTAIN_QUALIFIED_ROLE_ID = "983000000000000006";

const MIDSHIPMAN_ROLE_ID = "983000000000000007";

const EVENT_START = new Date("2026-09-21T19:00:00.000Z");

type Fixture = {
  guildId: number;

  eventTypeId: number;

  eventId: number;

  presetId: number;

  captainPresetOptionId: number;

  carpenterPresetOptionId: number;

  commandPresetGroupId: number;

  generalPresetGroupId: number;
};

describe("role-request preset application service", () => {
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

  it("atomically snapshots an active preset into independent event-level role-request state", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result.kind).toBe("applied");

    if (result.kind !== "applied") {
      throw new Error(
        `Expected preset application to succeed, received "${result.kind}".`,
      );
    }

    expect(result.eventId).toBe(fixture.eventId);

    expect(result.presetId).toBe(fixture.presetId);

    expect(result.eventRoleOptionIds).toHaveLength(2);

    expect(result.roleRequestGroupIds).toHaveLength(2);

    const options = await pool.query<{
      id: number;

      source_role_request_preset_option_id: number | null;

      key: string;

      display_name: string;

      description: string | null;

      request_restriction: string;

      capacity: number | null;

      sort_order: number;

      active: boolean;
    }>(
      `
        SELECT
          "id",
          "source_role_request_preset_option_id",
          "key",
          "display_name",
          "description",
          "request_restriction",
          "capacity",
          "sort_order",
          "active"
        FROM
          "event_role_options"
        WHERE
          "event_id" = $1
        ORDER BY
          "sort_order",
          "id"
      `,
      [fixture.eventId],
    );

    expect(options.rows).toEqual([
      {
        id: expect.any(Number),

        source_role_request_preset_option_id: fixture.captainPresetOptionId,

        key: "captain",

        display_name: "Captain",

        description: "Command the ship.",

        request_restriction: "qualified_only",

        capacity: 1,

        sort_order: 0,

        active: true,
      },

      {
        id: expect.any(Number),

        source_role_request_preset_option_id: fixture.carpenterPresetOptionId,

        key: "carpenter",

        display_name: "Carpenter",

        description: "Repair the ship.",

        request_restriction: "open",

        capacity: null,

        sort_order: 1,

        active: true,
      },
    ]);

    expect(new Set(result.eventRoleOptionIds)).toEqual(
      new Set(options.rows.map((row) => row.id)),
    );

    const qualificationRoles = await pool.query<{
      preset_option_id: number | null;

      discord_role_id: string;

      role_name_snapshot: string;

      qualification_level: string;
    }>(
      `
        SELECT
          "event_role_options"."source_role_request_preset_option_id"
            AS "preset_option_id",
          "event_role_option_qualification_roles"."discord_role_id",
          "event_role_option_qualification_roles"."role_name_snapshot",
          "event_role_option_qualification_roles"."qualification_level"
        FROM
          "event_role_option_qualification_roles"
        INNER JOIN
          "event_role_options"
        ON
          "event_role_options"."id" =
            "event_role_option_qualification_roles"."event_role_option_id"
        WHERE
          "event_role_options"."event_id" = $1
        ORDER BY
          "event_role_option_qualification_roles"."discord_role_id"
      `,
      [fixture.eventId],
    );

    expect(qualificationRoles.rows).toEqual([
      {
        preset_option_id: fixture.captainPresetOptionId,

        discord_role_id: CAPTAIN_QUALIFIED_ROLE_ID,

        role_name_snapshot: "Qualified Captain",

        qualification_level: "qualified",
      },

      {
        preset_option_id: fixture.captainPresetOptionId,

        discord_role_id: MIDSHIPMAN_ROLE_ID,

        role_name_snapshot: "Midshipman",

        qualification_level: "supervision_required",
      },
    ]);

    const groups = await pool.query<{
      id: number;

      source_role_request_preset_group_id: number | null;

      name: string;

      description: string | null;

      channel_id: string;

      message_id: string | null;

      notify_role_id: string | null;

      notify_role_name_snapshot: string | null;

      requires_positive_signup: boolean;

      open_minutes_before_start: number | null;

      opens_at: Date;

      close_minutes_before_start: number;

      closes_at: Date;

      closed_at: Date | null;

      created_by_user_id: string;
    }>(
      `
        SELECT
          "id",
          "source_role_request_preset_group_id",
          "name",
          "description",
          "channel_id",
          "message_id",
          "notify_role_id",
          "notify_role_name_snapshot",
          "requires_positive_signup",
          "open_minutes_before_start",
          "opens_at",
          "close_minutes_before_start",
          "closes_at",
          "closed_at",
          "created_by_user_id"
        FROM
          "role_request_groups"
        WHERE
          "event_id" = $1
        ORDER BY
          "id"
      `,
      [fixture.eventId],
    );

    expect(groups.rows).toHaveLength(2);

    expect(new Set(result.roleRequestGroupIds)).toEqual(
      new Set(groups.rows.map((row) => row.id)),
    );

    const commandGroup = groups.rows.find(
      (row) =>
        row.source_role_request_preset_group_id ===
        fixture.commandPresetGroupId,
    );

    expect(commandGroup).toEqual({
      id: expect.any(Number),

      source_role_request_preset_group_id: fixture.commandPresetGroupId,

      name: "Command Roles",

      description: "Early command applications.",

      channel_id: COMMAND_CHANNEL_ID,

      message_id: null,

      notify_role_id: null,

      notify_role_name_snapshot: null,

      requires_positive_signup: false,

      open_minutes_before_start: 180,

      opens_at: new Date(EVENT_START.getTime() - 180 * 60_000),

      close_minutes_before_start: 60,

      closes_at: new Date(EVENT_START.getTime() - 60 * 60_000),

      closed_at: null,

      created_by_user_id: ADMIN_USER_ID,
    });

    const generalGroup = groups.rows.find(
      (row) =>
        row.source_role_request_preset_group_id ===
        fixture.generalPresetGroupId,
    );

    expect(generalGroup).toEqual({
      id: expect.any(Number),

      source_role_request_preset_group_id: fixture.generalPresetGroupId,

      name: "Naval Roles",

      description: "General naval role requests.",

      /*
       * The preset deliberately stored NULL, so application must resolve
       * the guild's current default and then snapshot the resolved ID.
       */
      channel_id: DEFAULT_ROLE_REQUEST_CHANNEL_ID,

      message_id: null,

      notify_role_id: NOTIFY_ROLE_ID,

      notify_role_name_snapshot: "Naval",

      requires_positive_signup: true,

      open_minutes_before_start: 60,

      opens_at: new Date(EVENT_START.getTime() - 60 * 60_000),

      close_minutes_before_start: -10,

      closes_at: new Date(EVENT_START.getTime() + 10 * 60_000),

      closed_at: null,

      created_by_user_id: ADMIN_USER_ID,
    });

    const groupMappings = await pool.query<{
      preset_group_id: number | null;

      preset_option_id: number | null;

      sort_order: number;
    }>(
      `
        SELECT
          "role_request_groups"."source_role_request_preset_group_id"
            AS "preset_group_id",
          "event_role_options"."source_role_request_preset_option_id"
            AS "preset_option_id",
          "role_request_group_options"."sort_order"
        FROM
          "role_request_group_options"
        INNER JOIN
          "role_request_groups"
        ON
          "role_request_groups"."id" =
            "role_request_group_options"."group_id"
        INNER JOIN
          "event_role_options"
        ON
          "event_role_options"."id" =
            "role_request_group_options"."event_role_option_id"
        WHERE
          "role_request_groups"."event_id" = $1
      `,
      [fixture.eventId],
    );

    expect(groupMappings.rows).toHaveLength(3);

    expect(groupMappings.rows).toEqual(
      expect.arrayContaining([
        {
          preset_group_id: fixture.commandPresetGroupId,

          preset_option_id: fixture.captainPresetOptionId,

          sort_order: 0,
        },

        {
          preset_group_id: fixture.generalPresetGroupId,

          preset_option_id: fixture.captainPresetOptionId,

          sort_order: 0,
        },

        {
          preset_group_id: fixture.generalPresetGroupId,

          preset_option_id: fixture.carpenterPresetOptionId,

          sort_order: 1,
        },
      ]),
    );

    const application = await pool.query<{
      event_id: number;

      preset_id: number;

      applied_by_user_id: string;

      applied_at: Date;
    }>(
      `
        SELECT
          "event_id",
          "preset_id",
          "applied_by_user_id",
          "applied_at"
        FROM
          "event_role_request_preset_applications"
        WHERE
          "event_id" = $1
          AND
          "preset_id" = $2
      `,
      [fixture.eventId, fixture.presetId],
    );

    expect(application.rows).toHaveLength(1);

    expect(application.rows[0]).toMatchObject({
      event_id: fixture.eventId,

      preset_id: fixture.presetId,

      applied_by_user_id: ADMIN_USER_ID,

      applied_at: expect.any(Date),
    });

    if (!commandGroup || !generalGroup) {
      throw new Error(
        "Expected both preset-derived role-request groups to exist.",
      );
    }

    /*
     * Planned preset groups must receive their durable open and close work
     * in the same authoritative application transaction.
     *
     * This ensures a process interruption after preset application cannot
     * leave a perfectly valid planned group which the scheduler knows
     * nothing about.
     */
    const scheduledActions = await pool.query<{
      action_key: string;

      due_at: Date;

      status: string;

      attempt_count: number;

      locked_at: Date | null;

      completed_at: Date | null;

      last_error: string | null;
    }>(
      `
        SELECT
          "action_key",
          "due_at",
          "status",
          "attempt_count",
          "locked_at",
          "completed_at",
          "last_error"
        FROM
          "scheduled_actions"
        WHERE
          "event_id" = $1
          AND
          "action_key" IN (
            $2,
            $3,
            $4,
            $5
          )
      `,
      [
        fixture.eventId,

        `role_request_group_open:${commandGroup.id}`,

        `role_request_group_close:${commandGroup.id}`,

        `role_request_group_open:${generalGroup.id}`,

        `role_request_group_close:${generalGroup.id}`,
      ],
    );

    expect(scheduledActions.rows).toHaveLength(4);

    expect(scheduledActions.rows).toEqual(
      expect.arrayContaining([
        {
          action_key: `role_request_group_open:${commandGroup.id}`,

          due_at: new Date(EVENT_START.getTime() - 180 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        {
          action_key: `role_request_group_close:${commandGroup.id}`,

          due_at: new Date(EVENT_START.getTime() - 60 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        {
          action_key: `role_request_group_open:${generalGroup.id}`,

          due_at: new Date(EVENT_START.getTime() - 60 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        {
          action_key: `role_request_group_close:${generalGroup.id}`,

          due_at: new Date(EVENT_START.getTime() + 10 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },
      ]),
    );
  });

  it("keeps applied event state independent from later preset edits", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    expect(result.kind).toBe("applied");

    if (result.kind !== "applied") {
      throw new Error(
        `Expected preset application to succeed, received "${result.kind}".`,
      );
    }

    // Act
    await pool.query(
      `
        UPDATE
          "role_request_preset_options"
        SET
          "display_name" = 'Changed Captain',
          "request_restriction" = 'open',
          "capacity" = 99
        WHERE
          "id" = $1
      `,
      [fixture.captainPresetOptionId],
    );

    await pool.query(
      `
        UPDATE
          "role_request_preset_option_qualification_roles"
        SET
          "role_name_snapshot" = 'Changed Qualification'
        WHERE
          "preset_option_id" = $1
      `,
      [fixture.captainPresetOptionId],
    );

    await pool.query(
      `
        UPDATE
          "role_request_preset_groups"
        SET
          "channel_id" = '983000000000000099',
          "notify_role_id" = NULL,
          "notify_role_name_snapshot" = NULL,
          "requires_positive_signup" = false,
          "open_minutes_before_start" = 5,
          "close_minutes_before_start" = -30
        WHERE
          "id" = $1
      `,
      [fixture.generalPresetGroupId],
    );

    await pool.query(
      `
        DELETE FROM
          "role_request_preset_group_options"
        WHERE
          "group_id" = $1
          AND
          "preset_option_id" = $2
      `,
      [fixture.generalPresetGroupId, fixture.carpenterPresetOptionId],
    );

    // Assert
    const captain = await pool.query<{
      display_name: string;

      request_restriction: string;

      capacity: number | null;
    }>(
      `
        SELECT
          "display_name",
          "request_restriction",
          "capacity"
        FROM
          "event_role_options"
        WHERE
          "event_id" = $1
          AND
          "source_role_request_preset_option_id" = $2
      `,
      [fixture.eventId, fixture.captainPresetOptionId],
    );

    expect(captain.rows).toEqual([
      {
        display_name: "Captain",

        request_restriction: "qualified_only",

        capacity: 1,
      },
    ]);

    const qualifications = await pool.query<{
      role_name_snapshot: string;
    }>(
      `
        SELECT
          "event_role_option_qualification_roles"."role_name_snapshot"
        FROM
          "event_role_option_qualification_roles"
        INNER JOIN
          "event_role_options"
        ON
          "event_role_options"."id" =
            "event_role_option_qualification_roles"."event_role_option_id"
        WHERE
          "event_role_options"."event_id" = $1
          AND
          "event_role_options"."source_role_request_preset_option_id" = $2
        ORDER BY
          "event_role_option_qualification_roles"."discord_role_id"
      `,
      [fixture.eventId, fixture.captainPresetOptionId],
    );

    expect(qualifications.rows).toEqual([
      {
        role_name_snapshot: "Qualified Captain",
      },

      {
        role_name_snapshot: "Midshipman",
      },
    ]);

    const generalGroup = await pool.query<{
      channel_id: string;

      notify_role_id: string | null;

      notify_role_name_snapshot: string | null;

      requires_positive_signup: boolean;

      open_minutes_before_start: number | null;

      close_minutes_before_start: number;
    }>(
      `
        SELECT
          "channel_id",
          "notify_role_id",
          "notify_role_name_snapshot",
          "requires_positive_signup",
          "open_minutes_before_start",
          "close_minutes_before_start"
        FROM
          "role_request_groups"
        WHERE
          "event_id" = $1
          AND
          "source_role_request_preset_group_id" = $2
      `,
      [fixture.eventId, fixture.generalPresetGroupId],
    );

    expect(generalGroup.rows).toEqual([
      {
        channel_id: DEFAULT_ROLE_REQUEST_CHANNEL_ID,

        notify_role_id: NOTIFY_ROLE_ID,

        notify_role_name_snapshot: "Naval",

        requires_positive_signup: true,

        open_minutes_before_start: 60,

        close_minutes_before_start: -10,
      },
    ]);

    const copiedGeneralMappings = await pool.query<{
      count: number;
    }>(
      `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "role_request_group_options"
        INNER JOIN
          "role_request_groups"
        ON
          "role_request_groups"."id" =
            "role_request_group_options"."group_id"
        WHERE
          "role_request_groups"."event_id" = $1
          AND
          "role_request_groups"."source_role_request_preset_group_id" = $2
      `,
      [fixture.eventId, fixture.generalPresetGroupId],
    );

    expect(copiedGeneralMappings.rows).toEqual([
      {
        count: 2,
      },
    ]);
  });

  it("rejects duplicate application without creating duplicate event state", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    const firstResult = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    expect(firstResult.kind).toBe("applied");

    const before = await readPresetSnapshotCounts(pool, fixture.eventId);

    // Act
    const secondResult = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(secondResult).toEqual({
      kind: "already_applied",
    });

    const after = await readPresetSnapshotCounts(pool, fixture.eventId);

    expect(after).toEqual(before);

    expect(after).toEqual({
      applications: 1,

      presetOptions: 2,

      qualificationRoles: 2,

      presetGroups: 2,

      groupOptions: 3,

      scheduledActions: 4,
    });
  });

  it("rejects a preset owned by another guild", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    const otherGuildId = await createOtherGuild(pool);

    await pool.query(
      `
        UPDATE
          "role_request_presets"
        SET
          "owner_guild_id" = $1
        WHERE
          "id" = $2
      `,
      [otherGuildId, fixture.presetId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_not_found",
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects an inactive preset", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        UPDATE
          "role_request_presets"
        SET
          "active" = false
        WHERE
          "id" = $1
      `,
      [fixture.presetId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_inactive",
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects application to a cancelled event", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        UPDATE
          "events"
        SET
          "status" = 'cancelled'
        WHERE
          "id" = $1
      `,
      [fixture.eventId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "event_terminal",

      status: "cancelled",
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects application when role requests are disabled for the event type", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        UPDATE
          "event_types"
        SET
          "role_requests_enabled" = false
        WHERE
          "id" = $1
      `,
      [fixture.eventTypeId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "role_requests_disabled",
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects the whole application when a group requires signup but the event has signups disabled", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        UPDATE
          "events"
        SET
          "signups_enabled" = false
        WHERE
          "id" = $1
      `,
      [fixture.eventId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "signup_required",

      presetGroupId: fixture.generalPresetGroupId,
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects the whole application when a group needs the guild default channel but none is configured", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        UPDATE
          "guild_settings"
        SET
          "default_role_request_channel_id" = NULL
        WHERE
          "guild_id" = $1
      `,
      [fixture.guildId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "missing_default_channel",

      presetGroupId: fixture.generalPresetGroupId,
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects the whole application when a group does not open before it closes", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        UPDATE
          "role_request_preset_groups"
        SET
          "open_minutes_before_start" = 0,
          "close_minutes_before_start" = 60
        WHERE
          "id" = $1
      `,
      [fixture.generalPresetGroupId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_preset",

      reason: "invalid_group_window",

      presetGroupId: fixture.generalPresetGroupId,
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects the whole application when an event role-option key already conflicts", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        INSERT INTO
          "event_role_options" (
            "event_id",
            "key",
            "display_name",
            "description",
            "request_restriction",
            "capacity",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'captain',
          'Existing Captain',
          NULL,
          'open',
          NULL,
          0,
          true
        )
      `,
      [fixture.eventId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "role_option_conflict",

      key: "captain",
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });

  it("rejects a qualified-only preset option with no qualification roles", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
        DELETE FROM
          "role_request_preset_option_qualification_roles"
        WHERE
          "preset_option_id" = $1
      `,
      [fixture.captainPresetOptionId],
    );

    // Act
    const result = await applyRoleRequestPresetToEvent({
      guildDatabaseId: fixture.guildId,

      eventId: fixture.eventId,

      presetId: fixture.presetId,

      appliedByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_preset",

      reason: "missing_qualification_roles",

      presetOptionId: fixture.captainPresetOptionId,
    });

    await assertNoPresetSnapshot(pool, fixture.eventId);
  });
});

async function createFixture(pool: Pool): Promise<Fixture> {
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
    [DISCORD_GUILD_ID, "Role Request Preset Service Test Guild"],
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
          "default_role_request_channel_id"
        )
      VALUES (
        $1,
        $2
      )
    `,
    [guildId, DEFAULT_ROLE_REQUEST_CHANNEL_ID],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "event_types" (
          "owner_guild_id",
          "code",
          "name",
          "role_requests_enabled"
        )
      VALUES (
        $1,
        'naval',
        'Naval Event',
        true
      )
      RETURNING
        "id"
    `,
    [guildId],
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
          "timezone",
          "name",
          "description",
          "starts_at",
          "ends_at",
          "signups_enabled",
          "status",
          "created_by_user_id"
        )
      VALUES (
        $1,
        $2,
        'Europe/London',
        'Preset Application Test Event',
        'An event used to test reusable role-request presets.',
        $3,
        $4,
        true,
        'scheduled',
        $5
      )
      RETURNING
        "id"
    `,
    [
      guildId,
      eventTypeId,
      EVENT_START,
      new Date(EVENT_START.getTime() + 60 * 60_000),
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const presetResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "role_request_presets" (
          "owner_guild_id",
          "name",
          "description",
          "active",
          "created_by_user_id"
        )
      VALUES (
        $1,
        'Naval',
        'Reusable naval role requests.',
        true,
        $2
      )
      RETURNING
        "id"
    `,
    [guildId, ADMIN_USER_ID],
  );

  const presetId = presetResult.rows[0]?.id;

  if (!presetId) {
    throw new Error("The integration-test preset was not created.");
  }

  const presetOptions = await pool.query<{
    id: number;

    key: string;
  }>(
    `
      INSERT INTO
        "role_request_preset_options" (
          "preset_id",
          "key",
          "display_name",
          "description",
          "request_restriction",
          "capacity",
          "sort_order",
          "active"
        )
      VALUES
        (
          $1,
          'captain',
          'Captain',
          'Command the ship.',
          'qualified_only',
          1,
          0,
          true
        ),
        (
          $1,
          'carpenter',
          'Carpenter',
          'Repair the ship.',
          'open',
          NULL,
          1,
          true
        )
      RETURNING
        "id",
        "key"
    `,
    [presetId],
  );

  const captainPresetOptionId = presetOptions.rows.find(
    (row) => row.key === "captain",
  )?.id;

  const carpenterPresetOptionId = presetOptions.rows.find(
    (row) => row.key === "carpenter",
  )?.id;

  if (!captainPresetOptionId || !carpenterPresetOptionId) {
    throw new Error("The integration-test preset options were not created.");
  }

  await pool.query(
    `
      INSERT INTO
        "role_request_preset_option_qualification_roles" (
          "preset_option_id",
          "discord_role_id",
          "role_name_snapshot",
          "qualification_level"
        )
      VALUES
        (
          $1,
          $2,
          'Qualified Captain',
          'qualified'
        ),
        (
          $1,
          $3,
          'Midshipman',
          'supervision_required'
        )
    `,
    [captainPresetOptionId, CAPTAIN_QUALIFIED_ROLE_ID, MIDSHIPMAN_ROLE_ID],
  );

  const presetGroups = await pool.query<{
    id: number;

    name: string;
  }>(
    `
      INSERT INTO
        "role_request_preset_groups" (
          "preset_id",
          "name",
          "description",
          "channel_id",
          "notify_role_id",
          "notify_role_name_snapshot",
          "requires_positive_signup",
          "open_minutes_before_start",
          "close_minutes_before_start",
          "sort_order",
          "active"
        )
      VALUES
        (
          $1,
          'Command Roles',
          'Early command applications.',
          $2,
          NULL,
          NULL,
          false,
          180,
          60,
          0,
          true
        ),
        (
          $1,
          'Naval Roles',
          'General naval role requests.',
          NULL,
          $3,
          'Naval',
          true,
          60,
          -10,
          1,
          true
        )
      RETURNING
        "id",
        "name"
    `,
    [presetId, COMMAND_CHANNEL_ID, NOTIFY_ROLE_ID],
  );

  const commandPresetGroupId = presetGroups.rows.find(
    (row) => row.name === "Command Roles",
  )?.id;

  const generalPresetGroupId = presetGroups.rows.find(
    (row) => row.name === "Naval Roles",
  )?.id;

  if (!commandPresetGroupId || !generalPresetGroupId) {
    throw new Error("The integration-test preset groups were not created.");
  }

  await pool.query(
    `
      INSERT INTO
        "role_request_preset_group_options" (
          "group_id",
          "preset_option_id",
          "sort_order"
        )
      VALUES
        (
          $1,
          $2,
          0
        ),
        (
          $3,
          $2,
          0
        ),
        (
          $3,
          $4,
          1
        )
    `,
    [
      commandPresetGroupId,
      captainPresetOptionId,
      generalPresetGroupId,
      carpenterPresetOptionId,
    ],
  );

  return {
    guildId,

    eventTypeId,

    eventId,

    presetId,

    captainPresetOptionId,

    carpenterPresetOptionId,

    commandPresetGroupId,

    generalPresetGroupId,
  };
}

async function createOtherGuild(pool: Pool): Promise<number> {
  const result = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO
        "discord_guilds" (
          "discord_guild_id",
          "name"
        )
      VALUES (
        '983000000000000099',
        'Other Test Guild'
      )
      RETURNING
        "id"
    `,
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error("The secondary integration-test guild was not created.");
  }

  return id;
}

async function readPresetSnapshotCounts(
  pool: Pool,
  eventId: number,
): Promise<{
  applications: number;

  presetOptions: number;

  qualificationRoles: number;

  presetGroups: number;

  groupOptions: number;

  scheduledActions: number;
}> {
  const result = await pool.query<{
    applications: number;

    preset_options: number;

    qualification_roles: number;

    preset_groups: number;

    group_options: number;

    scheduled_actions: number;
  }>(
    `
      SELECT
        (
          SELECT
            COUNT(*)::int
          FROM
            "event_role_request_preset_applications"
          WHERE
            "event_id" = $1
        ) AS "applications",

        (
          SELECT
            COUNT(*)::int
          FROM
            "event_role_options"
          WHERE
            "event_id" = $1
            AND
            "source_role_request_preset_option_id" IS NOT NULL
        ) AS "preset_options",

        (
          SELECT
            COUNT(*)::int
          FROM
            "event_role_option_qualification_roles"
          INNER JOIN
            "event_role_options"
          ON
            "event_role_options"."id" =
              "event_role_option_qualification_roles"."event_role_option_id"
          WHERE
            "event_role_options"."event_id" = $1
            AND
            "event_role_options"."source_role_request_preset_option_id"
              IS NOT NULL
        ) AS "qualification_roles",

        (
          SELECT
            COUNT(*)::int
          FROM
            "role_request_groups"
          WHERE
            "event_id" = $1
            AND
            "source_role_request_preset_group_id" IS NOT NULL
        ) AS "preset_groups",

        (
          SELECT
            COUNT(*)::int
          FROM
            "role_request_group_options"
          INNER JOIN
            "role_request_groups"
          ON
            "role_request_groups"."id" =
              "role_request_group_options"."group_id"
          WHERE
            "role_request_groups"."event_id" = $1
            AND
            "role_request_groups"."source_role_request_preset_group_id"
              IS NOT NULL
        ) AS "group_options",

        (
          SELECT
            COUNT(*)::int
          FROM
            "scheduled_actions"
          WHERE
            "event_id" = $1
            AND (
              "action_key" LIKE 'role_request_group_open:%'
              OR
              "action_key" LIKE 'role_request_group_close:%'
            )
        ) AS "scheduled_actions"
    `,
    [eventId],
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error("Could not read preset snapshot counts.");
  }

  return {
    applications: row.applications,

    presetOptions: row.preset_options,

    qualificationRoles: row.qualification_roles,

    presetGroups: row.preset_groups,

    groupOptions: row.group_options,

    scheduledActions: row.scheduled_actions,
  };
}

async function assertNoPresetSnapshot(
  pool: Pool,
  eventId: number,
): Promise<void> {
  expect(await readPresetSnapshotCounts(pool, eventId)).toEqual({
    applications: 0,

    presetOptions: 0,

    qualificationRoles: 0,

    presetGroups: 0,

    groupOptions: 0,

    scheduledActions: 0,
  });
}
