import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import {
  getRoleRequestPresetDetails,
  listRoleRequestPresets,
} from "../../../src/role-requests/role-request-preset-query-service.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "987000000000000001";

const OTHER_DISCORD_GUILD_ID = "987000000000000002";

const ADMIN_USER_ID = "987000000000000003";

const CAPTAIN_ROLE_ID = "987000000000000004";

const SUPERVISED_ROLE_ID = "987000000000000005";

const NAVAL_NOTIFY_ROLE_ID = "987000000000000006";

const EXPLICIT_CHANNEL_ID = "987000000000000007";

type Fixture = {
  guildId: number;

  otherGuildId: number;

  navalPresetId: number;

  inactivePresetId: number;

  captainOptionId: number;

  carpenterOptionId: number;

  inactiveOptionId: number;

  commandGroupId: number;

  generalGroupId: number;

  inactiveGroupId: number;
};

describe("role-request preset query service", () => {
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

  it("lists active presets for one guild with active option and group counts", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    // Act
    const presets = await listRoleRequestPresets({
      guildDatabaseId: fixture.guildId,
    });

    // Assert
    expect(presets).toEqual([
      {
        id: fixture.navalPresetId,

        name: "Naval",

        description: "Reusable naval role requests.",

        active: true,

        /*
         * The fixture also has one inactive option and one inactive group.
         * Summary counts deliberately describe currently usable children.
         */
        activeOptionCount: 2,

        activeGroupCount: 2,

        createdByUserId: ADMIN_USER_ID,

        createdAt: expect.any(Date),

        updatedAt: expect.any(Date),
      },
    ]);
  });

  it("can include inactive presets without leaking presets from another guild", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    // Act
    const presets = await listRoleRequestPresets({
      guildDatabaseId: fixture.guildId,

      includeInactive: true,
    });

    // Assert
    expect(
      presets.map((preset) => ({
        id: preset.id,

        name: preset.name,

        active: preset.active,

        activeOptionCount: preset.activeOptionCount,

        activeGroupCount: preset.activeGroupCount,
      })),
    ).toEqual([
      {
        id: fixture.inactivePresetId,

        name: "Archived Naval",

        active: false,

        activeOptionCount: 0,

        activeGroupCount: 0,
      },

      {
        id: fixture.navalPresetId,

        name: "Naval",

        active: true,

        activeOptionCount: 2,

        activeGroupCount: 2,
      },
    ]);
  });

  it("returns a complete ordered preset definition for administration", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    // Act
    const result = await getRoleRequestPresetDetails({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.navalPresetId,
    });

    // Assert
    expect(result.kind).toBe("found");

    if (result.kind !== "found") {
      throw new Error(`Expected preset details, received "${result.kind}".`);
    }

    expect(result.preset).toEqual({
      id: fixture.navalPresetId,

      name: "Naval",

      description: "Reusable naval role requests.",

      active: true,

      createdByUserId: ADMIN_USER_ID,

      createdAt: expect.any(Date),

      updatedAt: expect.any(Date),

      /*
       * Detail reads include inactive children so administrators can see
       * the complete reusable definition rather than only the portion
       * currently applied to new events.
       */
      options: [
        {
          id: fixture.captainOptionId,

          key: "captain",

          displayName: "Captain",

          description: "Command the ship.",

          requestRestriction: "qualified_only",

          capacity: 1,

          sortOrder: 0,

          active: true,

          qualificationRoles: [
            {
              discordRoleId: CAPTAIN_ROLE_ID,

              roleNameSnapshot: "Qualified Captain",

              qualificationLevel: "qualified",
            },

            {
              discordRoleId: SUPERVISED_ROLE_ID,

              roleNameSnapshot: "Midshipman",

              qualificationLevel: "supervision_required",
            },
          ],
        },

        {
          id: fixture.carpenterOptionId,

          key: "carpenter",

          displayName: "Carpenter",

          description: "Repair the ship.",

          requestRestriction: "open",

          capacity: null,

          sortOrder: 1,

          active: true,

          qualificationRoles: [],
        },

        {
          id: fixture.inactiveOptionId,

          key: "retired-role",

          displayName: "Retired Role",

          description: null,

          requestRestriction: "open",

          capacity: null,

          sortOrder: 9,

          active: false,

          qualificationRoles: [],
        },
      ],

      groups: [
        {
          id: fixture.commandGroupId,

          name: "Command Roles",

          description: "Early command applications.",

          channelId: EXPLICIT_CHANNEL_ID,

          notifyRoleId: null,

          notifyRoleNameSnapshot: null,

          requiresPositiveSignup: false,

          openMinutesBeforeStart: 180,

          closeMinutesBeforeStart: 60,

          sortOrder: 0,

          active: true,

          presetOptionIds: [fixture.captainOptionId],
        },

        {
          id: fixture.generalGroupId,

          name: "Naval Roles",

          description: "General naval role requests.",

          /*
           * Null remains meaningful. It means resolve the guild default
           * role-request channel when this preset is applied.
           */
          channelId: null,

          notifyRoleId: NAVAL_NOTIFY_ROLE_ID,

          notifyRoleNameSnapshot: "Naval",

          requiresPositiveSignup: true,

          openMinutesBeforeStart: 60,

          closeMinutesBeforeStart: -10,

          sortOrder: 1,

          active: true,

          /*
           * Mapping order is presentation order, not option table order.
           */
          presetOptionIds: [fixture.carpenterOptionId, fixture.captainOptionId],
        },

        {
          id: fixture.inactiveGroupId,

          name: "Retired Group",

          description: null,

          channelId: null,

          notifyRoleId: null,

          notifyRoleNameSnapshot: null,

          requiresPositiveSignup: false,

          openMinutesBeforeStart: 60,

          closeMinutesBeforeStart: 0,

          sortOrder: 9,

          active: false,

          presetOptionIds: [fixture.inactiveOptionId],
        },
      ],
    });
  });

  it("treats another guild's preset as not found", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    // Act
    const result = await getRoleRequestPresetDetails({
      guildDatabaseId: fixture.otherGuildId,

      presetId: fixture.navalPresetId,
    });

    // Assert
    expect(result).toEqual({
      kind: "not_found",
    });
  });
});

