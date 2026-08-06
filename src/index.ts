import "dotenv/config";

import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";

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
    .setDescription("Checks whether the naval event bot is online.")
    .toJSON(),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(guildId);

    // Guild commands update quickly, making them ideal during development.
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
      content: `Pong. The bot is online with ${client.ws.ping} ms Gateway latency.`,
      flags: MessageFlags.Ephemeral,
    });
  }
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

function shutDown(signal: string): void {
  console.log(`Received ${signal}; shutting down cleanly.`);
  client.destroy();
  process.exit(0);
}

process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));

await client.login(token);
