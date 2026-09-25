import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventTemplateRecurrences, eventTemplates } from "../db/schema.js";
import {
  normaliseRecurrenceDate,
  normaliseRecurrenceRule,
  type RecurrenceRuleInvalidReason,
} from "./event-recurrence-rule.js";

export type EventTemplateRecurrenceRecord = {
  id: number;

  templateId: number;

  recurrenceRule: string;

  startDate: string;

  active: boolean;

  nextSweepAt: Date;

  lastSweepStartedAt: Date | null;

  lastSweepCompletedAt: Date | null;

  lastSweepOutcome: string | null;

  lastSweepDiagnostic: string | null;

  createdByUserId: string;

  createdAt: Date;

  updatedAt: Date;
};

export type EventTemplateRecurrenceDetail = EventTemplateRecurrenceRecord & {
  templateName: string;

  templateTimezone: string;

  templateLocalStartTime: string | null;

  templatePublicationMode: string;

  templateActive: boolean;
};

export type EventTemplateRecurrenceInvalidReason =
  | RecurrenceRuleInvalidReason
  | "invalid_start_date"
  | "template_missing_local_start_time"
  | "immediate_publication_not_supported";

export type CreateEventTemplateRecurrenceInput = {
  guildDatabaseId: number;

  templateId: number;

  recurrenceRule: string;

  startDate: string;

  createdByUserId: string;
};

export type CreateEventTemplateRecurrenceResult =
  | {
      kind: "created";

      recurrence: EventTemplateRecurrenceRecord;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "recurrence_already_exists";

      recurrence: EventTemplateRecurrenceRecord;
    }
  | {
      kind: "invalid_input";

      reason: EventTemplateRecurrenceInvalidReason;
    };

export type GetEventTemplateRecurrenceInput = {
  guildDatabaseId: number;

  templateId: number;
};

export type GetEventTemplateRecurrenceResult =
  | {
      kind: "found";

      recurrence: EventTemplateRecurrenceDetail;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "recurrence_not_found";
    };

export type EditEventTemplateRecurrenceInput = {
  guildDatabaseId: number;

  templateId: number;

  recurrenceRule?: string;

  startDate?: string;
};

export type EditEventTemplateRecurrenceResult =
  | {
      kind: "updated" | "unchanged";

      recurrence: EventTemplateRecurrenceRecord;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "recurrence_not_found";
    }
  | {
      kind: "invalid_input";

      reason: EventTemplateRecurrenceInvalidReason | "no_changes_requested";
    };

export type SetEventTemplateRecurrenceActiveInput = {
  guildDatabaseId: number;

  templateId: number;

  active: boolean;
};

export type SetEventTemplateRecurrenceActiveResult =
  | {
      kind: "updated" | "unchanged";

      recurrence: EventTemplateRecurrenceRecord;
    }
  | {
      kind: "template_not_found";
    }
  | {
      kind: "recurrence_not_found";
    }
  | {
      kind: "invalid_input";

      reason:
        | "template_missing_local_start_time"
        | "immediate_publication_not_supported";
    };

const recurrenceSelection = {
  id: eventTemplateRecurrences.id,

  templateId: eventTemplateRecurrences.templateId,

  recurrenceRule: eventTemplateRecurrences.recurrenceRule,

  startDate: eventTemplateRecurrences.startDate,

  active: eventTemplateRecurrences.active,

  nextSweepAt: eventTemplateRecurrences.nextSweepAt,

  lastSweepStartedAt: eventTemplateRecurrences.lastSweepStartedAt,

  lastSweepCompletedAt: eventTemplateRecurrences.lastSweepCompletedAt,

  lastSweepOutcome: eventTemplateRecurrences.lastSweepOutcome,

  lastSweepDiagnostic: eventTemplateRecurrences.lastSweepDiagnostic,

  createdByUserId: eventTemplateRecurrences.createdByUserId,

  createdAt: eventTemplateRecurrences.createdAt,

  updatedAt: eventTemplateRecurrences.updatedAt,
};

