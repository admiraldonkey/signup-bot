import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const notificationMocks = vi.hoisted(() => ({
  sendOrganiserAssignmentNotification: vi.fn().mockResolvedValue("dm"),
}));

vi.mock("../../../src/events/organiser-notification.js", () => ({
  sendOrganiserAssignmentNotification:
    notificationMocks.sendOrganiserAssignmentNotification,
}));

import { setEventOrganiser } from "../../../src/commands/event-organisers.js";
import { publishStoredEvent } from "../../../src/events/event-publication.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "100000000000000001";
const ADMIN_USER_ID = "100000000000000002";
const ORGANISER_USER_ID = "100000000000000003";
const PUBLICATION_CHANNEL_ID = "100000000000000004";
const PUBLICATION_MESSAGE_ID = "100000000000000005";
const BOT_USER_ID = "100000000000000006";

describe("primary organiser assignment", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    notificationMocks.sendOrganiserAssignmentNotification.mockClear();
  });

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  it("keeps a newly assigned primary organiser dormant while the event is unpublished", async () => {
    // Arrange
    const eventId = await createUnpublishedEvent(pool);

    const interaction = createOrganiserSetInteraction(eventId);

    // Act
    await setEventOrganiser(interaction);

    // Assert
    const assignmentResult = await pool.query<{
      slot: string;
      discord_user_id: string;
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
        SELECT
          "slot",
          "discord_user_id",
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "is_current" = true
      `,
      [eventId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect.soft(assignmentResult.rows[0]).toMatchObject({
      slot: "primary",
      discord_user_id: ORGANISER_USER_ID,
      status: "pending",
      is_current: true,

      /*
       * The organiser exists, but publication has not happened yet.
       * Their response clock must therefore not have started.
       */
      activated_at: null,
      response_deadline_at: null,
    });

    const scheduledActionsResult = await pool.query<{
      action_key: string;
      status: string;
    }>(
      `
        SELECT
          "action_key",
          "status"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND (
            "action_key" LIKE 'organiser_warning:%'
            OR "action_key" LIKE 'organiser_timeout:%'
          )
        ORDER BY "action_key"
      `,
      [eventId],
    );

    expect.soft(scheduledActionsResult.rows).toEqual([]);

    expect
      .soft(notificationMocks.sendOrganiserAssignmentNotification)
      .not.toHaveBeenCalled();
  });

  it("activates a dormant primary exactly once when the event is published", async () => {
    // Arrange
    const eventId = await createUnpublishedEvent(pool);

    const interaction = createOrganiserSetInteraction(eventId);

    await setEventOrganiser(interaction);

    /*
     * Confirm the starting state for this test:
     * assignment exists, but publication has not activated it.
     */
    const beforePublicationResult = await pool.query<{
      id: number;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
        SELECT
          "id",
          "activated_at",
          "response_deadline_at"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "slot" = 'primary'
          AND "is_current" = true
      `,
      [eventId],
    );

    expect(beforePublicationResult.rows).toHaveLength(1);

    const assignmentBeforePublication = beforePublicationResult.rows[0];

    expect(assignmentBeforePublication).toBeDefined();

    expect(assignmentBeforePublication?.activated_at).toBeNull();

    expect(assignmentBeforePublication?.response_deadline_at).toBeNull();

    expect(
      notificationMocks.sendOrganiserAssignmentNotification,
    ).not.toHaveBeenCalled();

    const publicationDiscord = createPublicationGuild();

    // Act
    const firstPublication = await publishStoredEvent(
      publicationDiscord.guild,
      eventId,
    );

    /*
     * Attempting publication again lets us verify that activation,
     * scheduler creation and notification are all one-time effects.
     */
    const secondPublication = await publishStoredEvent(
      publicationDiscord.guild,
      eventId,
    );

    // Assert
    expect(firstPublication.ok).toBe(true);

    if (!firstPublication.ok) {
      throw new Error(
        `Expected publication to succeed, but received "${firstPublication.reason}".`,
      );
    }

    expect(firstPublication.primaryOrganiserNotification).toBe("dm");

    expect(secondPublication).toMatchObject({
      ok: false,
      reason: "already-published",
    });

    const eventResult = await pool.query<{
      published_at: Date | null;
      status: string;
    }>(
      `
        SELECT
          "published_at",
          "status"
        FROM "events"
        WHERE "id" = $1
      `,
      [eventId],
    );

    expect(eventResult.rows).toHaveLength(1);

    const publishedEvent = eventResult.rows[0];

    expect(publishedEvent?.published_at).toBeInstanceOf(Date);

    expect(publishedEvent?.status).toBe("open");

    const afterPublicationResult = await pool.query<{
      id: number;
      slot: string;
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
        SELECT
          "id",
          "slot",
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at"
        FROM "event_organiser_assignments"
        WHERE
          "event_id" = $1
          AND "slot" = 'primary'
        ORDER BY "id"
      `,
      [eventId],
    );

    /*
     * Publication must activate the existing dormant assignment,
     * not create a replacement assignment.
     */
    expect(afterPublicationResult.rows).toHaveLength(1);

    const assignmentAfterPublication = afterPublicationResult.rows[0];

    expect(assignmentAfterPublication?.id).toBe(
      assignmentBeforePublication?.id,
    );

    expect.soft(assignmentAfterPublication).toMatchObject({
      slot: "primary",
      status: "pending",
      is_current: true,
    });

    expect(assignmentAfterPublication?.activated_at).toBeInstanceOf(Date);

    expect(assignmentAfterPublication?.response_deadline_at).toBeInstanceOf(
      Date,
    );

    /*
     * Publication uses one authoritative timestamp for the event
     * publication and organiser activation.
     */
    expect(assignmentAfterPublication?.activated_at?.getTime()).toBe(
      publishedEvent?.published_at?.getTime(),
    );

    /*
     * The guild fixture uses the normal 80-minute primary response
     * deadline default.
     */
    expect(
      assignmentAfterPublication!.response_deadline_at!.getTime() -
        assignmentAfterPublication!.activated_at!.getTime(),
    ).toBe(80 * 60 * 1000);

    const scheduledActionsResult = await pool.query<{
      action_key: string;
      status: string;
    }>(
      `
        SELECT
          "action_key",
          "status"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND (
            "action_key" LIKE 'organiser_warning:%'
            OR "action_key" LIKE 'organiser_timeout:%'
          )
        ORDER BY "action_key"
      `,
      [eventId],
    );

    expect(scheduledActionsResult.rows).toEqual([
      {
        action_key: `organiser_timeout:${assignmentBeforePublication!.id}`,
        status: "pending",
      },
      {
        action_key: `organiser_warning:${assignmentBeforePublication!.id}`,
        status: "pending",
      },
    ]);

    const eventMessagesResult = await pool.query<{
      channel_id: string;
      message_id: string;
      kind: string;
    }>(
      `
        SELECT
          "channel_id",
          "message_id",
          "kind"
        FROM "event_messages"
        WHERE "event_id" = $1
      `,
      [eventId],
    );

    expect(eventMessagesResult.rows).toEqual([
      {
        channel_id: PUBLICATION_CHANNEL_ID,
        message_id: PUBLICATION_MESSAGE_ID,
        kind: "attendance",
      },
    ]);

    expect(
      notificationMocks.sendOrganiserAssignmentNotification,
    ).toHaveBeenCalledTimes(1);

    expect(
      notificationMocks.sendOrganiserAssignmentNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: assignmentBeforePublication!.id,

        eventId,

        discordUserId: ORGANISER_USER_ID,

        slot: "primary",

        eventMessageUrl: `https://discord.test/messages/${PUBLICATION_MESSAGE_ID}`,
      }),
    );

    expect(publicationDiscord.sendMessage).toHaveBeenCalledTimes(1);
  });
});

