import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  discordGuilds,
  eventTemplateRecurrences,
  eventTemplates,
} from "../db/schema.js";
import {
  generateRecurringHorizon,
  type GenerateRecurringHorizonResult,
  type RecurringHorizonSlotResult,
} from "./event-template-recurrence-horizon-service.js";

/*
 * A recurrence is rediscovered from durable source state rather than through
 * one event-owned scheduled_actions row.
 *
 * Five minutes is short relative to the ten-day generation horizon and its
 * three days of lead-time headroom, while avoiding pointless horizon
 * enumeration on every scheduler poll.
 */
export const RECURRENCE_SWEEP_INTERVAL_MS = 5 * 60_000;

/*
 * A claimed recurrence normally finishes quickly.
 *
 * If a process disappears after claiming one, another worker may recover the
 * series after this lease age. Individual occurrence generation remains
 * independently idempotent, so stale recovery cannot create duplicate slots.
 */
export const RECURRENCE_SWEEP_STALE_AFTER_MS = 15 * 60_000;

export const MAX_RECURRENCE_SWEEPS_PER_RUN = 10;

export type RecurrenceSweepOutcome =
  | "success"
  | "partial_failure"
  | "failure"
  | "skipped";

export type RecurrenceSweepExecutionResult = {
  recurrenceId: number;

  templateId: number;

  guildDatabaseId: number;

  outcome: RecurrenceSweepOutcome;

  generatedCount: number;

  alreadyGeneratedCount: number;

  skippedCount: number;

  failedCount: number;

  diagnostic: string | null;

  /*
   * False means this worker no longer owned the persisted claim by the time
   * it tried to record completion.
   *
   * A recurrence edit, lifecycle change or newer stale-recovery claim may
   * legitimately supersede an older worker.
   */
  recorded: boolean;
};

export type RunDueRecurrenceSweepsResult = {
  claimedCount: number;

  results: RecurrenceSweepExecutionResult[];
};

type DueRecurrenceCandidate = {
  recurrenceId: number;

  templateId: number;

  guildDatabaseId: number;
};

type RecurrenceSweepClaim = DueRecurrenceCandidate & {
  claimToken: string;

  startedAt: Date;
};

type RecurrenceSweepClassification = {
  outcome: RecurrenceSweepOutcome;

  generatedCount: number;

  alreadyGeneratedCount: number;

  skippedCount: number;

  failedCount: number;

  diagnostic: string | null;
};

export async function runDueRecurrenceSweeps(
  input: {
    now?: Date;

    limit?: number;
  } = {},
): Promise<RunDueRecurrenceSweepsResult> {
  const now = input.now ?? new Date();

  if (!Number.isFinite(now.getTime())) {
    throw new Error("Recurrence sweep received an invalid current time.");
  }

  const limit = input.limit ?? MAX_RECURRENCE_SWEEPS_PER_RUN;

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Recurrence sweep limit must be a positive whole number.");
  }

  const staleBefore = new Date(now.getTime() - RECURRENCE_SWEEP_STALE_AFTER_MS);

  /*
   * Discovery is deliberately unlocked.
   *
   * Several workers may observe the same candidate. The conditional UPDATE in
   * tryClaimRecurrenceSweep() is the authoritative ownership boundary.
   */
  const candidates = await db
    .select({
      recurrenceId: eventTemplateRecurrences.id,

      templateId: eventTemplateRecurrences.templateId,

      guildDatabaseId: eventTemplates.ownerGuildId,
    })
    .from(eventTemplateRecurrences)
    .innerJoin(
      eventTemplates,

      eq(eventTemplates.id, eventTemplateRecurrences.templateId),
    )
    .innerJoin(
      discordGuilds,

      eq(discordGuilds.id, eventTemplates.ownerGuildId),
    )
    .where(
      and(
        eq(eventTemplateRecurrences.active, true),

        eq(eventTemplates.active, true),

        eq(discordGuilds.enabled, true),

        lte(eventTemplateRecurrences.nextSweepAt, now),

        or(
          isNull(eventTemplateRecurrences.sweepClaimToken),

          isNull(eventTemplateRecurrences.lastSweepStartedAt),

          lte(eventTemplateRecurrences.lastSweepStartedAt, staleBefore),
        ),
      ),
    )
    .orderBy(
      asc(eventTemplateRecurrences.nextSweepAt),

      asc(eventTemplateRecurrences.id),
    )
    .limit(limit);

  const results: RecurrenceSweepExecutionResult[] = [];

  let claimedCount = 0;

  /*
   * Claim and process one candidate at a time.
   *
   * Do not pre-claim the entire batch. If this process disappears halfway
   * through a run, only the recurrence currently being processed should retain
   * a stale lease.
   */
  for (const candidate of candidates) {
    const claim = await tryClaimRecurrenceSweep(
      candidate,

      now,

      staleBefore,
    );

    if (!claim) {
      continue;
    }

    claimedCount += 1;

    try {
      results.push(await executeRecurrenceSweepClaim(claim));
    } catch (error) {
      /*
       * A database failure while recording completion may itself prevent
       * durable failure state from being written.
       *
       * Keep unrelated recurrence candidates moving. The still-owned claim
       * becomes recoverable after the stale-lease interval.
       */
      results.push({
        recurrenceId: claim.recurrenceId,

        templateId: claim.templateId,

        guildDatabaseId: claim.guildDatabaseId,

        outcome: "failure",

        generatedCount: 0,

        alreadyGeneratedCount: 0,

        skippedCount: 0,

        failedCount: 1,

        diagnostic: formatUnexpectedError(error),

        recorded: false,
      });
    }
  }

  return {
    claimedCount,

    results,
  };
}

