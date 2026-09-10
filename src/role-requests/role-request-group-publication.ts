import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";

import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { TransactionRollbackError } from "drizzle-orm/errors";

import { db } from "../db/client.js";

import { discordGuilds, events, roleRequestGroups } from "../db/schema.js";

import { buildRoleRequestGroupMessagePayload } from "./role-request-message.js";

export type RoleRequestGroupNotificationDelivery =
  | {
      kind: "none";
    }
  | {
      kind: "pinged";

      roleId: string;

      roleNameSnapshot: string | null;
    }
  | {
      kind: "skipped";

      roleId: string;

      roleNameSnapshot: string | null;

      reason: "missing-role" | "not-mentionable" | "everyone-not-allowed";
    };

export type PublishRoleRequestGroupResult =
  | {
      ok: true;

      eventId: number;

      groupId: number;

      messageId: string;

      messageUrl: string;

      notification: RoleRequestGroupNotificationDelivery;
    }
  | {
      ok: false;

      reason: "not-found";
    }
  | {
      ok: false;

      reason: "already-posted";

      eventId: number;

      groupId: number;

      messageId: string;
    }
  | {
      ok: false;

      reason: "inactive";

      eventId: number;

      groupId: number;
    }
  | {
      ok: false;

      reason: "not-open-yet";

      eventId: number;

      groupId: number;

      opensAt: Date;
    }
  | {
      ok: false;

      reason: "awaiting-event-publication";

      eventId: number;

      groupId: number;
    }
  | {
      ok: false;

      reason: "window-expired";

      eventId: number;

      groupId: number;
    }
  | {
      ok: false;

      reason: "channel-unavailable";

      eventId: number;

      groupId: number;

      channelId: string;
    };

type LoadedRoleRequestGroup = {
  id: number;

  eventId: number;

  eventStatus: "scheduled" | "open" | "closed" | "cancelled" | "completed";

  eventPublishedAt: Date | null;

  eventPublishMinutesBeforeStart: number | null;

  eventStartsAt: Date;

  channelId: string;

  messageId: string | null;

  notifyRoleId: string | null;

  notifyRoleNameSnapshot: string | null;

  opensAt: Date;

  closesAt: Date;

  closedAt: Date | null;
};

/**
 * Publishes the Discord presentation for one already-existing
 * role-request group.
 *
 * The role-request group itself is authoritative PostgreSQL state.
 * Discord failure must therefore never cause this service to delete the
 * group or its option mappings.
 *
 * The same service is suitable for scheduled opening and for any future
 * explicit "open now" administration operation.
 */
