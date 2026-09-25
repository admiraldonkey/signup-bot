import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sweepMocks = vi.hoisted(() => ({
  runDueRecurrenceSweeps: vi.fn(),
}));

vi.mock(
  "../../../src/templates/event-template-recurrence-sweep-service.js",
  () => sweepMocks,
);

import {
  RECURRENCE_SCHEDULER_POLL_INTERVAL_MS,
  startRecurrenceScheduler,
  stopRecurrenceScheduler,
} from "../../../src/scheduler/recurrence-scheduler.js";

const EMPTY_SWEEP_RESULT = {
  claimedCount: 0,

  results: [],
};

describe("recurrence scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    vi.clearAllMocks();

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await stopRecurrenceScheduler();

    vi.useRealTimers();

    vi.restoreAllMocks();
  });

  it("runs immediately and does not create duplicate timers when started twice", async () => {
    sweepMocks.runDueRecurrenceSweeps.mockResolvedValue(EMPTY_SWEEP_RESULT);

    startRecurrenceScheduler();

    startRecurrenceScheduler();

    await flushAsyncWork();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RECURRENCE_SCHEDULER_POLL_INTERVAL_MS);

    await flushAsyncWork();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(2);
  });

  it("does not overlap local ticks while an earlier sweep is still running", async () => {
    let releaseFirstSweep:
      | ((value: typeof EMPTY_SWEEP_RESULT) => void)
      | undefined;

    const firstSweep = new Promise<typeof EMPTY_SWEEP_RESULT>((resolve) => {
      releaseFirstSweep = resolve;
    });

    sweepMocks.runDueRecurrenceSweeps
      .mockReturnValueOnce(firstSweep)
      .mockResolvedValue(EMPTY_SWEEP_RESULT);

    startRecurrenceScheduler();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(1);

    /*
     * Several timer polls happen while the first sweep is still active.
     *
     * None may start another local sweep.
     */
    vi.advanceTimersByTime(RECURRENCE_SCHEDULER_POLL_INTERVAL_MS * 3);

    await flushAsyncWork();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(1);

    if (!releaseFirstSweep) {
      throw new Error(
        "Expected the blocked recurrence sweep to expose its release function.",
      );
    }

    releaseFirstSweep(EMPTY_SWEEP_RESULT);

    await flushAsyncWork();

    vi.advanceTimersByTime(RECURRENCE_SCHEDULER_POLL_INTERVAL_MS);

    await flushAsyncWork();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(2);
  });

  it("drains an in-flight sweep before shutdown completes", async () => {
    let releaseSweep: ((value: typeof EMPTY_SWEEP_RESULT) => void) | undefined;

    const sweep = new Promise<typeof EMPTY_SWEEP_RESULT>((resolve) => {
      releaseSweep = resolve;
    });

    sweepMocks.runDueRecurrenceSweeps.mockReturnValue(sweep);

    startRecurrenceScheduler();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(1);

    let stopped = false;

    const stopPromise = stopRecurrenceScheduler().then(() => {
      stopped = true;
    });

    await flushAsyncWork();

    expect(stopped).toBe(false);

    if (!releaseSweep) {
      throw new Error(
        "Expected the blocked recurrence sweep to expose its release function.",
      );
    }

    releaseSweep(EMPTY_SWEEP_RESULT);

    await stopPromise;

    expect(stopped).toBe(true);

    vi.advanceTimersByTime(RECURRENCE_SCHEDULER_POLL_INTERVAL_MS * 2);

    await flushAsyncWork();

    /*
     * Stopping clears future timer polls.
     */
    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(1);
  });

  it("contains a failed polling tick and continues on the next interval", async () => {
    sweepMocks.runDueRecurrenceSweeps
      .mockRejectedValueOnce(
        new Error("Temporary recurrence database failure."),
      )
      .mockResolvedValue(EMPTY_SWEEP_RESULT);

    startRecurrenceScheduler();

    await flushAsyncWork();

    expect(console.error).toHaveBeenCalledWith(
      "Recurrence scheduler tick failed:",

      expect.any(Error),
    );

    vi.advanceTimersByTime(RECURRENCE_SCHEDULER_POLL_INTERVAL_MS);

    await flushAsyncWork();

    expect(sweepMocks.runDueRecurrenceSweeps).toHaveBeenCalledTimes(2);
  });

  it("logs durable recurrence failures without failing the scheduler tick", async () => {
    sweepMocks.runDueRecurrenceSweeps.mockResolvedValue({
      claimedCount: 1,

      results: [
        {
          recurrenceId: 41,

          templateId: 7,

          guildDatabaseId: 42,

          outcome: "failure",

          generatedCount: 0,

          alreadyGeneratedCount: 0,

          skippedCount: 0,

          failedCount: 1,

          diagnostic: "invalid_template_timezone",

          recorded: true,
        },
      ],
    });

    startRecurrenceScheduler();

    await flushAsyncWork();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Recurrence #41 for template #7 failed"),
    );
  });
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();

  await Promise.resolve();

  await Promise.resolve();
}