async function tryClaimRecurrenceSweep(
  candidate: DueRecurrenceCandidate,
  now: Date,
  staleBefore: Date,
): Promise<RecurrenceSweepClaim | null> {
  const claimToken = randomUUID();

  const nextSweepAt = new Date(now.getTime() + RECURRENCE_SWEEP_INTERVAL_MS);

  /*
   * This UPDATE is the durable claim.
   *
   * Two workers may both have discovered this row. PostgreSQL serialises their
   * competing updates and re-evaluates the WHERE clause after waiting.
   *
   * Once one worker moves nextSweepAt into the future, the loser updates zero
   * rows and performs no recurrence work.
   */
  const [claimed] = await db
    .update(eventTemplateRecurrences)
    .set({
      nextSweepAt,

      sweepClaimToken: claimToken,

      lastSweepStartedAt: now,
    })
    .where(
      and(
        eq(eventTemplateRecurrences.id, candidate.recurrenceId),

        eq(eventTemplateRecurrences.active, true),

        lte(eventTemplateRecurrences.nextSweepAt, now),

        or(
          isNull(eventTemplateRecurrences.sweepClaimToken),

          isNull(eventTemplateRecurrences.lastSweepStartedAt),

          lte(eventTemplateRecurrences.lastSweepStartedAt, staleBefore),
        ),
      ),
    )
    .returning({
      id: eventTemplateRecurrences.id,
    });

  if (!claimed) {
    return null;
  }

  return {
    ...candidate,

    claimToken,

    startedAt: now,
  };
}

async function executeRecurrenceSweepClaim(
  claim: RecurrenceSweepClaim,
): Promise<RecurrenceSweepExecutionResult> {
  /*
   * Discovery and claim may race ordinary lifecycle administration.
   *
   * Re-read cheap eligibility state before entering horizon generation.
   * The horizon and per-occurrence generator retain their own authoritative
   * template/recurrence locks and defensive checks.
   */
  const [eligibility] = await db
    .select({
      recurrenceActive: eventTemplateRecurrences.active,

      templateActive: eventTemplates.active,

      guildEnabled: discordGuilds.enabled,
    })
    .from(eventTemplateRecurrences)
    .innerJoin(
      eventTemplates,

      eq(eventTemplates.id, eventTemplateRecurrences.templateId),
    )
    .innerJoin(
      discordGuilds,

      eq(discordGuilds.id, eventTemplates.ownerGuildId),
    )
    .where(eq(eventTemplateRecurrences.id, claim.recurrenceId))
    .limit(1);

  let classification: RecurrenceSweepClassification;

  if (!eligibility) {
    classification = skippedClassification(
      "recurrence source no longer exists",
    );
  } else if (!eligibility.guildEnabled) {
    classification = skippedClassification("guild_disabled");
  } else if (!eligibility.templateActive) {
    classification = skippedClassification("template_inactive");
  } else if (!eligibility.recurrenceActive) {
    classification = skippedClassification("recurrence_inactive");
  } else {
    try {
      const horizon = await generateRecurringHorizon({
        guildDatabaseId: claim.guildDatabaseId,

        templateId: claim.templateId,

        /*
         * Every occurrence in this sweep uses one coherent clock.
         */
        now: claim.startedAt,
      });

      classification = classifyRecurringHorizonResult(horizon);
    } catch (error) {
      classification = {
        outcome: "failure",

        generatedCount: 0,

        alreadyGeneratedCount: 0,

        skippedCount: 0,

        failedCount: 1,

        diagnostic: formatUnexpectedError(error),
      };
    }
  }

  const recorded = await completeRecurrenceSweepClaim(
    claim,

    classification,
  );

  return {
    recurrenceId: claim.recurrenceId,

    templateId: claim.templateId,

    guildDatabaseId: claim.guildDatabaseId,

    ...classification,

    recorded,
  };
}

