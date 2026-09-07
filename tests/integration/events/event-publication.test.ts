import { ChannelType, type Guild } from "discord.js";
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

const organiserNotificationMocks = vi.hoisted(() => ({
  sendOrganiserAssignmentNotification: vi.fn().mockResolvedValue("dm"),
}));

vi.mock("../../../src/events/organiser-notification.js", () => ({
  sendOrganiserAssignmentNotification:
    organiserNotificationMocks.sendOrganiserAssignmentNotification,
}));

import { pool as applicationPool } from "../../../src/db/client.js";
import { publishStoredEvent } from "../../../src/events/event-publication.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "980000000000000001";

const ADMIN_USER_ID = "980000000000000002";

const ORGANISER_USER_ID = "980000000000000003";

const CHANNEL_ID = "980000000000000004";

describe("event publication organiser feature", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    organiserNotificationMocks.sendOrganiserAssignmentNotification
      .mockReset()
      .mockResolvedValue("dm");

    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();

    await applicationPool.end();
  });

  it("publishes without activating a dormant primary when organisers are disabled", async () => {
    // Arrange
    const fixture = await createPublicationFixture(pool, {
      organisersEnabled: false,
    });

    const send = vi.fn().mockResolvedValue({
      id: "980000000000000005",

      url: "https://discord.example/messages/980000000000000005",

      delete: vi.fn().mockResolvedValue(undefined),
    });

    const channel = {
      id: CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: () => true,

      permissionsFor: () => ({
        has: () => true,
      }),

      send,
    };

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: vi.fn().mockResolvedValue(channel),
      },

      members: {
        me: {},
      },

      roles: {
        fetch: vi.fn(),
      },
    } as unknown as Guild;

    // Act
    const result = await publishStoredEvent(guild, fixture.eventId);

    // Assert
    expect(result).toMatchObject({
      ok: true,

      eventId: fixture.eventId,

      primaryOrganiserNotification: null,
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
      [fixture.eventId],
    );

    expect(eventResult.rows[0]?.published_at).toBeInstanceOf(Date);

    expect(eventResult.rows[0]?.status).toBe("open");

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
    }>(
      `
          SELECT
            "status",
            "is_current",
            "activated_at",
            "response_deadline_at"
          FROM "event_organiser_assignments"
          WHERE "id" = $1
        `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,
      },
    ]);

    const organiserActionResult = await pool.query<{
      count: number;
    }>(
      `
          SELECT COUNT(*)::int AS "count"
          FROM "scheduled_actions"
          WHERE
            "event_id" = $1
            AND (
              "action_key" LIKE 'organiser_warning:%'
              OR
              "action_key" LIKE 'organiser_timeout:%'
            )
        `,
      [fixture.eventId],
    );

    expect(organiserActionResult.rows).toEqual([
      {
        count: 0,
      },
    ]);

    expect(
      organiserNotificationMocks.sendOrganiserAssignmentNotification,
    ).not.toHaveBeenCalled();

    expect(send).toHaveBeenCalledTimes(1);
    const sentPayload = send.mock.calls[0]?.[0] as
      | {
          embeds?: {
            toJSON(): {
              description?: string;
            };
          }[];
        }
      | undefined;

    const description = sentPayload?.embeds?.[0]?.toJSON().description ?? "";

    expect(description).not.toContain("**Organiser**");

    expect(description).not.toContain("Not assigned");
  });
});

async function createPublicationFixture(
  pool: Pool,
  input: {
    organisersEnabled: boolean;
  },
): Promise<{
  eventId: number;

  assignmentId: number;
}> {
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
    [DISCORD_GUILD_ID, "Publication Feature Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "default_attendance_channel_id",
        "organisers_enabled"
      )
      VALUES ($1, $2, $3)
    `,
    [guildId, CHANNEL_ID, input.organisersEnabled],
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
          "attendance_closes_at",
          "status",
          "created_by_user_id"
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW() + INTERVAL '2 hours',
          true,
          NOW() + INTERVAL '1 hour',
          'scheduled',
          $4
        )
        RETURNING "id"
      `,
    [guildId, eventTypeId, "Publication Organiser Feature Test", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const assignmentResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_organiser_assignments" (
          "event_id",
          "slot",
          "discord_user_id",
          "display_name_snapshot",
          "status",
          "is_current",
          "assigned_by_user_id",
          "activated_at",
          "response_deadline_at"
        )
        VALUES (
          $1,
          'primary',
          $2,
          'Dormant Primary',
          'pending',
          true,
          $3,
          NULL,
          NULL
        )
        RETURNING "id"
      `,
    [eventId, ORGANISER_USER_ID, ADMIN_USER_ID],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
  }

  return {
    eventId,

    assignmentId,
  };
}
