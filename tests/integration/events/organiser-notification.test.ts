import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
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
  sendOrganiserAssignmentNotification,
  sendOrganiserCoverRequest,
  sendOrganiserPendingWarning,
} from "../../../src/events/organiser-notification.js";
import { reconcileOrganiserPendingWarning } from "../../../src/events/organiser-warning-reconciliation.js";
import { reconcileOrganiserCoverMessages } from "../../../src/events/organiser-cover-reconciliation.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "820000000000000001";

const WARNING_CHANNEL_ID = "820000000000000002";

const WARNING_MESSAGE_ID = "820000000000000003";

const ORGANISER_USER_ID = "820000000000000004";

const ADMIN_USER_ID = "820000000000000005";

const ORGANISER_ROLE_ID = "820000000000000006";

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

  describe("organiser cover message reconciliation", () => {
    it("resolves every outstanding organiser cover message after cover is claimed", async () => {
      // Arrange
      const fixture = await createOrganiserCoverMessageFixture(pool);

      const editCover = vi.fn().mockResolvedValue(undefined);

      const editStartAlert = vi.fn().mockResolvedValue(undefined);

      const fetchMessage = vi.fn(async (messageId: string) => {
        if (messageId === fixture.coverMessageId) {
          return {
            id: messageId,

            edit: editCover,
          };
        }

        if (messageId === fixture.startAlertMessageId) {
          return {
            id: messageId,

            edit: editStartAlert,
          };
        }

        throw new Error(`Unexpected message ID: ${messageId}`);
      });

      const channel = {
        id: fixture.channelId,

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
      const result = await reconcileOrganiserCoverMessages({
        guild,

        eventId: fixture.eventId,

        resolution: {
          kind: "claimed",

          organiserUserId: ORGANISER_USER_ID,
        },
      });

      // Assert
      expect(result).toBe(2);

      expect(fetchChannel).toHaveBeenCalledTimes(2);

      expect(fetchChannel).toHaveBeenNthCalledWith(1, fixture.channelId);

      expect(fetchChannel).toHaveBeenNthCalledWith(2, fixture.channelId);

      expect(fetchMessage).toHaveBeenCalledTimes(2);

      expect(fetchMessage).toHaveBeenCalledWith(fixture.coverMessageId);

      expect(fetchMessage).toHaveBeenCalledWith(fixture.startAlertMessageId);

      expect(editCover).toHaveBeenCalledTimes(1);

      expect(editStartAlert).toHaveBeenCalledTimes(1);

      for (const editMessage of [editCover, editStartAlert]) {
        expect(editMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            components: [],

            allowedMentions: {
              parse: [],
            },

            content: expect.stringContaining(
              `Cover was claimed by <@${ORGANISER_USER_ID}>`,
            ),
          }),
        );
      }

      const messageRows = await pool.query<{
        kind: string;

        resolved_at: Date | null;

        deleted_at: Date | null;
      }>(
        `
        SELECT
          "kind"::text AS "kind",
          "resolved_at",
          "deleted_at"
        FROM
          "event_messages"
        WHERE
          "event_id" = $1
        ORDER BY
          "id"
      `,
        [fixture.eventId],
      );

      expect(messageRows.rows).toHaveLength(2);

      expect(messageRows.rows[0]).toEqual({
        kind: "organiser_cover",

        resolved_at: expect.any(Date),

        deleted_at: null,
      });

      expect(messageRows.rows[1]).toEqual({
        kind: "organiser_missing_at_start",

        resolved_at: expect.any(Date),

        deleted_at: null,
      });
    });

    it("can resolve only older general-cover messages when the event-start alert supersedes them", async () => {
      // Arrange
      const fixture = await createOrganiserCoverMessageFixture(pool);

      const editCover = vi.fn().mockResolvedValue(undefined);

      const fetchMessage = vi.fn().mockResolvedValue({
        id: fixture.coverMessageId,

        edit: editCover,
      });

      const channel = {
        id: fixture.channelId,

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
      const result = await reconcileOrganiserCoverMessages({
        guild,

        eventId: fixture.eventId,

        resolution: {
          kind: "superseded_at_start",
        },

        scope: "cover_only",
      });

      // Assert
      expect(result).toBe(1);

      expect(fetchMessage).toHaveBeenCalledTimes(1);

      expect(fetchMessage).toHaveBeenCalledWith(fixture.coverMessageId);

      expect(editCover).toHaveBeenCalledWith(
        expect.objectContaining({
          components: [],

          content: expect.stringContaining(
            "superseded by the event-start organiser alert",
          ),

          allowedMentions: {
            parse: [],
          },
        }),
      );

      const messageRows = await pool.query<{
        kind: string;

        resolved_at: Date | null;
      }>(
        `
        SELECT
          "kind"::text AS "kind",
          "resolved_at"
        FROM
          "event_messages"
        WHERE
          "event_id" = $1
        ORDER BY
          "id"
      `,
        [fixture.eventId],
      );

      expect(messageRows.rows).toEqual([
        {
          kind: "organiser_cover",

          resolved_at: expect.any(Date),
        },
        {
          kind: "organiser_missing_at_start",

          resolved_at: null,
        },
      ]);
    });

    it("marks a deleted organiser cover message as resolved and deleted", async () => {
      // Arrange
      const fixture = await createOrganiserCoverMessageFixture(pool, {
        includeStartAlert: false,
      });

      const unknownMessageError = {
        code: 10008,

        message: "Unknown Message",
      };

      const fetchMessage = vi.fn().mockRejectedValue(unknownMessageError);

      const channel = {
        id: fixture.channelId,

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
      const result = await reconcileOrganiserCoverMessages({
        guild,

        eventId: fixture.eventId,

        resolution: {
          kind: "event_completed",
        },
      });

      // Assert
      expect(result).toBe(1);

      const messageResult = await pool.query<{
        resolved_at: Date | null;

        deleted_at: Date | null;
      }>(
        `
        SELECT
          "resolved_at",
          "deleted_at"
        FROM
          "event_messages"
        WHERE
          "message_id" = $1
      `,
        [fixture.coverMessageId],
      );

      expect(messageResult.rows).toEqual([
        {
          resolved_at: expect.any(Date),

          deleted_at: expect.any(Date),
        },
      ]);
    });

    it("propagates an unexpected Discord failure and leaves the message unresolved", async () => {
      // Arrange
      const fixture = await createOrganiserCoverMessageFixture(pool, {
        includeStartAlert: false,
      });

      const transientError = new Error("Temporary Discord failure.");

      const fetchMessage = vi.fn().mockRejectedValue(transientError);

      const channel = {
        id: fixture.channelId,

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

      // Act / Assert
      await expect(
        reconcileOrganiserCoverMessages({
          guild,

          eventId: fixture.eventId,

          resolution: {
            kind: "event_cancelled",
          },
        }),
      ).rejects.toBe(transientError);

      const messageResult = await pool.query<{
        resolved_at: Date | null;

        deleted_at: Date | null;
      }>(
        `
        SELECT
          "resolved_at",
          "deleted_at"
        FROM
          "event_messages"
        WHERE
          "message_id" = $1
      `,
        [fixture.coverMessageId],
      );

      expect(messageResult.rows).toEqual([
        {
          resolved_at: null,

          deleted_at: null,
        },
      ]);
    });

    it("does not fetch organiser messages which have already been resolved", async () => {
      // Arrange
      const fixture = await createOrganiserCoverMessageFixture(pool, {
        includeStartAlert: false,
      });

      await pool.query(
        `
        UPDATE
          "event_messages"
        SET
          "resolved_at" = NOW()
        WHERE
          "message_id" = $1
      `,
        [fixture.coverMessageId],
      );

      const fetchChannel = vi.fn();

      const guild = {
        id: DISCORD_GUILD_ID,

        channels: {
          fetch: fetchChannel,
        },
      } as unknown as Guild;

      // Act
      const result = await reconcileOrganiserCoverMessages({
        guild,

        eventId: fixture.eventId,

        resolution: {
          kind: "event_completed",
        },
      });

      // Assert
      expect(result).toBe(0);

      expect(fetchChannel).not.toHaveBeenCalled();
    });
  });
});

