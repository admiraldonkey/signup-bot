import { DateTime } from "luxon";

import { isValidEventTimezone } from "../time/timezones.js";
import {
  enumerateRecurrenceOccurrenceDates,
  type EnumerateRecurrenceDatesResult,
} from "./event-recurrence-rule.js";
import {
  generateRecurringOccurrence,
  type GenerateRecurringOccurrenceResult,
} from "./event-template-recurrence-generation-service.js";
import { getEventTemplateRecurrence } from "./event-template-recurrence-service.js";

/*
 * Materialise exactly 21 local calendar dates:
 *
 * today
 * through
 * today + 20 days
 *
 * Current administrator-facing publication/reminder/role-request lead times
 * are capped at seven days, leaving a two-week safety buffer.
 */
export const RECURRING_EVENT_HORIZON_DAYS = 21;

type GeneratedRecurringOccurrence = Extract<
  GenerateRecurringOccurrenceResult,
  {
    kind: "generated";
  }
>;

type RecurrencePublicationMode =
  GeneratedRecurringOccurrence["generation"]["publicationMode"];

type InvalidStoredRecurrenceReason = Extract<
  EnumerateRecurrenceDatesResult,
  {
    ok: false;
  }
>["reason"];

export type RecurringHorizonSlotResult =
  | {
      kind: "generated";

      occurrenceDate: string;

      eventId: number;

      publicationMode: RecurrencePublicationMode;

      immediatePublicationQueued: boolean;
    }
  | {
      kind: "already_generated";

      occurrenceDate: string;

      eventId: number;
    }
  | {
      kind: "skipped";

      occurrenceDate: string;

      reason:
        | "start_not_future"
        | "signup_close_not_future"
        | "source_changed"
        | "recurrence_inactive"
        | "template_inactive";
    }
  | {
      kind: "failed";

      occurrenceDate: string;

      result: GenerateRecurringOccurrenceResult;
    };

export type GenerateRecurringHorizonInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * Optional deterministic clock.
   *
   * Normal automatic callers omit this. Tests and explicit recovery tooling
   * may supply one.
   */
  now?: Date;
};

export type GenerateRecurringHorizonResult =
  | {
      kind: "processed";

      templateId: number;

      recurrenceId: number;

      fromDate: string;

      throughDate: string;

      slotResults: RecurringHorizonSlotResult[];
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "recurrence_not_found";
    }
  | {
      kind: "template_inactive";
    }
  | {
      kind: "recurrence_inactive";
    }
  | {
      kind: "template_missing_local_start_time";
    }
  | {
      kind: "invalid_template_timezone";
    }
  | {
      kind: "invalid_now";
    }
  | {
      kind: "invalid_recurrence";

      reason: InvalidStoredRecurrenceReason;
    };

/**
 * Materialises every recurrence slot inside one bounded local-calendar
 * horizon.
 *
 * Each occurrence deliberately owns its own PostgreSQL transaction through
 * generateRecurringOccurrence().
 *
 * One bad occurrence therefore cannot roll back successful sibling
 * occurrences, while each individual event/provenance pair remains atomic.
 */