export async function publishRoleRequestGroup(
  guild: Guild,
  groupId: number,
): Promise<PublishRoleRequestGroupResult> {
  const initialGroup = await loadRoleRequestGroup(guild.id, groupId);

  if (!initialGroup) {
    return {
      ok: false,

      reason: "not-found",
    };
  }

  const initialState = classifyUnpublishableState(initialGroup, new Date());

  if (initialState) {
    return initialState;
  }

  const channel = await guild.channels
    .fetch(initialGroup.channelId)
    .catch((error: unknown) => {
      if (isUnknownChannelError(error)) {
        return null;
      }

      throw error;
    });

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    !channel.isSendable()
  ) {
    return {
      ok: false,

      reason: "channel-unavailable",

      eventId: initialGroup.eventId,

      groupId: initialGroup.id,

      channelId: initialGroup.channelId,
    };
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());

  const permissions = channel.permissionsFor(botMember);

  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,

    PermissionFlagsBits.SendMessages,

    PermissionFlagsBits.EmbedLinks,

    PermissionFlagsBits.ReadMessageHistory,
  ];

  if (requiredPermissions.some((permission) => !permissions.has(permission))) {
    return {
      ok: false,

      reason: "channel-unavailable",

      eventId: initialGroup.eventId,

      groupId: initialGroup.id,

      channelId: initialGroup.channelId,
    };
  }

  const notification = await resolveNotificationDelivery(
    guild,
    initialGroup,
    permissions,
  );

  /*
   * Channel and role lookups crossed the Discord boundary.
   *
   * Re-read before sending so obvious lifecycle/configuration changes which
   * happened during those external calls do not use the stale initial
   * snapshot.
   */
  const currentGroup = await loadRoleRequestGroup(guild.id, groupId);

  if (!currentGroup) {
    return {
      ok: false,

      reason: "not-found",
    };
  }

  const currentState = classifyUnpublishableState(currentGroup, new Date());

  if (currentState) {
    return currentState;
  }

  /*
   * Do not send to a channel which stopped being authoritative while Discord
   * lookups were in flight.
   *
   * Returning a normal permanent result would allow a scheduler action to
   * complete and strand the group. Throw instead so the durable action can
   * retry against the newly authoritative state.
   */
  if (currentGroup.channelId !== initialGroup.channelId) {
    throw new Error(
      `Role-request group ${groupId} changed channel while publication was in flight.`,
    );
  }

  const payload = await buildRoleRequestGroupMessagePayload(groupId);

  let sentMessage: {
    id: string;

    url: string;

    delete: () => Promise<unknown>;
  } | null = null;

  try {
    sentMessage = await channel.send({
      content:
        notification.kind === "pinged"
          ? `<@&${notification.roleId}>`
          : undefined,

      ...payload,

      allowedMentions: {
        parse: [],

        roles: notification.kind === "pinged" ? [notification.roleId] : [],
      },
    });

    const linkageTime = new Date();

    let linkageClaimed = false;

    try {
      linkageClaimed = await db.transaction(async (transaction) => {
        /*
         * Match the existing role-request close lock ordering:
         *
         * 1. acquire/mutate the group;
         * 2. re-read and lock the parent event.
         *
         * Keeping one ordering avoids introducing a new group/event
         * deadlock pattern.
         */
        const [claimedGroup] = await transaction
          .update(roleRequestGroups)
          .set({
            messageId: sentMessage!.id,

            updatedAt: linkageTime,
          })
          .where(
            and(
              eq(roleRequestGroups.id, currentGroup.id),

              eq(roleRequestGroups.eventId, currentGroup.eventId),

              eq(roleRequestGroups.channelId, currentGroup.channelId),

              isNull(roleRequestGroups.messageId),

              isNull(roleRequestGroups.closedAt),

              lte(roleRequestGroups.opensAt, linkageTime),

              gt(roleRequestGroups.closesAt, linkageTime),
            ),
          )
          .returning({
            id: roleRequestGroups.id,
          });

        if (!claimedGroup) {
          return false;
        }

        /*
         * The Discord send happened before this transaction.
         *
         * If event cancellation/completion already won, roll the message
         * linkage back. If the event is still active, FOR UPDATE fences
         * a terminal transition until this publication claim commits.
         */
        const [currentEvent] = await transaction
          .select({
            status: events.status,

            publishedAt: events.publishedAt,

            publishMinutesBeforeStart: events.publishMinutesBeforeStart,

            startsAt: events.startsAt,
          })
          .from(events)
          .where(eq(events.id, currentGroup.eventId))
          .for("update")
          .limit(1);

        if (!currentEvent) {
          transaction.rollback();

          /*
           * Drizzle rollback throws at runtime, but its TypeScript signature does not
           * tell the compiler that execution cannot continue. Keep this unreachable
           * throw so currentEvent is correctly narrowed below.
           */
          throw new Error(
            `Role-request group ${currentGroup.id} lost its parent event while claiming Discord message linkage.`,
          );
        }

        if (
          currentEvent.status === "cancelled" ||
          currentEvent.status === "completed"
        ) {
          transaction.rollback();
        }

        if (
          isAwaitingEventPublication(
            {
              eventPublishedAt: currentEvent.publishedAt,

              eventPublishMinutesBeforeStart:
                currentEvent.publishMinutesBeforeStart,

              eventStartsAt: currentEvent.startsAt,
            },

            linkageTime,
          )
        ) {
          transaction.rollback();
        }

        return true;
      });
    } catch (error) {
      /*
       * rollback() above represents an authoritative state change winning
       * while Discord publication was in flight.
       *
       * Remove our stale candidate, then classify the latest state rather
       * than assuming every rollback means terminal event lifecycle.
       */
      if (error instanceof TransactionRollbackError) {
        await deleteUnlinkedMessage(sentMessage, currentGroup.id);

        sentMessage = null;

        const latestGroup = await loadRoleRequestGroup(guild.id, groupId);

        if (!latestGroup) {
          return {
            ok: false,

            reason: "not-found",
          };
        }

        const latestState = classifyUnpublishableState(latestGroup, new Date());

        if (latestState) {
          return latestState;
        }

        /*
         * The state changed again after the rollback and is publishable once
         * more. Treat that as retryable rather than claiming the stale Discord
         * candidate we already removed.
         */
        throw new Error(
          `Role-request group ${groupId} became publishable again after losing its in-flight publication claim.`,
        );
      }

      throw error;
    }

    if (!linkageClaimed) {
      /*
       * Another publisher or lifecycle mutation won after our last read.
       *
       * PostgreSQL remains authoritative, so the Discord message which lost
       * that claim must not be left behind as an untracked duplicate.
       */
      await deleteUnlinkedMessage(sentMessage, currentGroup.id);

      sentMessage = null;

      const latestGroup = await loadRoleRequestGroup(guild.id, groupId);

      if (!latestGroup) {
        return {
          ok: false,

          reason: "not-found",
        };
      }

      const latestState = classifyUnpublishableState(latestGroup, new Date());

      if (latestState) {
        return latestState;
      }

      /*
       * The group is still publishable but our exact linkage predicate lost
       * for some other authoritative change, such as a destination edit.
       *
       * This is retryable rather than obsolete.
       */
      throw new Error(
        `Role-request group ${groupId} changed while Discord publication was in flight.`,
      );
    }

    return {
      ok: true,

      eventId: currentGroup.eventId,

      groupId: currentGroup.id,

      messageId: sentMessage.id,

      messageUrl: sentMessage.url,

      notification,
    };
  } catch (error) {
    if (sentMessage) {
      await deleteUnlinkedMessage(sentMessage, currentGroup.id);
    }

    throw error;
  }
}

