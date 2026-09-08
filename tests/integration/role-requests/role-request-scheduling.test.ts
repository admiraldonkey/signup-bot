import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";

import { rescheduleRoleRequestGroupsForEventStart } from "../../../src/role-requests/role-request-scheduling.js";

import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "985000000000000001";

const ADMIN_USER_ID = "985000000000000002";

const POSTED_MESSAGE_ID = "985000000000000003";

const MANUAL_MESSAGE_ID = "985000000000000004";

const OLD_START = new Date("2099-01-05T20:00:00.000Z");

const NEW_START = new Date("2099-01-12T20:00:00.000Z");

const NOW = new Date("2099-01-01T12:00:00.000Z");

type Fixture = {
  eventId: number;

  plannedGroupId: number;

  postedGroupId: number;

  manualGroupId: number;

  closedGroupId: number;
};

describe("role-request group start-time rescheduling", () => {
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

  it("reschedules future planned openings and all active closes without rewriting historical opening state", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    await pool.query(
      `
          UPDATE
            "events"
          SET
            "starts_at" = $1
          WHERE
            "id" = $2
        `,
      [NEW_START, fixture.eventId],
    );

    // Act
    await rescheduleRoleRequestGroupsForEventStart(fixture.eventId, NOW);

    // Assert
    const groups = await pool.query<{
      id: number;

      message_id: string | null;

      open_minutes_before_start: number | null;

      opens_at: Date;

      close_minutes_before_start: number;

      closes_at: Date;

      closed_at: Date | null;
    }>(
      `
            SELECT
              "id",
              "message_id",
              "open_minutes_before_start",
              "opens_at",
              "close_minutes_before_start",
              "closes_at",
              "closed_at"
            FROM
              "role_request_groups"
            WHERE
              "event_id" = $1
            ORDER BY
              "id"
          `,
      [fixture.eventId],
    );

    const planned = groups.rows.find(
      (group) => group.id === fixture.plannedGroupId,
    );

    const posted = groups.rows.find(
      (group) => group.id === fixture.postedGroupId,
    );

    const manual = groups.rows.find(
      (group) => group.id === fixture.manualGroupId,
    );

    const closed = groups.rows.find(
      (group) => group.id === fixture.closedGroupId,
    );

    expect(planned).toMatchObject({
      message_id: null,

      open_minutes_before_start: 60,

      opens_at: new Date(NEW_START.getTime() - 60 * 60_000),

      close_minutes_before_start: -10,

      closes_at: new Date(NEW_START.getTime() + 10 * 60_000),

      closed_at: null,
    });

    /*
     * Once the Discord presentation exists, opensAt describes what
     * actually happened. Moving the event must not rewrite that history
     * or resurrect its completed opening action.
     */
    expect(posted).toMatchObject({
      message_id: POSTED_MESSAGE_ID,

      open_minutes_before_start: 120,

      opens_at: new Date(OLD_START.getTime() - 120 * 60_000),

      close_minutes_before_start: 0,

      closes_at: NEW_START,

      closed_at: null,
    });

    /*
     * Manually-posted groups deliberately have no event-start-relative
     * opening rule.
     */
    expect(manual).toMatchObject({
      message_id: MANUAL_MESSAGE_ID,

      open_minutes_before_start: null,

      opens_at: new Date(OLD_START.getTime() - 15 * 60_000),

      close_minutes_before_start: 30,

      closes_at: new Date(NEW_START.getTime() - 30 * 60_000),

      closed_at: null,
    });

    /*
     * Explicit closure is final for this group lifecycle.
     */
    expect(closed).toMatchObject({
      opens_at: new Date(OLD_START.getTime() - 30 * 60_000),

      closes_at: OLD_START,

      closed_at: expect.any(Date),
    });

    const actions = await pool.query<{
      action_key: string;

      due_at: Date;

      status: string;

      attempt_count: number;

      locked_at: Date | null;

      completed_at: Date | null;

      last_error: string | null;
    }>(
      `
            SELECT
              "action_key",
              "due_at",
              "status",
              "attempt_count",
              "locked_at",
              "completed_at",
              "last_error"
            FROM
              "scheduled_actions"
            WHERE
              "event_id" = $1
            ORDER BY
              "action_key"
          `,
      [fixture.eventId],
    );

    expect(actions.rows).toEqual(
      expect.arrayContaining([
        {
          action_key: `role_request_group_open:${fixture.plannedGroupId}`,

          due_at: new Date(NEW_START.getTime() - 60 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        {
          action_key: `role_request_group_close:${fixture.plannedGroupId}`,

          due_at: new Date(NEW_START.getTime() + 10 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        /*
         * The posted group's opening action remains historical/completed.
         */
        {
          action_key: `role_request_group_open:${fixture.postedGroupId}`,

          due_at: new Date(OLD_START.getTime() - 120 * 60_000),

          status: "completed",

          attempt_count: 1,

          locked_at: null,

          completed_at: expect.any(Date),

          last_error: null,
        },

        {
          action_key: `role_request_group_close:${fixture.postedGroupId}`,

          due_at: NEW_START,

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        {
          action_key: `role_request_group_close:${fixture.manualGroupId}`,

          due_at: new Date(NEW_START.getTime() - 30 * 60_000),

          status: "pending",

          attempt_count: 0,

          locked_at: null,

          completed_at: null,

          last_error: null,
        },

        /*
         * The explicitly closed group's actions remain untouched.
         */
        {
          action_key: `role_request_group_open:${fixture.closedGroupId}`,

          due_at: new Date(OLD_START.getTime() - 30 * 60_000),

          status: "completed",

          attempt_count: 1,

          locked_at: null,

          completed_at: expect.any(Date),

          last_error: null,
        },

        {
          action_key: `role_request_group_close:${fixture.closedGroupId}`,

          due_at: OLD_START,

          status: "completed",

          attempt_count: 1,

          locked_at: null,

          completed_at: expect.any(Date),

          last_error: null,
        },
      ]),
    );

    /*
     * A manual immediate group has no opening action to invent.
     */
    expect(
      actions.rows.some(
        (action) =>
          action.action_key ===
          `role_request_group_open:${fixture.manualGroupId}`,
      ),
    ).toBe(false);
  });

  it("queues newly-past opening and closing actions for immediate scheduler processing while preserving exact resolved timestamps", async () => {
    // Arrange
    const fixture = await createFixture(pool);

    const nearStart = new Date(NOW.getTime() + 10 * 60_000);

    /*
     * With these offsets:
     *
     * open  = T-60 -> 50 minutes ago
     * close = T-30 -> 20 minutes ago
     *
     * The stored group timestamps should retain those exact relationships,
     * while the durable actions become due immediately.
     */
    await pool.query(
      `
          UPDATE
            "role_request_groups"
          SET
            "close_minutes_before_start" = 30
          WHERE
            "id" = $1
        `,
      [fixture.plannedGroupId],
    );

    await pool.query(
      `
          UPDATE
            "events"
          SET
            "starts_at" = $1
          WHERE
            "id" = $2
        `,
      [nearStart, fixture.eventId],
    );

    // Act
    await rescheduleRoleRequestGroupsForEventStart(fixture.eventId, NOW);

    // Assert
    const groupResult = await pool.query<{
      opens_at: Date;

      closes_at: Date;
    }>(
      `
            SELECT
              "opens_at",
              "closes_at"
            FROM
              "role_request_groups"
            WHERE
              "id" = $1
          `,
      [fixture.plannedGroupId],
    );

    expect(groupResult.rows).toEqual([
      {
        opens_at: new Date(nearStart.getTime() - 60 * 60_000),

        closes_at: new Date(nearStart.getTime() - 30 * 60_000),
      },
    ]);

    const actionResult = await pool.query<{
      action_key: string;

      due_at: Date;

      status: string;

      attempt_count: number;
    }>(
      `
            SELECT
              "action_key",
              "due_at",
              "status",
              "attempt_count"
            FROM
              "scheduled_actions"
            WHERE
              "event_id" = $1
              AND
              "action_key" IN (
                $2,
                $3
              )
            ORDER BY
              "action_key"
          `,
      [
        fixture.eventId,

        `role_request_group_open:${fixture.plannedGroupId}`,

        `role_request_group_close:${fixture.plannedGroupId}`,
      ],
    );

    expect(actionResult.rows).toEqual([
      {
        action_key: `role_request_group_close:${fixture.plannedGroupId}`,

        due_at: NOW,

        status: "pending",

        attempt_count: 0,
      },

      {
        action_key: `role_request_group_open:${fixture.plannedGroupId}`,

        due_at: NOW,

        status: "pending",

        attempt_count: 0,
      },
    ]);
  });
});

async function createFixture(pool: Pool): Promise<Fixture> {
  const guildResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "discord_guilds" (
            "discord_guild_id",
            "name"
          )
        VALUES (
          $1,
          'Role Request Scheduling Test Guild'
        )
        RETURNING
          "id"
      `,
    [DISCORD_GUILD_ID],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("The integration-test guild was not created.");
  }

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "event_types" (
            "owner_guild_id",
            "code",
            "name",
            "role_requests_enabled"
          )
        VALUES (
          $1,
          'naval',
          'Naval Event',
          true
        )
        RETURNING
          "id"
      `,
    [guildId],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("The integration-test event type was not created.");
  }

  const eventResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO
          "events" (
            "owner_guild_id",
            "event_type_id",
            "name",
            "starts_at",
            "ends_at",
            "signups_enabled",
            "status",
            "created_by_user_id"
          )
        VALUES (
          $1,
          $2,
          'Role Request Scheduling Test Event',
          $3,
          $4,
          true,
          'scheduled',
          $5
        )
        RETURNING
          "id"
      `,
    [
      guildId,
      eventTypeId,
      OLD_START,
      new Date(OLD_START.getTime() + 60 * 60_000),
      ADMIN_USER_ID,
    ],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const manualOpensAt = new Date(OLD_START.getTime() - 15 * 60_000);

  const closedAt = new Date(OLD_START.getTime() - 5 * 60_000);

  const groups = await pool.query<{
    id: number;

    name: string;
  }>(
    `
        INSERT INTO
          "role_request_groups" (
            "event_id",
            "name",
            "channel_id",
            "message_id",
            "requires_positive_signup",
            "open_minutes_before_start",
            "opens_at",
            "close_minutes_before_start",
            "closes_at",
            "closed_at",
            "created_by_user_id"
          )
        VALUES
          (
            $1,
            'Planned Group',
            '985000000000000010',
            NULL,
            false,
            60,
            $2,
            -10,
            $3,
            NULL,
            $4
          ),
          (
            $1,
            'Posted Group',
            '985000000000000011',
            $5,
            false,
            120,
            $6,
            0,
            $7,
            NULL,
            $4
          ),
          (
            $1,
            'Manual Group',
            '985000000000000012',
            $8,
            false,
            NULL,
            $9,
            30,
            $10,
            NULL,
            $4
          ),
          (
            $1,
            'Closed Group',
            '985000000000000013',
            NULL,
            false,
            30,
            $11,
            0,
            $7,
            $12,
            $4
          )
        RETURNING
          "id",
          "name"
      `,
    [
      eventId,

      new Date(OLD_START.getTime() - 60 * 60_000),

      new Date(OLD_START.getTime() + 10 * 60_000),

      ADMIN_USER_ID,

      POSTED_MESSAGE_ID,

      new Date(OLD_START.getTime() - 120 * 60_000),

      OLD_START,

      MANUAL_MESSAGE_ID,

      manualOpensAt,

      new Date(OLD_START.getTime() - 30 * 60_000),

      new Date(OLD_START.getTime() - 30 * 60_000),

      closedAt,
    ],
  );

  const plannedGroupId = groups.rows.find(
    (group) => group.name === "Planned Group",
  )?.id;

  const postedGroupId = groups.rows.find(
    (group) => group.name === "Posted Group",
  )?.id;

  const manualGroupId = groups.rows.find(
    (group) => group.name === "Manual Group",
  )?.id;

  const closedGroupId = groups.rows.find(
    (group) => group.name === "Closed Group",
  )?.id;

  if (!plannedGroupId || !postedGroupId || !manualGroupId || !closedGroupId) {
    throw new Error(
      "The integration-test role-request groups were not created.",
    );
  }

  await pool.query(
    `
      INSERT INTO
        "scheduled_actions" (
          "event_id",
          "action_key",
          "due_at",
          "status",
          "attempt_count",
          "locked_at",
          "completed_at",
          "last_error"
        )
      VALUES
        (
          $1,
          $2,
          $3,
          'processing',
          3,
          $4,
          NULL,
          'old opening attempt'
        ),
        (
          $1,
          $5,
          $6,
          'processing',
          2,
          $4,
          NULL,
          'old close attempt'
        ),
        (
          $1,
          $7,
          $8,
          'completed',
          1,
          NULL,
          $8,
          NULL
        ),
        (
          $1,
          $9,
          $10,
          'processing',
          2,
          $4,
          NULL,
          'old posted close attempt'
        ),
        (
          $1,
          $11,
          $12,
          'pending',
          1,
          NULL,
          NULL,
          'old manual close attempt'
        ),
        (
          $1,
          $13,
          $14,
          'completed',
          1,
          NULL,
          $14,
          NULL
        ),
        (
          $1,
          $15,
          $10,
          'completed',
          1,
          NULL,
          $10,
          NULL
        )
    `,
    [
      eventId,

      `role_request_group_open:${plannedGroupId}`,

      new Date(OLD_START.getTime() - 60 * 60_000),

      NOW,

      `role_request_group_close:${plannedGroupId}`,

      new Date(OLD_START.getTime() + 10 * 60_000),

      `role_request_group_open:${postedGroupId}`,

      new Date(OLD_START.getTime() - 120 * 60_000),

      `role_request_group_close:${postedGroupId}`,

      OLD_START,

      `role_request_group_close:${manualGroupId}`,

      new Date(OLD_START.getTime() - 30 * 60_000),

      `role_request_group_open:${closedGroupId}`,

      new Date(OLD_START.getTime() - 30 * 60_000),

      `role_request_group_close:${closedGroupId}`,
    ],
  );

  return {
    eventId,

    plannedGroupId,

    postedGroupId,

    manualGroupId,

    closedGroupId,
  };
}
