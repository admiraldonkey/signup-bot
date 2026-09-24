import { and, eq } from "drizzle-orm";

import { db, type DatabaseTransaction } from "../db/client.js";
import {
  eventRecurrenceOccurrences,
  eventTemplateRecurrences,
  eventTemplates,
} from "../db/schema.js";
import { parseEventDateTime } from "../time/event-date-time.js";
import {
  enumerateRecurrenceOccurrenceDates,
  normaliseRecurrenceDate,
  type EnumerateRecurrenceDatesResult,
} from "./event-recurrence-rule.js";
import {
  generateEventFromTemplateInTransaction,
  type GenerateEventFromTemplateResult,
} from "./event-template-generation-service.js";

type GeneratedTemplateEvent = Extract<
  GenerateEventFromTemplateResult,
  {
    kind: "generated";
  }
>;

type TemplateGenerationFailure = Exclude<
  GenerateEventFromTemplateResult,
  {
    kind: "generated";
  }
>;

type InvalidStoredRecurrenceReason = Extract<
  EnumerateRecurrenceDatesResult,
  {
    ok: false;
  }
>["reason"];

export type GenerateRecurringOccurrenceInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * Immutable local calendar slot identity in YYYY-MM-DD form.
   */
  occurrenceDate: string;

  /*
   * Optional deterministic clock.
   *
   * A horizon run passes one shared value to every occurrence so all slots in
   * that run are evaluated against one coherent instant.
   */
  now?: Date;

  generatedByUserId: string;
};

export type GenerateRecurringOccurrenceResult =
  | {
      kind: "generated";

      recurrenceId: number;

      occurrenceDate: string;

      generation: GeneratedTemplateEvent;
    }
  | {
      kind: "already_generated";

      recurrenceId: number;

      occurrenceDate: string;

      eventId: number;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "immediate_publication_not_supported";
    }
  | {
      kind: "recurrence_not_found";
    }
  | {
      kind: "recurrence_inactive";
    }
  | {
      kind: "invalid_occurrence_date";
    }
  | {
      kind: "occurrence_not_in_rule";
    }
  | {
      kind: "invalid_recurrence";

      reason: InvalidStoredRecurrenceReason;
    }
  | {
      kind: "template_missing_local_start_time";
    }
  | {
      kind: "invalid_local_occurrence_time";

      error: string;
    }
  | {
      kind: "generation_failed";

      result: TemplateGenerationFailure;
    };

/**
 * Generates one ordinary event for one immutable recurrence calendar slot.
 *
 * The event snapshot and its recurrence provenance commit atomically.
 *
 * Discord publication remains outside this service. In particular,
 * requiresImmediatePublication on a successful generation result is only an
 * instruction to the post-commit caller.
 */
export async function generateRecurringOccurrence(
  input: GenerateRecurringOccurrenceInput,
): Promise<GenerateRecurringOccurrenceResult> {
  const occurrenceDate = normaliseRecurrenceDate(input.occurrenceDate);

  if (!occurrenceDate) {
    return {
      kind: "invalid_occurrence_date",
    };
  }

  return db.transaction((transaction) =>
    generateRecurringOccurrenceInTransaction(transaction, {
      ...input,

      occurrenceDate,
    }),
  );
}