export async function createEventTemplateRecurrence(
  input: CreateEventTemplateRecurrenceInput,
): Promise<CreateEventTemplateRecurrenceResult> {
  const configuration = normaliseRecurrenceConfiguration(
    input.recurrenceRule,
    input.startDate,
  );

  if (!configuration.ok) {
    return {
      kind: "invalid_input",

      reason: configuration.reason,
    };
  }

  return db.transaction(async (transaction) => {
    /*
     * Template mutation and recurrence mutation share the template parent as
     * their first lock.
     *
     * This serialises recurrence creation against edits which may change or
     * clear the template's local timing configuration.
     */
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        localStartTime: eventTemplates.localStartTime,

        publicationMode: eventTemplates.publicationMode,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    if (template.localStartTime === null) {
      return {
        kind: "invalid_input",

        reason: "template_missing_local_start_time",
      } as const;
    }

    if (template.publicationMode === "immediate") {
      return {
        kind: "invalid_input",

        reason: "immediate_publication_not_supported",
      } as const;
    }

    const [existing] = await transaction
      .select(recurrenceSelection)
      .from(eventTemplateRecurrences)
      .where(eq(eventTemplateRecurrences.templateId, template.id))
      .limit(1);

    if (existing) {
      return {
        kind: "recurrence_already_exists",

        recurrence: existing,
      } as const;
    }

    const [created] = await transaction
      .insert(eventTemplateRecurrences)
      .values({
        templateId: template.id,

        recurrenceRule: configuration.recurrenceRule,

        startDate: configuration.startDate,

        active: true,

        createdByUserId: input.createdByUserId,
      })
      .returning(recurrenceSelection);

    if (!created) {
      throw new Error(
        `The recurrence for event template #${template.id} could not be created.`,
      );
    }

    return {
      kind: "created",

      recurrence: created,
    } as const;
  });
}

export async function getEventTemplateRecurrence(
  input: GetEventTemplateRecurrenceInput,
): Promise<GetEventTemplateRecurrenceResult> {
  return db.transaction(async (transaction) => {
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        name: eventTemplates.name,

        timezone: eventTemplates.timezone,

        localStartTime: eventTemplates.localStartTime,

        publicationMode: eventTemplates.publicationMode,

        active: eventTemplates.active,
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
      } as const;
    }

    const [recurrence] = await transaction
      .select(recurrenceSelection)
      .from(eventTemplateRecurrences)
      .where(eq(eventTemplateRecurrences.templateId, template.id))
      .limit(1)
      .for("share");

    if (!recurrence) {
      return {
        kind: "recurrence_not_found",
      } as const;
    }

    return {
      kind: "found",

      recurrence: {
        ...recurrence,

        templateName: template.name,

        templateTimezone: template.timezone,

        templateLocalStartTime: template.localStartTime,

        templatePublicationMode: template.publicationMode,

        templateActive: template.active,
      },
    } as const;
  });
}

export async function listEventTemplateRecurrences(
  guildDatabaseId: number,
): Promise<EventTemplateRecurrenceDetail[]> {
  return db
    .select({
      ...recurrenceSelection,

      templateName: eventTemplates.name,

      templateTimezone: eventTemplates.timezone,

      templateLocalStartTime: eventTemplates.localStartTime,

      templatePublicationMode: eventTemplates.publicationMode,

      templateActive: eventTemplates.active,
    })
    .from(eventTemplateRecurrences)
    .innerJoin(
      eventTemplates,
      and(
        eq(eventTemplates.id, eventTemplateRecurrences.templateId),

        eq(eventTemplates.ownerGuildId, guildDatabaseId),
      ),
    )
    .orderBy(
      asc(eventTemplates.name),

      asc(eventTemplateRecurrences.id),
    );
}

