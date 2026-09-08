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

    const safetyActionResult = await pool.query<{
      count: number;
    }>(
      `
      SELECT COUNT(*)::int AS "count"
      FROM "scheduled_actions"
      WHERE
        "event_id" = $1
        AND (
          "action_key" LIKE
            'organiser_cover_deadline:%'
          OR
          "action_key" LIKE
            'organiser_missing_at_start:%'
        )
    `,
      [fixture.eventId],
    );

    expect(safetyActionResult.rows).toEqual([
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

  it("schedules organiser safety actions and activates the dormant primary when published before the cover deadline", async () => {
    // Arrange
    const fixture = await createPublicationFixture(pool, {
      organisersEnabled: true,

      startsInMinutes: 120,

      organiserCoverBeforeStartMinutes: 15,
    });

    const { guild } = createPublicationDiscordGuild();

    // Act
    const result = await publishStoredEvent(guild, fixture.eventId);

    // Assert
    expect(result).toMatchObject({
      ok: true,

      eventId: fixture.eventId,
    });

    expect(
      organiserNotificationMocks.sendOrganiserAssignmentNotification,
    ).toHaveBeenCalledTimes(1);

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

    expect(assignmentResult.rows).toHaveLength(1);

    const assignment = assignmentResult.rows[0];

    expect(assignment).toMatchObject({
      status: "pending",

      is_current: true,
    });

    expect(assignment?.activated_at).toBeInstanceOf(Date);

    expect(assignment?.response_deadline_at).toBeInstanceOf(Date);

    /*
     * The primary confirmation deadline remains activation-relative.
     *
     * With the new default it should be approximately 70 minutes after
     * publication/activation.
     */
    expect(
      assignment!.response_deadline_at!.getTime() -
        assignment!.activated_at!.getTime(),
    ).toBe(70 * 60_000);

    const safetyActions = await pool.query<{
      action_key: string;

      due_at: Date;
    }>(
      `
        SELECT
          "action_key",
          "due_at"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" IN (
            $2,
            $3
          )
        ORDER BY "due_at"
      `,
      [
        fixture.eventId,

        `organiser_cover_deadline:${fixture.eventId}`,

        `organiser_missing_at_start:${fixture.eventId}`,
      ],
    );

    expect(safetyActions.rows).toHaveLength(2);

    expect(safetyActions.rows[0]?.action_key).toBe(
      `organiser_cover_deadline:${fixture.eventId}`,
    );

    expect(safetyActions.rows[0]?.due_at.getTime()).toBe(
      fixture.startsAt.getTime() - 15 * 60_000,
    );

    expect(safetyActions.rows[1]?.action_key).toBe(
      `organiser_missing_at_start:${fixture.eventId}`,
    );

    expect(safetyActions.rows[1]?.due_at.getTime()).toBe(
      fixture.startsAt.getTime(),
    );
  });

  it("does not activate a dormant primary when publication occurs after the cover safety deadline", async () => {
    // Arrange
    const fixture = await createPublicationFixture(pool, {
      organisersEnabled: true,

      /*
       * Event starts in ten minutes while the safety deadline is fifteen
       * minutes before start.
       *
       * Publication therefore occurs five minutes after the safety
       * deadline has already passed.
       */
      startsInMinutes: 10,

      organiserCoverBeforeStartMinutes: 15,

      /*
       * Avoid an already-expired attendance-close deadline obscuring the
       * organiser behaviour this test is exercising.
       */
      signupsEnabled: false,
    });

    const { guild, send } = createPublicationDiscordGuild();

    // Act
    const result = await publishStoredEvent(guild, fixture.eventId);

    // Assert
    expect(result).toMatchObject({
      ok: true,

      eventId: fixture.eventId,

      primaryOrganiserNotification: null,
    });

    /*
     * The nominated primary no longer has time for a normal confirmation
     * window, so publication must not activate or notify them.
     */
    expect(
      organiserNotificationMocks.sendOrganiserAssignmentNotification,
    ).not.toHaveBeenCalled();

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

    /*
     * The event-level safety actions still exist. In particular, the cover
     * deadline is already overdue, so the scheduler can pick it up
     * immediately once its executor is implemented.
     */
    const publicationState = await pool.query<{
      published_at: Date;

      starts_at: Date;
    }>(
      `
        SELECT
          "published_at",
          "starts_at"
        FROM "events"
        WHERE "id" = $1
      `,
      [fixture.eventId],
    );

    const event = publicationState.rows[0];

    if (!event) {
      throw new Error("The published event was not returned.");
    }

    const safetyActions = await pool.query<{
      action_key: string;

      due_at: Date;
    }>(
      `
        SELECT
          "action_key",
          "due_at"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" IN (
            $2,
            $3
          )
        ORDER BY "due_at"
      `,
      [
        fixture.eventId,

        `organiser_cover_deadline:${fixture.eventId}`,

        `organiser_missing_at_start:${fixture.eventId}`,
      ],
    );

    expect(safetyActions.rows).toHaveLength(2);

    const coverDeadline = safetyActions.rows.find(
      (action) =>
        action.action_key === `organiser_cover_deadline:${fixture.eventId}`,
    );

    const missingAtStart = safetyActions.rows.find(
      (action) =>
        action.action_key === `organiser_missing_at_start:${fixture.eventId}`,
    );

    expect(coverDeadline).toBeDefined();

    expect(coverDeadline!.due_at.getTime()).toBeLessThan(
      event.published_at.getTime(),
    );

    expect(coverDeadline!.due_at.getTime()).toBe(
      event.starts_at.getTime() - 15 * 60_000,
    );

    expect(missingAtStart).toBeDefined();

    expect(missingAtStart!.due_at.getTime()).toBe(event.starts_at.getTime());

    /*
     * Because the dormant primary is deliberately not activated, the initial
     * event announcement should not misleadingly present them as the active
     * organiser.
     */
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

    expect(description).not.toContain(`<@${ORGANISER_USER_ID}>`);
  });
});

function createPublicationDiscordGuild(): {
  guild: Guild;

  send: ReturnType<typeof vi.fn>;
} {
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

  return {
    guild,

    send,
  };
}

async function createPublicationFixture(
  pool: Pool,
  input: {
    organisersEnabled: boolean;
    startsInMinutes?: number;
    signupsEnabled?: boolean;
    organiserCoverBeforeStartMinutes?: number;
  },
): Promise<{
  eventId: number;
  assignmentId: number;
  startsAt: Date;
}> {
  const startsInMinutes = input.startsInMinutes ?? 120;

  const signupsEnabled = input.signupsEnabled ?? true;

  const organiserCoverBeforeStartMinutes =
    input.organiserCoverBeforeStartMinutes ?? 15;

  const startsAt = new Date(Date.now() + startsInMinutes * 60_000);

  const attendanceClosesAt = signupsEnabled
    ? new Date(startsAt.getTime() - 60 * 60_000)
    : null;

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
        "organisers_enabled",
        "organiser_cover_before_start_minutes"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      guildId,
      CHANNEL_ID,
      input.organisersEnabled,
      organiserCoverBeforeStartMinutes,
    ],
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
          $4,
          $5,
          $6,
          'scheduled',
          $7
        )
        RETURNING "id"
      `,
    [
      guildId,
      eventTypeId,
      "Publication Organiser Feature Test",
      startsAt,
      signupsEnabled,
      attendanceClosesAt,
      ADMIN_USER_ID,
    ],
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
    startsAt,
  };
}