async function generateRecurringOccurrenceInTransaction(
  transaction: DatabaseTransaction,
  input: GenerateRecurringOccurrenceInput,
): Promise<GenerateRecurringOccurrenceResult> {
  /*
   * Keep the same lock order used by recurrence administration:
   *
   * template parent first
   * recurrence row second
   *
   * Template edits take FOR UPDATE on this parent, so FOR SHARE stabilises
   * timezone/local-time/source revision for the complete preparation and
   * generation operation.
   */
  const [template] = await transaction
    .select({
      id: eventTemplates.id,

      timezone: eventTemplates.timezone,

      localStartTime: eventTemplates.localStartTime,

      publicationMode: eventTemplates.publicationMode,

      updatedAt: eventTemplates.updatedAt,
    })
    .from(eventTemplates)
    .where(
      and(
        eq(eventTemplates.id, input.templateId),

        eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
      ),
    )
    .limit(1)
    .for("share");

  if (!template) {
    return {
      kind: "template_not_found",
    };
  }

  if (template.publicationMode === "immediate") {
    return {
      kind: "immediate_publication_not_supported",
    };
  }

  /*
   * FOR UPDATE serialises generators for one series and pairs with recurrence
   * editing/lifecycle mutation.
   *
   * Different series remain independently generatable.
   */
  const [recurrence] = await transaction
    .select({
      id: eventTemplateRecurrences.id,

      recurrenceRule: eventTemplateRecurrences.recurrenceRule,

      startDate: eventTemplateRecurrences.startDate,

      active: eventTemplateRecurrences.active,
    })
    .from(eventTemplateRecurrences)
    .where(eq(eventTemplateRecurrences.templateId, template.id))
    .limit(1)
    .for("update");

  if (!recurrence) {
    return {
      kind: "recurrence_not_found",
    };
  }

  if (!recurrence.active) {
    return {
      kind: "recurrence_inactive",
    };
  }

  if (template.localStartTime === null) {
    /*
     * Normal service mutations prevent this state, but generation must still
     * treat persisted data as potentially stale/corrupt rather than guessing a
     * time.
     */
    return {
      kind: "template_missing_local_start_time",
    };
  }

  /*
   * Do not trust the caller to identify a valid slot merely because it knows
   * the template ID.
   *
   * Re-evaluate the requested date against the recurrence definition while the
   * recurrence row is locked.
   */
  const membership = enumerateRecurrenceOccurrenceDates({
    recurrenceRule: recurrence.recurrenceRule,

    startDate: recurrence.startDate,

    fromDate: input.occurrenceDate,

    throughDate: input.occurrenceDate,
  });

  if (!membership.ok) {
    return {
      kind: "invalid_recurrence",

      reason: membership.reason,
    };
  }

  if (!membership.occurrenceDates.includes(input.occurrenceDate)) {
    return {
      kind: "occurrence_not_in_rule",
    };
  }

  /*
   * Idempotency check while holding the recurrence row lock.
   *
   * PostgreSQL's composite primary key remains the final authoritative
   * duplicate-prevention boundary. This read simply lets the normal repeated
   * path return the existing event cleanly.
   */
  const [existing] = await transaction
    .select({
      eventId: eventRecurrenceOccurrences.eventId,
    })
    .from(eventRecurrenceOccurrences)
    .where(
      and(
        eq(eventRecurrenceOccurrences.recurrenceId, recurrence.id),

        eq(eventRecurrenceOccurrences.occurrenceDate, input.occurrenceDate),
      ),
    )
    .limit(1);

  if (existing) {
    return {
      kind: "already_generated",

      recurrenceId: recurrence.id,

      occurrenceDate: input.occurrenceDate,

      eventId: existing.eventId,
    };
  }

  const parsedStart = parseEventDateTime(
    input.occurrenceDate,
    template.localStartTime,
    template.timezone,
  );

  if (!parsedStart.ok) {
    return {
      kind: "invalid_local_occurrence_time",

      error: parsedStart.error,
    };
  }

  /*
   * This transaction already holds the template FOR SHARE lock, so the
   * expected revision should remain stable. Passing it also preserves the
   * generator's explicit source-consistency contract.
   */
  const generation = await generateEventFromTemplateInTransaction(transaction, {
    guildDatabaseId: input.guildDatabaseId,

    templateId: template.id,

    startsAt: parsedStart.value.toJSDate(),

    now: input.now,

    expectedTemplateUpdatedAt: template.updatedAt,

    generatedByUserId: input.generatedByUserId,
  });

  if (generation.kind !== "generated") {
    return {
      kind: "generation_failed",

      result: generation,
    };
  }

  /*
   * This insert belongs to the same outer transaction as the generated event.
   *
   * If it fails for any reason, PostgreSQL rolls the event snapshot back too.
   */
  await transaction.insert(eventRecurrenceOccurrences).values({
    recurrenceId: recurrence.id,

    occurrenceDate: input.occurrenceDate,

    eventId: generation.event.id,
  });

  return {
    kind: "generated",

    recurrenceId: recurrence.id,

    occurrenceDate: input.occurrenceDate,

    generation,
  };
}