export async function editEventTemplateRecurrence(
  input: EditEventTemplateRecurrenceInput,
): Promise<EditEventTemplateRecurrenceResult> {
  if (input.recurrenceRule === undefined && input.startDate === undefined) {
    return {
      kind: "invalid_input",

      reason: "no_changes_requested",
    };
  }

  const normalisedRule =
    input.recurrenceRule === undefined
      ? null
      : normaliseRecurrenceRule(input.recurrenceRule);

  if (normalisedRule && !normalisedRule.ok) {
    return {
      kind: "invalid_input",

      reason: normalisedRule.reason,
    };
  }

  const normalisedStartDate =
    input.startDate === undefined
      ? undefined
      : normaliseRecurrenceDate(input.startDate);

  if (input.startDate !== undefined && !normalisedStartDate) {
    return {
      kind: "invalid_input",

      reason: "invalid_start_date",
    };
  }

  return db.transaction(async (transaction) => {
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        localStartTime: eventTemplates.localStartTime,

        publicationMode: eventTemplates.publicationMode,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const [recurrence] = await transaction
      .select(recurrenceSelection)
      .from(eventTemplateRecurrences)
      .where(eq(eventTemplateRecurrences.templateId, template.id))
      .limit(1)
      .for("update");

    if (!recurrence) {
      return {
        kind: "recurrence_not_found",
      } as const;
    }

    if (template.localStartTime === null) {
      return {
        kind: "invalid_input",

        reason: "template_missing_local_start_time",
      } as const;
    }

    if (recurrence.active && template.publicationMode === "immediate") {
      return {
        kind: "invalid_input",

        reason: "immediate_publication_not_supported",
      } as const;
    }

    const recurrenceRule = normalisedRule?.ok
      ? normalisedRule.recurrenceRule
      : recurrence.recurrenceRule;

    const startDate = normalisedStartDate ?? recurrence.startDate;

    if (
      recurrenceRule === recurrence.recurrenceRule &&
      startDate === recurrence.startDate
    ) {
      return {
        kind: "unchanged",

        recurrence,
      } as const;
    }

    const updatedAt = new Date();

    const [updated] = await transaction
      .update(eventTemplateRecurrences)
      .set({
        recurrenceRule,

        startDate,

        /*
         * Source changes should be reconsidered immediately.
         *
         * Clearing the claim token also fences completion from a sweep which
         * began against the previous source definition.
         */
        nextSweepAt: updatedAt,

        sweepClaimToken: null,

        lastSweepStartedAt: null,

        lastSweepCompletedAt: null,

        lastSweepOutcome: null,

        lastSweepDiagnostic: null,

        updatedAt,
      })
      .where(eq(eventTemplateRecurrences.id, recurrence.id))
      .returning(recurrenceSelection);

    if (!updated) {
      throw new Error(
        `Recurrence #${recurrence.id} disappeared while it was being edited.`,
      );
    }

    return {
      kind: "updated",

      recurrence: updated,
    } as const;
  });
}

export async function setEventTemplateRecurrenceActive(
  input: SetEventTemplateRecurrenceActiveInput,
): Promise<SetEventTemplateRecurrenceActiveResult> {
  return db.transaction(async (transaction) => {
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        localStartTime: eventTemplates.localStartTime,

        publicationMode: eventTemplates.publicationMode,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const [recurrence] = await transaction
      .select(recurrenceSelection)
      .from(eventTemplateRecurrences)
      .where(eq(eventTemplateRecurrences.templateId, template.id))
      .limit(1)
      .for("update");

    if (!recurrence) {
      return {
        kind: "recurrence_not_found",
      } as const;
    }

    if (input.active && template.localStartTime === null) {
      return {
        kind: "invalid_input",

        reason: "template_missing_local_start_time",
      } as const;
    }

    if (input.active && template.publicationMode === "immediate") {
      return {
        kind: "invalid_input",

        reason: "immediate_publication_not_supported",
      } as const;
    }

    if (recurrence.active === input.active) {
      return {
        kind: "unchanged",

        recurrence,
      } as const;
    }

    const updatedAt = new Date();

    const [updated] = await transaction
      .update(eventTemplateRecurrences)
      .set({
        active: input.active,

        /*
         * Reactivation should not wait for an old future sweep timestamp.
         */
        ...(input.active
          ? {
              nextSweepAt: updatedAt,
            }
          : {}),

        /*
         * Lifecycle mutation supersedes any previously-claimed sweep.
         *
         * A stale worker may still finish its current code path, but its
         * completion token will no longer match.
         */
        sweepClaimToken: null,

        updatedAt,
      })
      .where(eq(eventTemplateRecurrences.id, recurrence.id))
      .returning(recurrenceSelection);

    if (!updated) {
      throw new Error(
        `Recurrence #${recurrence.id} disappeared while its lifecycle state was being changed.`,
      );
    }

    return {
      kind: "updated",

      recurrence: updated,
    } as const;
  });
}

function normaliseRecurrenceConfiguration(
  recurrenceRule: string,
  startDate: string,
):
  | {
      ok: true;

      recurrenceRule: string;

      startDate: string;
    }
  | {
      ok: false;

      reason: EventTemplateRecurrenceInvalidReason;
    } {
  const ruleResult = normaliseRecurrenceRule(recurrenceRule);

  if (!ruleResult.ok) {
    return ruleResult;
  }

  const normalisedStartDate = normaliseRecurrenceDate(startDate);

  if (!normalisedStartDate) {
    return {
      ok: false,

      reason: "invalid_start_date",
    };
  }

  return {
    ok: true,

    recurrenceRule: ruleResult.recurrenceRule,

    startDate: normalisedStartDate,
  };
}