async function loadRoleRequestGroup(
  discordGuildId: string,
  groupId: number,
): Promise<LoadedRoleRequestGroup | null> {
  const [group] = await db
    .select({
      id: roleRequestGroups.id,

      eventId: roleRequestGroups.eventId,

      eventStatus: events.status,

      eventPublishedAt: events.publishedAt,

      eventPublishMinutesBeforeStart: events.publishMinutesBeforeStart,

      eventStartsAt: events.startsAt,

      channelId: roleRequestGroups.channelId,

      messageId: roleRequestGroups.messageId,

      notifyRoleId: roleRequestGroups.notifyRoleId,

      notifyRoleNameSnapshot: roleRequestGroups.notifyRoleNameSnapshot,

      opensAt: roleRequestGroups.opensAt,

      closesAt: roleRequestGroups.closesAt,

      closedAt: roleRequestGroups.closedAt,
    })
    .from(roleRequestGroups)
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(roleRequestGroups.id, groupId),

        eq(discordGuilds.discordGuildId, discordGuildId),
      ),
    )
    .limit(1);

  return group ?? null;
}

function classifyUnpublishableState(
  group: LoadedRoleRequestGroup,
  now: Date,
): PublishRoleRequestGroupResult | null {
  if (group.messageId) {
    return {
      ok: false,

      reason: "already-posted",

      eventId: group.eventId,

      groupId: group.id,

      messageId: group.messageId,
    };
  }

  if (group.eventStatus === "cancelled" || group.eventStatus === "completed") {
    return {
      ok: false,

      reason: "inactive",

      eventId: group.eventId,

      groupId: group.id,
    };
  }

  if (group.closedAt !== null || group.closesAt <= now) {
    return {
      ok: false,

      reason: "window-expired",

      eventId: group.eventId,

      groupId: group.id,
    };
  }

  if (group.opensAt > now) {
    return {
      ok: false,

      reason: "not-open-yet",

      eventId: group.eventId,

      groupId: group.id,

      opensAt: group.opensAt,
    };
  }

  if (isAwaitingEventPublication(group, now)) {
    return {
      ok: false,

      reason: "awaiting-event-publication",

      eventId: group.eventId,

      groupId: group.id,
    };
  }

  return null;
}

