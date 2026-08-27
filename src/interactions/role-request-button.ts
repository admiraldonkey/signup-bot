import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  MessageFlags,
} from "discord.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  attendanceResponses,
  discordGuilds,
  eventRoleOptionQualificationRoles,
  eventRoleOptions,
  events,
  roleRequestGroupOptions,
  roleRequestGroups,
  roleRequests,
} from "../db/schema.js";
import {
  buildRoleRequestWithdrawCustomId,
  refreshRoleRequestMessages,
} from "../role-requests/role-request-message.js";

type ParsedRoleRequestInteraction =
  | {
      kind: "add";
      groupId: number;
      optionId: number;
    }
  | {
      kind: "manage";
      eventId: number;
    }
  | {
      kind: "withdraw";
      eventId: number;
      optionId: number;
    };

export async function handleRoleRequestButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseRoleRequestCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  switch (parsed.kind) {
    case "add":
      await handleAddRequest(interaction, parsed.groupId, parsed.optionId);
      return true;

    case "manage":
      await handleManageRequests(interaction, parsed.eventId);
      return true;

    case "withdraw":
      await handleWithdrawRequest(interaction, parsed.eventId, parsed.optionId);
      return true;
  }
}

async function handleAddRequest(
  interaction: ButtonInteraction,
  groupId: number,
  optionId: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Role requests can only be submitted inside the event's Discord server.",
    );

    return;
  }

  const [context] = await db
    .select({
      groupId: roleRequestGroups.id,

      eventId: roleRequestGroups.eventId,

      channelId: roleRequestGroups.channelId,

      messageId: roleRequestGroups.messageId,

      signupsEnabled: events.signupsEnabled,

      requiresPositiveSignup: roleRequestGroups.requiresPositiveSignup,

      opensAt: roleRequestGroups.opensAt,

      closesAt: roleRequestGroups.closesAt,

      closedAt: roleRequestGroups.closedAt,

      eventName: events.name,

      eventStatus: events.status,

      discordGuildId: discordGuilds.discordGuildId,

      optionId: eventRoleOptions.id,

      optionName: eventRoleOptions.displayName,

      requestRestriction: eventRoleOptions.requestRestriction,
    })
    .from(roleRequestGroupOptions)
    .innerJoin(
      roleRequestGroups,
      eq(roleRequestGroups.id, roleRequestGroupOptions.groupId),
    )
    .innerJoin(
      eventRoleOptions,
      eq(eventRoleOptions.id, roleRequestGroupOptions.eventRoleOptionId),
    )
    .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(
      and(
        eq(roleRequestGroups.id, groupId),

        eq(eventRoleOptions.id, optionId),

        eq(eventRoleOptions.active, true),
      ),
    )
    .limit(1);

  if (!context || context.discordGuildId !== interaction.guildId) {
    await interaction.editReply("This role request is no longer available.");

    return;
  }

  if (
    context.messageId !== interaction.message.id ||
    context.channelId !== interaction.channelId
  ) {
    await interaction.editReply(
      "This button does not belong to the current role-request message.",
    );

    return;
  }

  const now = new Date();

  if (
    context.eventStatus === "cancelled" ||
    context.eventStatus === "completed"
  ) {
    await interaction.editReply(
      "This event is no longer accepting role requests.",
    );

    return;
  }

  if (context.closedAt || context.opensAt > now || context.closesAt <= now) {
    await interaction.editReply(
      "New requests through this role-request group are closed.",
    );

    return;
  }

  const [signup] = context.signupsEnabled
    ? await db
        .select({
          status: attendanceResponses.status,
        })
        .from(attendanceResponses)
        .where(
          and(
            eq(attendanceResponses.eventId, context.eventId),

            eq(attendanceResponses.discordUserId, interaction.user.id),
          ),
        )
        .limit(1)
    : [];

  /*
   * Someone who has explicitly said they are not attending should
   * not add further role requests, even through an early group which
   * otherwise does not require a signup.
   */
  if (signup?.status === "not_attending") {
    await interaction.editReply(
      "You are currently marked **Not attending**. Change your attendance response before adding another role request.",
    );

    return;
  }

  if (
    context.requiresPositiveSignup &&
    (!signup ||
      (signup.status !== "attending" && signup.status !== "tentative"))
  ) {
    await interaction.editReply(
      "You need to be signed **Attending** or **Tentative** before requesting roles through this message.",
    );

    return;
  }

  if (context.requestRestriction === "qualified_only") {
    const qualificationRoles = await db
      .select({
        discordRoleId: eventRoleOptionQualificationRoles.discordRoleId,
      })
      .from(eventRoleOptionQualificationRoles)
      .where(
        eq(
          eventRoleOptionQualificationRoles.eventRoleOptionId,
          context.optionId,
        ),
      );

    if (
      qualificationRoles.length === 0 ||
      !qualificationRoles.some((qualification) =>
        interaction.member.roles.cache.has(qualification.discordRoleId),
      )
    ) {
      await interaction.editReply(
        `You do not currently hold a configured qualification role for **${context.optionName}**.`,
      );

      return;
    }
  }

  const nowForInsert = new Date();

  /*
   * The earlier checks provide useful, specific feedback, but their results
   * may become stale before the request is persisted.
   *
   * Revalidate all database-resident eligibility in the INSERT itself and
   * lock the event/group/option rows which establish that eligibility.
   *
   * This prevents a concurrent lifecycle/group/configuration change from
   * slipping between validation and persistence.
   */
  const roleRequestWrite = await db.execute(sql`
  WITH "eligible_request" AS (
    SELECT
      "request_group"."event_id"
        AS "event_id",

      "role_option"."id"
        AS "event_role_option_id",

      "request_group"."id"
        AS "source_group_id"

    FROM ${roleRequestGroupOptions}
      AS "group_option"

    INNER JOIN ${roleRequestGroups}
      AS "request_group"
      ON
        "request_group"."id" =
          "group_option"."group_id"

    INNER JOIN ${eventRoleOptions}
      AS "role_option"
      ON
        "role_option"."id" =
          "group_option"."event_role_option_id"

    INNER JOIN ${events}
      AS "event"
      ON
        "event"."id" =
          "request_group"."event_id"

    WHERE
      "request_group"."id" =
        ${context.groupId}

      AND "role_option"."id" =
        ${context.optionId}

      /*
       * A group must never expose an option belonging to another event,
       * even if malformed persisted data somehow exists.
       */
      AND "role_option"."event_id" =
        "request_group"."event_id"

      AND "role_option"."active" = true

      /*
       * If the restriction itself changed after the Discord-role check,
       * reject this stale interaction rather than applying the old rule.
       */
      AND "role_option"."request_restriction" =
        ${context.requestRestriction}

      AND "event"."status"
        NOT IN ('cancelled', 'completed')

      AND "request_group"."closed_at"
        IS NULL

      AND "request_group"."opens_at"
        <= ${nowForInsert}

      AND "request_group"."closes_at"
        > ${nowForInsert}

      /*
       * Preserve the existing signup semantics:
       *
       * - positive-signup groups require Attending or Tentative;
       * - an explicit Not attending response blocks new requests even when
       *   the group does not otherwise require a positive signup;
       * - when event signups are disabled, a group requiring a positive
       *   signup cannot accept requests.
       */
      AND (
        (
          "event"."signups_enabled" = false
          AND
          "request_group"."requires_positive_signup" = false
        )

        OR

        (
          "event"."signups_enabled" = true
          AND (
            (
              "request_group"."requires_positive_signup" = false
              AND NOT EXISTS (
                SELECT 1
                FROM ${attendanceResponses}
                  AS "attendance"

                WHERE
                  "attendance"."event_id" =
                    "request_group"."event_id"

                  AND "attendance"."discord_user_id" =
                    ${interaction.user.id}

                  AND "attendance"."status" =
                    'not_attending'
              )
            )

            OR

            (
              "request_group"."requires_positive_signup" = true
              AND EXISTS (
                SELECT 1
                FROM ${attendanceResponses}
                  AS "attendance"

                WHERE
                  "attendance"."event_id" =
                    "request_group"."event_id"

                  AND "attendance"."discord_user_id" =
                    ${interaction.user.id}

                  AND "attendance"."status"
                    IN ('attending', 'tentative')
              )
            )
          )
        )
      )

    FOR UPDATE OF
      "group_option",
      "request_group",
      "role_option",
      "event"
  )

  INSERT INTO ${roleRequests} (
    "event_id",
    "discord_user_id",
    "event_role_option_id",
    "source_group_id",
    "updated_at"
  )

  SELECT
    "eligible_request"."event_id",
    ${interaction.user.id},
    "eligible_request"."event_role_option_id",
    "eligible_request"."source_group_id",
    ${nowForInsert}

  FROM "eligible_request"

  ON CONFLICT (
    "event_id",
    "discord_user_id",
    "event_role_option_id"
  )
  DO NOTHING

  RETURNING "id"
`);

  if (roleRequestWrite.rowCount !== 1) {
    /*
     * The guarded write can return no row for either:
     *
     * 1. a duplicate request; or
     * 2. eligibility changing after the initial read.
     *
     * Re-read enough current state to give useful feedback. These reads are
     * explanatory only: the database write above remains authoritative.
     */
    const [freshContext] = await db
      .select({
        closedAt: roleRequestGroups.closedAt,

        opensAt: roleRequestGroups.opensAt,

        closesAt: roleRequestGroups.closesAt,

        eventStatus: events.status,

        optionActive: eventRoleOptions.active,
      })
      .from(roleRequestGroupOptions)
      .innerJoin(
        roleRequestGroups,
        eq(roleRequestGroups.id, roleRequestGroupOptions.groupId),
      )
      .innerJoin(
        eventRoleOptions,
        eq(eventRoleOptions.id, roleRequestGroupOptions.eventRoleOptionId),
      )
      .innerJoin(events, eq(events.id, roleRequestGroups.eventId))
      .where(
        and(
          eq(roleRequestGroups.id, context.groupId),

          eq(eventRoleOptions.id, context.optionId),
        ),
      )
      .limit(1);

    const rejectionNow = new Date();

    if (
      freshContext &&
      (freshContext.closedAt ||
        freshContext.opensAt > rejectionNow ||
        freshContext.closesAt <= rejectionNow)
    ) {
      await interaction.editReply(
        "New requests through this role-request group are closed.",
      );

      return;
    }

    if (
      freshContext &&
      (freshContext.eventStatus === "cancelled" ||
        freshContext.eventStatus === "completed")
    ) {
      await interaction.editReply(
        "This event is no longer accepting role requests.",
      );

      return;
    }

    if (!freshContext || !freshContext.optionActive) {
      await interaction.editReply("This role request is no longer available.");

      return;
    }

    const [existingRequest] = await db
      .select({
        id: roleRequests.id,
      })
      .from(roleRequests)
      .where(
        and(
          eq(roleRequests.eventId, context.eventId),

          eq(roleRequests.discordUserId, interaction.user.id),

          eq(roleRequests.eventRoleOptionId, context.optionId),
        ),
      )
      .limit(1);

    if (existingRequest) {
      await interaction.editReply(
        `ℹ️ You are already registered as willing to perform **${context.optionName}**. No changes were made.`,
      );

      return;
    }

    /*
     * Some other eligibility rule changed between the initial read and the
     * guarded write, for example signup eligibility or role-option
     * configuration.
     *
     * The important thing here is not to report a false success.
     */
    await interaction.editReply("This role request is no longer available.");

    return;
  }

  await refreshRoleRequestMessages(interaction.guild, context.eventId);

  await interaction.editReply(
    `✅ You are now listed as willing to perform **${context.optionName}** for **${context.eventName}**.`,
  );
}