async function createFixture(pool: Pool): Promise<Fixture> {
  const guildId = await createGuild(
    pool,
    DISCORD_GUILD_ID,
    "Preset Query Test Guild",
  );

  const otherGuildId = await createGuild(
    pool,
    OTHER_DISCORD_GUILD_ID,
    "Other Preset Query Test Guild",
  );

  const navalPresetResult = await pool.query<{
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

  const navalPresetId = navalPresetResult.rows[0]?.id;

  if (!navalPresetId) {
    throw new Error("The active integration-test preset was not created.");
  }

  const inactivePresetResult = await pool.query<{
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
          'Archived Naval',
          NULL,
          false,
          $2
        )
        RETURNING
          "id"
      `,
    [guildId, ADMIN_USER_ID],
  );

  const inactivePresetId = inactivePresetResult.rows[0]?.id;

  if (!inactivePresetId) {
    throw new Error("The inactive integration-test preset was not created.");
  }

  /*
   * This row exists solely to prove the guild boundary on list operations.
   */
  await pool.query(
    `
      INSERT INTO
        "role_request_presets" (
          "owner_guild_id",
          "name",
          "active",
          "created_by_user_id"
        )
      VALUES (
        $1,
        'Foreign Preset',
        true,
        $2
      )
    `,
    [otherGuildId, ADMIN_USER_ID],
  );

  const optionResult = await pool.query<{
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
          ),
          (
            $1,
            'retired-role',
            'Retired Role',
            NULL,
            'open',
            NULL,
            9,
            false
          )
        RETURNING
          "id",
          "key"
      `,
    [navalPresetId],
  );

  const captainOptionId = optionResult.rows.find(
    (option) => option.key === "captain",
  )?.id;

  const carpenterOptionId = optionResult.rows.find(
    (option) => option.key === "carpenter",
  )?.id;

  const inactiveOptionId = optionResult.rows.find(
    (option) => option.key === "retired-role",
  )?.id;

  if (!captainOptionId || !carpenterOptionId || !inactiveOptionId) {
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
    [captainOptionId, CAPTAIN_ROLE_ID, SUPERVISED_ROLE_ID],
  );

  const groupResult = await pool.query<{
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
          ),
          (
            $1,
            'Retired Group',
            NULL,
            NULL,
            NULL,
            NULL,
            false,
            60,
            0,
            9,
            false
          )
        RETURNING
          "id",
          "name"
      `,
    [navalPresetId, EXPLICIT_CHANNEL_ID, NAVAL_NOTIFY_ROLE_ID],
  );

  const commandGroupId = groupResult.rows.find(
    (group) => group.name === "Command Roles",
  )?.id;

  const generalGroupId = groupResult.rows.find(
    (group) => group.name === "Naval Roles",
  )?.id;

  const inactiveGroupId = groupResult.rows.find(
    (group) => group.name === "Retired Group",
  )?.id;

  if (!commandGroupId || !generalGroupId || !inactiveGroupId) {
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
          $4,
          0
        ),
        (
          $3,
          $2,
          1
        ),
        (
          $5,
          $6,
          0
        )
    `,
    [
      commandGroupId,
      captainOptionId,
      generalGroupId,
      carpenterOptionId,
      inactiveGroupId,
      inactiveOptionId,
    ],
  );

  return {
    guildId,

    otherGuildId,

    navalPresetId,

    inactivePresetId,

    captainOptionId,

    carpenterOptionId,

    inactiveOptionId,

    commandGroupId,

    generalGroupId,

    inactiveGroupId,
  };
}

async function createGuild(
  pool: Pool,
  discordGuildId: string,
  name: string,
): Promise<number> {
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
          $1,
          $2
        )
        RETURNING
          "id"
      `,
    [discordGuildId, name],
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error("The integration-test guild was not created.");
  }

  return id;
}