async function completeRecurrenceSweepClaim(
  claim: RecurrenceSweepClaim,
  classification: RecurrenceSweepClassification,
): Promise<boolean> {
  /*
   * Completion is fenced by the exact claim token.
   *
   * If an administrator edited/deactivated this recurrence, or a later worker
   * recovered a stale claim, this UPDATE affects zero rows and the newer
   * authoritative state remains untouched.
   */
  const [completed] = await db
    .update(eventTemplateRecurrences)
    .set({
      sweepClaimToken: null,

      lastSweepCompletedAt: claim.startedAt,

      lastSweepOutcome: classification.outcome,

      lastSweepDiagnostic: classification.diagnostic,
    })
    .where(
      and(
        eq(eventTemplateRecurrences.id, claim.recurrenceId),

        eq(eventTemplateRecurrences.sweepClaimToken, claim.claimToken),
      ),
    )
    .returning({
      id: eventTemplateRecurrences.id,
    });

  return completed !== undefined;
}

function classifyRecurringHorizonResult(
  result: GenerateRecurringHorizonResult,
): RecurrenceSweepClassification {
  if (result.kind !== "processed") {
    switch (result.kind) {
      case "template_not_found":
      case "recurrence_not_found":
      case "template_inactive":
      case "recurrence_inactive":
        return skippedClassification(result.kind);

      case "invalid_recurrence":
        return failureClassification(`invalid_recurrence:${result.reason}`);

      case "template_missing_local_start_time":
      case "immediate_publication_not_supported":
      case "invalid_template_timezone":
      case "invalid_now":
        return failureClassification(result.kind);
    }
  }

  const generatedCount = result.slotResults.filter(
    (slot) => slot.kind === "generated",
  ).length;

  const alreadyGeneratedCount = result.slotResults.filter(
    (slot) => slot.kind === "already_generated",
  ).length;

  const skippedCount = result.slotResults.filter(
    (slot) => slot.kind === "skipped",
  ).length;

  const failedSlots = result.slotResults.filter(
    (
      slot,
    ): slot is Extract<
      RecurringHorizonSlotResult,
      {
        kind: "failed";
      }
    > => slot.kind === "failed",
  );

  const failedCount = failedSlots.length;

  if (failedCount === 0) {
    return {
      outcome: "success",

      generatedCount,

      alreadyGeneratedCount,

      skippedCount,

      failedCount: 0,

      diagnostic: null,
    };
  }

  const outcome: RecurrenceSweepOutcome =
    failedCount === result.slotResults.length ? "failure" : "partial_failure";

  return {
    outcome,

    generatedCount,

    alreadyGeneratedCount,

    skippedCount,

    failedCount,

    diagnostic: failedSlots.map(formatFailedSlotDiagnostic).join(" | "),
  };
}

function formatFailedSlotDiagnostic(
  slot: Extract<
    RecurringHorizonSlotResult,
    {
      kind: "failed";
    }
  >,
): string {
  const result = slot.result;

  if (result.kind === "invalid_local_occurrence_time") {
    return `${slot.occurrenceDate}: invalid_local_occurrence_time (${result.error})`;
  }

  if (result.kind === "invalid_recurrence") {
    return `${slot.occurrenceDate}: invalid_recurrence:${result.reason}`;
  }

  if (result.kind === "generation_failed") {
    const nested = result.result;

    const nestedReason = "reason" in nested ? `:${String(nested.reason)}` : "";

    return `${slot.occurrenceDate}: generation_failed:${nested.kind}${nestedReason}`;
  }

  return `${slot.occurrenceDate}: ${result.kind}`;
}

function skippedClassification(
  diagnostic: string,
): RecurrenceSweepClassification {
  return {
    outcome: "skipped",

    generatedCount: 0,

    alreadyGeneratedCount: 0,

    skippedCount: 1,

    failedCount: 0,

    diagnostic,
  };
}

function failureClassification(
  diagnostic: string,
): RecurrenceSweepClassification {
  return {
    outcome: "failure",

    generatedCount: 0,

    alreadyGeneratedCount: 0,

    skippedCount: 0,

    failedCount: 1,

    diagnostic,
  };
}

function formatUnexpectedError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