async function createUnpublishedEvent(pool: Pool): Promise<number> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, $2)
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID, "Integration Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  /*
   * Defaults provide the organiser response timings.
   * Event Admin/Organiser roles and the bot-log channel deliberately
   * remain null so this test does not require real Discord roles/channels.
   */
  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id"
      )
      VALUES ($1)
    `,
    [guildId],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name"
      )
      VALUES ($1, $2, $3)
      RETURNING "id"
    `,
    [guildId, "naval", "Naval Event"],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("The integration-test event type was not created.");
  }

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "events" (
        "owner_guild_id",
        "event_type_id",
        "name",
        "starts_at",
        "signups_enabled",
        "published_at",
        "publication_channel_id",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        true,
        null,
        $5,
        'scheduled',
        $6
      )
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Unpublished Organiser Test Event",
      new Date(Date.now() + 24 * 60 * 60 * 1000),
      PUBLICATION_CHANNEL_ID,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  return eventId;
}

function createOrganiserSetInteraction(
  eventId: number,
): ChatInputCommandInteraction<"cached"> {
  const interaction = {
    guildId: DISCORD_GUILD_ID,

    user: {
      id: ADMIN_USER_ID,
    },

    /*
     * getOrganiserContext() checks Manage Server permission.
     * We allow it here because authorisation is not the behaviour
     * under test.
     */
    member: {
      permissions: {
        has: () => true,
      },

      roles: {
        cache: {
          has: () => false,
        },
      },
    },

    guild: {
      id: DISCORD_GUILD_ID,

      members: {
        fetch: vi.fn().mockResolvedValue({
          displayName: "Primary Organiser",

          roles: {
            cache: {
              has: () => false,
            },
          },
        }),
      },
    },

    options: {
      getInteger: () => eventId,

      getString: () => "primary",

      getUser: () => ({
        id: ORGANISER_USER_ID,
        bot: false,
      }),
    },

    editReply: vi.fn().mockResolvedValue(undefined),
  };

  /*
   * This deliberately implements only the small part of the Discord
   * interaction contract used by setEventOrganiser().
   *
   * Constructing a giant fake discord.js interaction would add noise
   * without improving coverage of the organiser lifecycle.
   */
  return interaction as unknown as ChatInputCommandInteraction<"cached">;
}

function createPublicationGuild(): {
  guild: Guild;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const deleteMessage = vi.fn().mockResolvedValue(undefined);

  const sendMessage = vi.fn().mockResolvedValue({
    id: PUBLICATION_MESSAGE_ID,

    url: `https://discord.test/messages/${PUBLICATION_MESSAGE_ID}`,

    delete: deleteMessage,
  });

  const publicationChannel = {
    id: PUBLICATION_CHANNEL_ID,

    type: ChannelType.GuildText,

    isSendable: () => true,

    permissionsFor: () => ({
      has: () => true,
    }),

    send: sendMessage,
  };

  const guild = {
    id: DISCORD_GUILD_ID,

    channels: {
      fetch: vi
        .fn()
        .mockImplementation(async (channelId: string) =>
          channelId === PUBLICATION_CHANNEL_ID ? publicationChannel : null,
        ),
    },

    members: {
      me: {
        id: BOT_USER_ID,
      },

      fetchMe: vi.fn().mockResolvedValue({
        id: BOT_USER_ID,
      }),
    },

    roles: {
      fetch: vi.fn(),
    },
  };

  return {
    guild: guild as unknown as Guild,
    sendMessage,
  };
}
