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

import { pool as applicationPool } from "../../../src/db/client.js";
import {
  reconcileOrganiserPendingWarning,
  sendOrganiserAssignmentNotification,
  sendOrganiserPendingWarning,
} from "../../../src/events/organiser-notification.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "820000000000000001";

const WARNING_CHANNEL_ID = "820000000000000002";

const WARNING_MESSAGE_ID = "820000000000000003";

const ORGANISER_USER_ID = "820000000000000004";

const ADMIN_USER_ID = "820000000000000005";

describe("organiser notification reconciliation", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  it("updates an already-posted organiser warning after the organiser confirms", async () => {
    // Arrange
    const fixture = await createConfirmedAssignmentWithWarning(pool);

    const editWarning = vi.fn().mockResolvedValue(undefined);

    const fetchMessage = vi.fn().mockResolvedValue({
      id: WARNING_MESSAGE_ID,

      edit: editWarning,
    });

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      messages: {
        fetch: fetchMessage,
      },
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await reconcileOrganiserPendingWarning({
      guild,

      assignmentId: fixture.assignmentId,
    });

    // Assert
    expect(result).toBe(true);

    /*
     * Reconciliation uses the exact Discord location stored when the
     * warning was originally posted.
     */
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(WARNING_MESSAGE_ID);

    expect(editWarning).toHaveBeenCalledTimes(1);

    const editedPayload = editWarning.mock.calls[0]?.[0];

    expect(editedPayload).toEqual(
      expect.objectContaining({
        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(editedPayload?.content).toContain(
      "✅ **Organiser response resolved**",
    );

    expect(editedPayload?.content).toContain(`<@${ORGANISER_USER_ID}>`);

    expect(editedPayload?.content).toContain("primary organiser");

    expect(editedPayload?.content).toContain(
      "Organiser Warning Reconciliation Test",
    );

    expect(editedPayload?.content).toContain(`#${fixture.eventId}`);

    /*
     * Most importantly, the stale pending-state wording is gone.
     */
    expect(editedPayload?.content).not.toContain("has not yet confirmed");

    /*
     * Discord reconciliation is presentation cleanup only. It must not
     * rewrite the authoritative organiser response.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
              SELECT
                "status",
                "is_current",
                "warning_channel_id",
                "warning_message_id"
              FROM
                "event_organiser_assignments"
              WHERE "id" = $1
            `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "confirmed",

        is_current: true,

        warning_channel_id: WARNING_CHANNEL_ID,

        warning_message_id: WARNING_MESSAGE_ID,
      },
    ]);
  });

  it("updates an already-posted organiser warning after the organiser times out", async () => {
    // Arrange
    const fixture = await createConfirmedAssignmentWithWarning(pool);

    /*
     * Reuse the otherwise realistic warning fixture, then make the timeout
     * authoritative in PostgreSQL before asking Discord presentation to catch
     * up with that state.
     */
    await pool.query(
      `
      UPDATE "event_organiser_assignments"
      SET
        "status" = 'timed_out',
        "is_current" = false,
        "response_deadline_at" = NOW() - INTERVAL '1 minute',
        "responded_at" = NULL
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    const editWarning = vi.fn().mockResolvedValue(undefined);

    const fetchMessage = vi.fn().mockResolvedValue({
      id: WARNING_MESSAGE_ID,

      edit: editWarning,
    });

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,
      messages: {
        fetch: fetchMessage,
      },
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await reconcileOrganiserPendingWarning({
      guild,

      assignmentId: fixture.assignmentId,
    });

    // Assert
    expect(result).toBe(true);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(WARNING_MESSAGE_ID);

    expect(editWarning).toHaveBeenCalledTimes(1);

    const editedPayload = editWarning.mock.calls[0]?.[0];

    expect(editedPayload).toEqual(
      expect.objectContaining({
        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(editedPayload?.content).toContain(
      "⌛ **Organiser response deadline passed**",
    );

    expect(editedPayload?.content).toContain(`<@${ORGANISER_USER_ID}>`);

    expect(editedPayload?.content).toContain("primary organiser");

    expect(editedPayload?.content).toContain(
      "Organiser Warning Reconciliation Test",
    );

    expect(editedPayload?.content).toContain(`#${fixture.eventId}`);

    expect(editedPayload?.content).toContain(
      "did not confirm the **primary organiser** assignment",
    );

    /*
     * The warning must no longer claim the organiser is merely awaiting a
     * response after their deadline has already expired.
     */
    expect(editedPayload?.content).not.toContain("has not yet confirmed");

    /*
     * Reconciliation remains presentation-only. It must not modify the
     * authoritative timeout state or discard the stored Discord linkage.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "warning_channel_id",
        "warning_message_id"
      FROM
        "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "timed_out",

        is_current: false,

        warning_channel_id: WARNING_CHANNEL_ID,

        warning_message_id: WARNING_MESSAGE_ID,
      },
    ]);
  });

  it("updates an already-posted organiser warning after the assignment is removed", async () => {
    // Arrange
    const fixture = await createConfirmedAssignmentWithWarning(pool);

    /*
     * Make the administrative removal authoritative before asking Discord
     * presentation to catch up with it.
     */
    await pool.query(
      `
      UPDATE "event_organiser_assignments"
      SET
        "status" = 'removed',
        "is_current" = false
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    const editWarning = vi.fn().mockResolvedValue(undefined);

    const fetchMessage = vi.fn().mockResolvedValue({
      id: WARNING_MESSAGE_ID,

      edit: editWarning,
    });

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      messages: {
        fetch: fetchMessage,
      },
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await reconcileOrganiserPendingWarning({
      guild,

      assignmentId: fixture.assignmentId,
    });

    // Assert
    expect(result).toBe(true);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(WARNING_MESSAGE_ID);

    expect(editWarning).toHaveBeenCalledTimes(1);

    const editedPayload = editWarning.mock.calls[0]?.[0];

    expect(editedPayload).toEqual(
      expect.objectContaining({
        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(editedPayload?.content).toContain(
      "ℹ️ **Organiser response no longer required**",
    );

    expect(editedPayload?.content).toContain(`<@${ORGANISER_USER_ID}>`);

    expect(editedPayload?.content).toContain("primary organiser");

    expect(editedPayload?.content).toContain(
      "Organiser Warning Reconciliation Test",
    );

    expect(editedPayload?.content).toContain(`#${fixture.eventId}`);

    expect(editedPayload?.content).toContain("is no longer current");

    /*
     * The warning must no longer claim that the removed organiser still has an
     * outstanding response to provide.
     */
    expect(editedPayload?.content).not.toContain("has not yet confirmed");

    /*
     * Reconciliation is presentation-only. The authoritative removal and the
     * stored Discord linkage must remain untouched.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "warning_channel_id",
        "warning_message_id"
      FROM
        "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "removed",

        is_current: false,

        warning_channel_id: WARNING_CHANNEL_ID,

        warning_message_id: WARNING_MESSAGE_ID,
      },
    ]);
  });

  it("updates an already-posted organiser warning after the event is cancelled", async () => {
    // Arrange
    const fixture = await createConfirmedAssignmentWithWarning(pool);

    /*
     * Recreate the state which exists when an event is cancelled while its
     * organiser is still awaiting a response.
     *
     * Cancellation terminates the response requirement; it does not rewrite
     * the organiser assignment history.
     */
    await pool.query(
      `
      UPDATE "event_organiser_assignments"
      SET
        "status" = 'pending',
        "is_current" = true,
        "responded_at" = NULL
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    await pool.query(
      `
      UPDATE "events"
      SET "status" = 'cancelled'
      WHERE "id" = $1
    `,
      [fixture.eventId],
    );

    const editWarning = vi.fn().mockResolvedValue(undefined);

    const fetchMessage = vi.fn().mockResolvedValue({
      id: WARNING_MESSAGE_ID,

      edit: editWarning,
    });

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      messages: {
        fetch: fetchMessage,
      },
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await reconcileOrganiserPendingWarning({
      guild,

      assignmentId: fixture.assignmentId,
    });

    // Assert
    expect(result).toBe(true);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchMessage).toHaveBeenCalledTimes(1);

    expect(fetchMessage).toHaveBeenCalledWith(WARNING_MESSAGE_ID);

    expect(editWarning).toHaveBeenCalledTimes(1);

    const editedPayload = editWarning.mock.calls[0]?.[0];

    expect(editedPayload).toEqual(
      expect.objectContaining({
        allowedMentions: {
          parse: [],
        },
      }),
    );

    expect(editedPayload?.content).toContain(
      "ℹ️ **Organiser response no longer required**",
    );

    expect(editedPayload?.content).toContain(`<@${ORGANISER_USER_ID}>`);

    expect(editedPayload?.content).toContain("primary organiser");

    expect(editedPayload?.content).toContain(
      "Organiser Warning Reconciliation Test",
    );

    expect(editedPayload?.content).toContain(`#${fixture.eventId}`);

    expect(editedPayload?.content).toContain(
      "is no longer active because the event is **cancelled**",
    );

    /*
     * The Discord message must no longer claim that the organiser still has an
     * outstanding response to provide.
     */
    expect(editedPayload?.content).not.toContain("has not yet confirmed");

    /*
     * Reconciliation is presentation-only. Cancellation remains an event-level
     * lifecycle change and must not rewrite the organiser assignment itself.
     */
    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      warning_channel_id: string | null;
      warning_message_id: string | null;
    }>(
      `
      SELECT
        "status",
        "is_current",
        "warning_channel_id",
        "warning_message_id"
      FROM
        "event_organiser_assignments"
      WHERE "id" = $1
    `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "pending",

        is_current: true,

        warning_channel_id: WARNING_CHANNEL_ID,

        warning_message_id: WARNING_MESSAGE_ID,
      },
    ]);

    const eventResult = await pool.query<{
      status: string;
    }>(
      `
      SELECT "status"
      FROM "events"
      WHERE "id" = $1
    `,
      [fixture.eventId],
    );

    expect(eventResult.rows).toEqual([
      {
        status: "cancelled",
      },
    ]);
  });
});

describe("organiser assignment notification delivery", () => {
  it("propagates an unexpected Event Administration channel fetch failure after DM fallback", async () => {
    // Arrange
    const dmError = new Error("Organiser DMs are unavailable.");

    const transientChannelError = new Error(
      "Temporary Discord channel fetch failure.",
    );

    const sendDm = vi.fn().mockRejectedValue(dmError);

    const fetchMember = vi.fn().mockResolvedValue({
      send: sendDm,
    });

    const fetchChannel = vi.fn().mockRejectedValue(transientChannelError);

    const guild = {
      id: DISCORD_GUILD_ID,

      members: {
        fetch: fetchMember,
      },

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act / Assert
    await expect(
      sendOrganiserAssignmentNotification({
        guild,

        assignmentId: 123,

        eventId: 456,

        eventName: "Organiser Notification Failure Test",

        discordUserId: ORGANISER_USER_ID,

        slot: "primary",

        eventAdminChannelId: WARNING_CHANNEL_ID,
      }),
    ).rejects.toBe(transientChannelError);

    /*
     * The normal DM-first policy must still be attempted before falling back
     * to the configured Event Administration channel.
     */
    expect(fetchMember).toHaveBeenCalledTimes(1);

    expect(fetchMember).toHaveBeenCalledWith(ORGANISER_USER_ID);

    expect(sendDm).toHaveBeenCalledTimes(1);

    /*
     * Once DM delivery fails, the configured administration channel is the
     * only legitimate fallback destination.
     */
    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);
  });

  it("returns failed when the configured Event Administration channel has been deleted", async () => {
    // Arrange
    const sendDm = vi
      .fn()
      .mockRejectedValue(new Error("Organiser DMs are unavailable."));

    const fetchMember = vi.fn().mockResolvedValue({
      send: sendDm,
    });

    const unknownChannelError = {
      code: 10003,
      message: "Unknown Channel",
    };

    const fetchChannel = vi.fn().mockRejectedValue(unknownChannelError);

    const guild = {
      id: DISCORD_GUILD_ID,

      members: {
        fetch: fetchMember,
      },

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserAssignmentNotification({
      guild,

      assignmentId: 123,

      eventId: 456,

      eventName: "Deleted Administration Channel Test",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      eventAdminChannelId: WARNING_CHANNEL_ID,
    });

    // Assert
    expect(result).toBe("failed");

    expect(fetchMember).toHaveBeenCalledTimes(1);

    expect(fetchMember).toHaveBeenCalledWith(ORGANISER_USER_ID);

    expect(sendDm).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);
  });
});

describe("organiser pending warning delivery", () => {
  it("returns no delivery when the configured Event Administration channel has been deleted", async () => {
    // Arrange
    const unknownChannelError = {
      code: 10003,
      message: "Unknown Channel",
    };

    const fetchChannel = vi.fn().mockRejectedValue(unknownChannelError);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserPendingWarning({
      guild,

      eventAdminChannelId: WARNING_CHANNEL_ID,

      eventId: 456,

      eventName: "Deleted Warning Channel Test",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      responseDeadlineAt: new Date(Date.now() + 5 * 60_000),
    });

    // Assert
    expect(result).toBeNull();

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);
  });

  it("returns no delivery when the Event Administration channel is deleted while the warning is being sent", async () => {
    // Arrange
    const unknownChannelError = {
      code: 10003,
      message: "Unknown Channel",
    };

    const sendWarning = vi.fn().mockRejectedValue(unknownChannelError);

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),

      send: sendWarning,
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserPendingWarning({
      guild,

      eventAdminChannelId: WARNING_CHANNEL_ID,

      eventId: 456,

      eventName: "Deleted Warning Channel Test",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      responseDeadlineAt: new Date(Date.now() + 5 * 60_000),
    });

    // Assert
    expect(result).toBeNull();

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(sendWarning).toHaveBeenCalledTimes(1);
  });
});

