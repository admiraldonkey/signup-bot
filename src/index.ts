import "dotenv/config";

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

import { commandDefinitions } from "./commands/definitions.js";
import { handleChatInputCommand } from "./commands/router.js";
import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { handleAttendanceButton } from "./interactions/attendance-button.js";
import { handleAttendanceAutocomplete } from "./interactions/attendance-autocomplete.js";
import { handleEventAutocomplete } from "./interactions/event-autocomplete.js";
import {
  startEventScheduler,
  stopEventScheduler,
} from "./scheduler/event-scheduler.js";

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  throw new Error("DISCORD_TOKEN is not configured.");
}

if (!guildId) {
  throw new Error("DISCORD_GUILD_ID is not configured.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(guildId);

    await guild.commands.set(commandDefinitions);

    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Registered commands in ${guild.name}`);
    startEventScheduler(readyClient);
  } catch (error) {
    console.error("Failed to register guild commands:", error);
    process.exitCode = 1;
    client.destroy();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  /*
   * Autocomplete has its own response method and error handling.
   */
  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === "event") {
        await handleEventAutocomplete(interaction);
        return;
      }

      if (interaction.commandName === "attendance") {
        await handleAttendanceAutocomplete(interaction);
        return;
      }

      await interaction.respond([]);
    } catch (error) {
      console.error(
        `Autocomplete for ${interaction.commandName} failed:`,
        error,
      );

      if (!interaction.responded) {
        await interaction.respond([]).catch((responseError: unknown) => {
          console.error(
            "Failed to send empty autocomplete response:",
            responseError,
          );
        });
      }
    }

    return;
  }

  /*
   * Buttons are global interactions. The handler returns false if
   * the custom ID belongs to some future, unrelated feature.
   */
  if (interaction.isButton()) {
    try {
      await handleAttendanceButton(interaction);
    } catch (error) {
      console.error(`Button ${interaction.customId} failed:`, error);

      const content =
        "❌ Your response could not be completed. " +
        "The event administrators can check the bot logs.";

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(content);
        } else {
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (responseError) {
        console.error("Failed to send button error response:", responseError);
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    await handleChatInputCommand(interaction, client.ws.ping);
  } catch (error) {
    console.error(`Command ${interaction.commandName} failed:`, error);

    const content =
      "❌ The command could not be completed. " +
      "Check the bot logs for the underlying error.";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (responseError) {
      console.error("Failed to send command error response:", responseError);
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

  stopEventScheduler();

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
  await runMigrations();
  await client.login(token);
}

start().catch(async (error: unknown) => {
  console.error("Bot startup failed:", error);

  try {
    await pool.end();
  } catch {
    // Preserve the original startup error.
  }

  process.exit(1);
});
