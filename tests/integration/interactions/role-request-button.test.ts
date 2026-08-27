import type { ButtonInteraction } from "discord.js";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const roleRequestMessageMocks = vi.hoisted(() => ({
  refreshRoleRequestMessages: vi.fn(),
}));

vi.mock(
  "../../../src/role-requests/role-request-message.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/role-requests/role-request-message.js")
      >();

    return {
      ...actual,

      refreshRoleRequestMessages:
        roleRequestMessageMocks.refreshRoleRequestMessages,
    };
  },
);

import { handleRoleRequestButton } from "../../../src/interactions/role-request-button.js";
import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "600000000000000001";

const MEMBER_USER_ID = "600000000000000002";

const ADMIN_USER_ID = "600000000000000003";

const ROLE_REQUEST_CHANNEL_ID = "600000000000000004";

const ROLE_REQUEST_MESSAGE_ID = "600000000000000005";

describe("role-request button interactions", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);

    roleRequestMessageMocks.refreshRoleRequestMessages
      .mockReset()
      .mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  it("does not create a stale role request after the request group closes", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool);

    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Let the handler read the role-request group as open, then stop it
       * precisely when it tries to persist the request.
       */
      await lockClient.query(
        `
          LOCK TABLE "role_requests"
          IN ACCESS EXCLUSIVE MODE
        `,
      );

      interactionPromise = handleRoleRequestButton(interaction);

      await waitForBlockedRoleRequestInsert(pool);

      /*
       * The group closes after the interaction's eligibility read but
       * before its request can be persisted.
       */
      await pool.query(
        `
          UPDATE "role_request_groups"
          SET
            "closed_at" = NOW(),
            "updated_at" = NOW()
          WHERE "id" = $1
        `,
        [fixture.groupId],
      );

      await lockClient.query("COMMIT");

      await interactionPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await interactionPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const groupResult = await pool.query<{
      closed_at: Date | null;
    }>(
      `
          SELECT "closed_at"
          FROM "role_request_groups"
          WHERE "id" = $1
        `,
      [fixture.groupId],
    );

    expect(groupResult.rows[0]?.closed_at).toBeInstanceOf(Date);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
      source_group_id: number | null;
    }>(
      `
          SELECT
            "event_id",
            "discord_user_id",
            "event_role_option_id",
            "source_group_id"
          FROM "role_requests"
          WHERE
            "event_id" = $1
            AND "discord_user_id" = $2
        `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    /*
     * The newer closed-group state owns eligibility. The stale interaction
     * must not create a request based on its earlier open-state snapshot.
     */
    expect.soft(requestResult.rows).toEqual([]);

    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
      .not.toHaveBeenCalled();

    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith(
        "New requests through this role-request group are closed.",
      );
  });

  it("creates a role request normally while the group and event remain eligible", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool);

    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    // Act
    const handled = await handleRoleRequestButton(interaction);

    // Assert
    expect(handled).toBe(true);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
      source_group_id: number | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        SELECT
          "event_id",
          "discord_user_id",
          "event_role_option_id",
          "source_group_id",
          "created_at",
          "updated_at"
        FROM "role_requests"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
          AND "event_role_option_id" = $3
      `,
      [fixture.eventId, MEMBER_USER_ID, fixture.optionId],
    );

    expect(requestResult.rows).toHaveLength(1);

    expect(requestResult.rows[0]).toMatchObject({
      event_id: fixture.eventId,

      discord_user_id: MEMBER_USER_ID,

      event_role_option_id: fixture.optionId,

      source_group_id: fixture.groupId,
    });

    expect(requestResult.rows[0]?.created_at).toBeInstanceOf(Date);

    expect(requestResult.rows[0]?.updated_at).toBeInstanceOf(Date);

    /*
     * A successful write should refresh the role-request presentation and
     * confirm the request to the member.
     */
    expect(
      roleRequestMessageMocks.refreshRoleRequestMessages,
    ).toHaveBeenCalledTimes(1);

    expect(
      roleRequestMessageMocks.refreshRoleRequestMessages,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),
      fixture.eventId,
    );

    expect(interaction.editReply).toHaveBeenLastCalledWith(
      "✅ You are now listed as willing to perform **Captain** for **Role Request Race Test Event**.",
    );
  });

  it.each(["cancelled", "completed"] as const)(
    "does not create a stale role request after the event becomes %s",
    async (terminalStatus) => {
      // Arrange
      const fixture = await createOpenRoleRequestGroup(pool);

      const interaction = createRoleRequestButtonInteraction(
        fixture.groupId,
        fixture.optionId,
      );

      const lockClient = await pool.connect();

      let interactionPromise: Promise<boolean> | undefined;

      try {
        await lockClient.query("BEGIN");

        /*
         * Let the handler complete its initial eligibility reads while the
         * event is active, then stop the authoritative role-request write.
         */
        await lockClient.query(
          `
          LOCK TABLE "role_requests"
          IN ACCESS EXCLUSIVE MODE
        `,
        );

        interactionPromise = handleRoleRequestButton(interaction);

        await waitForBlockedRoleRequestInsert(pool);

        /*
         * A newer terminal lifecycle transition wins after the handler's
         * initial read but before its request can be persisted.
         */
        await pool.query(
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

        await interactionPromise;
      } catch (error) {
        await lockClient.query("ROLLBACK").catch(() => undefined);

        await interactionPromise?.catch(() => undefined);

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

      const requestResult = await pool.query<{
        event_id: number;
        discord_user_id: string;
        event_role_option_id: number;
      }>(
        `
          SELECT
            "event_id",
            "discord_user_id",
            "event_role_option_id"
          FROM "role_requests"
          WHERE
            "event_id" = $1
            AND "discord_user_id" = $2
        `,
        [fixture.eventId, MEMBER_USER_ID],
      );

      /*
       * Cancellation/completion committed before the authoritative write.
       * A role request based on the handler's stale active-event snapshot
       * must therefore not be persisted.
       */
      expect.soft(requestResult.rows).toEqual([]);

      expect
        .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
        .not.toHaveBeenCalled();

      expect
        .soft(interaction.editReply)
        .toHaveBeenLastCalledWith(
          "This event is no longer accepting role requests.",
        );
    },
  );

  it("does not create a role request when positive-signup eligibility is lost before persistence", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool, {
      requiresPositiveSignup: true,
    });

    /*
     * The member is eligible when the interaction begins.
     */
    await pool.query(
      `
      INSERT INTO "attendance_responses" (
        "event_id",
        "discord_user_id",
        "source_guild_id",
        "status"
      )
      VALUES (
        $1,
        $2,
        $3,
        'attending'
      )
    `,
      [fixture.eventId, MEMBER_USER_ID, fixture.guildDatabaseId],
    );

    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Let the handler:
       *
       * - read the group as open;
       * - read the member as Attending;
       * - pass the positive-signup check;
       *
       * then stop it at the authoritative role-request write.
       */
      await lockClient.query(
        `
        LOCK TABLE "role_requests"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      interactionPromise = handleRoleRequestButton(interaction);

      await waitForBlockedRoleRequestInsert(pool);

      /*
       * The member loses positive-signup eligibility after the handler's
       * initial read but before its role request is persisted.
       */
      await pool.query(
        `
        UPDATE "attendance_responses"
        SET
          "status" =
            'not_attending',
          "updated_at" =
            NOW()
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
        [fixture.eventId, MEMBER_USER_ID],
      );

      await lockClient.query("COMMIT");

      await interactionPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await interactionPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const attendanceResult = await pool.query<{
      status: string;
    }>(
      `
        SELECT "status"
        FROM "attendance_responses"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    expect(attendanceResult.rows).toEqual([
      {
        status: "not_attending",
      },
    ]);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
    }>(
      `
        SELECT
          "event_id",
          "discord_user_id",
          "event_role_option_id"
        FROM "role_requests"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    /*
     * Positive signup was lost before persistence. The stale request must
     * therefore not survive merely because the earlier eligibility read
     * observed Attending.
     */
    expect.soft(requestResult.rows).toEqual([]);

    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
      .not.toHaveBeenCalled();

    /*
     * The guarded write currently uses a generic fallback when an
     * attendance-based eligibility rule changes after the initial read.
     *
     * Most importantly, it must not return the normal success confirmation.
     */
    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith("This role request is no longer available.");
  });

  it("creates a role request for a tentative member when positive signup is required", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool, {
      requiresPositiveSignup: true,
    });

    await pool.query(
      `
      INSERT INTO "attendance_responses" (
        "event_id",
        "discord_user_id",
        "source_guild_id",
        "status"
      )
      VALUES (
        $1,
        $2,
        $3,
        'tentative'
      )
    `,
      [fixture.eventId, MEMBER_USER_ID, fixture.guildDatabaseId],
    );

    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    // Act
    const handled = await handleRoleRequestButton(interaction);

    // Assert
    expect(handled).toBe(true);

    const attendanceResult = await pool.query<{
      status: string;
    }>(
      `
        SELECT "status"
        FROM "attendance_responses"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    expect(attendanceResult.rows).toEqual([
      {
        status: "tentative",
      },
    ]);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
      source_group_id: number | null;
    }>(
      `
        SELECT
          "event_id",
          "discord_user_id",
          "event_role_option_id",
          "source_group_id"
        FROM "role_requests"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
          AND "event_role_option_id" = $3
      `,
      [fixture.eventId, MEMBER_USER_ID, fixture.optionId],
    );

    expect(requestResult.rows).toEqual([
      {
        event_id: fixture.eventId,

        discord_user_id: MEMBER_USER_ID,

        event_role_option_id: fixture.optionId,

        source_group_id: fixture.groupId,
      },
    ]);

    expect(
      roleRequestMessageMocks.refreshRoleRequestMessages,
    ).toHaveBeenCalledTimes(1);

    expect(
      roleRequestMessageMocks.refreshRoleRequestMessages,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DISCORD_GUILD_ID,
      }),
      fixture.eventId,
    );

    expect(interaction.editReply).toHaveBeenLastCalledWith(
      "✅ You are now listed as willing to perform **Captain** for **Role Request Race Test Event**.",
    );
  });

  it("does not create a role request when the member becomes not attending before persistence", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool);

    /*
     * This group does not require a positive signup, and the member initially
     * has no attendance response. They are therefore eligible when the
     * interaction begins.
     */
    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Allow the handler to:
       *
       * - read the group/event as eligible;
       * - find no attendance response;
       * - pass the initial role-request checks;
       *
       * then stop it at the authoritative persistence statement.
       */
      await lockClient.query(
        `
        LOCK TABLE "role_requests"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      interactionPromise = handleRoleRequestButton(interaction);

      await waitForBlockedRoleRequestInsert(pool);

      /*
       * The member explicitly changes to Not attending after the handler's
       * initial eligibility read but before the role request is persisted.
       */
      await pool.query(
        `
        INSERT INTO "attendance_responses" (
          "event_id",
          "discord_user_id",
          "source_guild_id",
          "status"
        )
        VALUES (
          $1,
          $2,
          $3,
          'not_attending'
        )
      `,
        [fixture.eventId, MEMBER_USER_ID, fixture.guildDatabaseId],
      );

      await lockClient.query("COMMIT");

      await interactionPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await interactionPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const attendanceResult = await pool.query<{
      status: string;
    }>(
      `
        SELECT "status"
        FROM "attendance_responses"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    expect(attendanceResult.rows).toEqual([
      {
        status: "not_attending",
      },
    ]);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
    }>(
      `
        SELECT
          "event_id",
          "discord_user_id",
          "event_role_option_id"
        FROM "role_requests"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    /*
     * A group which does not require positive signup may accept someone with
     * no response, but an explicit Not attending response is different.
     *
     * Once that newer state exists, the stale role-request interaction must
     * not create a request.
     */
    expect.soft(requestResult.rows).toEqual([]);

    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
      .not.toHaveBeenCalled();

    /*
     * The attendance state changed after the handler's specific early
     * checks, so the guarded-write fallback is currently generic.
     */
    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith("This role request is no longer available.");
  });

  it("does not create a role request when the role option becomes inactive before persistence", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool);

    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * The handler initially sees an active role option and passes its
       * ordinary eligibility checks. Stop it at the authoritative database
       * write before the request can be persisted.
       */
      await lockClient.query(
        `
        LOCK TABLE "role_requests"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      interactionPromise = handleRoleRequestButton(interaction);

      await waitForBlockedRoleRequestInsert(pool);

      /*
       * An administrator disables the option after the handler's initial
       * read but before persistence.
       */
      await pool.query(
        `
        UPDATE "event_role_options"
        SET
          "active" = false,
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
        [fixture.optionId],
      );

      await lockClient.query("COMMIT");

      await interactionPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await interactionPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const optionResult = await pool.query<{
      active: boolean;
    }>(
      `
        SELECT "active"
        FROM "event_role_options"
        WHERE "id" = $1
      `,
      [fixture.optionId],
    );

    expect(optionResult.rows).toEqual([
      {
        active: false,
      },
    ]);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
    }>(
      `
        SELECT
          "event_id",
          "discord_user_id",
          "event_role_option_id"
        FROM "role_requests"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    /*
     * The active option observed during the initial read is stale. The
     * authoritative guarded write must honour the newer inactive state.
     */
    expect.soft(requestResult.rows).toEqual([]);

    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
      .not.toHaveBeenCalled();

    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith("This role request is no longer available.");
  });

  it("does not create a role request when the request restriction changes before persistence", async () => {
    // Arrange
    const fixture = await createOpenRoleRequestGroup(pool);

    /*
     * The fixture starts with request_restriction = open.
     *
     * The test member deliberately holds no qualification roles, so they
     * would not satisfy qualified_only if that rule had existed when the
     * interaction began.
     */
    const interaction = createRoleRequestButtonInteraction(
      fixture.groupId,
      fixture.optionId,
    );

    const lockClient = await pool.connect();

    let interactionPromise: Promise<boolean> | undefined;

    try {
      await lockClient.query("BEGIN");

      /*
       * Allow the handler to read request_restriction = open and pass the
       * initial checks, then stop it at the authoritative role-request write.
       */
      await lockClient.query(
        `
        LOCK TABLE "role_requests"
        IN ACCESS EXCLUSIVE MODE
      `,
      );

      interactionPromise = handleRoleRequestButton(interaction);

      await waitForBlockedRoleRequestInsert(pool);

      /*
       * An administrator tightens the option from open to qualified_only
       * after the interaction's original rule evaluation.
       */
      await pool.query(
        `
        UPDATE "event_role_options"
        SET
          "request_restriction" =
            'qualified_only',
          "updated_at" =
            NOW()
        WHERE "id" = $1
      `,
        [fixture.optionId],
      );

      await lockClient.query("COMMIT");

      await interactionPromise;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);

      await interactionPromise?.catch(() => undefined);

      throw error;
    } finally {
      lockClient.release();
    }

    // Assert
    const optionResult = await pool.query<{
      request_restriction: string;
      active: boolean;
    }>(
      `
        SELECT
          "request_restriction",
          "active"
        FROM "event_role_options"
        WHERE "id" = $1
      `,
      [fixture.optionId],
    );

    expect(optionResult.rows).toEqual([
      {
        request_restriction: "qualified_only",
        active: true,
      },
    ]);

    const requestResult = await pool.query<{
      event_id: number;
      discord_user_id: string;
      event_role_option_id: number;
    }>(
      `
        SELECT
          "event_id",
          "discord_user_id",
          "event_role_option_id"
        FROM "role_requests"
        WHERE
          "event_id" = $1
          AND "discord_user_id" = $2
      `,
      [fixture.eventId, MEMBER_USER_ID],
    );

    /*
     * The handler evaluated the old open rule. Once the persisted rule
     * changes, that stale evaluation no longer authorises the request.
     */
    expect.soft(requestResult.rows).toEqual([]);

    expect
      .soft(roleRequestMessageMocks.refreshRoleRequestMessages)
      .not.toHaveBeenCalled();

    /*
     * The explanatory re-read sees an active option, but the guarded write
     * rejected it because another eligibility/configuration rule changed.
     */
    expect
      .soft(interaction.editReply)
      .toHaveBeenLastCalledWith("This role request is no longer available.");
  });
});

