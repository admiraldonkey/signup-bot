import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Guild,
} from "discord.js";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  attendanceResponses,
  eventRoleOptions,
  events,
  roleRequestGroupOptions,
  roleRequestGroups,
  roleRequests,
} from "../db/schema.js";

export function buildRoleRequestAddCustomId(
  groupId: number,
  optionId: number,
): string {
  return `role-request:add:${groupId}:${optionId}`;
}

export function buildRoleRequestManageCustomId(eventId: number): string {
  return `role-request:manage:${eventId}`;
}

export function buildRoleRequestWithdrawCustomId(
  eventId: number,
  optionId: number,
): string {
  return `role-request:withdraw:${eventId}:${optionId}`;
}

export async function buildRoleRequestGroupMessagePayload(groupId: number) {
  const [group] = await db
    .select({
      id: roleRequestGroups.id,

      eventId: roleRequestGroups.eventId,

      name: roleRequestGroups.name,

      description: roleRequestGroups.description,

      requiresPositiveSignup: roleRequestGroups.requiresPositiveSignup,

      opensAt: roleRequestGroups.opensAt,

      closesAt: roleRequestGroups.closesAt,

      closedAt: roleRequestGroups.closedAt,

      eventName: events.name,

      signupsEnabled: events.signupsEnabled,

      eventStatus: events.status,
    })
    .from(roleRequestGroups)
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .where(eq(roleRequestGroups.id, groupId))
    .limit(1);

  if (!group) {
    throw new Error(`Role-request group ${groupId} does not exist.`);
  }

  const options = await db
    .select({
      id: eventRoleOptions.id,

      displayName: eventRoleOptions.displayName,

      description: eventRoleOptions.description,

      sortOrder: roleRequestGroupOptions.sortOrder,
    })
    .from(roleRequestGroupOptions)
    .innerJoin(
      eventRoleOptions,
      eq(eventRoleOptions.id, roleRequestGroupOptions.eventRoleOptionId),
    )
    .where(
      and(
        eq(roleRequestGroupOptions.groupId, group.id),

        eq(eventRoleOptions.active, true),
      ),
    )
    .orderBy(asc(roleRequestGroupOptions.sortOrder), asc(eventRoleOptions.id));

  const optionIds = options.map((option) => option.id);

  const requests =
    optionIds.length === 0
      ? []
      : await db
          .select({
            optionId: roleRequests.eventRoleOptionId,

            userId: roleRequests.discordUserId,

            createdAt: roleRequests.createdAt,

            sourceRequiresPositiveSignup:
              roleRequestGroups.requiresPositiveSignup,
          })
          .from(roleRequests)
          .leftJoin(
            roleRequestGroups,
            eq(roleRequestGroups.id, roleRequests.sourceGroupId),
          )
          .where(
            and(
              eq(roleRequests.eventId, group.eventId),

              inArray(roleRequests.eventRoleOptionId, optionIds),
            ),
          )
          .orderBy(asc(roleRequests.createdAt), asc(roleRequests.id));

  const requestUserIds = [
    ...new Set(requests.map((request) => request.userId)),
  ];

  const signupRows =
    group.signupsEnabled && requestUserIds.length > 0
      ? await db
          .select({
            userId: attendanceResponses.discordUserId,

            status: attendanceResponses.status,
          })
          .from(attendanceResponses)
          .where(
            and(
              eq(attendanceResponses.eventId, group.eventId),

              inArray(attendanceResponses.discordUserId, requestUserIds),
            ),
          )
      : [];

  const signupByUserId = new Map(
    signupRows.map((signup) => [signup.userId, signup.status]),
  );

  const requestsByOption = new Map<number, typeof requests>();

  for (const request of requests) {
    const existing = requestsByOption.get(request.optionId) ?? [];

    existing.push(request);

    requestsByOption.set(request.optionId, existing);
  }

  const now = new Date();

  const groupOpen =
    group.closedAt === null &&
    group.opensAt <= now &&
    group.closesAt > now &&
    group.eventStatus !== "cancelled" &&
    group.eventStatus !== "completed";

  /*
   * Withdrawal remains possible after request closure/start so that
   * organisers can learn that a volunteer is no longer available.
   * Event completion/cancellation is the final boundary.
   */
  const eventStillManageable =
    group.eventStatus !== "cancelled" && group.eventStatus !== "completed";

  const closeTimestamp = Math.floor(group.closesAt.getTime() / 1000);

  const description = [
    group.description ??
      "Select any roles you would be willing to perform. You may request multiple roles.",

    "",

    "**Requests do not guarantee allocation.**",

    group.requiresPositiveSignup
      ? "You must currently be signed **Attending** or **Tentative** to add a request through this message."
      : null,

    `Requests close: <t:${closeTimestamp}:F> (<t:${closeTimestamp}:R>)`,

    groupOpen ? null : "🔒 **New requests through this message are closed.**",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle(`${group.name} — ${group.eventName}`)
    .setDescription(description)
    .setFooter({
      text: `Event #${group.eventId} • Request group #${group.id}`,
    });

  for (const option of options.slice(0, 20)) {
    const optionRequests = requestsByOption.get(option.id) ?? [];

    const availableRequests = optionRequests.filter((request) =>
      requestIsCurrentlyAvailable(
        group.signupsEnabled,
        signupByUserId.get(request.userId) ?? null,
        request.sourceRequiresPositiveSignup,
      ),
    );

    const unavailableRequests = optionRequests.filter(
      (request) =>
        !requestIsCurrentlyAvailable(
          group.signupsEnabled,
          signupByUserId.get(request.userId) ?? null,
          request.sourceRequiresPositiveSignup,
        ),
    );

    const availableLines = availableRequests
      .slice(0, 15)
      .map(
        (request, index) =>
          `${index + 1}. <@${request.userId}>${formatSignupMarker(
            group.signupsEnabled,
            signupByUserId.get(request.userId) ?? null,
          )}`,
      );

    if (availableRequests.length > 15) {
      availableLines.push(`+ ${availableRequests.length - 15} more`);
    }

    const unavailableLines = unavailableRequests
      .slice(0, 8)
      .map(
        (request) =>
          `• <@${request.userId}>${formatSignupMarker(
            group.signupsEnabled,
            signupByUserId.get(request.userId) ?? null,
          )}`,
      );

    if (unavailableRequests.length > 8) {
      unavailableLines.push(`+ ${unavailableRequests.length - 8} more`);
    }

    const valueParts = [
      "**Available:**",
      availableLines.length > 0
        ? availableLines.join("\n")
        : "No requests yet.",
    ];

    if (unavailableLines.length > 0) {
      valueParts.push(
        "",
        "**Currently unavailable:**",
        unavailableLines.join("\n"),
      );
    }

    embed.addFields({
      name:
        `${option.displayName} ` + `(${availableRequests.length} available)`,

      value: valueParts.join("\n").slice(0, 1024),

      inline: false,
    });
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < options.length; index += 5) {
    const rowOptions = options.slice(index, index + 5);

    const row = new ActionRowBuilder<ButtonBuilder>();

    for (const option of rowOptions) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildRoleRequestAddCustomId(group.id, option.id))
          .setLabel(option.displayName.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!groupOpen),
      );
    }

    rows.push(row);
  }

  if (rows.length < 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildRoleRequestManageCustomId(group.eventId))
          .setLabel("Manage My Requests")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!eventStillManageable),
      ),
    );
  }

  return {
    embeds: [embed],

    components: rows,
  };
}