describe("organiser assignment notification delivery", () => {
  it("uses DM delivery when organiser DMs are enabled and the DM succeeds", async () => {
    // Arrange
    const sendDm = vi.fn().mockResolvedValue(undefined);

    const fetchMember = vi.fn().mockResolvedValue({
      send: sendDm,
    });

    const fetchChannel = vi.fn();

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

      eventName: "DM Enabled Test",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      eventAdminChannelId: WARNING_CHANNEL_ID,

      organiserDmsEnabled: true,
    });

    // Assert
    expect(result).toBe("dm");

    expect(fetchMember).toHaveBeenCalledTimes(1);

    expect(fetchMember).toHaveBeenCalledWith(ORGANISER_USER_ID);

    expect(sendDm).toHaveBeenCalledTimes(1);

    /*
     * Successful DM delivery must not also post an administration-channel
     * notification.
     */
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it("sends directly to the Event Administration channel when organiser DMs are disabled", async () => {
    // Arrange
    const fetchMember = vi.fn();

    const sendAdminNotification = vi.fn().mockResolvedValue({
      id: "820000000000000009",
    });

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),

      send: sendAdminNotification,
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

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

      eventName: "DM Disabled Test",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      eventAdminChannelId: WARNING_CHANNEL_ID,

      organiserDmsEnabled: false,
    });

    // Assert
    expect(result).toBe("admin_channel");

    /*
     * This is the critical feature-switch guarantee: disabling organiser DMs
     * means the DM path is skipped entirely, not merely attempted and ignored.
     */
    expect(fetchMember).not.toHaveBeenCalled();

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(sendAdminNotification).toHaveBeenCalledTimes(1);

    expect(sendAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "Direct organiser DMs are disabled for this server.",
        ),

        allowedMentions: {
          parse: [],

          users: [ORGANISER_USER_ID],
        },
      }),
    );

    const sentPayload = sendAdminNotification.mock.calls[0]?.[0];

    expect(sentPayload?.content).not.toContain(
      "The bot could not deliver a DM",
    );
  });

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

        organiserDmsEnabled: true,
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

      organiserDmsEnabled: true,
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

  it("propagates an unexpected Event Administration channel failure while posting a warning", async () => {
    // Arrange
    const transientSendError = new Error(
      "Temporary Discord warning send failure.",
    );

    const sendWarning = vi.fn().mockRejectedValue(transientSendError);

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

    // Act / Assert
    await expect(
      sendOrganiserPendingWarning({
        guild,

        eventAdminChannelId: WARNING_CHANNEL_ID,

        eventId: 456,

        eventName: "Transient Warning Failure Test",

        discordUserId: ORGANISER_USER_ID,

        slot: "primary",

        responseDeadlineAt: new Date(Date.now() + 5 * 60_000),
      }),
    ).rejects.toBe(transientSendError);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(sendWarning).toHaveBeenCalledTimes(1);
  });
});

