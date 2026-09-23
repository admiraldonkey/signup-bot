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

const authMocks = vi.hoisted(() => ({
  getGuildConfiguration: vi.fn(),

  memberCanManageEvents: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

const messageMocks = vi.hoisted(() => ({
  sendEventCustomMessage: vi.fn(),

  validateEventMessageDestination: vi.fn(),
}));

vi.mock("../../../src/auth/event-admin.js", () => authMocks);

vi.mock("../../../src/audit/audit-log.js", () => auditMocks);

vi.mock("../../../src/events/event-custom-message.js", () => messageMocks);

import { pool as applicationPool } from "../../../src/db/client.js";
import { addEventReminder } from "../../../src/commands/event-reminders.js";
import { buildReminderActionKey } from "../../../src/reminders/reminder-scheduling.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "988000000000000001";

const ADMIN_USER_ID = "988000000000000002";

const PUBLICATION_CHANNEL_ID = "988000000000000003";

describe("/event reminder commands", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    await resetIntegrationDatabase(pool);

    authMocks.memberCanManageEvents.mockReturnValue(true);

    messageMocks.validateEventMessageDestination.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await pool.end();

    await applicationPool.end();
  });

  it("adds a reminder to a scheduled unpublished event without an attendance message", async () => {
    // Arrange
    const fixture = await createUnpublishedEventFixture(pool);

    authMocks.getGuildConfiguration.mockResolvedValue({
      guildId: fixture.guildDatabaseId,

      enabled: true,

      eventAdminRoleId: null,
    });

    const { interaction, editReply } = createReminderAddInteraction(
      fixture.eventId,
    );

    // Prove the regression fixture really is unpublished.
    const messageCount = await pool.query<{
      count: number;
    }>(
      `
              SELECT COUNT(*)::int AS "count"
              FROM "event_messages"
              WHERE
                "event_id" = $1
                AND "kind" = 'attendance'
            `,
      [fixture.eventId],
    );

    expect(messageCount.rows).toEqual([
      {
        count: 0,
      },
    ]);

    // Act
    await addEventReminder(interaction);

    // Assert
    expect(messageMocks.validateEventMessageDestination).toHaveBeenCalledWith(
      interaction.guild,
      fixture.eventId,
      PUBLICATION_CHANNEL_ID,
      false,
    );

    const storedReminder = await pool.query<{
      id: number;
      event_id: number;
      timing_reference: string;
      minutes_before: number;
      message: string;
      channel_id: string;
      ping_event_roles: boolean;
      enabled: boolean;
    }>(
      `
              SELECT
                "id",
                "event_id",
                "timing_reference",
                "minutes_before",
                "message",
                "channel_id",
                "ping_event_roles",
                "enabled"
              FROM "event_reminders"
              WHERE "event_id" = $1
            `,
      [fixture.eventId],
    );

    expect(storedReminder.rows).toHaveLength(1);

    const reminder = storedReminder.rows[0];

    expect(reminder).toEqual({
      id: expect.any(Number),

      event_id: fixture.eventId,

      timing_reference: "event_start",

      minutes_before: 60,

      message: "Scheduled event reminder.",

      channel_id: PUBLICATION_CHANNEL_ID,

      ping_event_roles: false,

      enabled: true,
    });

    if (!reminder) {
      throw new Error("Expected reminder creation to persist a reminder.");
    }

    const storedAction = await pool.query<{
      event_id: number;
      action_key: string;
      status: string;
    }>(
      `
              SELECT
                "event_id",
                "action_key",
                "status"
              FROM "scheduled_actions"
              WHERE
                "event_id" = $1
                AND "action_key" = $2
            `,
      [fixture.eventId, buildReminderActionKey(reminder.id)],
    );

    expect(storedAction.rows).toEqual([
      {
        event_id: fixture.eventId,

        action_key: buildReminderActionKey(reminder.id),

        status: "pending",
      },
    ]);

    expect(readReplyContent(editReply)).toContain("Reminder **#");

    expect(readReplyContent(editReply)).toContain(
      "added to **Scheduled unpublished reminder test**",
    );

    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: fixture.guildDatabaseId,

        actorUserId: ADMIN_USER_ID,

        action: "event.reminder.add",

        outcome: "success",

        targetType: "event",

        targetId: String(fixture.eventId),
      }),
    );
  });
});

async function createUnpublishedEventFixture(pool: Pool): Promise<{
  guildDatabaseId: number;

  eventId: number;
}> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "discord_guilds" (
          "discord_guild_id",
          "name"
        )
        VALUES (
          $1,
          'Reminder Command Test Guild'
        )
        RETURNING "id"
      `,
    [DISCORD_GUILD_ID],
  );

  const guildDatabaseId = guildResult.rows[0]?.id;

  if (!guildDatabaseId) {
    throw new Error("Expected guild fixture creation to return an ID.");
  }

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_types" (
          "owner_guild_id",
          "code",
          "name"
        )
        VALUES (
          $1,
          'naval',
          'Naval'
        )
        RETURNING "id"
      `,
    [guildDatabaseId],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("Expected event-type fixture creation to return an ID.");
  }

  const startsAt = new Date(Date.now() + 6 * 60 * 60_000);

  const attendanceClosesAt = new Date(startsAt.getTime() - 60 * 60_000);

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
          "attendance_closes_at",
          "status",
          "publication_channel_id",
          "created_by_user_id"
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          true,
          $5,
          'scheduled',
          $6,
          $7
        )
        RETURNING "id"
      `,
    [
      guildDatabaseId,

      eventTypeId,

      "Scheduled unpublished reminder test",

      startsAt,

      attendanceClosesAt,

      PUBLICATION_CHANNEL_ID,

      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("Expected event fixture creation to return an ID.");
  }

  return {
    guildDatabaseId,

    eventId,
  };
}

function createReminderAddInteraction(eventId: number) {
  const editReply = vi.fn();

  const guild = {
    id: DISCORD_GUILD_ID,
  };

  const interaction = {
    guildId: DISCORD_GUILD_ID,

    guild,

    member: {},

    user: {
      id: ADMIN_USER_ID,
    },

    options: {
      getSubcommand: () => "reminder-add",

      getInteger: (name: string) => {
        switch (name) {
          case "event-id":
            return eventId;

          case "minutes-before":
            return 60;

          default:
            return null;
        }
      },

      getString: (name: string) => {
        switch (name) {
          case "relative-to":
            return "event_start";

          case "message":
            return "Scheduled event reminder.";

          default:
            return null;
        }
      },

      getChannel: () => null,

      getBoolean: (name: string) =>
        name === "ping-event-roles" ? false : null,
    },

    editReply,
  };

  return {
    interaction: interaction as unknown as Parameters<
      typeof addEventReminder
    >[0],

    editReply,
  };
}

function readReplyContent(editReply: ReturnType<typeof vi.fn>): string {
  const value = editReply.mock.calls.at(-1)?.[0];

  if (typeof value === "string") {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    typeof value.content === "string"
  ) {
    return value.content;
  }

  return "";
}