async function handleManageRequests(
  interaction: ButtonInteraction,
  eventId: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Role requests can only be managed inside the event's Discord server.",
    );

    return;
  }

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event || event.discordGuildId !== interaction.guildId) {
    await interaction.editReply("This event is no longer available.");

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Role requests for this event can no longer be changed.",
    );

    return;
  }

  const requests = await db
    .select({
      optionId: roleRequests.eventRoleOptionId,

      optionName: eventRoleOptions.displayName,

      createdAt: roleRequests.createdAt,
    })
    .from(roleRequests)
    .innerJoin(
      eventRoleOptions,
      eq(eventRoleOptions.id, roleRequests.eventRoleOptionId),
    )
    .where(
      and(
        eq(roleRequests.eventId, event.id),

        eq(roleRequests.discordUserId, interaction.user.id),
      ),
    )
    .orderBy(asc(roleRequests.createdAt), asc(roleRequests.id));

  if (requests.length === 0) {
    await interaction.editReply(
      `You currently have no role requests for **${event.name}**.`,
    );

    return;
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < Math.min(requests.length, 20); index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();

    for (const request of requests.slice(index, index + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildRoleRequestWithdrawCustomId(event.id, request.optionId),
          )
          .setLabel(`Withdraw: ${request.optionName}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
      );
    }

    rows.push(row);
  }

  await interaction.editReply({
    content: [
      `**Your requests — ${event.name}**`,
      "",
      ...requests.map((request) => `• ${request.optionName}`),
      "",
      "Use a button below only if you want to withdraw that request.",
    ].join("\n"),

    components: rows,

    allowedMentions: {
      parse: [],
    },
  });
}

async function handleWithdrawRequest(
  interaction: ButtonInteraction,
  eventId: number,
  optionId: number,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.editReply(
      "Role requests can only be changed inside the event's Discord server.",
    );

    return;
  }

  const [event] = await db
    .select({
      id: events.id,

      name: events.name,

      status: events.status,

      discordGuildId: discordGuilds.discordGuildId,
    })
    .from(events)
    .innerJoin(discordGuilds, eq(discordGuilds.id, events.ownerGuildId))
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event || event.discordGuildId !== interaction.guildId) {
    await interaction.editReply("This event is no longer available.");

    return;
  }

  if (event.status === "cancelled" || event.status === "completed") {
    await interaction.editReply(
      "Role requests for this event can no longer be changed.",
    );

    return;
  }

  const [option] = await db
    .select({
      name: eventRoleOptions.displayName,
    })
    .from(eventRoleOptions)
    .where(
      and(
        eq(eventRoleOptions.id, optionId),

        eq(eventRoleOptions.eventId, event.id),
      ),
    )
    .limit(1);

  if (!option) {
    await interaction.editReply("That role option no longer exists.");

    return;
  }

  const deleted = await db
    .delete(roleRequests)
    .where(
      and(
        eq(roleRequests.eventId, event.id),

        eq(roleRequests.discordUserId, interaction.user.id),

        eq(roleRequests.eventRoleOptionId, optionId),
      ),
    )
    .returning({
      id: roleRequests.id,
    });

  if (deleted.length === 0) {
    await interaction.editReply(
      `You were not currently requesting **${option.name}**.`,
    );

    return;
  }

  await refreshRoleRequestMessages(interaction.guild, event.id);

  await interaction.editReply(
    `✅ Your **${option.name}** request for **${event.name}** has been withdrawn.`,
  );
}

function parseRoleRequestCustomId(
  customId: string,
): ParsedRoleRequestInteraction | null {
  let match = /^role-request:add:(\d+):(\d+)$/.exec(customId);

  if (match) {
    const groupId = Number(match[1]);
    const optionId = Number(match[2]);

    if (
      Number.isSafeInteger(groupId) &&
      groupId > 0 &&
      Number.isSafeInteger(optionId) &&
      optionId > 0
    ) {
      return {
        kind: "add",
        groupId,
        optionId,
      };
    }
  }

  match = /^role-request:manage:(\d+)$/.exec(customId);

  if (match) {
    const eventId = Number(match[1]);

    if (Number.isSafeInteger(eventId) && eventId > 0) {
      return {
        kind: "manage",
        eventId,
      };
    }
  }

  match = /^role-request:withdraw:(\d+):(\d+)$/.exec(customId);

  if (match) {
    const eventId = Number(match[1]);
    const optionId = Number(match[2]);

    if (
      Number.isSafeInteger(eventId) &&
      eventId > 0 &&
      Number.isSafeInteger(optionId) &&
      optionId > 0
    ) {
      return {
        kind: "withdraw",
        eventId,
        optionId,
      };
    }
  }

  return null;
}