export async function generateRecurringHorizon(
  input: GenerateRecurringHorizonInput,
): Promise<GenerateRecurringHorizonResult> {
  const now = input.now ?? new Date();

  if (!Number.isFinite(now.getTime())) {
    return {
      kind: "invalid_now",
    };
  }

  const source = await getEventTemplateRecurrence({
    guildDatabaseId: input.guildDatabaseId,

    templateId: input.templateId,
  });

  if (source.kind === "template_not_found") {
    return source;
  }

  if (source.kind === "recurrence_not_found") {
    return source;
  }

  const recurrence = source.recurrence;

  if (!recurrence.templateActive) {
    return {
      kind: "template_inactive",
    };
  }

  if (!recurrence.active) {
    return {
      kind: "recurrence_inactive",
    };
  }

  if (recurrence.templateLocalStartTime === null) {
    return {
      kind: "template_missing_local_start_time",
    };
  }

  if (!isValidEventTimezone(recurrence.templateTimezone)) {
    return {
      kind: "invalid_template_timezone",
    };
  }

  /*
   * The horizon is a local-calendar policy.
   *
   * Derive "today" in the template timezone rather than from UTC or the
   * process host timezone.
   */
  const localNow = DateTime.fromJSDate(now, {
    zone: recurrence.templateTimezone,
  });

  if (!localNow.isValid) {
    return {
      kind: "invalid_template_timezone",
    };
  }

  const fromDate = localNow.toFormat("yyyy-MM-dd");

  const throughDate = localNow
    .plus({
      days: RECURRING_EVENT_HORIZON_DAYS - 1,
    })
    .toFormat("yyyy-MM-dd");

  const enumeration = enumerateRecurrenceOccurrenceDates({
    recurrenceRule: recurrence.recurrenceRule,

    startDate: recurrence.startDate,

    fromDate,

    throughDate,
  });

  if (!enumeration.ok) {
    return {
      kind: "invalid_recurrence",

      reason: enumeration.reason,
    };
  }

  const slotResults: RecurringHorizonSlotResult[] = [];

  /*
   * Process sequentially.
   *
   * Each slot has its own short authoritative transaction. There is no value
   * in holding one long transaction across an entire multi-week horizon.
   */
  for (const occurrenceDate of enumeration.occurrenceDates) {
    const result = await generateRecurringOccurrence({
      guildDatabaseId: input.guildDatabaseId,

      templateId: input.templateId,

      occurrenceDate,

      now,

      /*
       * Automated materialisation needs durable user provenance even
       * though no human is pressing a command at generation time.
       *
       * The recurrence creator is therefore retained as the generated
       * event's source user identity.
       */
      generatedByUserId: recurrence.createdByUserId,
    });

    slotResults.push(classifySlotResult(occurrenceDate, result));
  }

  return {
    kind: "processed",

    templateId: input.templateId,

    recurrenceId: recurrence.id,

    fromDate,

    throughDate,

    slotResults,
  };
}

function classifySlotResult(
  occurrenceDate: string,
  result: GenerateRecurringOccurrenceResult,
): RecurringHorizonSlotResult {
  switch (result.kind) {
    case "generated":
      return {
        kind: "generated",

        occurrenceDate,

        eventId: result.generation.event.id,

        publicationMode: result.generation.publicationMode,

        immediatePublicationQueued: result.immediatePublicationQueued,
      };

    case "already_generated":
      return {
        kind: "already_generated",

        occurrenceDate,

        eventId: result.eventId,
      };

    /*
     * A rule/lifecycle mutation may win after the horizon was enumerated but
     * before this individual slot acquires its authoritative locks.
     *
     * That is not a failed occurrence. The next horizon run will enumerate
     * the new source state.
     */
    case "occurrence_not_in_rule":
      return {
        kind: "skipped",

        occurrenceDate,

        reason: "source_changed",
      };

    case "recurrence_inactive":
      return {
        kind: "skipped",

        occurrenceDate,

        reason: "recurrence_inactive",
      };

    case "generation_failed":
      if (
        result.result.kind === "invalid_occurrence" &&
        result.result.reason === "start_not_future"
      ) {
        return {
          kind: "skipped",

          occurrenceDate,

          reason: "start_not_future",
        };
      }

      if (
        result.result.kind === "invalid_occurrence" &&
        result.result.reason === "signup_close_not_future"
      ) {
        return {
          kind: "skipped",

          occurrenceDate,

          reason: "signup_close_not_future",
        };
      }

      if (result.result.kind === "template_inactive") {
        return {
          kind: "skipped",

          occurrenceDate,

          reason: "template_inactive",
        };
      }

      return {
        kind: "failed",

        occurrenceDate,

        result,
      };

    default:
      return {
        kind: "failed",

        occurrenceDate,

        result,
      };
  }
}
