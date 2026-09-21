import { db, type DatabaseTransaction } from "../db/client.js";
import { eventReminders, scheduledActions } from "../db/schema.js";
import {
  buildReminderActionKey,
  type ReminderTimingReference,
} from "./reminder-scheduling.js";

export type CreateEventReminderInput = {
  eventId: number;

  timingReference: ReminderTimingReference;

  minutesBefore: number;

  message: string;

  channelId: string;

  pingEventRoles: boolean;

  createdByUserId: string;

  /*
   * The caller resolves the concrete due time from the authoritative event
   * state before calling this persistence boundary.
   *
   * Keeping both the relative reminder definition and resolved durable action
   * timestamp preserves the existing event_reminders/scheduled_actions model.
   */
  dueAt: Date;
};

export type CreateEventReminderResult = {
  id: number;
};

export async function createEventReminder(
  input: CreateEventReminderInput,
): Promise<CreateEventReminderResult> {
  return db.transaction((transaction) =>
    createEventReminderInTransaction(transaction, input),
  );
}

/**
 * Creates one ordinary event reminder and its durable scheduler action inside
 * a caller-owned transaction.
 *
 * The caller owns commit and rollback. Future template generation can
 * therefore create reminder snapshots alongside the event and other generated
 * state without an intermediate commit.
 *
 * This function receives already-resolved reminder data. Discord destination
 * validation and administrator-facing command validation belong outside this
 * persistence boundary.
 */
export async function createEventReminderInTransaction(
  transaction: DatabaseTransaction,
  input: CreateEventReminderInput,
): Promise<CreateEventReminderResult> {
  const now = new Date();

  const [createdReminder] = await transaction
    .insert(eventReminders)
    .values({
      eventId: input.eventId,

      timingReference: input.timingReference,

      minutesBefore: input.minutesBefore,

      message: input.message,

      channelId: input.channelId,

      pingEventRoles: input.pingEventRoles,

      enabled: true,

      createdByUserId: input.createdByUserId,

      updatedAt: now,
    })
    .returning({
      id: eventReminders.id,
    });

  if (!createdReminder) {
    throw new Error("The reminder could not be created.");
  }

  await transaction.insert(scheduledActions).values({
    eventId: input.eventId,

    actionKey: buildReminderActionKey(createdReminder.id),

    dueAt: input.dueAt,

    status: "pending",

    attemptCount: 0,

    updatedAt: now,
  });

  return createdReminder;
}