async function createOpenRoleRequestGroup(
  pool: Pool,
  options: {
    requiresPositiveSignup?: boolean;
  } = {},
): Promise<{
  eventId: number;
  groupId: number;
  optionId: number;
  guildDatabaseId: number;
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
    [DISCORD_GUILD_ID, "Role Request Interaction Test Guild"],
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
    [guildId, eventTypeId, "Role Request Race Test Event", ADMIN_USER_ID],
  );

  const eventId = eventResult.rows[0]?.id;

  if (!eventId) {
    throw new Error("The integration-test event was not created.");
  }

  const optionResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_role_options" (
          "event_id",
          "key",
          "display_name",
          "request_restriction",
          "active"
        )
        VALUES (
          $1,
          'captain',
          'Captain',
          'open',
          true
        )
        RETURNING "id"
      `,
    [eventId],
  );

  const optionId = optionResult.rows[0]?.id;

  if (!optionId) {
    throw new Error("The integration-test role option was not created.");
  }

  const groupResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "role_request_groups" (
          "event_id",
          "name",
          "channel_id",
          "message_id",
          "requires_positive_signup",
          "opens_at",
          "closes_at",
          "created_by_user_id"
        )
VALUES (
  $1,
  'General Role Requests',
  $2,
  $3,
  $4,
  NOW() - INTERVAL '1 hour',
  NOW() + INTERVAL '1 hour',
  $5
)
        RETURNING "id"
      `,
    [
      eventId,
      ROLE_REQUEST_CHANNEL_ID,
      ROLE_REQUEST_MESSAGE_ID,
      options.requiresPositiveSignup ?? false,
      ADMIN_USER_ID,
    ],
  );

  const groupId = groupResult.rows[0]?.id;

  if (!groupId) {
    throw new Error("The integration-test role-request group was not created.");
  }

  await pool.query(
    `
      INSERT INTO "role_request_group_options" (
        "group_id",
        "event_role_option_id",
        "sort_order"
      )
      VALUES ($1, $2, 0)
    `,
    [groupId, optionId],
  );

  return {
    eventId,
    groupId,
    optionId,
    guildDatabaseId: guildId,
  };
}

