import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import {
  addPresetRoleOption,
  createRoleRequestPreset,
} from "../../../src/role-requests/role-request-preset-admin-service.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "986000000000000001";

const OTHER_DISCORD_GUILD_ID = "986000000000000002";

const ADMIN_USER_ID = "986000000000000003";

const QUALIFIED_ROLE_ID = "986000000000000004";

const SUPERVISED_ROLE_ID = "986000000000000005";

describe("role-request preset administration service", () => {
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

  it("creates a reusable guild-owned role-request preset", async () => {
    // Arrange
    const guildId = await createGuild(pool, DISCORD_GUILD_ID);

    // Act
    const result = await createRoleRequestPreset({
      guildDatabaseId: guildId,

      name: "  Naval  ",

      description: "  Standard naval role requests.  ",

      createdByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result.kind).toBe("created");

    if (result.kind !== "created") {
      throw new Error(
        `Expected preset creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.preset).toEqual({
      id: expect.any(Number),

      name: "Naval",

      description: "Standard naval role requests.",

      active: true,

      createdByUserId: ADMIN_USER_ID,
    });

    const stored = await pool.query<{
      owner_guild_id: number;

      name: string;

      description: string | null;

      active: boolean;

      created_by_user_id: string;
    }>(
      `
            SELECT
              "owner_guild_id",
              "name",
              "description",
              "active",
              "created_by_user_id"
            FROM
              "role_request_presets"
            WHERE
              "id" = $1
          `,
      [result.preset.id],
    );

    expect(stored.rows).toEqual([
      {
        owner_guild_id: guildId,

        name: "Naval",

        description: "Standard naval role requests.",

        active: true,

        created_by_user_id: ADMIN_USER_ID,
      },
    ]);
  });

  it("rejects a duplicate preset name without creating another row", async () => {
    // Arrange
    const guildId = await createGuild(pool, DISCORD_GUILD_ID);

    const first = await createRoleRequestPreset({
      guildDatabaseId: guildId,

      name: "Naval",

      description: null,

      createdByUserId: ADMIN_USER_ID,
    });

    expect(first.kind).toBe("created");

    // Act
    const second = await createRoleRequestPreset({
      guildDatabaseId: guildId,

      name: "Naval",

      description: "Duplicate.",

      createdByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(second).toEqual({
      kind: "name_conflict",

      name: "Naval",
    });

    const count = await pool.query<{
      count: number;
    }>(
      `
            SELECT
              COUNT(*)::int AS "count"
            FROM
              "role_request_presets"
            WHERE
              "owner_guild_id" = $1
              AND
              "name" = 'Naval'
          `,
      [guildId],
    );

    expect(count.rows).toEqual([
      {
        count: 1,
      },
    ]);
  });

  it("rejects a blank preset name", async () => {
    // Arrange
    const guildId = await createGuild(pool, DISCORD_GUILD_ID);

    // Act
    const result = await createRoleRequestPreset({
      guildDatabaseId: guildId,

      name: "   ",

      description: null,

      createdByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "invalid_name",
    });

    const count = await pool.query<{
      count: number;
    }>(
      `
            SELECT
              COUNT(*)::int AS "count"
            FROM
              "role_request_presets"
          `,
    );

    expect(count.rows[0]?.count).toBe(0);
  });

  it("adds a qualified preset role option with snapshotted qualification roles and the next sort order", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    /*
     * Leave an intentional sort-order gap.
     *
     * The new option should append after the current maximum rather than
     * assuming that the existing rows are contiguous.
     */
    await pool.query(
      `
          INSERT INTO
            "role_request_preset_options" (
              "preset_id",
              "key",
              "display_name",
              "request_restriction",
              "sort_order",
              "active"
            )
          VALUES (
            $1,
            'carpenter',
            'Carpenter',
            'open',
            4,
            true
          )
        `,
      [fixture.presetId],
    );

    // Act
    const result = await addPresetRoleOption({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      displayName: "  2-Gun Gunner  ",

      description: "  Operates a two-gun position.  ",

      requestRestriction: "qualified_only",

      capacity: 2,

      qualificationRoles: [
        {
          discordRoleId: QUALIFIED_ROLE_ID,

          roleNameSnapshot: "  Qualified Gunner  ",

          qualificationLevel: "qualified",
        },

        {
          discordRoleId: SUPERVISED_ROLE_ID,

          roleNameSnapshot: "Gunner Trainee",

          qualificationLevel: "supervision_required",
        },
      ],
    });

    // Assert
    expect(result.kind).toBe("added");

    if (result.kind !== "added") {
      throw new Error(
        `Expected preset role option creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.option).toEqual({
      id: expect.any(Number),

      presetId: fixture.presetId,

      key: "2-gun-gunner",

      displayName: "2-Gun Gunner",

      description: "Operates a two-gun position.",

      requestRestriction: "qualified_only",

      capacity: 2,

      sortOrder: 5,

      active: true,
    });

    const storedOption = await pool.query<{
      source_preset_id: number;

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
              "preset_id"
                AS "source_preset_id",
              "key",
              "display_name",
              "description",
              "request_restriction",
              "capacity",
              "sort_order",
              "active"
            FROM
              "role_request_preset_options"
            WHERE
              "id" = $1
          `,
      [result.option.id],
    );

    expect(storedOption.rows).toEqual([
      {
        source_preset_id: fixture.presetId,

        key: "2-gun-gunner",

        display_name: "2-Gun Gunner",

        description: "Operates a two-gun position.",

        request_restriction: "qualified_only",

        capacity: 2,

        sort_order: 5,

        active: true,
      },
    ]);

    const qualifications = await pool.query<{
      discord_role_id: string;

      role_name_snapshot: string;

      qualification_level: string;
    }>(
      `
            SELECT
              "discord_role_id",
              "role_name_snapshot",
              "qualification_level"
            FROM
              "role_request_preset_option_qualification_roles"
            WHERE
              "preset_option_id" = $1
            ORDER BY
              "discord_role_id"
          `,
      [result.option.id],
    );

    expect(qualifications.rows).toEqual([
      {
        discord_role_id: QUALIFIED_ROLE_ID,

        role_name_snapshot: "Qualified Gunner",

        qualification_level: "qualified",
      },

      {
        discord_role_id: SUPERVISED_ROLE_ID,

        role_name_snapshot: "Gunner Trainee",

        qualification_level: "supervision_required",
      },
    ]);
  });

  it("rejects a qualified-only option with no qualification roles without creating the option", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    // Act
    const result = await addPresetRoleOption({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      displayName: "Captain",

      description: null,

      requestRestriction: "qualified_only",

      capacity: 1,

      qualificationRoles: [],
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "missing_qualification_roles",
    });

    await expectNoPresetOptions(pool, fixture.presetId);
  });

  it("rejects one Discord role being configured at two qualification levels", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    // Act
    const result = await addPresetRoleOption({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      displayName: "Captain",

      description: null,

      requestRestriction: "qualified_only",

      capacity: 1,

      qualificationRoles: [
        {
          discordRoleId: QUALIFIED_ROLE_ID,

          roleNameSnapshot: "Captain",

          qualificationLevel: "qualified",
        },

        {
          discordRoleId: QUALIFIED_ROLE_ID,

          roleNameSnapshot: "Captain",

          qualificationLevel: "supervision_required",
        },
      ],
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "duplicate_qualification_role",

      discordRoleId: QUALIFIED_ROLE_ID,
    });

    await expectNoPresetOptions(pool, fixture.presetId);
  });

  it("rejects @everyone as a qualification role", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    // Act
    const result = await addPresetRoleOption({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      displayName: "Captain",

      description: null,

      requestRestriction: "qualified_only",

      capacity: 1,

      qualificationRoles: [
        {
          /*
           * Discord's @everyone role has the same snowflake as the
           * guild itself.
           */
          discordRoleId: DISCORD_GUILD_ID,

          roleNameSnapshot: "@everyone",

          qualificationLevel: "qualified",
        },
      ],
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "everyone_qualification_role",

      discordRoleId: DISCORD_GUILD_ID,
    });

    await expectNoPresetOptions(pool, fixture.presetId);
  });

  it("rejects a normalised option-key conflict without changing existing preset state", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const first = await addPresetRoleOption({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      displayName: "2-Gun Gunner",

      description: null,

      requestRestriction: "open",

      capacity: null,

      qualificationRoles: [],
    });

    expect(first.kind).toBe("added");

    // Act
    const second = await addPresetRoleOption({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      /*
       * Different display spelling, same generated logical key.
       */
      displayName: "2 Gun Gunner",

      description: null,

      requestRestriction: "open",

      capacity: null,

      qualificationRoles: [],
    });

    // Assert
    expect(second).toEqual({
      kind: "key_conflict",

      key: "2-gun-gunner",
    });

    const options = await pool.query<{
      key: string;
    }>(
      `
            SELECT
              "key"
            FROM
              "role_request_preset_options"
            WHERE
              "preset_id" = $1
          `,
      [fixture.presetId],
    );

    expect(options.rows).toEqual([
      {
        key: "2-gun-gunner",
      },
    ]);
  });

  it("does not allow one guild to mutate another guild's preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const otherGuildId = await createGuild(pool, OTHER_DISCORD_GUILD_ID);

    // Act
    const result = await addPresetRoleOption({
      guildDatabaseId: otherGuildId,

      presetId: fixture.presetId,

      displayName: "Captain",

      description: null,

      requestRestriction: "open",

      capacity: null,

      qualificationRoles: [],
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_not_found",
    });

    await expectNoPresetOptions(pool, fixture.presetId);
  });
});

async function createGuild(
  pool: Pool,
  discordGuildId: string,
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
          'Role Request Preset Admin Test Guild'
        )
        RETURNING
          "id"
      `,
    [discordGuildId],
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error("The integration-test guild was not created.");
  }

  return id;
}

async function createPresetFixture(pool: Pool): Promise<{
  guildId: number;

  presetId: number;
}> {
  const guildId = await createGuild(pool, DISCORD_GUILD_ID);

  const result = await pool.query<{
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
          'Reusable naval roles.',
          true,
          $2
        )
        RETURNING
          "id"
      `,
    [guildId, ADMIN_USER_ID],
  );

  const presetId = result.rows[0]?.id;

  if (!presetId) {
    throw new Error("The integration-test preset was not created.");
  }

  return {
    guildId,

    presetId,
  };
}

async function expectNoPresetOptions(
  pool: Pool,
  presetId: number,
): Promise<void> {
  const count = await pool.query<{
    count: number;
  }>(
    `
        SELECT
          COUNT(*)::int AS "count"
        FROM
          "role_request_preset_options"
        WHERE
          "preset_id" = $1
      `,
    [presetId],
  );

  expect(count.rows).toEqual([
    {
      count: 0,
    },
  ]);
}
