import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import { pool } from "../db/client.js";

export async function handleDbCheckCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
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

  const result = await pool.query<{
    database_name: string;
    database_time: Date;
    event_count: number;
    table_count: number;
  }>(`
    SELECT
      current_database() AS database_name,
      NOW() AS database_time,
      (
        SELECT COUNT(*)::int
        FROM public.events
      ) AS event_count,
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
      `Database time: <t:${Math.floor(row.database_time.getTime() / 1000)}:F>`,
      `Application tables: **${row.table_count}**`,
      `Stored events: **${row.event_count}**`,
    ].join("\n"),
  );
}
