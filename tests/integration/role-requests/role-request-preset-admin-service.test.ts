import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import {
  addPresetRequestGroup,
  addPresetRoleOption,
  createRoleRequestPreset,
  setRoleRequestPresetActive,
  setRoleRequestPresetGroupActive,
  setRoleRequestPresetOptionActive,
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

const ROLE_REQUEST_CHANNEL_ID = "986000000000000006";

const NOTIFY_ROLE_ID = "986000000000000007";

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

  it("deactivates a preset without changing its child configuration", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Naval Roles',
          false,
          60,
          0,
          0,
          true
        )
        RETURNING
          "id"
      `,
      [fixture.presetId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error("The integration-test preset group was not created.");
    }

    await pool.query(
      `
      INSERT INTO
        "role_request_preset_group_options" (
          "group_id",
          "preset_option_id",
          "sort_order"
        )
      VALUES (
        $1,
        $2,
        0
      )
    `,
      [groupId, options.captainId],
    );

    /*
     * Give updated_at a deterministic old value so the assertion does not
     * depend on two very fast operations landing in the same clock tick.
     */
    await pool.query(
      `
      UPDATE
        "role_request_presets"
      SET
        "updated_at" =
          '2026-01-01T00:00:00Z'
      WHERE
        "id" = $1
    `,
      [fixture.presetId],
    );

    // Act
    const result = await setRoleRequestPresetActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      preset: {
        id: fixture.presetId,

        name: "Naval",

        active: false,
      },
    });

    const storedPreset = await pool.query<{
      active: boolean;

      updated_at: Date;
    }>(
      `
        SELECT
          "active",
          "updated_at"
        FROM
          "role_request_presets"
        WHERE
          "id" = $1
      `,
      [fixture.presetId],
    );

    expect(storedPreset.rows[0]?.active).toBe(false);

    expect(storedPreset.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );

    /*
     * Deactivating the parent archives the reusable preset as a source. It
     * does not rewrite the administrator's child configuration.
     */
    const childState = await pool.query<{
      active_options: number;

      active_groups: number;

      mappings: number;
    }>(
      `
        SELECT
          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_options"
            WHERE
              "preset_id" = $1
              AND
              "active" = true
          ) AS "active_options",

          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_groups"
            WHERE
              "preset_id" = $1
              AND
              "active" = true
          ) AS "active_groups",

          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_group_options"
            WHERE
              "group_id" = $2
          ) AS "mappings"
      `,
      [fixture.presetId, groupId],
    );

    expect(childState.rows).toEqual([
      {
        active_options: 2,

        active_groups: 1,

        mappings: 1,
      },
    ]);
  });

  it("reactivates an inactive preset while preserving its child active states", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

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

    /*
     * Child activation is independent. Retiring Carpenter should remain
     * retired when the parent preset is later reactivated.
     */
    await pool.query(
      `
      UPDATE
        "role_request_preset_options"
      SET
        "active" = false
      WHERE
        "id" = $1
    `,
      [options.carpenterId],
    );

    // Act
    const result = await setRoleRequestPresetActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      active: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      preset: {
        id: fixture.presetId,

        name: "Naval",

        active: true,
      },
    });

    const stored = await pool.query<{
      preset_active: boolean;

      captain_active: boolean;

      carpenter_active: boolean;
    }>(
      `
        SELECT
          "preset"."active"
            AS "preset_active",

          "captain"."active"
            AS "captain_active",

          "carpenter"."active"
            AS "carpenter_active"

        FROM
          "role_request_presets"
            AS "preset"

        INNER JOIN
          "role_request_preset_options"
            AS "captain"
        ON
          "captain"."preset_id" =
            "preset"."id"
          AND
          "captain"."id" = $2

        INNER JOIN
          "role_request_preset_options"
            AS "carpenter"
        ON
          "carpenter"."preset_id" =
            "preset"."id"
          AND
          "carpenter"."id" = $3

        WHERE
          "preset"."id" = $1
      `,
      [fixture.presetId, options.captainId, options.carpenterId],
    );

    expect(stored.rows).toEqual([
      {
        preset_active: true,

        captain_active: true,

        carpenter_active: false,
      },
    ]);
  });

  it("treats setting a preset to its existing active state as an idempotent no-op", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const fixedUpdatedAt = new Date("2026-01-01T00:00:00Z");

    await pool.query(
      `
      UPDATE
        "role_request_presets"
      SET
        "updated_at" = $2
      WHERE
        "id" = $1
    `,
      [fixture.presetId, fixedUpdatedAt],
    );

    // Act
    const result = await setRoleRequestPresetActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      active: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "unchanged",

      preset: {
        id: fixture.presetId,

        name: "Naval",

        active: true,
      },
    });

    const stored = await pool.query<{
      updated_at: Date;
    }>(
      `
        SELECT
          "updated_at"
        FROM
          "role_request_presets"
        WHERE
          "id" = $1
      `,
      [fixture.presetId],
    );

    expect(stored.rows[0]?.updated_at.getTime()).toBe(fixedUpdatedAt.getTime());
  });

  it("does not allow one guild to change another guild's preset lifecycle", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const otherGuildId = await createGuild(pool, OTHER_DISCORD_GUILD_ID);

    // Act
    const result = await setRoleRequestPresetActive({
      guildDatabaseId: otherGuildId,

      presetId: fixture.presetId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_not_found",
    });

    const stored = await pool.query<{
      active: boolean;
    }>(
      `
        SELECT
          "active"
        FROM
          "role_request_presets"
        WHERE
          "id" = $1
      `,
      [fixture.presetId],
    );

    expect(stored.rows).toEqual([
      {
        active: true,
      },
    ]);
  });

  it("deactivates a preset option while preserving mappings and reports active groups left without active options", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const groups = await pool.query<{
      id: number;

      name: string;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES
          (
            $1,
            'Captain Only',
            false,
            60,
            0,
            0,
            true
          ),
          (
            $1,
            'Mixed Roles',
            false,
            60,
            0,
            1,
            true
          ),
          (
            $1,
            'Retired Captain Group',
            false,
            60,
            0,
            2,
            false
          )
        RETURNING
          "id",
          "name"
      `,
      [fixture.presetId],
    );

    const captainOnlyGroupId = groups.rows.find(
      (group) => group.name === "Captain Only",
    )?.id;

    const mixedGroupId = groups.rows.find(
      (group) => group.name === "Mixed Roles",
    )?.id;

    const retiredGroupId = groups.rows.find(
      (group) => group.name === "Retired Captain Group",
    )?.id;

    if (!captainOnlyGroupId || !mixedGroupId || !retiredGroupId) {
      throw new Error(
        "The option-lifecycle integration-test groups were not created.",
      );
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
          $4,
          0
        ),
        (
          $2,
          $4,
          0
        ),
        (
          $2,
          $5,
          1
        ),
        (
          $3,
          $4,
          0
        )
    `,
      [
        captainOnlyGroupId,
        mixedGroupId,
        retiredGroupId,
        options.captainId,
        options.carpenterId,
      ],
    );

    // Act
    const result = await setRoleRequestPresetOptionActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetOptionId: options.captainId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      option: {
        id: options.captainId,

        presetId: fixture.presetId,

        displayName: "Captain",

        active: false,
      },

      newlyInvalidActiveGroups: [
        {
          id: captainOnlyGroupId,

          name: "Captain Only",
        },
      ],
    });

    const stored = await pool.query<{
      captain_active: boolean;

      carpenter_active: boolean;

      captain_only_group_active: boolean;

      mixed_group_active: boolean;

      retired_group_active: boolean;

      mapping_count: number;
    }>(
      `
      SELECT
        (
          SELECT
            "active"
          FROM
            "role_request_preset_options"
          WHERE
            "id" = $1
        ) AS "captain_active",

        (
          SELECT
            "active"
          FROM
            "role_request_preset_options"
          WHERE
            "id" = $2
        ) AS "carpenter_active",

        (
          SELECT
            "active"
          FROM
            "role_request_preset_groups"
          WHERE
            "id" = $3
        ) AS "captain_only_group_active",

        (
          SELECT
            "active"
          FROM
            "role_request_preset_groups"
          WHERE
            "id" = $4
        ) AS "mixed_group_active",

        (
          SELECT
            "active"
          FROM
            "role_request_preset_groups"
          WHERE
            "id" = $5
        ) AS "retired_group_active",

        (
          SELECT
            COUNT(*)::int
          FROM
            "role_request_preset_group_options"
          WHERE
            "group_id" IN (
              $3,
              $4,
              $5
            )
        ) AS "mapping_count"
    `,
      [
        options.captainId,
        options.carpenterId,
        captainOnlyGroupId,
        mixedGroupId,
        retiredGroupId,
      ],
    );

    expect(stored.rows).toEqual([
      {
        captain_active: false,

        carpenter_active: true,

        captain_only_group_active: true,

        mixed_group_active: true,

        retired_group_active: false,

        mapping_count: 4,
      },
    ]);
  });

  it("reactivates an inactive preset option without rewriting its group mappings", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Captain Only',
          false,
          60,
          0,
          0,
          true
        )
        RETURNING
          "id"
      `,
      [fixture.presetId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The option-reactivation integration-test group was not created.",
      );
    }

    await pool.query(
      `
      INSERT INTO
        "role_request_preset_group_options" (
          "group_id",
          "preset_option_id",
          "sort_order"
        )
      VALUES (
        $1,
        $2,
        0
      )
    `,
      [groupId, options.captainId],
    );

    await pool.query(
      `
      UPDATE
        "role_request_preset_options"
      SET
        "active" = false
      WHERE
        "id" = $1
    `,
      [options.captainId],
    );

    // Act
    const result = await setRoleRequestPresetOptionActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetOptionId: options.captainId,

      active: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      option: {
        id: options.captainId,

        presetId: fixture.presetId,

        displayName: "Captain",

        active: true,
      },

      newlyInvalidActiveGroups: [],
    });

    const stored = await pool.query<{
      option_active: boolean;

      group_active: boolean;

      mappings: number;
    }>(
      `
        SELECT
          (
            SELECT
              "active"
            FROM
              "role_request_preset_options"
            WHERE
              "id" = $1
          ) AS "option_active",

          (
            SELECT
              "active"
            FROM
              "role_request_preset_groups"
            WHERE
              "id" = $2
          ) AS "group_active",

          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_group_options"
            WHERE
              "group_id" = $2
              AND
              "preset_option_id" = $1
          ) AS "mappings"
      `,
      [options.captainId, groupId],
    );

    expect(stored.rows).toEqual([
      {
        option_active: true,

        group_active: true,

        mappings: 1,
      },
    ]);
  });

  it("treats setting a preset option to its existing state as an idempotent no-op", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const fixedOptionUpdatedAt = new Date("2026-01-01T00:00:00Z");

    const fixedPresetUpdatedAt = new Date("2026-01-02T00:00:00Z");

    await pool.query(
      `
      UPDATE
        "role_request_preset_options"
      SET
        "updated_at" = $2
      WHERE
        "id" = $1
    `,
      [options.captainId, fixedOptionUpdatedAt],
    );

    await pool.query(
      `
      UPDATE
        "role_request_presets"
      SET
        "updated_at" = $2
      WHERE
        "id" = $1
    `,
      [fixture.presetId, fixedPresetUpdatedAt],
    );

    // Act
    const result = await setRoleRequestPresetOptionActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetOptionId: options.captainId,

      active: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "unchanged",

      option: {
        id: options.captainId,

        presetId: fixture.presetId,

        displayName: "Captain",

        active: true,
      },
    });

    const stored = await pool.query<{
      option_updated_at: Date;

      preset_updated_at: Date;
    }>(
      `
        SELECT
          (
            SELECT
              "updated_at"
            FROM
              "role_request_preset_options"
            WHERE
              "id" = $2
          ) AS "option_updated_at",

          (
            SELECT
              "updated_at"
            FROM
              "role_request_presets"
            WHERE
              "id" = $1
          ) AS "preset_updated_at"
      `,
      [fixture.presetId, options.captainId],
    );

    expect(stored.rows[0]?.option_updated_at.getTime()).toBe(
      fixedOptionUpdatedAt.getTime(),
    );

    expect(stored.rows[0]?.preset_updated_at.getTime()).toBe(
      fixedPresetUpdatedAt.getTime(),
    );
  });

  it("does not allow one guild to change an option belonging to another guild's preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const otherGuildId = await createGuild(pool, OTHER_DISCORD_GUILD_ID);

    // Act
    const result = await setRoleRequestPresetOptionActive({
      guildDatabaseId: otherGuildId,

      presetId: fixture.presetId,

      presetOptionId: options.captainId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_not_found",
    });

    const stored = await pool.query<{
      active: boolean;
    }>(
      `
        SELECT
          "active"
        FROM
          "role_request_preset_options"
        WHERE
          "id" = $1
      `,
      [options.captainId],
    );

    expect(stored.rows).toEqual([
      {
        active: true,
      },
    ]);
  });

  it("does not allow an option from a different preset to be changed through the selected preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const otherPresetResult = await pool.query<{
      id: number;
    }>(
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
          'Linebattle',
          true,
          $2
        )
        RETURNING
          "id"
      `,
      [fixture.guildId, ADMIN_USER_ID],
    );

    const otherPresetId = otherPresetResult.rows[0]?.id;

    if (!otherPresetId) {
      throw new Error("The secondary preset was not created.");
    }

    const otherOptions = await createPresetOptions(pool, otherPresetId);

    // Act
    const result = await setRoleRequestPresetOptionActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetOptionId: otherOptions.captainId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "option_not_found",
    });

    const stored = await pool.query<{
      active: boolean;
    }>(
      `
        SELECT
          "active"
        FROM
          "role_request_preset_options"
        WHERE
          "id" = $1
      `,
      [otherOptions.captainId],
    );

    expect(stored.rows).toEqual([
      {
        active: true,
      },
    ]);
  });

  it("deactivates a preset request group while preserving its option mappings", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Naval Roles',
          true,
          60,
          -10,
          0,
          true
        )
        RETURNING
          "id"
      `,
      [fixture.presetId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The group-lifecycle integration-test group was not created.",
      );
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
          $1,
          $3,
          1
        )
    `,
      [groupId, options.captainId, options.carpenterId],
    );

    // Act
    const result = await setRoleRequestPresetGroupActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetGroupId: groupId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      group: {
        id: groupId,

        presetId: fixture.presetId,

        name: "Naval Roles",

        active: false,
      },
    });

    const stored = await pool.query<{
      group_active: boolean;

      captain_active: boolean;

      carpenter_active: boolean;

      mappings: number;
    }>(
      `
        SELECT
          (
            SELECT
              "active"
            FROM
              "role_request_preset_groups"
            WHERE
              "id" = $1
          ) AS "group_active",

          (
            SELECT
              "active"
            FROM
              "role_request_preset_options"
            WHERE
              "id" = $2
          ) AS "captain_active",

          (
            SELECT
              "active"
            FROM
              "role_request_preset_options"
            WHERE
              "id" = $3
          ) AS "carpenter_active",

          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_group_options"
            WHERE
              "group_id" = $1
          ) AS "mappings"
      `,
      [groupId, options.captainId, options.carpenterId],
    );

    expect(stored.rows).toEqual([
      {
        group_active: false,

        captain_active: true,

        carpenter_active: true,

        mappings: 2,
      },
    ]);
  });

  it("reactivates an inactive preset request group without rewriting its mappings", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Command Roles',
          false,
          180,
          60,
          0,
          false
        )
        RETURNING
          "id"
      `,
      [fixture.presetId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The group-reactivation integration-test group was not created.",
      );
    }

    await pool.query(
      `
      INSERT INTO
        "role_request_preset_group_options" (
          "group_id",
          "preset_option_id",
          "sort_order"
        )
      VALUES (
        $1,
        $2,
        0
      )
    `,
      [groupId, options.captainId],
    );

    // Act
    const result = await setRoleRequestPresetGroupActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetGroupId: groupId,

      active: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "updated",

      group: {
        id: groupId,

        presetId: fixture.presetId,

        name: "Command Roles",

        active: true,
      },
    });

    const stored = await pool.query<{
      active: boolean;

      mappings: number;
    }>(
      `
        SELECT
          (
            SELECT
              "active"
            FROM
              "role_request_preset_groups"
            WHERE
              "id" = $1
          ) AS "active",

          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_group_options"
            WHERE
              "group_id" = $1
          ) AS "mappings"
      `,
      [groupId],
    );

    expect(stored.rows).toEqual([
      {
        active: true,

        mappings: 1,
      },
    ]);
  });

  it("treats setting a preset request group to its existing state as an idempotent no-op", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Naval Roles',
          false,
          60,
          0,
          0,
          true
        )
        RETURNING
          "id"
      `,
      [fixture.presetId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The idempotency integration-test group was not created.",
      );
    }

    const fixedGroupUpdatedAt = new Date("2026-01-01T00:00:00Z");

    const fixedPresetUpdatedAt = new Date("2026-01-02T00:00:00Z");

    await pool.query(
      `
      UPDATE
        "role_request_preset_groups"
      SET
        "updated_at" = $2
      WHERE
        "id" = $1
    `,
      [groupId, fixedGroupUpdatedAt],
    );

    await pool.query(
      `
      UPDATE
        "role_request_presets"
      SET
        "updated_at" = $2
      WHERE
        "id" = $1
    `,
      [fixture.presetId, fixedPresetUpdatedAt],
    );

    // Act
    const result = await setRoleRequestPresetGroupActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetGroupId: groupId,

      active: true,
    });

    // Assert
    expect(result).toEqual({
      kind: "unchanged",

      group: {
        id: groupId,

        presetId: fixture.presetId,

        name: "Naval Roles",

        active: true,
      },
    });

    const stored = await pool.query<{
      group_updated_at: Date;

      preset_updated_at: Date;
    }>(
      `
        SELECT
          (
            SELECT
              "updated_at"
            FROM
              "role_request_preset_groups"
            WHERE
              "id" = $2
          ) AS "group_updated_at",

          (
            SELECT
              "updated_at"
            FROM
              "role_request_presets"
            WHERE
              "id" = $1
          ) AS "preset_updated_at"
      `,
      [fixture.presetId, groupId],
    );

    expect(stored.rows[0]?.group_updated_at.getTime()).toBe(
      fixedGroupUpdatedAt.getTime(),
    );

    expect(stored.rows[0]?.preset_updated_at.getTime()).toBe(
      fixedPresetUpdatedAt.getTime(),
    );
  });

  it("does not allow one guild to change a request group belonging to another guild's preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Naval Roles',
          false,
          60,
          0,
          0,
          true
        )
        RETURNING
          "id"
      `,
      [fixture.presetId],
    );

    const groupId = groupResult.rows[0]?.id;

    if (!groupId) {
      throw new Error(
        "The foreign-guild integration-test group was not created.",
      );
    }

    const otherGuildId = await createGuild(pool, OTHER_DISCORD_GUILD_ID);

    // Act
    const result = await setRoleRequestPresetGroupActive({
      guildDatabaseId: otherGuildId,

      presetId: fixture.presetId,

      presetGroupId: groupId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_not_found",
    });

    const stored = await pool.query<{
      active: boolean;
    }>(
      `
        SELECT
          "active"
        FROM
          "role_request_preset_groups"
        WHERE
          "id" = $1
      `,
      [groupId],
    );

    expect(stored.rows).toEqual([
      {
        active: true,
      },
    ]);
  });

  it("does not allow a request group from a different preset to be changed through the selected preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const otherPresetResult = await pool.query<{
      id: number;
    }>(
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
          'Linebattle',
          true,
          $2
        )
        RETURNING
          "id"
      `,
      [fixture.guildId, ADMIN_USER_ID],
    );

    const otherPresetId = otherPresetResult.rows[0]?.id;

    if (!otherPresetId) {
      throw new Error("The secondary lifecycle-test preset was not created.");
    }

    const groupResult = await pool.query<{
      id: number;
    }>(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "requires_positive_signup",
            "open_minutes_before_start",
            "close_minutes_before_start",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Linebattle Roles',
          false,
          60,
          0,
          0,
          true
        )
        RETURNING
          "id"
      `,
      [otherPresetId],
    );

    const otherGroupId = groupResult.rows[0]?.id;

    if (!otherGroupId) {
      throw new Error("The secondary lifecycle-test group was not created.");
    }

    // Act
    const result = await setRoleRequestPresetGroupActive({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      presetGroupId: otherGroupId,

      active: false,
    });

    // Assert
    expect(result).toEqual({
      kind: "group_not_found",
    });

    const stored = await pool.query<{
      active: boolean;
    }>(
      `
        SELECT
          "active"
        FROM
          "role_request_preset_groups"
        WHERE
          "id" = $1
      `,
      [otherGroupId],
    );

    expect(stored.rows).toEqual([
      {
        active: true,
      },
    ]);
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

  it("adds a preset request group with ordered option mappings and the next sort order", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    /*
     * Leave an intentional sort-order gap.
     *
     * Inactive groups still occupy their existing display position, so a
     * newly-added group should append after the current maximum rather than
     * reusing the retired group's order.
     */
    await pool.query(
      `
        INSERT INTO
          "role_request_preset_groups" (
            "preset_id",
            "name",
            "sort_order",
            "active"
          )
        VALUES (
          $1,
          'Retired Group',
          4,
          false
        )
      `,
      [fixture.presetId],
    );

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "  Naval Roles  ",

      description: "  General naval role requests.  ",

      /*
       * Deliberately reverse the natural option order. The mapping must
       * preserve the administrator's requested presentation order.
       */
      presetOptionIds: [options.carpenterId, options.captainId],

      channelId: `  ${ROLE_REQUEST_CHANNEL_ID}  `,

      notifyRole: {
        discordRoleId: `  ${NOTIFY_ROLE_ID}  `,

        roleNameSnapshot: "  Naval  ",
      },

      requiresPositiveSignup: true,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: -10,
    });

    // Assert
    expect(result.kind).toBe("added");

    if (result.kind !== "added") {
      throw new Error(
        `Expected preset request-group creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.group).toEqual({
      id: expect.any(Number),

      presetId: fixture.presetId,

      name: "Naval Roles",

      description: "General naval role requests.",

      channelId: ROLE_REQUEST_CHANNEL_ID,

      notifyRoleId: NOTIFY_ROLE_ID,

      notifyRoleNameSnapshot: "Naval",

      requiresPositiveSignup: true,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: -10,

      sortOrder: 5,

      active: true,

      presetOptionIds: [options.carpenterId, options.captainId],
    });

    const storedGroup = await pool.query<{
      preset_id: number;

      name: string;

      description: string | null;

      channel_id: string | null;

      notify_role_id: string | null;

      notify_role_name_snapshot: string | null;

      requires_positive_signup: boolean;

      open_minutes_before_start: number;

      close_minutes_before_start: number;

      sort_order: number;

      active: boolean;
    }>(
      `
          SELECT
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
          FROM
            "role_request_preset_groups"
          WHERE
            "id" = $1
        `,
      [result.group.id],
    );

    expect(storedGroup.rows).toEqual([
      {
        preset_id: fixture.presetId,

        name: "Naval Roles",

        description: "General naval role requests.",

        channel_id: ROLE_REQUEST_CHANNEL_ID,

        notify_role_id: NOTIFY_ROLE_ID,

        notify_role_name_snapshot: "Naval",

        requires_positive_signup: true,

        open_minutes_before_start: 60,

        close_minutes_before_start: -10,

        sort_order: 5,

        active: true,
      },
    ]);

    const mappings = await pool.query<{
      preset_option_id: number;

      sort_order: number;
    }>(
      `
          SELECT
            "preset_option_id",
            "sort_order"
          FROM
            "role_request_preset_group_options"
          WHERE
            "group_id" = $1
          ORDER BY
            "sort_order"
        `,
      [result.group.id],
    );

    expect(mappings.rows).toEqual([
      {
        preset_option_id: options.carpenterId,

        sort_order: 0,
      },

      {
        preset_option_id: options.captainId,

        sort_order: 1,
      },
    ]);
  });

  it("stores a null channel as apply-time default-channel resolution rather than resolving it during preset editing", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Command Roles",

      description: null,

      presetOptionIds: [options.captainId],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 180,

      closeMinutesBeforeStart: 60,
    });

    // Assert
    expect(result.kind).toBe("added");

    if (result.kind !== "added") {
      throw new Error(
        `Expected preset request-group creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.group.channelId).toBeNull();

    expect(result.group.notifyRoleId).toBeNull();

    expect(result.group.notifyRoleNameSnapshot).toBeNull();

    const stored = await pool.query<{
      channel_id: string | null;

      notify_role_id: string | null;

      notify_role_name_snapshot: string | null;
    }>(
      `
          SELECT
            "channel_id",
            "notify_role_id",
            "notify_role_name_snapshot"
          FROM
            "role_request_preset_groups"
          WHERE
            "id" = $1
        `,
      [result.group.id],
    );

    expect(stored.rows).toEqual([
      {
        channel_id: null,

        notify_role_id: null,

        notify_role_name_snapshot: null,
      },
    ]);
  });

  it("rejects a preset request group with no role options", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Empty Group",

      description: null,

      presetOptionIds: [],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: 0,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "no_options",
    });

    await expectNoPresetGroups(pool, fixture.presetId);
  });

  it("rejects duplicate option IDs rather than silently changing the requested group definition", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Duplicate Captain",

      description: null,

      presetOptionIds: [options.captainId, options.captainId],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: 0,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "duplicate_option",

      presetOptionId: options.captainId,
    });

    await expectNoPresetGroups(pool, fixture.presetId);
  });

  it("rejects an option belonging to another preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const otherPresetResult = await pool.query<{
      id: number;
    }>(
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
            'Linebattle',
            true,
            $2
          )
          RETURNING
            "id"
        `,
      [fixture.guildId, ADMIN_USER_ID],
    );

    const otherPresetId = otherPresetResult.rows[0]?.id;

    if (!otherPresetId) {
      throw new Error("The secondary integration-test preset was not created.");
    }

    const otherOptions = await createPresetOptions(pool, otherPresetId);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Mixed Preset Group",

      description: null,

      presetOptionIds: [options.captainId, otherOptions.carpenterId],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: 0,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "option_not_found_or_inactive",

      presetOptionId: otherOptions.carpenterId,
    });

    await expectNoPresetGroups(pool, fixture.presetId);
  });

  it("rejects an inactive preset option", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    await pool.query(
      `
        UPDATE
          "role_request_preset_options"
        SET
          "active" = false
        WHERE
          "id" = $1
      `,
      [options.carpenterId],
    );

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Inactive Option Group",

      description: null,

      presetOptionIds: [options.captainId, options.carpenterId],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: 0,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "option_not_found_or_inactive",

      presetOptionId: options.carpenterId,
    });

    await expectNoPresetGroups(pool, fixture.presetId);
  });

  it("rejects a request group whose opening does not precede its closing", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Impossible Window",

      description: null,

      presetOptionIds: [options.captainId],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      /*
       * An offset of 0 opens at event start, while 60 closes an hour
       * before event start. The opening would therefore be after closing.
       */
      openMinutesBeforeStart: 0,

      closeMinutesBeforeStart: 60,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "invalid_group_window",
    });

    await expectNoPresetGroups(pool, fixture.presetId);
  });

  it("rejects @everyone as a preset request-group notification role", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: fixture.guildId,

      presetId: fixture.presetId,

      name: "Everyone Ping",

      description: null,

      presetOptionIds: [options.captainId],

      channelId: null,

      notifyRole: {
        /*
         * Discord's @everyone role uses the guild snowflake.
         */
        discordRoleId: DISCORD_GUILD_ID,

        roleNameSnapshot: "@everyone",
      },

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: 0,
    });

    // Assert
    expect(result).toEqual({
      kind: "invalid_input",

      reason: "everyone_notify_role",

      discordRoleId: DISCORD_GUILD_ID,
    });

    await expectNoPresetGroups(pool, fixture.presetId);
  });

  it("does not allow one guild to add a request group to another guild's preset", async () => {
    // Arrange
    const fixture = await createPresetFixture(pool);

    const options = await createPresetOptions(pool, fixture.presetId);

    const otherGuildId = await createGuild(pool, OTHER_DISCORD_GUILD_ID);

    // Act
    const result = await addPresetRequestGroup({
      guildDatabaseId: otherGuildId,

      presetId: fixture.presetId,

      name: "Foreign Group",

      description: null,

      presetOptionIds: [options.captainId],

      channelId: null,

      notifyRole: null,

      requiresPositiveSignup: false,

      openMinutesBeforeStart: 60,

      closeMinutesBeforeStart: 0,
    });

    // Assert
    expect(result).toEqual({
      kind: "preset_not_found",
    });

    await expectNoPresetGroups(pool, fixture.presetId);
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

async function createPresetOptions(
  pool: Pool,
  presetId: number,
): Promise<{
  captainId: number;

  carpenterId: number;
}> {
  const result = await pool.query<{
    id: number;

    key: string;
  }>(
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
        VALUES
          (
            $1,
            'captain',
            'Captain',
            'open',
            0,
            true
          ),
          (
            $1,
            'carpenter',
            'Carpenter',
            'open',
            1,
            true
          )
        RETURNING
          "id",
          "key"
      `,
    [presetId],
  );

  const captainId = result.rows.find((option) => option.key === "captain")?.id;

  const carpenterId = result.rows.find(
    (option) => option.key === "carpenter",
  )?.id;

  if (!captainId || !carpenterId) {
    throw new Error("The integration-test preset options were not created.");
  }

  return {
    captainId,

    carpenterId,
  };
}

async function expectNoPresetGroups(
  pool: Pool,
  presetId: number,
): Promise<void> {
  const result = await pool.query<{
    groups: number;

    mappings: number;
  }>(
    `
        SELECT
          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_groups"
            WHERE
              "preset_id" = $1
          ) AS "groups",

          (
            SELECT
              COUNT(*)::int
            FROM
              "role_request_preset_group_options"
            INNER JOIN
              "role_request_preset_groups"
            ON
              "role_request_preset_groups"."id" =
                "role_request_preset_group_options"."group_id"
            WHERE
              "role_request_preset_groups"."preset_id" = $1
          ) AS "mappings"
      `,
    [presetId],
  );

  expect(result.rows).toEqual([
    {
      groups: 0,

      mappings: 0,
    },
  ]);
}
