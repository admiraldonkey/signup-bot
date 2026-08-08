import { type GuildMember, PermissionFlagsBits } from "discord.js";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { discordGuilds, guildSettings } from "../db/schema.js";

export async function getGuildConfiguration(discordGuildId: string) {
  const [configuration] = await db
    .select({
      guildId: discordGuilds.id,
      guildName: discordGuilds.name,
      timezone: discordGuilds.timezone,
      enabled: discordGuilds.enabled,

      eventAdminRoleId: guildSettings.eventAdminRoleId,

      attendanceChannelId: guildSettings.defaultAttendanceChannelId,

      roleRequestChannelId: guildSettings.defaultRoleRequestChannelId,

      botLogChannelId: guildSettings.botLogChannelId,
    })
    .from(discordGuilds)
    .leftJoin(guildSettings, eq(guildSettings.guildId, discordGuilds.id))
    .where(eq(discordGuilds.discordGuildId, discordGuildId))
    .limit(1);

  return configuration ?? null;
}

export function memberCanManageEvents(
  member: GuildMember,
  eventAdminRoleId: string | null,
): boolean {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return Boolean(eventAdminRoleId && member.roles.cache.has(eventAdminRoleId));
}
