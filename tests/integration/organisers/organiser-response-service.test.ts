import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { recordOrganiserResponse } from "../../../src/organisers/organiser-response-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "950000000000000001";
const ADMIN_USER_ID = "950000000000000002";
const ORGANISER_USER_ID = "950000000000000003";
const OTHER_USER_ID = "950000000000000004";

describe("organiser response service", () => {
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

  it("confirms an active pending assignment and cancels its response actions", async () => {
    // Arrange
    const fixture = await createResponseFixture(pool);

    // Act
    const result = await recordOrganiserResponse({
      assignmentId: fixture.assignmentId,

      respondingUserId: ORGANISER_USER_ID,

      action: "confirm",
    });

    // Assert
    expect(result).toMatchObject({
      kind: "saved",

      assignment: {
        id: fixture.assignmentId,

        eventId: fixture.eventId,

        slot: "primary",

        discordUserId: ORGANISER_USER_ID,

        eventName: "Organiser Response Service Test",

        guildDatabaseId: fixture.guildId,

        discordGuildId: DISCORD_GUILD_ID,
      },
    });

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect(assignmentResult.rows[0]).toMatchObject({
      status: "confirmed",

      is_current: true,

      ended_at: null,
    });

    expect(assignmentResult.rows[0]?.responded_at).toBeInstanceOf(Date);

    const actionResult = await readResponseActions(pool, fixture.eventId);

    expect(actionResult).toEqual([
      {
        action_key: `organiser_timeout:${fixture.assignmentId}`,

        status: "cancelled",
      },
      {
        action_key: `organiser_warning:${fixture.assignmentId}`,

        status: "cancelled",
      },
    ]);
  });

  it("declines an active pending assignment and ends its ownership", async () => {
    // Arrange
    const fixture = await createResponseFixture(pool);

    // Act
    const result = await recordOrganiserResponse({
      assignmentId: fixture.assignmentId,

      respondingUserId: ORGANISER_USER_ID,

      action: "decline",
    });

    // Assert
    expect(result.kind).toBe("saved");

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toHaveLength(1);

    expect(assignmentResult.rows[0]).toMatchObject({
      status: "declined",

      is_current: false,
    });

    expect(assignmentResult.rows[0]?.responded_at).toBeInstanceOf(Date);

    expect(assignmentResult.rows[0]?.ended_at).toBeInstanceOf(Date);

    const actionResult = await readResponseActions(pool, fixture.eventId);

    expect(actionResult).toEqual([
      {
        action_key: `organiser_timeout:${fixture.assignmentId}`,

        status: "cancelled",
      },
      {
        action_key: `organiser_warning:${fixture.assignmentId}`,

        status: "cancelled",
      },
    ]);
  });

  it("rejects a response from a different user without changing assignment state", async () => {
    // Arrange
    const fixture = await createResponseFixture(pool);

    // Act
    const result = await recordOrganiserResponse({
      assignmentId: fixture.assignmentId,

      respondingUserId: OTHER_USER_ID,

      action: "confirm",
    });

    // Assert
    expect(result).toEqual({
      kind: "wrong_user",
    });

    await expectPendingAssignmentUnchanged(pool, fixture.assignmentId);

    /*
     * Invalid responses do not own the assignment's scheduled work.
     */
    const actionResult = await readResponseActions(pool, fixture.eventId);

    expect(actionResult).toEqual([
      {
        action_key: `organiser_timeout:${fixture.assignmentId}`,

        status: "pending",
      },
      {
        action_key: `organiser_warning:${fixture.assignmentId}`,

        status: "pending",
      },
    ]);
  });

  it("rejects a response to a dormant standby assignment", async () => {
    // Arrange
    const fixture = await createResponseFixture(pool, {
      activated: false,

      createResponseActions: false,
    });

    // Act
    const result = await recordOrganiserResponse({
      assignmentId: fixture.assignmentId,

      respondingUserId: ORGANISER_USER_ID,

      action: "confirm",
    });

    // Assert
    expect(result).toEqual({
      kind: "assignment_standby",
    });

    const assignmentResult = await pool.query<{
      status: string;
      is_current: boolean;
      activated_at: Date | null;
      response_deadline_at: Date | null;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "activated_at",
          "response_deadline_at",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    expect(assignmentResult.rows).toEqual([
      {
        status: "pending",

        is_current: true,

        activated_at: null,

        response_deadline_at: null,

        responded_at: null,

        ended_at: null,
      },
    ]);

    const actionResult = await readResponseActions(pool, fixture.eventId);

    expect(actionResult).toEqual([]);
  });

  it("reports an already-completed response without mutating it again", async () => {
    // Arrange
    const fixture = await createResponseFixture(pool, {
      assignmentStatus: "confirmed",

      createResponseActions: false,
    });

    await pool.query(
      `
        UPDATE "event_organiser_assignments"
        SET
          "responded_at" = NOW() - INTERVAL '5 minutes',
          "updated_at" = NOW() - INTERVAL '5 minutes'
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    const beforeResult = await pool.query<{
      responded_at: Date;
    }>(
      `
        SELECT "responded_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    const originalRespondedAt = beforeResult.rows[0]?.responded_at;

    if (!originalRespondedAt) {
      throw new Error("The already-confirmed fixture is missing responded_at.");
    }

    // Act
    const result = await recordOrganiserResponse({
      assignmentId: fixture.assignmentId,

      respondingUserId: ORGANISER_USER_ID,

      action: "decline",
    });

    // Assert
    expect(result).toEqual({
      kind: "already_responded",

      status: "confirmed",
    });

    const afterResult = await pool.query<{
      status: string;
      is_current: boolean;
      responded_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        SELECT
          "status",
          "is_current",
          "responded_at",
          "ended_at"
        FROM "event_organiser_assignments"
        WHERE "id" = $1
      `,
      [fixture.assignmentId],
    );

    expect(afterResult.rows).toHaveLength(1);

    expect(afterResult.rows[0]).toMatchObject({
      status: "confirmed",

      is_current: true,

      ended_at: null,
    });

    expect(afterResult.rows[0]?.responded_at?.getTime()).toBe(
      originalRespondedAt.getTime(),
    );
  });

  it.each(["cancelled", "completed"] as const)(
    "does not save a response when %s wins the event lifecycle race",
    async (terminalStatus) => {
      // Arrange
      const fixture = await createResponseFixture(pool);

      const lockClient = await pool.connect();

      let responsePromise:
        | ReturnType<typeof recordOrganiserResponse>
        | undefined;

      try {
        await lockClient.query("BEGIN");

        /*
         * Own the lifecycle row before the response service reaches its
         * authoritative FOR UPDATE check.
         *
         * Its initial ordinary read may still observe the committed open
         * event through MVCC, which is exactly the stale-read race this lock
         * is designed to protect against.
         */
        await lockClient.query(
          `
            SELECT "id"
            FROM "events"
            WHERE "id" = $1
            FOR UPDATE
          `,
          [fixture.eventId],
        );

        responsePromise = recordOrganiserResponse({
          assignmentId: fixture.assignmentId,

          respondingUserId: ORGANISER_USER_ID,

          action: "confirm",
        });

        await waitForBlockedOrganiserEventLock(pool);

        /*
         * The terminal lifecycle transition becomes authoritative before
         * the organiser-response transaction can acquire the event lock.
         */
        await lockClient.query(
          `
            UPDATE "events"
            SET
              "status" = $2,
              "updated_at" = NOW()
            WHERE "id" = $1
          `,
          [fixture.eventId, terminalStatus],
        );

        await lockClient.query("COMMIT");

        const result = await responsePromise;

        expect(result).toEqual({
          kind: "event_inactive",
        });
      } catch (error: unknown) {
        await lockClient.query("ROLLBACK").catch(() => undefined);

        await responsePromise?.catch(() => undefined);

        throw error;
      } finally {
        lockClient.release();
      }

      // Assert
      const eventResult = await pool.query<{
        status: string;
      }>(
        `
          SELECT "status"
          FROM "events"
          WHERE "id" = $1
        `,
        [fixture.eventId],
      );

      expect(eventResult.rows).toEqual([
        {
          status: terminalStatus,
        },
      ]);

      /*
       * The stale organiser response must not alter authoritative assignment
       * state after the terminal event lifecycle transition wins.
       */
      await expectPendingAssignmentUnchanged(pool, fixture.assignmentId);

      const actionResult = await readResponseActions(pool, fixture.eventId);

      expect(actionResult).toEqual([
        {
          action_key: `organiser_timeout:${fixture.assignmentId}`,

          status: "pending",
        },
        {
          action_key: `organiser_warning:${fixture.assignmentId}`,

          status: "pending",
        },
      ]);
    },
  );

  it("does not record a response when organisers are disabled", async () => {
    // Arrange
    const fixture = await createResponseFixture(pool);

    await pool.query(
      `
      UPDATE "guild_settings"
      SET
        "organisers_enabled" = false,
        "updated_at" = NOW()
      WHERE "guild_id" = $1
    `,
      [fixture.guildId],
    );

    // Act
    const result = await recordOrganiserResponse({
      assignmentId: fixture.assignmentId,

      respondingUserId: ORGANISER_USER_ID,

      action: "confirm",
    });

    // Assert
    expect(result).toEqual({
      kind: "organisers_disabled",
    });

    await expectPendingAssignmentUnchanged(pool, fixture.assignmentId);

    const actionResult = await readResponseActions(pool, fixture.eventId);

    expect(actionResult).toEqual([
      {
        action_key: `organiser_timeout:${fixture.assignmentId}`,

        status: "pending",
      },
      {
        action_key: `organiser_warning:${fixture.assignmentId}`,

        status: "pending",
      },
    ]);
  });
});

async function createResponseFixture(
  pool: Pool,
  options: {
    activated?: boolean;

    assignmentStatus?: "pending" | "confirmed";

    createResponseActions?: boolean;
  } = {},
): Promise<{
  guildId: number;

  eventId: number;

  assignmentId: number;
}> {
  const activated = options.activated ?? true;

  const assignmentStatus = options.assignmentStatus ?? "pending";

  const createResponseActions =
    options.createResponseActions ??
    (activated && assignmentStatus === "pending");

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
    [DISCORD_GUILD_ID, "Organiser Response Service Test Guild"],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id"
      )
      VALUES ($1)
    `,
    [guildId],
  );

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
        "signups_enabled",
        "published_at",
        "status",
        "created_by_user_id"
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '2 hours',
        true,
        NOW(),
        'open',
        $4
      )
      RETURNING "id"
    `,
    [guildId, eventTypeId, "Organiser Response Service Test", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const activatedAt = activated ? new Date() : null;

  const responseDeadlineAt = activatedAt
    ? new Date(activatedAt.getTime() + 80 * 60 * 1000)
    : null;

  const assignmentResult = await pool.query<{
    id: number;
  }>(
    `
      INSERT INTO "event_organiser_assignments" (
        "event_id",
        "slot",
        "discord_user_id",
        "display_name_snapshot",
        "status",
        "is_current",
        "assigned_by_user_id",
        "activated_at",
        "response_deadline_at"
      )
      VALUES (
        $1,
        'primary',
        $2,
        'Response Service Organiser',
        $3,
        true,
        $4,
        $5,
        $6
      )
      RETURNING "id"
    `,
    [
      eventId,
      ORGANISER_USER_ID,
      assignmentStatus,
      ADMIN_USER_ID,
      activatedAt,
      responseDeadlineAt,
    ],
  );

  const assignmentId = assignmentResult.rows[0]?.id;

  if (!assignmentId) {
    throw new Error(
      "The integration-test organiser assignment was not created.",
    );
  }

  if (createResponseActions) {
    await pool.query(
      `
        INSERT INTO "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status"
        )
        VALUES
          (
            $1,
            $2,
            NOW() + INTERVAL '1 hour',
            'pending'
          ),
          (
            $1,
            $3,
            $4,
            'pending'
          )
      `,
      [
        eventId,
        `organiser_warning:${assignmentId}`,
        `organiser_timeout:${assignmentId}`,
        responseDeadlineAt,
      ],
    );
  }

  return {
    guildId,

    eventId,

    assignmentId,
  };
}

async function readResponseActions(
  pool: Pool,
  eventId: number,
): Promise<
  {
    action_key: string;
    status: string;
  }[]
> {
  const result = await pool.query<{
    action_key: string;
    status: string;
  }>(
    `
      SELECT
        "action_key",
        "status"
      FROM "scheduled_actions"
      WHERE "event_id" = $1
      ORDER BY "action_key"
    `,
    [eventId],
  );

  return result.rows;
}

async function expectPendingAssignmentUnchanged(
  pool: Pool,
  assignmentId: number,
): Promise<void> {
  const assignmentResult = await pool.query<{
    status: string;
    is_current: boolean;
    responded_at: Date | null;
    ended_at: Date | null;
  }>(
    `
      SELECT
        "status",
        "is_current",
        "responded_at",
        "ended_at"
      FROM "event_organiser_assignments"
      WHERE "id" = $1
    `,
    [assignmentId],
  );

  expect(assignmentResult.rows).toEqual([
    {
      status: "pending",

      is_current: true,

      responded_at: null,

      ended_at: null,
    },
  ]);
}

async function waitForBlockedOrganiserEventLock(pool: Pool): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
      SELECT EXISTS (
        SELECT 1
        FROM "pg_stat_activity"
        WHERE
          "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
          AND "query" ILIKE '%"events"%'
          AND "query" ILIKE '%for update%'
      ) AS "blocked"
    `);

    if (result.rows[0]?.blocked) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    "Timed out waiting for the organiser response service to block on the event lifecycle row.",
  );
}
