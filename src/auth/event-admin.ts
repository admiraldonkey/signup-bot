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

      eventAdminChannelId: guildSettings.eventAdminChannelId,

      eventOrganiserRoleId: guildSettings.eventOrganiserRoleId,

      organiserPrimaryResponseMinutes:
        guildSettings.organiserPrimaryResponseMinutes,

      organiserBackupResponseMinutes:
        guildSettings.organiserBackupResponseMinutes,

      organiserWarningMinutesBefore:
        guildSettings.organiserWarningMinutesBefore,

      botLogChannelId: guildSettings.botLogChannelId,
    })
    .from(discordGuilds)
    .leftJoin(guildSettings, eq(guildSettings.guildId, discordGuilds.id))
    .where(eq(discordGuilds.discordGuildId, discordGuildId))
    .limit(1);

  if (!configuration) {
    return null;
  }

  return {
    ...configuration,

    organiserPrimaryResponseMinutes:
      configuration.organiserPrimaryResponseMinutes ?? 80,

    organiserBackupResponseMinutes:
      configuration.organiserBackupResponseMinutes ?? 40,

    organiserWarningMinutesBefore:
      configuration.organiserWarningMinutesBefore ?? 15,
  };
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
