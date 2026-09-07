import { ChannelType, type Guild } from "discord.js";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventOrganiserAssignments, events } from "../db/schema.js";
import { isDiscordErrorCode } from "../discord/discord-errors.js";
import type {
  OrganiserAssignmentSlot,
  OrganiserAssignmentStatus,
} from "../organisers/organiser-types.js";

import { formatOrganiserSlot } from "./organiser-formatting.js";

export async function reconcileOrganiserPendingWarning(input: {
  guild: Guild;

  assignmentId: number;
}): Promise<boolean> {
  const [assignment] = await db
    .select({
      eventId: eventOrganiserAssignments.eventId,

      discordUserId: eventOrganiserAssignments.discordUserId,

      slot: eventOrganiserAssignments.slot,

      status: eventOrganiserAssignments.status,

      isCurrent: eventOrganiserAssignments.isCurrent,

      warningChannelId: eventOrganiserAssignments.warningChannelId,

      warningMessageId: eventOrganiserAssignments.warningMessageId,

      eventName: events.name,

      eventStatus: events.status,
    })
    .from(eventOrganiserAssignments)
    .innerJoin(events, eq(events.id, eventOrganiserAssignments.eventId))
    .where(eq(eventOrganiserAssignments.id, input.assignmentId))
    .limit(1);

  if (
    !assignment ||
    !assignment.warningChannelId ||
    !assignment.warningMessageId
  ) {
    return false;
  }

  /*
   * There is nothing to reconcile while this is still the live pending
   * assignment for an active event.
   */
  if (
    assignment.isCurrent &&
    assignment.status === "pending" &&
    assignment.eventStatus !== "cancelled" &&
    assignment.eventStatus !== "completed"
  ) {
    return false;
  }

  let channel;

  try {
    channel = await input.guild.channels.fetch(assignment.warningChannelId);
  } catch (error: unknown) {
    if (isDiscordErrorCode(error, 10003)) {
      return false;
    }

    throw error;
  }

  if (!channel || channel.type !== ChannelType.GuildText) {
    return false;
  }

  let message;

  try {
    message = await channel.messages.fetch(assignment.warningMessageId);
  } catch (error: unknown) {
    /*
     * Someone may have manually removed the warning. The stale UI no longer
     * exists, so there is nothing left to reconcile.
     */
    if (isDiscordErrorCode(error, 10008)) {
      return false;
    }

    throw error;
  }

  await message.edit({
    content: buildResolvedOrganiserWarningContent(assignment),

    allowedMentions: {
      parse: [],
    },
  });

  return true;
}

function buildResolvedOrganiserWarningContent(assignment: {
  eventId: number;

  eventName: string;

  discordUserId: string;

  slot: OrganiserAssignmentSlot;

  status: OrganiserAssignmentStatus;

  eventStatus: "scheduled" | "open" | "closed" | "cancelled" | "completed";
}): string {
  const slotLabel = formatOrganiserSlot(assignment.slot);

  if (
    assignment.eventStatus === "cancelled" ||
    assignment.eventStatus === "completed"
  ) {
    return [
      "ℹ️ **Organiser response no longer required**",

      "",

      `The **${slotLabel}** response request for <@${assignment.discordUserId}> on **${assignment.eventName}** (#${assignment.eventId}) is no longer active because the event is **${assignment.eventStatus}**.`,
    ].join("\n");
  }

  switch (assignment.status) {
    case "confirmed":
      return [
        "✅ **Organiser response resolved**",

        "",

        `<@${assignment.discordUserId}> has confirmed as the **${slotLabel}** for **${assignment.eventName}** (#${assignment.eventId}).`,
      ].join("\n");

    case "declined":
      return [
        "❌ **Organiser response resolved**",

        "",

        `<@${assignment.discordUserId}> declined the **${slotLabel}** assignment for **${assignment.eventName}** (#${assignment.eventId}).`,
      ].join("\n");

    case "timed_out":
      return [
        "⌛ **Organiser response deadline passed**",

        "",

        `<@${assignment.discordUserId}> did not confirm the **${slotLabel}** assignment for **${assignment.eventName}** (#${assignment.eventId}) before the response deadline.`,
      ].join("\n");

    case "replaced":
    case "removed":
      return [
        "ℹ️ **Organiser response no longer required**",

        "",

        `The **${slotLabel}** assignment for <@${assignment.discordUserId}> on **${assignment.eventName}** (#${assignment.eventId}) is no longer current.`,
      ].join("\n");

    case "pending":
      /*
       * A pending assignment reaches this builder only when another state,
       * such as event cancellation/completion, already made it obsolete.
       */
      return [
        "ℹ️ **Organiser response no longer required**",

        "",

        `The **${slotLabel}** response request for <@${assignment.discordUserId}> on **${assignment.eventName}** (#${assignment.eventId}) is no longer active.`,
      ].join("\n");
  }
}
