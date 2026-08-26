import type { Client } from "discord.js";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  startEventScheduler,
  stopEventScheduler,
} from "../../../src/scheduler/event-scheduler.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "400000000000000001";
const ADMIN_USER_ID = "400000000000000002";

describe("scheduler retry and recovery", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    stopEventScheduler();

    await resetIntegrationDatabase(pool);
  });

  afterEach(() => {
    stopEventScheduler();
  });

  afterAll(async () => {
    stopEventScheduler();

    await pool.end();
    await applicationPool.end();
  });

  it("does not give a stale processing action a sixth attempt after the maximum attempt count was already reached", async () => {
    // Arrange
    const fixture = await createStaleExhaustedAction(pool);

    /*
     * No Discord functionality is needed for this regression.
     *
     * The deliberately-invalid action key will throw inside the scheduler
     * dispatcher if stale recovery incorrectly makes it executable again.
     */
    const client = {} as Client<true>;

    // Act
    startEventScheduler(client);

    await waitForScheduledActionStatus(pool, fixture.actionId, "failed");

    stopEventScheduler();

    // Assert
    const result = await pool.query<{
      status: string;
      attempt_count: number;
      locked_at: Date | null;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `
        SELECT
          "status",
          "attempt_count",
          "locked_at",
          "completed_at",
          "last_error"
        FROM "scheduled_actions"
        WHERE "id" = $1
      `,
      [fixture.actionId],
    );

    expect(result.rows).toHaveLength(1);

    const action = result.rows[0];

    /*
     * Five claimed attempts have already occurred.
     *
     * Recovering an interrupted fifth attempt must not return the action
     * to pending and allow claimAction() to increment it to six.
     */
    expect.soft(action?.attempt_count).toBe(5);

    expect.soft(action?.status).toBe("failed");

    expect.soft(action?.locked_at).toBeNull();

    expect.soft(action?.completed_at).toBeNull();

    /*
     * The failure should describe interrupted processing rather than an
     * error from executing the action for an impermissible sixth time.
     */
    expect.soft(action?.last_error).toContain("interrupted processing");

    expect
      .soft(action?.last_error)
      .not.toContain("Unknown scheduled action key");
  });
});

async function createStaleExhaustedAction(pool: Pool): Promise<{
  eventId: number;
  actionId: number;
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
    [DISCORD_GUILD_ID, "Scheduler Retry Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
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
    [guildId, "naval", "Naval Event"],
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
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '1 hour',
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Scheduler Retry Test Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  /*
   * Simulate a process which crashed during its fifth and final allowed
   * execution attempt.
   *
   * The lock is older than the scheduler's five-minute stale threshold,
   * so recoverStaleActions() will inspect it on the next tick.
   */
  const actionResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status",
          "attempt_count",
          "locked_at"
        )
        VALUES (
          $1,
          'integration_test_invalid_action',
          NOW() - INTERVAL '10 minutes',
          'processing',
          5,
          NOW() - INTERVAL '6 minutes'
        )
        RETURNING "id"
      `,
    [eventId],
  );

  const actionId = actionResult.rows[0]?.id;

  if (!actionId) {
    throw new Error("The stale integration-test action was not created.");
  }

  return {
    eventId,
    actionId,
  };
}

async function waitForScheduledActionStatus(
  pool: Pool,
  actionId: number,
  expectedStatus: string,
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      status: string;
    }>(
      `
          SELECT "status"
          FROM "scheduled_actions"
          WHERE "id" = $1
        `,
      [actionId],
    );

    if (result.rows[0]?.status === expectedStatus) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for scheduled action #${actionId} to reach status "${expectedStatus}".`,
  );
}
