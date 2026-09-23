import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import {
  buildReminderActionKey,
  reschedulePendingEventReminders,
} from "../../../src/reminders/reminder-scheduling.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "987000000000000001";
const ADMIN_USER_ID = "987000000000000002";
const REMINDER_CHANNEL_ID = "987000000000000003";

describe("reminder scheduling", () => {
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

  it("keeps a future signup-close reminder scheduled for an unpublished scheduled event", async () => {
    // Arrange
    const guildId = await createGuild(pool);
    const eventTypeId = await createEventType(pool, guildId);

    const startsAt = new Date(Date.now() + 6 * 60 * 60_000);

    const attendanceClosesAt = new Date(startsAt.getTime() - 60 * 60_000);

    const expectedDueAt = new Date(attendanceClosesAt.getTime() - 30 * 60_000);

    const eventResult = await pool.query<{ id: number }>(
      `
        INSERT INTO "events" (
          "owner_guild_id",
          "event_type_id",
          "name",
          "starts_at",
          "signups_enabled",
          "attendance_closes_at",
          "published_at",
          "status",
          "created_by_user_id"
        )
        VALUES ($1, $2, $3, $4, true, $5, NULL, 'scheduled', $6)
        RETURNING "id"
      `,
      [
        guildId,
        eventTypeId,
        "Future unpublished event",
        startsAt,
        attendanceClosesAt,
        ADMIN_USER_ID,
      ],
    );

    const eventId = eventResult.rows[0]?.id;

    if (!eventId) {
      throw new Error("Expected event fixture creation to return an ID.");
    }

    const reminderResult = await pool.query<{ id: number }>(
      `
        INSERT INTO "event_reminders" (
          "event_id",
          "timing_reference",
          "minutes_before",
          "message",
          "channel_id",
          "ping_event_roles",
          "enabled",
          "created_by_user_id"
        )
        VALUES ($1, 'signup_close', 30, $2, $3, false, true, $4)
        RETURNING "id"
      `,
      [eventId, "Signup close reminder", REMINDER_CHANNEL_ID, ADMIN_USER_ID],
    );

    const reminderId = reminderResult.rows[0]?.id;

    if (!reminderId) {
      throw new Error("Expected reminder fixture creation to return an ID.");
    }

    const actionKey = buildReminderActionKey(reminderId);

    /*
     * Seed an existing pending durable action so the regression proves that
     * rescheduling preserves valid work rather than cancelling it merely
     * because the event has not yet been published.
     *
     * Give it an intentionally stale due time as well. A successful
     * reschedule should replace that with the reminder's resolved due time.
     */
    await pool.query(
      `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status"
        )
        VALUES ($1, $2, $3, 'pending')
      `,
      [eventId, actionKey, new Date(expectedDueAt.getTime() + 15 * 60_000)],
    );

    // Act
    await reschedulePendingEventReminders(eventId);

    // Assert
    const storedAction = await pool.query<{
      status: string;
      due_at: Date;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
        SELECT
          "status",
          "due_at",
          "attempt_count",
          "locked_at",
          "completed_at",
          "last_error"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" = $2
      `,
      [eventId, actionKey],
    );

    expect(storedAction.rows).toEqual([
      {
        status: "pending",
        due_at: expectedDueAt,
        attempt_count: 0,
        locked_at: null,
        completed_at: null,
        last_error: null,
      },
    ]);
  });

  it("cancels a future signup-close reminder when attendance is already closed", async () => {
    // Arrange
    const guildId = await createGuild(pool);
    const eventTypeId = await createEventType(pool, guildId);

    const startsAt = new Date(Date.now() + 6 * 60 * 60_000);

    const attendanceClosesAt = new Date(startsAt.getTime() - 60 * 60_000);

    const reminderDueAt = new Date(attendanceClosesAt.getTime() - 30 * 60_000);

    const eventResult = await pool.query<{ id: number }>(
      `
        INSERT INTO "events" (
          "owner_guild_id",
          "event_type_id",
          "name",
          "starts_at",
          "signups_enabled",
          "attendance_closes_at",
          "published_at",
          "status",
          "created_by_user_id"
        )
        VALUES ($1, $2, $3, $4, true, $5, NOW(), 'closed', $6)
        RETURNING "id"
      `,
      [
        guildId,
        eventTypeId,
        "Closed event",
        startsAt,
        attendanceClosesAt,
        ADMIN_USER_ID,
      ],
    );

    const eventId = eventResult.rows[0]?.id;

    if (!eventId) {
      throw new Error("Expected event fixture creation to return an ID.");
    }

    const reminderResult = await pool.query<{ id: number }>(
      `
        INSERT INTO "event_reminders" (
          "event_id",
          "timing_reference",
          "minutes_before",
          "message",
          "channel_id",
          "ping_event_roles",
          "enabled",
          "created_by_user_id"
        )
        VALUES ($1, 'signup_close', 30, $2, $3, false, true, $4)
        RETURNING "id"
      `,
      [eventId, "Signup close reminder", REMINDER_CHANNEL_ID, ADMIN_USER_ID],
    );

    const reminderId = reminderResult.rows[0]?.id;

    if (!reminderId) {
      throw new Error("Expected reminder fixture creation to return an ID.");
    }

    const actionKey = buildReminderActionKey(reminderId);

    await pool.query(
      `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status"
        )
        VALUES ($1, $2, $3, 'pending')
      `,
      [eventId, actionKey, reminderDueAt],
    );

    // Act
    await reschedulePendingEventReminders(eventId);

    // Assert
    const storedAction = await pool.query<{
      status: string;
      locked_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "locked_at"
        FROM "scheduled_actions"
        WHERE
          "event_id" = $1
          AND "action_key" = $2
      `,
      [eventId, actionKey],
    );

    expect(storedAction.rows).toEqual([
      {
        status: "cancelled",
        locked_at: null,
      },
    ]);
  });
});

async function createGuild(pool: Pool): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES ($1, 'Reminder Integration Test Guild')
      RETURNING "id"
    `,
    [DISCORD_GUILD_ID],
  );

  const guildId = result.rows[0]?.id;

  if (!guildId) {
    throw new Error("Expected guild fixture creation to return an ID.");
  }

  return guildId;
}

async function createEventType(pool: Pool, guildId: number): Promise<number> {
  const result = await pool.query<{ id: number }>(
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

  const eventTypeId = result.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("Expected event-type fixture creation to return an ID.");
  }

  return eventTypeId;
}