async function createConfirmedAssignmentWithWarning(pool: Pool): Promise<{
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
    [DISCORD_GUILD_ID, "Organiser Notification Test Guild"],
  );

  const guildDatabaseId = guildResult.rows[0]?.id;

  if (!guildDatabaseId) {
    throw new Error("The integration-test guild was not created.");
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
        VALUES ($1, $2, $3)
        RETURNING "id"
      `,
    [guildDatabaseId, "naval", "Naval Event"],
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
          "status",
          "created_by_user_id"
        )
        VALUES (
          $1,
          $2,
          'Organiser Warning Reconciliation Test',
          NOW() + INTERVAL '2 hours',
          true,
          NOW() - INTERVAL '30 minutes',
          'open',
          $3
        )
        RETURNING "id"
      `,
    [guildDatabaseId, eventTypeId, ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const assignmentResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_organiser_assignments" (
            "event_id",
            "slot",
            "discord_user_id",
            "display_name_snapshot",
            "status",
            "is_current",
            "assigned_by_user_id",
            "activated_at",
            "response_deadline_at",
            "warning_channel_id",
            "warning_message_id",
            "responded_at"
          )
        VALUES (
          $1,
          'primary',
          $2,
          'Test Organiser',
          'confirmed',
          true,
          $3,
          NOW() - INTERVAL '10 minutes',
          NOW() + INTERVAL '5 minutes',
          $4,
          $5,
          NOW()
        )
        RETURNING "id"
      `,
    [
      eventId,
      ORGANISER_USER_ID,
      ADMIN_USER_ID,
      WARNING_CHANNEL_ID,
      WARNING_MESSAGE_ID,
    ],
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
