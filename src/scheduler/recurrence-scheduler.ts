import {
  runDueRecurrenceSweeps,
  type RunDueRecurrenceSweepsResult,
} from "../templates/event-template-recurrence-sweep-service.js";

/*
 * This is only a discovery cadence.
 *
 * Authoritative recurrence timing lives in PostgreSQL through next_sweep_at.
 * Polling more frequently lets newly-created, edited or recovered recurrence
 * work start promptly without turning this JavaScript interval into state.
 */
export const RECURRENCE_SCHEDULER_POLL_INTERVAL_MS = 15_000;

let recurrenceSchedulerTimer: NodeJS.Timeout | null = null;

let recurrenceSchedulerTickPromise: Promise<void> | null = null;

export function startRecurrenceScheduler(): void {
  if (recurrenceSchedulerTimer) {
    return;
  }

  console.log("Recurrence scheduler started.");

  /*
   * Recover due durable recurrence work immediately on startup.
   */
  void requestRecurrenceSchedulerTick();

  recurrenceSchedulerTimer = setInterval(() => {
    void requestRecurrenceSchedulerTick();
  }, RECURRENCE_SCHEDULER_POLL_INTERVAL_MS);

  /*
   * The polling timer itself is not authoritative and must not keep Node
   * alive during an otherwise-clean shutdown.
   */
  recurrenceSchedulerTimer.unref();
}

export async function stopRecurrenceScheduler(): Promise<void> {
  /*
   * Stop discovering new recurrence work first.
   */
  const timer = recurrenceSchedulerTimer;

  if (timer) {
    clearInterval(timer);

    recurrenceSchedulerTimer = null;
  }

  /*
   * A sweep may still be using PostgreSQL after the timer is cleared.
   *
   * Drain it before the shared database pool is closed.
   */
  const activeTick = recurrenceSchedulerTickPromise;

  if (activeTick) {
    await activeTick;
  }

  if (timer) {
    console.log("Recurrence scheduler stopped.");
  }
}

async function requestRecurrenceSchedulerTick(): Promise<void> {
  /*
   * Local ticks must not overlap.
   *
   * PostgreSQL claim fencing also protects multiple processes or replicas,
   * but there is no reason for one Node process to compete with itself.
   */
  if (recurrenceSchedulerTickPromise) {
    return;
  }

  const tickPromise = runRecurrenceSchedulerTickSafely();

  recurrenceSchedulerTickPromise = tickPromise;

  try {
    await tickPromise;
  } finally {
    if (recurrenceSchedulerTickPromise === tickPromise) {
      recurrenceSchedulerTickPromise = null;
    }
  }
}

async function runRecurrenceSchedulerTickSafely(): Promise<void> {
  try {
    const result = await runDueRecurrenceSweeps();

    reportRecurrenceSweepResults(result);
  } catch (error) {
    /*
     * A polling failure must not terminate the scheduler.
     *
     * Durable next_sweep_at state remains in PostgreSQL and will be
     * rediscovered by a later tick or process restart.
     */
    console.error(
      "Recurrence scheduler tick failed:",

      error,
    );
  }
}

function reportRecurrenceSweepResults(
  result: RunDueRecurrenceSweepsResult,
): void {
  for (const entry of result.results) {
    if (!entry.recorded) {
      console.warn(
        [
          `Recurrence #${entry.recurrenceId} for template #${entry.templateId}`,
          "finished without recording completion because this worker no longer owned the durable claim.",
        ].join(" "),
      );

      continue;
    }

    if (entry.outcome === "failure" || entry.outcome === "partial_failure") {
      const outcomeLabel =
        entry.outcome === "failure" ? "failed" : "partially failed";

      console.error(
        [
          `Recurrence #${entry.recurrenceId} for template #${entry.templateId} ${outcomeLabel}.`,
          `Generated: ${entry.generatedCount}.`,
          `Already generated: ${entry.alreadyGeneratedCount}.`,
          `Skipped: ${entry.skippedCount}.`,
          `Failed: ${entry.failedCount}.`,
          entry.diagnostic ? `Diagnostic: ${entry.diagnostic}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );

      continue;
    }

    if (entry.generatedCount > 0) {
      console.log(
        [
          `Recurrence #${entry.recurrenceId} for template #${entry.templateId}`,
          `generated ${entry.generatedCount} occurrence(s).`,
        ].join(" "),
      );
    }
  }
}