export async function refreshRoleRequestGroupMessage(
  guild: Guild,
  groupId: number,
): Promise<boolean> {
  const [group] = await db
    .select({
      channelId: roleRequestGroups.channelId,

      messageId: roleRequestGroups.messageId,
    })
    .from(roleRequestGroups)
    .where(eq(roleRequestGroups.id, groupId))
    .limit(1);

  if (!group?.messageId) {
    return false;
  }

  const channel = await guild.channels.fetch(group.channelId);

  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return false;
  }

  /*
   * Both the ordinary refresh path and the deleted-message recovery path
   * render from the same authoritative database state.
   */
  const payload = {
    ...(await buildRoleRequestGroupMessagePayload(groupId)),

    allowedMentions: {
      /*
       * Refreshing or recovering a presentation message must not trigger
       * fresh role/member notifications.
       */
      parse: [],
    },
  };

  /*
   * Normal path: refresh the existing linked Discord message.
   */
  try {
    const message = await channel.messages.fetch(group.messageId);

    await message.edit(payload);

    return true;
  } catch (error: unknown) {
    /*
     * Automatic replacement is safe only when Discord explicitly says the
     * stored message no longer exists.
     *
     * Preserve the previous behaviour for other fetch failures rather than
     * risking a duplicate message during a temporary Discord/API problem.
     */
    if (!isUnknownMessageError(error)) {
      return false;
    }
  }

  /*
   * The role-request group still exists and its destination channel is
   * available, but the linked Discord message has been deleted.
   *
   * Repair only the presentation. Do not recreate the group, options,
   * requests or scheduled close action.
   */
  const replacementMessage = await channel.send(payload);

  let claimedReplacement:
    | {
        messageId: string | null;
      }
    | undefined;

  try {
    [claimedReplacement] = await db
      .update(roleRequestGroups)
      .set({
        messageId: replacementMessage.id,
      })
      .where(
        and(
          eq(roleRequestGroups.id, groupId),

          /*
           * Concurrency fence:
           *
           * this recovery may replace only the exact stale Discord message
           * ID which it originally observed.
           */
          eq(roleRequestGroups.messageId, group.messageId),
        ),
      )
      .returning({
        messageId: roleRequestGroups.messageId,
      });
  } catch (error: unknown) {
    /*
     * PostgreSQL remains authoritative. If we could not record this
     * replacement, remove the Discord message rather than knowingly leaving
     * behind an untracked duplicate.
     */
    await replacementMessage.delete().catch((cleanupError: unknown) => {
      console.error(
        `Failed to delete replacement role-request group message ${replacementMessage.id} after database recovery failure:`,
        cleanupError,
      );
    });

    throw error;
  }

  /*
   * Our conditional linkage update won.
   */
  if (claimedReplacement) {
    return true;
  }

  /*
   * Another refresh recovered the same deleted message after our initial
   * read but before our conditional update.
   *
   * Remove our duplicate and use the linkage which won in PostgreSQL.
   */
  await replacementMessage.delete().catch((cleanupError: unknown) => {
    console.error(
      `Failed to delete duplicate recovered role-request group message ${replacementMessage.id}:`,
      cleanupError,
    );
  });

  const [currentLink] = await db
    .select({
      messageId: roleRequestGroups.messageId,
    })
    .from(roleRequestGroups)
    .where(eq(roleRequestGroups.id, groupId))
    .limit(1);

  if (!currentLink?.messageId || currentLink.messageId === group.messageId) {
    return false;
  }

  /*
   * Verify that the winning replacement is actually available rather than
   * reporting success solely because its ID reached PostgreSQL.
   */
  try {
    await channel.messages.fetch(currentLink.messageId);

    return true;
  } catch {
    return false;
  }
}

