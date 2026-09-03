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
import { reconcileOrganiserPendingWarning } from "../../../src/events/organiser-notification.js";
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
