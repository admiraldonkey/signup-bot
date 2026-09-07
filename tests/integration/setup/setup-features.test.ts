import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { handleSetupCommand } from "../../../src/commands/setup.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "910000000000000001";
const ADMIN_USER_ID = "910000000000000002";
const EVENT_ADMIN_CHANNEL_ID = "910000000000000003";

describe("setup feature configuration", () => {
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

  it("denies feature configuration without Manage Server permission", async () => {
    // Arrange
    const guildId = await createConfiguredGuild(pool, {
      organiserDmsEnabled: true,
      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,
    });

    const interaction = createSetupInteraction({
      subcommand: "features",
      feature: "organiser-dms",
      enabled: false,
      hasManageGuild: false,
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
    const settingsResult = await pool.query<{
      organiser_dms_enabled: boolean;
    }>(
      `
        SELECT "organiser_dms_enabled"
        FROM "guild_settings"
        WHERE "guild_id" = $1
      `,
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organiser_dms_enabled: true,
      },
    ]);

    expect(interaction.reply).toHaveBeenCalledTimes(1);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need the Manage Server permission to configure the bot.",

      flags: MessageFlags.Ephemeral,
    });

    /*
     * Permission denial happens before the command enters its normal
     * deferred setup flow.
     */
    expect(interaction.deferReply).not.toHaveBeenCalled();

    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("allows a server administrator to disable organiser DMs", async () => {
    // Arrange
    const guildId = await createConfiguredGuild(pool, {
      organiserDmsEnabled: true,
      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,
    });

    const interaction = createSetupInteraction({
      subcommand: "features",
      feature: "organiser-dms",
      enabled: false,
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
    const settingsResult = await pool.query<{
      organiser_dms_enabled: boolean;
    }>(
      `
        SELECT "organiser_dms_enabled"
        FROM "guild_settings"
        WHERE "guild_id" = $1
      `,
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organiser_dms_enabled: false,
      },
    ]);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });

    expect(interaction.editReply).toHaveBeenCalledTimes(1);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Organiser DMs disabled"),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    const auditResult = await pool.query<{
      action: string;
      outcome: string;
      actor_user_id: string | null;
      target_id: string | null;
      feature: string | null;
      enabled: boolean | null;
      previous_value: boolean | null;
    }>(
      `
        SELECT
          "action",
          "outcome",
          "actor_user_id",
          "target_id",
          "details" ->> 'feature' AS "feature",
          ("details" ->> 'enabled')::boolean AS "enabled",
          ("details" ->> 'previousValue')::boolean AS "previous_value"
        FROM "audit_logs"
        WHERE "action" = 'setup.feature.update'
      `,
    );

    expect(auditResult.rows).toEqual([
      {
        action: "setup.feature.update",

        outcome: "success",

        actor_user_id: ADMIN_USER_ID,

        target_id: DISCORD_GUILD_ID,

        feature: "organiser-dms",

        enabled: false,

        previous_value: true,
      },
    ]);
  });

  it("allows a server administrator to re-enable organiser DMs", async () => {
    // Arrange
    const guildId = await createConfiguredGuild(pool, {
      organiserDmsEnabled: false,
      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,
    });

    const interaction = createSetupInteraction({
      subcommand: "features",
      feature: "organiser-dms",
      enabled: true,
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
    const settingsResult = await pool.query<{
      organiser_dms_enabled: boolean;
    }>(
      `
        SELECT "organiser_dms_enabled"
        FROM "guild_settings"
        WHERE "guild_id" = $1
      `,
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organiser_dms_enabled: true,
      },
    ]);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Organiser DMs enabled"),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    const auditResult = await pool.query<{
      enabled: boolean | null;
      previous_value: boolean | null;
    }>(
      `
        SELECT
          ("details" ->> 'enabled')::boolean AS "enabled",
          ("details" ->> 'previousValue')::boolean AS "previous_value"
        FROM "audit_logs"
        WHERE "action" = 'setup.feature.update'
      `,
    );

    expect(auditResult.rows).toEqual([
      {
        enabled: true,

        previous_value: false,
      },
    ]);
  });

  it("does not allow organiser DMs to be disabled without an Event Administration channel", async () => {
    // Arrange
    const guildId = await createConfiguredGuild(pool, {
      organiserDmsEnabled: true,
      eventAdminChannelId: null,
    });

    const interaction = createSetupInteraction({
      subcommand: "features",
      feature: "organiser-dms",
      enabled: false,
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
    const settingsResult = await pool.query<{
      organiser_dms_enabled: boolean;
    }>(
      `
        SELECT "organiser_dms_enabled"
        FROM "guild_settings"
        WHERE "guild_id" = $1
      `,
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organiser_dms_enabled: true,
      },
    ]);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "Organiser DMs cannot be disabled yet",
        ),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "Configure an Event Administration channel",
        ),
      }),
    );

    /*
     * A rejected configuration change must not create a success audit.
     */
    const auditResult = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "audit_logs"
        WHERE "action" = 'setup.feature.update'
      `,
    );

    expect(auditResult.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("shows the organiser feature states in setup status", async () => {
    // Arrange
    await createConfiguredGuild(pool, {
      organisersEnabled: false,
      organiserDmsEnabled: false,
      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,
    });

    const interaction = createSetupInteraction({
      subcommand: "status",
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
    expect(interaction.editReply).toHaveBeenCalledTimes(1);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("• Organiser DMs: Disabled"),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("• Organisers: Disabled"),
      }),
    );
  });

  it("uses enabled organiser defaults for new guild settings", async () => {
    // Arrange
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
      [DISCORD_GUILD_ID, "Integration Test Guild"],
    );

    const guildId = guildResult.rows[0]?.id;

    if (!guildId) {
      throw new Error("The integration-test guild was not created.");
    }

    /*
     * Deliberately omit both organiser feature settings. Existing/new guilds
     * should inherit the backwards-compatible enabled defaults from PostgreSQL.
     */
    await pool.query(
      `
        INSERT INTO "guild_settings" (
          "guild_id"
        )
        VALUES ($1)
      `,
      [guildId],
    );

    // Assert
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
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organisers_enabled: true,
        organiser_dms_enabled: true,
      },
    ]);
  });

  it("allows a server administrator to disable organisers", async () => {
    // Arrange
    const guildId = await createConfiguredGuild(pool, {
      organisersEnabled: true,

      organiserDmsEnabled: true,

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,
    });

    const interaction = createSetupInteraction({
      subcommand: "features",

      feature: "organisers",

      enabled: false,
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
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
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organisers_enabled: false,

        /*
         * Disabling the parent feature must not destroy the stored child
         * preference.
         */
        organiser_dms_enabled: true,
      },
    ]);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Organisers disabled"),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    const auditResult = await pool.query<{
      feature: string | null;
      enabled: boolean | null;
      previous_value: boolean | null;
    }>(
      `
        SELECT
          "details" ->> 'feature'
            AS "feature",

          ("details" ->> 'enabled')::boolean
            AS "enabled",

          ("details" ->> 'previousValue')::boolean
            AS "previous_value"
        FROM "audit_logs"
        WHERE "action" = 'setup.feature.update'
      `,
    );

    expect(auditResult.rows).toEqual([
      {
        feature: "organisers",

        enabled: false,

        previous_value: true,
      },
    ]);
  });

  it("allows a server administrator to re-enable organisers", async () => {
    // Arrange
    const guildId = await createConfiguredGuild(pool, {
      organisersEnabled: false,

      organiserDmsEnabled: false,

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,
    });

    const interaction = createSetupInteraction({
      subcommand: "features",

      feature: "organisers",

      enabled: true,
    });

    // Act
    await handleSetupCommand(interaction);

    // Assert
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
      [guildId],
    );

    expect(settingsResult.rows).toEqual([
      {
        organisers_enabled: true,

        /*
         * Re-enabling the parent restores availability without changing the
         * previously selected delivery preference.
         */
        organiser_dms_enabled: false,
      },
    ]);
  });
});

async function createConfiguredGuild(
  pool: Pool,
  input: {
    organisersEnabled?: boolean;
    organiserDmsEnabled: boolean;
    eventAdminChannelId: string | null;
  },
): Promise<number> {
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
    [DISCORD_GUILD_ID, "Integration Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "event_admin_channel_id",
        "organisers_enabled",
        "organiser_dms_enabled"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      guildId,
      input.eventAdminChannelId,
      input.organisersEnabled ?? true,
      input.organiserDmsEnabled,
    ],
  );

  return guildId;
}

function createSetupInteraction(input: {
  subcommand: "features" | "status";
  feature?: "organisers" | "organiser-dms";
  enabled?: boolean;
  hasManageGuild?: boolean;
}): ChatInputCommandInteraction {
  const hasManageGuild = input.hasManageGuild ?? true;

  const guild = {
    id: DISCORD_GUILD_ID,
  } as unknown as Guild;

  const interaction = {
    guildId: DISCORD_GUILD_ID,

    guild,

    user: {
      id: ADMIN_USER_ID,
    },

    memberPermissions: {
      has: vi.fn().mockReturnValue(hasManageGuild),
    },

    inGuild: vi.fn().mockReturnValue(true),

    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),

      getString: vi.fn((name: string) => {
        if (name === "feature") {
          return input.feature ?? null;
        }

        return null;
      }),

      getBoolean: vi.fn((name: string) => {
        if (name === "enabled") {
          return input.enabled ?? null;
        }

        return null;
      }),
    },

    reply: vi.fn().mockResolvedValue(undefined),

    deferReply: vi.fn().mockResolvedValue(undefined),

    editReply: vi.fn().mockResolvedValue(undefined),
  };

  /*
   * The test double intentionally implements only the Discord interaction
   * surface used by handleSetupCommand() and the two tested subcommands.
   */
  return interaction as unknown as ChatInputCommandInteraction;
}