export async function refreshRoleRequestMessages(
  guild: Guild,
  eventId: number,
): Promise<void> {
  const groups = await db
    .select({
      id: roleRequestGroups.id,
    })
    .from(roleRequestGroups)
    .where(
      and(
        eq(roleRequestGroups.eventId, eventId),

        isNotNull(roleRequestGroups.messageId),
      ),
    );

  for (const group of groups) {
    await refreshRoleRequestGroupMessage(guild, group.id).catch(
      (error: unknown) => {
        console.error(
          `Failed to refresh role-request group ${group.id}:`,
          error,
        );
      },
    );
  }
}

function requestIsCurrentlyAvailable(
  signupsEnabled: boolean,
  signupStatus: "attending" | "tentative" | "not_attending" | null,
  sourceRequiresPositiveSignup: boolean | null,
): boolean {
  if (!signupsEnabled) {
    return true;
  }

  if (signupStatus === "not_attending") {
    return false;
  }

  if (signupStatus === "attending" || signupStatus === "tentative") {
    return true;
  }

  /*
   * No current signup is acceptable when the request originated
   * through an early/non-signup request group.
   */
  return sourceRequiresPositiveSignup !== true;
}

function formatSignupMarker(
  signupsEnabled: boolean,
  status: "attending" | "tentative" | "not_attending" | null,
): string {
  if (!signupsEnabled) {
    return "";
  }

  switch (status) {
    case "attending":
      return " • ✅ Attending";

    case "tentative":
      return " • ❔ Tentative";

    case "not_attending":
      return " • 🚫 Not attending";

    case null:
      return " • ⚪ No signup";
  }
}

function isUnknownMessageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (
    (
      error as {
        code?: unknown;
      }
    ).code === 10008
  );
}