function createRoleRequestButtonInteraction(
  groupId: number,
  optionId: number,
): ButtonInteraction {
  const interaction = {
    customId: `role-request:add:${groupId}:${optionId}`,

    deferReply: vi.fn().mockResolvedValue(undefined),

    editReply: vi.fn().mockResolvedValue(undefined),

    inCachedGuild: () => true,

    guildId: DISCORD_GUILD_ID,

    channelId: ROLE_REQUEST_CHANNEL_ID,

    message: {
      id: ROLE_REQUEST_MESSAGE_ID,
    },

    user: {
      id: MEMBER_USER_ID,
    },

    guild: {
      id: DISCORD_GUILD_ID,
    },

    member: {
      roles: {
        cache: {
          has: vi.fn().mockReturnValue(false),
        },
      },
    },
  };

  return interaction as unknown as ButtonInteraction;
}

async function waitForBlockedRoleRequestInsert(pool: Pool): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(`
        SELECT EXISTS (
          SELECT 1
          FROM "pg_locks" AS "waiting_lock"

          INNER JOIN "pg_stat_activity"
            AS "activity"
            ON
              "activity"."pid" =
                "waiting_lock"."pid"

          WHERE
            "activity"."datname" =
              current_database()

            /*
             * The interaction is attempting to acquire a relation lock on
             * role_requests, but our test's ACCESS EXCLUSIVE lock currently
             * prevents it.
             *
             * Detect the actual PostgreSQL locking condition rather than
             * depending on how the driver's SQL happens to appear in
             * pg_stat_activity.query.
             */
            AND "waiting_lock"."locktype" =
              'relation'

            AND "waiting_lock"."relation" =
              'role_requests'::regclass

            AND "waiting_lock"."granted" =
              false
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
    "Timed out waiting for the role-request interaction to block on the role_requests table.",
  );
}
