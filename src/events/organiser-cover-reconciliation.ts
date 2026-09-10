import { ChannelType, type Guild } from "discord.js";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventMessages, events } from "../db/schema.js";
import { isDiscordErrorCode } from "../discord/discord-errors.js";

export type OrganiserCoverResolution =
  | {
      kind: "claimed";

      organiserUserId: string;
    }
  | {
      kind: "active_assignment";
    }
  | {
      kind: "superseded_at_start";
    }
  | {
      kind: "organisers_disabled";
    }
  | {
      kind: "event_cancelled";
    }
  | {
      kind: "event_completed";
    };

export type OrganiserCoverReconciliationScope = "all" | "cover_only";

export async function reconcileOrganiserCoverMessages(input: {
  guild: Guild;

  eventId: number;

  resolution: OrganiserCoverResolution;

  scope?: OrganiserCoverReconciliationScope;
}): Promise<number> {
  const [event] = await db
    .select({
      id: events.id,

      name: events.name,
    })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);

  if (!event) {
    return 0;
  }

  const kinds =
    input.scope === "cover_only"
      ? (["organiser_cover"] as const)
      : (["organiser_cover", "organiser_missing_at_start"] as const);

  const messages = await db
    .select({
      id: eventMessages.id,

      channelId: eventMessages.channelId,

      messageId: eventMessages.messageId,

      kind: eventMessages.kind,
    })
    .from(eventMessages)
    .where(
      and(
        eq(eventMessages.eventId, input.eventId),

        inArray(eventMessages.kind, [...kinds]),

        isNull(eventMessages.resolvedAt),

        isNull(eventMessages.deletedAt),
      ),
    );

  let resolvedCount = 0;

  for (const trackedMessage of messages) {
    const resolved = await reconcileTrackedOrganiserCoverMessage({
      guild: input.guild,

      event: {
        id: event.id,

        name: event.name,
      },

      trackedMessage,

      resolution: input.resolution,
    });

    if (resolved) {
      resolvedCount += 1;
    }
  }

  return resolvedCount;
}

async function reconcileTrackedOrganiserCoverMessage(input: {
  guild: Guild;

  event: {
    id: number;

    name: string;
  };

  trackedMessage: {
    id: number;

    channelId: string;

    messageId: string;

    kind:
      | "attendance"
      | "role_request"
      | "reminder"
      | "admin_summary"
      | "organiser_cover"
      | "organiser_missing_at_start";
  };

  resolution: OrganiserCoverResolution;
}): Promise<boolean> {
  let channel;

  try {
    channel = await input.guild.channels.fetch(input.trackedMessage.channelId);
  } catch (error: unknown) {
    if (isDiscordErrorCode(error, 10003)) {
      await markTrackedMessageDeleted(input.trackedMessage.id);

      return true;
    }

    throw error;
  }

  if (!channel || channel.type !== ChannelType.GuildText) {
    /*
     * The message was originally posted to a guild text channel. If that
     * destination can no longer be represented as one, there is no useful
     * Discord presentation left to reconcile.
     */
    await markTrackedMessageDeleted(input.trackedMessage.id);

    return true;
  }

  let message;

  try {
    message = await channel.messages.fetch(input.trackedMessage.messageId);
  } catch (error: unknown) {
    if (isDiscordErrorCode(error, 10008)) {
      await markTrackedMessageDeleted(input.trackedMessage.id);

      return true;
    }

    throw error;
  }

  await message.edit({
    content: buildResolvedOrganiserCoverContent({
      eventId: input.event.id,

      eventName: input.event.name,

      resolution: input.resolution,
    }),

    components: [],

    allowedMentions: {
      parse: [],
    },
  });

  const now = new Date();

  await db
    .update(eventMessages)
    .set({
      resolvedAt: now,
    })
    .where(
      and(
        eq(eventMessages.id, input.trackedMessage.id),

        isNull(eventMessages.resolvedAt),
      ),
    );

  return true;
}

async function markTrackedMessageDeleted(messageRowId: number): Promise<void> {
  const now = new Date();

  await db
    .update(eventMessages)
    .set({
      resolvedAt: now,

      deletedAt: now,
    })
    .where(
      and(
        eq(eventMessages.id, messageRowId),

        isNull(eventMessages.resolvedAt),
      ),
    );
}

function buildResolvedOrganiserCoverContent(input: {
  eventId: number;

  eventName: string;

  resolution: OrganiserCoverResolution;
}): string {
  const eventReference = `**${input.eventName}** (#${input.eventId})`;

  switch (input.resolution.kind) {
    case "claimed":
      return [
        "✅ **Organiser cover resolved**",

        "",

        `Cover was claimed by <@${input.resolution.organiserUserId}> for ${eventReference}.`,
      ].join("\n");

    case "active_assignment":
      return [
        "ℹ️ **Organiser cover no longer required**",

        "",

        `${eventReference} now has an active organiser assignment.`,
      ].join("\n");

    case "superseded_at_start":
      return [
        "ℹ️ **Organiser cover request superseded**",

        "",

        `This earlier cover request for ${eventReference} has been superseded by the event-start organiser alert.`,
      ].join("\n");

    case "organisers_disabled":
      return [
        "ℹ️ **Organiser cover no longer required**",

        "",

        `Organiser workflows have been disabled for ${eventReference}.`,
      ].join("\n");

    case "event_cancelled":
      return [
        "🚫 **Organiser cover no longer required**",

        "",

        `${eventReference} has been cancelled.`,
      ].join("\n");

    case "event_completed":
      return [
        "🏁 **Organiser cover no longer required**",

        "",

        `${eventReference} has completed.`,
      ].join("\n");
  }
}