function isAwaitingEventPublication(
  group: Pick<
    LoadedRoleRequestGroup,
    "eventPublishedAt" | "eventPublishMinutesBeforeStart" | "eventStartsAt"
  >,
  now: Date,
): boolean {
  /*
   * Once the main event is published there is no publication gate left.
   */
  if (group.eventPublishedAt !== null) {
    return false;
  }

  /*
   * An unpublished event with no scheduled publication offset is being held
   * for explicit manual publication.
   *
   * Automatic role-request groups must not independently expose that event.
   */
  if (group.eventPublishMinutesBeforeStart === null) {
    return true;
  }

  const scheduledPublicationAt = new Date(
    group.eventStartsAt.getTime() -
      group.eventPublishMinutesBeforeStart * 60_000,
  );

  /*
   * A role group may intentionally precede a future scheduled event
   * publication.
   *
   * Once the scheduled event publication time itself has arrived, however,
   * the main event should be public first. If it is still unpublished, later
   * automatic role-group publication waits for that problem to resolve.
   */
  return scheduledPublicationAt <= now;
}

async function resolveNotificationDelivery(
  guild: Guild,
  group: LoadedRoleRequestGroup,
  permissions: {
    has: (permission: bigint) => boolean;
  },
): Promise<RoleRequestGroupNotificationDelivery> {
  if (!group.notifyRoleId) {
    return {
      kind: "none",
    };
  }

  /*
   * Preset administration should reject @everyone up front, but publication
   * remains defensive against malformed/legacy rows.
   */
  if (group.notifyRoleId === guild.id) {
    return {
      kind: "skipped",

      roleId: group.notifyRoleId,

      roleNameSnapshot: group.notifyRoleNameSnapshot,

      reason: "everyone-not-allowed",
    };
  }

  const role = await guild.roles
    .fetch(group.notifyRoleId)
    .catch((error: unknown) => {
      if (isUnknownRoleError(error)) {
        return null;
      }

      throw error;
    });

  if (!role) {
    return {
      kind: "skipped",

      roleId: group.notifyRoleId,

      roleNameSnapshot: group.notifyRoleNameSnapshot,

      reason: "missing-role",
    };
  }

  if (
    !role.mentionable &&
    !permissions.has(PermissionFlagsBits.MentionEveryone)
  ) {
    return {
      kind: "skipped",

      roleId: group.notifyRoleId,

      roleNameSnapshot: group.notifyRoleNameSnapshot,

      reason: "not-mentionable",
    };
  }

  return {
    kind: "pinged",

    roleId: group.notifyRoleId,

    roleNameSnapshot: group.notifyRoleNameSnapshot,
  };
}

async function deleteUnlinkedMessage(
  message: {
    id: string;

    delete: () => Promise<unknown>;
  },
  groupId: number,
): Promise<void> {
  await message.delete().catch((cleanupError: unknown) => {
    console.error(
      `Failed to delete unlinked role-request group message ${message.id} for group ${groupId}:`,
      cleanupError,
    );
  });
}

function isUnknownChannelError(error: unknown): boolean {
  return hasDiscordErrorCode(error, 10003);
}

function isUnknownRoleError(error: unknown): boolean {
  return hasDiscordErrorCode(error, 10011);
}

function hasDiscordErrorCode(error: unknown, expectedCode: number): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (
    (
      error as {
        code?: unknown;
      }
    ).code === expectedCode
  );
}
