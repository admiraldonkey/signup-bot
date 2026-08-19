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
import { handleOrganiserButton } from "./interactions/organiser-button.js";
import { handleRoleRequestButton } from "./interactions/role-request-button.js";

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error("DISCORD_TOKEN is not configured.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await guild.commands.set(commandDefinitions);

      console.log(`Registered commands in ${guild.name} (${guild.id}).`);
    } catch (error) {
      console.error(`Failed to register commands in guild ${guild.id}:`, error);
    }
  }

  startEventScheduler(readyClient);
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
      let handled = await handleAttendanceButton(interaction);

      if (!handled) {
        handled = await handleOrganiserButton(interaction);
      }

      if (!handled) {
        handled = await handleRoleRequestButton(interaction);
      }

      if (!handled) {
        console.warn(`No button handler recognised ${interaction.customId}.`);
      }
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
