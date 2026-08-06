import "dotenv/config";

import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  throw new Error("DISCORD_TOKEN is not configured.");
}

if (!guildId) {
  throw new Error("DISCORD_GUILD_ID is not configured.");
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Checks whether the event bot is online.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("dbcheck")
    .setDescription("Checks the bot's PostgreSQL connection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(guildId);

    // Guild commands update immediately, which is useful during development.
    await guild.commands.set(commands);

    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Registered commands in ${guild.name}`);
  } catch (error) {
    console.error("Failed to register guild commands:", error);
    process.exitCode = 1;
    client.destroy();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "ping") {
    await interaction.reply({
      content:
        `Pong. The bot is online with ` +
        `${client.ws.ping} ms Gateway latency.`,
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  if (interaction.commandName === "dbcheck") {
    /*
     * The command definition hides this from ordinary members by default,
     * but the runtime check prevents accidental access if Discord-side
     * permissions are later changed.
     */
    if (
      !interaction.inGuild() ||
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    ) {
      await interaction.reply({
        content: "You need the Manage Server permission to run this command.",
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const result = await pool.query<{
        database_name: string;
        database_time: Date;
        event_count: number;
        table_count: number;
      }>(`
        SELECT
          current_database() AS database_name,
          NOW() AS database_time,
          (SELECT COUNT(*)::int FROM public.events) AS event_count,
          (
            SELECT COUNT(*)::int
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
          ) AS table_count
      `);

      const row = result.rows[0];

      if (!row) {
        throw new Error("PostgreSQL returned no diagnostic row.");
      }

      await interaction.editReply(
        [
          "✅ PostgreSQL connection successful.",
          `Database: \`${row.database_name}\``,
          `Database time: <t:${Math.floor(
            row.database_time.getTime() / 1000,
          )}:F>`,
          `Application tables: **${row.table_count}**`,
          `Stored events: **${row.event_count}**`,
        ].join("\n"),
      );
    } catch (error) {
      console.error("Database check failed:", error);

      await interaction.editReply(
        "❌ The bot could not complete the database check. " +
          "See the Northflank deployment logs for the underlying error.",
      );
    }
  }
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

let shuttingDown = false;

async function shutDown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`Received ${signal}; shutting down cleanly.`);

  client.destroy();

  try {
    await pool.end();
  } catch (error) {
    console.error("Failed to close the PostgreSQL pool:", error);
  }

  process.exit(0);
}

process.once("SIGINT", () => {
  void shutDown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutDown("SIGTERM");
});

async function start(): Promise<void> {
  /*
   * Do not connect to Discord until the database schema is usable.
   * This prevents the bot appearing online but failing every useful command.
   */
  await runMigrations();
  await client.login(token);
}

start().catch(async (error: unknown) => {
  console.error("Bot startup failed:", error);

  try {
    await pool.end();
  } catch {
    // The original startup error is the useful one.
  }

  process.exit(1);
});