describe("organiser cover-request delivery", () => {
  it("returns failed when the configured Event Administration channel has been deleted", async () => {
    // Arrange
    const unknownChannelError = {
      code: 10003,
      message: "Unknown Channel",
    };

    const fetchChannel = vi.fn().mockRejectedValue(unknownChannelError);

    const fetchRole = vi.fn().mockResolvedValue({
      id: ORGANISER_ROLE_ID,

      name: "Event Organiser",

      mentionable: true,
    });

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },

      roles: {
        fetch: fetchRole,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserCoverRequest({
      guild,

      eventId: 456,

      eventName: "Deleted Cover Channel Test",

      eventAdminChannelId: WARNING_CHANNEL_ID,

      eventOrganiserRoleId: ORGANISER_ROLE_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "failed",

      delivery: "failed",
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);
  });

  it("returns failed when the Event Administration channel is deleted while the cover request is being sent", async () => {
    // Arrange
    const unknownChannelError = {
      code: 10003,
      message: "Unknown Channel",
    };

    const sendCoverRequest = vi.fn().mockRejectedValue(unknownChannelError);

    const permissions = {
      has: vi.fn().mockReturnValue(false),
    };

    const botMember = {
      id: "820000000000000007",
    };

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),

      permissionsFor: vi.fn().mockReturnValue(permissions),

      send: sendCoverRequest,
    };

    const role = {
      id: ORGANISER_ROLE_ID,

      name: "Event Organiser",

      mentionable: true,
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const fetchRole = vi.fn().mockResolvedValue(role);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },

      roles: {
        fetch: fetchRole,
      },

      members: {
        me: botMember,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserCoverRequest({
      guild,

      eventId: 456,

      eventName: "Deleted Cover Channel Test",

      eventAdminChannelId: WARNING_CHANNEL_ID,

      eventOrganiserRoleId: ORGANISER_ROLE_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "failed",

      delivery: "failed",
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchRole).toHaveBeenCalledTimes(1);

    expect(fetchRole).toHaveBeenCalledWith(ORGANISER_ROLE_ID);

    expect(sendCoverRequest).toHaveBeenCalledTimes(1);
  });

  it("propagates an unexpected Event Administration channel failure while posting a cover request", async () => {
    // Arrange
    const transientSendError = new Error(
      "Temporary Discord cover-request send failure.",
    );

    const sendCoverRequest = vi.fn().mockRejectedValue(transientSendError);

    const permissions = {
      has: vi.fn().mockReturnValue(false),
    };

    const botMember = {
      id: "820000000000000007",
    };

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),

      permissionsFor: vi.fn().mockReturnValue(permissions),

      send: sendCoverRequest,
    };

    const role = {
      id: ORGANISER_ROLE_ID,

      name: "Event Organiser",

      mentionable: true,
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const fetchRole = vi.fn().mockResolvedValue(role);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },

      roles: {
        fetch: fetchRole,
      },

      members: {
        me: botMember,
      },
    } as unknown as Guild;

    // Act / Assert
    await expect(
      sendOrganiserCoverRequest({
        guild,

        eventId: 456,

        eventName: "Transient Cover Request Failure Test",

        eventAdminChannelId: WARNING_CHANNEL_ID,

        eventOrganiserRoleId: ORGANISER_ROLE_ID,
      }),
    ).rejects.toBe(transientSendError);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchRole).toHaveBeenCalledTimes(1);

    expect(fetchRole).toHaveBeenCalledWith(ORGANISER_ROLE_ID);

    expect(sendCoverRequest).toHaveBeenCalledTimes(1);
  });

  it("returns failed when the configured Event Organiser role has been deleted", async () => {
    // Arrange
    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    /*
     * discord.js RoleManager#fetch() converts Discord's Unknown Role response
     * into null for a single-role fetch.
     */
    const fetchRole = vi.fn().mockResolvedValue(null);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },

      roles: {
        fetch: fetchRole,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserCoverRequest({
      guild,

      eventId: 456,

      eventName: "Deleted Organiser Role Test",

      eventAdminChannelId: WARNING_CHANNEL_ID,

      eventOrganiserRoleId: ORGANISER_ROLE_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "failed",

      delivery: "failed",
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchRole).toHaveBeenCalledTimes(1);

    expect(fetchRole).toHaveBeenCalledWith(ORGANISER_ROLE_ID);
  });

  it("propagates an unexpected Event Organiser role fetch failure", async () => {
    // Arrange
    const transientRoleError = new Error(
      "Temporary Discord organiser-role fetch failure.",
    );

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const fetchRole = vi.fn().mockRejectedValue(transientRoleError);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },

      roles: {
        fetch: fetchRole,
      },
    } as unknown as Guild;

    // Act / Assert
    await expect(
      sendOrganiserCoverRequest({
        guild,

        eventId: 456,

        eventName: "Transient Organiser Role Failure Test",

        eventAdminChannelId: WARNING_CHANNEL_ID,

        eventOrganiserRoleId: ORGANISER_ROLE_ID,
      }),
    ).rejects.toBe(transientRoleError);

    expect(fetchChannel).toHaveBeenCalledTimes(1);

    expect(fetchChannel).toHaveBeenCalledWith(WARNING_CHANNEL_ID);

    expect(fetchRole).toHaveBeenCalledTimes(1);

    expect(fetchRole).toHaveBeenCalledWith(ORGANISER_ROLE_ID);
  });

  it("posts a cover request without pinging when the organiser role is not mentionable", async () => {
    // Arrange
    const sentCoverRequest = {
      id: "820000000000000008",

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const sendCoverRequest = vi.fn().mockResolvedValue(sentCoverRequest);

    const permissions = {
      has: vi.fn().mockReturnValue(false),
    };

    const botMember = {
      id: "820000000000000007",
    };

    const channel = {
      id: WARNING_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: vi.fn().mockReturnValue(true),

      permissionsFor: vi.fn().mockReturnValue(permissions),

      send: sendCoverRequest,
    };

    const role = {
      id: ORGANISER_ROLE_ID,

      name: "Event Organiser",

      mentionable: false,
    };

    const fetchChannel = vi.fn().mockResolvedValue(channel);

    const fetchRole = vi.fn().mockResolvedValue(role);

    const guild = {
      id: DISCORD_GUILD_ID,

      channels: {
        fetch: fetchChannel,
      },

      roles: {
        fetch: fetchRole,
      },

      members: {
        me: botMember,
      },
    } as unknown as Guild;

    // Act
    const result = await sendOrganiserCoverRequest({
      guild,

      eventId: 456,

      eventName: "Unmentionable Organiser Role Test",

      eventAdminChannelId: WARNING_CHANNEL_ID,

      eventOrganiserRoleId: ORGANISER_ROLE_ID,
    });

    // Assert
    expect(result).toEqual({
      kind: "sent",

      delivery: "posted_without_ping",

      channelId: WARNING_CHANNEL_ID,

      messageId: "820000000000000008",

      message: sentCoverRequest,
    });

    expect(sendCoverRequest).toHaveBeenCalledTimes(1);

    expect(sendCoverRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("**Event Organiser**"),

        allowedMentions: {
          parse: [],
        },
      }),
    );

    const sentPayload = sendCoverRequest.mock.calls[0]?.[0];

    expect(sentPayload?.content).not.toContain(`<@&${ORGANISER_ROLE_ID}>`);

    expect(permissions.has).toHaveBeenCalledWith(
      PermissionFlagsBits.MentionEveryone,
    );
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

async function createOrganiserCoverMessageFixture(
  pool: Pool,
  options: {
    includeStartAlert?: boolean;
  } = {},
): Promise<{
  eventId: number;

  channelId: string;

  coverMessageId: string;

  startAlertMessageId: string;
}> {
  const includeStartAlert = options.includeStartAlert ?? true;

  const channelId = "820000000000000020";

  const coverMessageId = "820000000000000021";

  const startAlertMessageId = "820000000000000022";

  const guildResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name",
        "timezone",
        "enabled"
      )
      VALUES (
        $1,
        'Organiser Cover Reconciliation Guild',
        'Europe/London',
        TRUE
      )
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildDatabaseId = guildResult.rows[0]?.id;

  if (!guildDatabaseId) {
    throw new Error("Failed to create organiser cover reconciliation guild.");
  }

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name",
        "role_requests_enabled",
        "active"
      )
      VALUES (
        $1,
        'naval',
        'Naval',
        TRUE,
        TRUE
      )
      RETURNING "id"
    `,
    [guildDatabaseId],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("Failed to create organiser cover reconciliation type.");
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
        "ends_at",
        "timezone",
        "status",
        "signups_enabled",
        "published_at",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        'Organiser Cover Reconciliation Test',
        NOW() + INTERVAL '30 minutes',
        NOW() + INTERVAL '90 minutes',
        'Europe/London',
        'open',
        TRUE,
        NOW(),
        $3
      )
      RETURNING "id"
    `,
    [guildDatabaseId, eventTypeId, ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("Failed to create organiser cover reconciliation event.");
  }

  await pool.query(
    `
      INSERT INTO "event_messages" (
        "event_id",
        "guild_id",
        "channel_id",
        "message_id",
        "kind"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'organiser_cover'
      )
    `,
    [eventId, guildDatabaseId, channelId, coverMessageId],
  );

  if (includeStartAlert) {
    await pool.query(
      `
        INSERT INTO "event_messages" (
          "event_id",
          "guild_id",
          "channel_id",
          "message_id",
          "kind"
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'organiser_missing_at_start'
        )
      `,
      [eventId, guildDatabaseId, channelId, startAlertMessageId],
    );
  }

  return {
    eventId,

    channelId,

    coverMessageId,

    startAlertMessageId,
  };
}
