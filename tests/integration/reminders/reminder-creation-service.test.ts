import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  db as applicationDb,
  pool as applicationPool,
} from "../../../src/db/client.js";
import {
  createEventReminder,
  createEventReminderInTransaction,
} from "../../../src/reminders/reminder-creation-service.js";
import { buildReminderActionKey } from "../../../src/reminders/reminder-scheduling.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "988000000000000001";
const ADMIN_USER_ID = "988000000000000002";
const REMINDER_CHANNEL_ID = "988000000000000003";

describe("reminder creation service", () => {
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

  it("atomically creates an event reminder and its durable scheduled action", async () => {
    // Arrange
    const eventId = await createEventFixture(pool);

    const dueAt = new Date(Date.now() + 4 * 60 * 60_000);

    // Act
    const reminder = await createEventReminder({
      eventId,

      timingReference: "event_start",

      minutesBefore: 60,

      message: "Event starts in one hour.",

      channelId: REMINDER_CHANNEL_ID,

      pingEventRoles: true,

      createdByUserId: ADMIN_USER_ID,

      dueAt,
    });

    // Assert
    const storedReminder = await pool.query<{
      id: number;
      event_id: number;
      timing_reference: string;
      minutes_before: number;
      message: string;
      channel_id: string;
      ping_event_roles: boolean;
      enabled: boolean;
      created_by_user_id: string;
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
          "enabled",
          "created_by_user_id"
        FROM "event_reminders"
        WHERE "id" = $1
      `,
      [reminder.id],
    );

    expect(storedReminder.rows).toEqual([
      {
        id: reminder.id,
        event_id: eventId,
        timing_reference: "event_start",
        minutes_before: 60,
        message: "Event starts in one hour.",
        channel_id: REMINDER_CHANNEL_ID,
        ping_event_roles: true,
        enabled: true,
        created_by_user_id: ADMIN_USER_ID,
      },
    ]);

    const storedAction = await pool.query<{
      event_id: number;
      action_key: string;
      due_at: Date;
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
        SELECT
          "event_id",
          "action_key",
          "due_at",
          "status",
          "attempt_count",
          "locked_at",
          "completed_at",
          "last_error"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" = $2
      `,
      [eventId, buildReminderActionKey(reminder.id)],
    );

    expect(storedAction.rows).toEqual([
      {
        event_id: eventId,
        action_key: buildReminderActionKey(reminder.id),
        due_at: dueAt,
        status: "pending",
        attempt_count: 0,
        locked_at: null,
        completed_at: null,
        last_error: null,
      },
    ]);
  });

  it("participates in a caller-owned transaction and rolls back the reminder and action with it", async () => {
    // Arrange
    const eventId = await createEventFixture(pool);

    const dueAt = new Date(Date.now() + 4 * 60 * 60_000);

    // Act
    await expect(
      applicationDb.transaction(async (transaction) => {
        const reminder = await createEventReminderInTransaction(transaction, {
          eventId,

          timingReference: "signup_close",

          minutesBefore: 30,

          message: "Signups close in thirty minutes.",

          channelId: REMINDER_CHANNEL_ID,

          pingEventRoles: false,

          createdByUserId: ADMIN_USER_ID,

          dueAt,
        });

        expect(reminder.id).toBeGreaterThan(0);

        /*
         * Simulate a later template-generation step failing after reminder
         * persistence and durable scheduling have already succeeded.
         */
        throw new Error("force caller-owned transaction rollback");
      }),
    ).rejects.toThrow("force caller-owned transaction rollback");

    // Assert
    const storedCounts = await pool.query<{
      reminder_count: number;
      scheduled_action_count: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM "event_reminders"
            WHERE "event_id" = $1
          ) AS "reminder_count",
          (
            SELECT COUNT(*)::int
            FROM "scheduled_actions"
            WHERE
              "event_id" = $1
              AND "action_key" LIKE 'event_reminder:%'
          ) AS "scheduled_action_count"
      `,
      [eventId],
    );

    expect(storedCounts.rows).toEqual([
      {
        reminder_count: 0,
        scheduled_action_count: 0,
      },
    ]);
  });
});

async function createEventFixture(pool: Pool): Promise<number> {
  const guildResult = await pool.query<{ id: number }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, 'Reminder Creation Test Guild')
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("Expected guild fixture creation to return an ID.");
  }

  const eventTypeResult = await pool.query<{ id: number }>(
    `
      INSERT INTO "event_types" (
        "owner_guild_id",
        "code",
        "name"
      )
      VALUES ($1, 'naval', 'Naval')
      RETURNING "id"
    `,
    [guildId],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("Expected event-type fixture creation to return an ID.");
  }

  const startsAt = new Date(Date.now() + 6 * 60 * 60_000);

  const attendanceClosesAt = new Date(startsAt.getTime() - 60 * 60_000);

  const eventResult = await pool.query<{ id: number }>(
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
      VALUES ($1, $2, $3, $4, true, $5, 'scheduled', $6)
      RETURNING "id"
    `,
    [
      guildId,
      eventTypeId,
      "Reminder creation test event",
      startsAt,
      attendanceClosesAt,
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("Expected event fixture creation to return an ID.");
  }

  return eventId;
}
