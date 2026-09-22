import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import {
  createEventTemplate,
  editEventTemplate,
  getEventTemplate,
  listEventTemplates,
  setEventTemplateActive,
  type CreateEventTemplateInput,
} from "../../../src/templates/event-template-admin-service.js";
import { generateEventFromTemplate } from "../../../src/templates/event-template-generation-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "990000000000000001";

const OTHER_DISCORD_GUILD_ID = "990000000000000002";

const ADMIN_USER_ID = "990000000000000003";

const PUBLICATION_CHANNEL_ID = "990000000000000004";

const PING_ROLE_ID = "990000000000000005";

const PRIMARY_ORGANISER_ID = "990000000000000006";

const REMINDER_CHANNEL_ID = "990000000000000007";

describe("event template administration service", () => {
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

  it("creates a normalised reusable template from valid guild-owned source records", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    // Act
    const result = await createEventTemplate({
      guildDatabaseId: fixture.guildId,

      eventTypeId: fixture.eventTypeId,

      audienceId: fixture.audienceId,

      roleRequestPresetId: fixture.presetId,

      name: "  Sunday Naval  ",

      description: "  Reusable naval event.  ",

      timezone: "Europe/London",

      localStartTime: "19:00",

      durationMinutes: 90,

      signupsEnabled: true,

      attendanceCloseMinutesBefore: 60,

      showDetailedDeadline: true,

      publicationMode: "scheduled",

      publishMinutesBeforeStart: 180,

      publicationChannelId: `  ${PUBLICATION_CHANNEL_ID}  `,

      createdByUserId: ADMIN_USER_ID,
    });

    // Assert
    expect(result.kind).toBe("created");

    if (result.kind !== "created") {
      throw new Error(
        `Expected template creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.template).toMatchObject({
      ownerGuildId: fixture.guildId,

      eventTypeId: fixture.eventTypeId,

      audienceId: fixture.audienceId,

      roleRequestPresetId: fixture.presetId,

      name: "Sunday Naval",

      description: "Reusable naval event.",

      timezone: "Europe/London",

      localStartTime: "19:00",

      durationMinutes: 90,

      signupsEnabled: true,

      attendanceCloseMinutesBefore: 60,

      showDetailedDeadline: true,

      publicationMode: "scheduled",

      publishMinutesBeforeStart: 180,

      publicationChannelId: PUBLICATION_CHANNEL_ID,

      active: true,

      createdByUserId: ADMIN_USER_ID,

      createdAt: expect.any(Date),

      updatedAt: expect.any(Date),
    });

    const stored = await pool.query<{
      name: string;

      description: string | null;

      publication_channel_id: string | null;

      active: boolean;
    }>(
      `
        SELECT
          "name",
          "description",
          "publication_channel_id",
          "active"
        FROM "event_templates"
        WHERE "id" = $1
      `,
      [result.template.id],
    );

    expect(stored.rows).toEqual([
      {
        name: "Sunday Naval",

        description: "Reusable naval event.",

        publication_channel_id: PUBLICATION_CHANNEL_ID,

        active: true,
      },
    ]);
  });

  it("rejects invalid parent configuration before creating a template", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    // Act / Assert: invalid local time
    expect(
      await createEventTemplate({
        ...buildCreateInput(fixture),

        localStartTime: "25:00",
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_local_start_time",
    });

    // Act / Assert: publication would occur at or after signup close
    expect(
      await createEventTemplate({
        ...buildCreateInput(fixture),

        publicationMode: "scheduled",

        publishMinutesBeforeStart: 60,

        attendanceCloseMinutesBefore: 60,
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "publication_not_before_signup_close",
    });

    const storedCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_templates"
      `,
    );

    expect(storedCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("rejects cross-guild event type, audience and preset references", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const foreignFixture = await createSourceFixture(
      pool,
      OTHER_DISCORD_GUILD_ID,
      "foreign",
    );

    // Act / Assert: event type
    expect(
      await createEventTemplate({
        ...buildCreateInput(fixture),

        eventTypeId: foreignFixture.eventTypeId,

        roleRequestPresetId: null,
      }),
    ).toEqual({
      kind: "event_type_unavailable",
    });

    // Act / Assert: audience
    expect(
      await createEventTemplate({
        ...buildCreateInput(fixture),

        audienceId: foreignFixture.audienceId,

        roleRequestPresetId: null,
      }),
    ).toEqual({
      kind: "audience_unavailable",
    });

    // Act / Assert: preset
    expect(
      await createEventTemplate({
        ...buildCreateInput(fixture),

        roleRequestPresetId: foreignFixture.presetId,
      }),
    ).toEqual({
      kind: "preset_unavailable",
    });

    const storedCount = await pool.query<{
      count: number;
    }>(
      `
        SELECT COUNT(*)::int AS "count"
        FROM "event_templates"
      `,
    );

    expect(storedCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("edits core configuration with omitted-preserve and explicit-clear semantics", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Act
    const result = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      name: "  Updated Sunday Naval  ",

      description: null,

      audienceId: null,

      roleRequestPresetId: null,

      localStartTime: null,

      durationMinutes: 75,

      publicationMode: "manual",

      publishMinutesBeforeStart: null,

      publicationChannelId: null,
    });

    // Assert
    expect(result.kind).toBe("updated");

    if (result.kind !== "updated") {
      throw new Error(
        `Expected template edit to succeed, received "${result.kind}".`,
      );
    }

    expect(result.template).toMatchObject({
      id: created.template.id,

      ownerGuildId: fixture.guildId,

      /*
       * Omitted fields remain unchanged.
       */
      eventTypeId: fixture.eventTypeId,

      timezone: "Europe/London",

      signupsEnabled: true,

      attendanceCloseMinutesBefore: 60,

      showDetailedDeadline: false,

      /*
       * Explicit values and clears are applied.
       */
      audienceId: null,

      roleRequestPresetId: null,

      name: "Updated Sunday Naval",

      description: null,

      localStartTime: null,

      durationMinutes: 75,

      publicationMode: "manual",

      publishMinutesBeforeStart: null,

      publicationChannelId: null,

      active: true,
    });

    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        name: "Updated Sunday Naval",
      }),
    ).toMatchObject({
      kind: "unchanged",
    });

    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "no_changes_requested",
    });
  });

  it("rejects cross-guild source changes without modifying the template", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const foreignFixture = await createSourceFixture(
      pool,
      OTHER_DISCORD_GUILD_ID,
      "foreign",
    );

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Act / Assert: event type
    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        eventTypeId: foreignFixture.eventTypeId,
      }),
    ).toEqual({
      kind: "event_type_unavailable",
    });

    // Act / Assert: audience
    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        audienceId: foreignFixture.audienceId,
      }),
    ).toEqual({
      kind: "audience_unavailable",
    });

    // Act / Assert: preset
    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        roleRequestPresetId: foreignFixture.presetId,
      }),
    ).toEqual({
      kind: "preset_unavailable",
    });

    const stored = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(stored.kind).toBe("found");

    if (stored.kind !== "found") {
      throw new Error("Expected the original template to remain readable.");
    }

    expect(stored.template).toMatchObject({
      eventTypeId: fixture.eventTypeId,

      audienceId: fixture.audienceId,

      roleRequestPresetId: fixture.presetId,
    });
  });

  it("allows unrelated edits when existing referenced sources were later deactivated", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    await pool.query(
      `
        UPDATE "event_types"
        SET "active" = false
        WHERE "id" = $1
      `,
      [fixture.eventTypeId],
    );

    await pool.query(
      `
        UPDATE "event_audiences"
        SET "active" = false
        WHERE "id" = $1
      `,
      [fixture.audienceId],
    );

    await pool.query(
      `
        UPDATE "role_request_presets"
        SET "active" = false
        WHERE "id" = $1
      `,
      [fixture.presetId],
    );

    // Act
    const result = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      name: "Renamed While Sources Are Inactive",
    });

    // Assert
    expect(result.kind).toBe("updated");

    if (result.kind !== "updated") {
      throw new Error(
        `Expected unrelated edit to remain possible, received "${result.kind}".`,
      );
    }

    expect(result.template.name).toBe("Renamed While Sources Are Inactive");

    /*
     * Explicitly re-selecting one of those inactive sources is a real source
     * mutation and must still be rejected.
     */
    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        audienceId: fixture.audienceId,
      }),
    ).toEqual({
      kind: "audience_unavailable",
    });
  });

  it("prevents a retained preset from being paired with an event type that disables role requests", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const disabledTypeResult = await pool.query<{
      id: number;
    }>(
      `
          INSERT INTO "event_types" (
            "owner_guild_id",
            "code",
            "name",
            "role_requests_enabled",
            "active"
          )
          VALUES (
            $1,
            'no_roles',
            'No Role Requests',
            false,
            true
          )
          RETURNING "id"
        `,
      [fixture.guildId],
    );

    const disabledTypeId = requireReturnedId(
      disabledTypeResult.rows[0]?.id,

      "role-request-disabled event type",
    );

    // Act / Assert
    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        eventTypeId: disabledTypeId,
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "preset_requires_role_requests",
    });

    /*
     * Explicitly clearing the preset in the same edit makes the new event
     * type valid.
     */
    const cleared = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      eventTypeId: disabledTypeId,

      roleRequestPresetId: null,
    });

    expect(cleared.kind).toBe("updated");

    if (cleared.kind !== "updated") {
      throw new Error(
        `Expected preset-clearing edit to succeed, received "${cleared.kind}".`,
      );
    }

    expect(cleared.template).toMatchObject({
      eventTypeId: disabledTypeId,

      roleRequestPresetId: null,
    });
  });

  it("lists only the owning guild's templates and includes inactive templates", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const foreignFixture = await createSourceFixture(
      pool,
      OTHER_DISCORD_GUILD_ID,
      "foreign",
    );

    const beta = await createEventTemplate({
      ...buildCreateInput(fixture),

      name: "Beta Template",

      roleRequestPresetId: null,
    });

    const alpha = await createEventTemplate({
      ...buildCreateInput(fixture),

      name: "Alpha Template",

      roleRequestPresetId: null,
    });

    const foreign = await createEventTemplate({
      ...buildCreateInput(foreignFixture),

      name: "Foreign Template",

      roleRequestPresetId: null,
    });

    if (
      beta.kind !== "created" ||
      alpha.kind !== "created" ||
      foreign.kind !== "created"
    ) {
      throw new Error("Expected list fixtures to be created.");
    }

    await setEventTemplateActive({
      guildDatabaseId: fixture.guildId,

      templateId: beta.template.id,

      active: false,
    });

    // Act
    const templates = await listEventTemplates(fixture.guildId);

    // Assert
    expect(
      templates.map((template) => ({
        id: template.id,

        name: template.name,

        active: template.active,
      })),
    ).toEqual([
      {
        id: alpha.template.id,

        name: "Alpha Template",

        active: true,
      },
      {
        id: beta.template.id,

        name: "Beta Template",

        active: false,
      },
    ]);
  });

  it("shows the complete source graph even while the template is inactive", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate({
      ...buildCreateInput(fixture),

      roleRequestPresetId: null,
    });

    if (created.kind !== "created") {
      throw new Error(
        `Expected template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    await pool.query(
      `
        INSERT INTO "event_template_ping_roles" (
          "template_id",
          "discord_role_id",
          "role_name_snapshot",
          "sort_order"
        )
        VALUES ($1, $2, 'Naval', 10)
      `,
      [created.template.id, PING_ROLE_ID],
    );

    await pool.query(
      `
        INSERT INTO "event_template_organiser_defaults" (
          "template_id",
          "slot",
          "discord_user_id",
          "display_name_snapshot"
        )
        VALUES (
          $1,
          'primary',
          $2,
          'Primary Organiser'
        )
      `,
      [created.template.id, PRIMARY_ORGANISER_ID],
    );

    await pool.query(
      `
        INSERT INTO "event_template_reminders" (
          "template_id",
          "timing_reference",
          "minutes_before",
          "message",
          "channel_id",
          "ping_event_roles"
        )
        VALUES (
          $1,
          'event_start',
          30,
          'Event starts soon.',
          $2,
          true
        )
      `,
      [created.template.id, REMINDER_CHANNEL_ID],
    );

    const lifecycle = await setEventTemplateActive({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      active: false,
    });

    expect(lifecycle.kind).toBe("updated");

    // Act
    const result = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    // Assert
    expect(result.kind).toBe("found");

    if (result.kind !== "found") {
      throw new Error(
        `Expected template inspection to succeed, received "${result.kind}".`,
      );
    }

    expect(result.template.active).toBe(false);

    expect(result.template.pingRoles).toEqual([
      {
        discordRoleId: PING_ROLE_ID,

        roleNameSnapshot: "Naval",

        sortOrder: 10,
      },
    ]);

    expect(result.template.organiserDefaults).toEqual([
      {
        slot: "primary",

        discordUserId: PRIMARY_ORGANISER_ID,

        displayNameSnapshot: "Primary Organiser",
      },
    ]);

    expect(result.template.reminders).toEqual([
      {
        id: expect.any(Number),

        timingReference: "event_start",

        minutesBefore: 30,

        message: "Event starts soon.",

        channelId: REMINDER_CHANNEL_ID,

        pingEventRoles: true,
      },
    ]);

    /*
     * Guild ownership applies to inspection too.
     */
    expect(
      await getEventTemplate({
        guildDatabaseId: fixture.guildId + 99_999,

        templateId: created.template.id,
      }),
    ).toEqual({
      kind: "template_not_found",
    });
  });

  it("deactivation is idempotent, blocks future generation and preserves existing generated events", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate({
      ...buildCreateInput(fixture),

      audienceId: null,

      roleRequestPresetId: null,

      publicationMode: "manual",

      publishMinutesBeforeStart: null,

      publicationChannelId: PUBLICATION_CHANNEL_ID,
    });

    if (created.kind !== "created") {
      throw new Error(
        `Expected lifecycle fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const firstGeneration = await generateEventFromTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      startsAt: futureStart(),

      generatedByUserId: ADMIN_USER_ID,
    });

    expect(firstGeneration.kind).toBe("generated");

    if (firstGeneration.kind !== "generated") {
      throw new Error(
        `Expected first generation to succeed, received "${firstGeneration.kind}".`,
      );
    }

    // Act
    const deactivated = await setEventTemplateActive({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      active: false,
    });

    // Assert
    expect(deactivated).toEqual({
      kind: "updated",

      template: {
        id: created.template.id,

        name: created.template.name,

        active: false,
      },
    });

    expect(
      await setEventTemplateActive({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        active: false,
      }),
    ).toEqual({
      kind: "unchanged",

      template: {
        id: created.template.id,

        name: created.template.name,

        active: false,
      },
    });

    expect(
      await generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        startsAt: futureStart(),

        generatedByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "template_inactive",
    });

    const originalEvent = await pool.query<{
      template_id: number | null;

      status: string;
    }>(
      `
          SELECT
            "template_id",
            "status"
          FROM "events"
          WHERE "id" = $1
        `,
      [firstGeneration.event.id],
    );

    expect(originalEvent.rows).toEqual([
      {
        template_id: created.template.id,

        status: "scheduled",
      },
    ]);
  });

  it("serialises lifecycle mutation behind an in-flight generation snapshot", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate({
      ...buildCreateInput(fixture),

      audienceId: null,

      roleRequestPresetId: null,

      publicationMode: "manual",

      publishMinutesBeforeStart: null,

      publicationChannelId: PUBLICATION_CHANNEL_ID,
    });

    if (created.kind !== "created") {
      throw new Error(
        `Expected concurrency fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const blockerClient = await pool.connect();

    let blockerTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let lifecyclePromise: ReturnType<typeof setEventTemplateActive> | null =
      null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

      /*
       * Generation takes FOR SHARE on the template before reading the event
       * type. Blocking event_types therefore pauses it while the shared parent
       * lock is already held.
       */
      await blockerClient.query(`
        LOCK TABLE "event_types"
        IN ACCESS EXCLUSIVE MODE
      `);

      generationPromise = generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        startsAt: futureStart(),

        generatedByUserId: ADMIN_USER_ID,
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_types"%',
      );

      let lifecycleResolved = false;

      lifecyclePromise = setEventTemplateActive({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        active: false,
      }).then((result) => {
        lifecycleResolved = true;

        return result;
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_templates"%for update%',
      );

      expect(lifecycleResolved).toBe(false);

      /*
       * Generation acquired the shared source lock first, so it must complete
       * using the pre-deactivation state. Lifecycle mutation can proceed only
       * after that generation commits.
       */
      await blockerClient.query("COMMIT");

      blockerTransactionOpen = false;

      const generationResult = await generationPromise;

      const lifecycleResult = await lifecyclePromise;

      expect(generationResult.kind).toBe("generated");

      expect(lifecycleResult).toEqual({
        kind: "updated",

        template: {
          id: created.template.id,

          name: created.template.name,

          active: false,
        },
      });

      expect(
        await generateEventFromTemplate({
          guildDatabaseId: fixture.guildId,

          templateId: created.template.id,

          startsAt: futureStart(),

          generatedByUserId: ADMIN_USER_ID,
        }),
      ).toEqual({
        kind: "template_inactive",
      });
    } finally {
      if (blockerTransactionOpen) {
        await blockerClient.query("ROLLBACK").catch(() => undefined);
      }

      const pendingOperations: Promise<unknown>[] = [];

      if (generationPromise) {
        pendingOperations.push(generationPromise);
      }

      if (lifecyclePromise) {
        pendingOperations.push(lifecyclePromise);
      }

      await Promise.allSettled(pendingOperations);

      blockerClient.release();
    }
  });

  it("serialises core editing behind an in-flight generation snapshot", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate({
      ...buildCreateInput(fixture),

      audienceId: null,

      roleRequestPresetId: null,

      publicationMode: "manual",

      publishMinutesBeforeStart: null,
    });

    if (created.kind !== "created") {
      throw new Error(
        `Expected edit-concurrency fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const blockerClient = await pool.connect();

    let blockerTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let editPromise: ReturnType<typeof editEventTemplate> | null = null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

      /*
       * Generation locks the template FOR SHARE before it reaches event_types.
       * Pause it there so the edit attempts FOR UPDATE while generation's
       * shared template lock is definitely still held.
       */
      await blockerClient.query(`
        LOCK TABLE "event_types"
        IN ACCESS EXCLUSIVE MODE
      `);

      generationPromise = generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        startsAt: futureStart(),

        generatedByUserId: ADMIN_USER_ID,
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_types"%',
      );

      let editResolved = false;

      editPromise = editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        name: "Edited After Generation",
      }).then((result) => {
        editResolved = true;

        return result;
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_templates"%for update%',
      );

      expect(editResolved).toBe(false);

      await blockerClient.query("COMMIT");

      blockerTransactionOpen = false;

      const generationResult = await generationPromise;

      const editResult = await editPromise;

      expect(generationResult.kind).toBe("generated");

      if (generationResult.kind !== "generated") {
        throw new Error(
          `Expected in-flight generation to succeed, received "${generationResult.kind}".`,
        );
      }

      expect(editResult.kind).toBe("updated");

      /*
       * Generation acquired the shared source lock first, so this occurrence
       * owns the old snapshot.
       */
      const firstEvent = await pool.query<{
        name: string;
      }>(
        `
            SELECT "name"
            FROM "events"
            WHERE "id" = $1
          `,
        [generationResult.event.id],
      );

      expect(firstEvent.rows).toEqual([
        {
          name: "Sunday Naval",
        },
      ]);

      /*
       * A later occurrence sees the newly committed template source.
       */
      const secondGeneration = await generateEventFromTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        startsAt: new Date(futureStart().getTime() + 60 * 60_000),

        generatedByUserId: ADMIN_USER_ID,
      });

      expect(secondGeneration.kind).toBe("generated");

      if (secondGeneration.kind !== "generated") {
        throw new Error(
          `Expected later generation to succeed, received "${secondGeneration.kind}".`,
        );
      }

      const secondEvent = await pool.query<{
        name: string;
      }>(
        `
            SELECT "name"
            FROM "events"
            WHERE "id" = $1
          `,
        [secondGeneration.event.id],
      );

      expect(secondEvent.rows).toEqual([
        {
          name: "Edited After Generation",
        },
      ]);
    } finally {
      if (blockerTransactionOpen) {
        await blockerClient.query("ROLLBACK").catch(() => undefined);
      }

      const pendingOperations: Promise<unknown>[] = [];

      if (generationPromise) {
        pendingOperations.push(generationPromise);
      }

      if (editPromise) {
        pendingOperations.push(editPromise);
      }

      await Promise.allSettled(pendingOperations);

      blockerClient.release();
    }
  });
});

type SourceFixture = {
  guildId: number;

  eventTypeId: number;

  audienceId: number;

  presetId: number;
};

async function createSourceFixture(
  pool: Pool,

  discordGuildId: string,

  suffix: string,
): Promise<SourceFixture> {
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
    [discordGuildId, `Template Admin Test Guild ${suffix}`],
  );

  const guildId = requireReturnedId(
    guildResult.rows[0]?.id,

    "guild",
  );

  await pool.query(
    `
      INSERT INTO "guild_settings" (
        "guild_id",
        "default_attendance_channel_id"
      )
      VALUES ($1, $2)
    `,
    [guildId, PUBLICATION_CHANNEL_ID],
  );

  const eventTypeResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_types" (
          "owner_guild_id",
          "code",
          "name",
          "role_requests_enabled",
          "active"
        )
        VALUES ($1, $2, $3, true, true)
        RETURNING "id"
      `,
    [guildId, `naval_${suffix}`, `Naval ${suffix}`],
  );

  const eventTypeId = requireReturnedId(
    eventTypeResult.rows[0]?.id,

    "event type",
  );

  const audienceResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_audiences" (
          "owner_guild_id",
          "code",
          "name",
          "default_timezone",
          "active"
        )
        VALUES (
          $1,
          $2,
          $3,
          'Europe/London',
          true
        )
        RETURNING "id"
      `,
    [guildId, `eu_${suffix}`, `EU ${suffix}`],
  );

  const audienceId = requireReturnedId(
    audienceResult.rows[0]?.id,

    "audience",
  );

  const presetResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "role_request_presets" (
          "owner_guild_id",
          "name",
          "active",
          "created_by_user_id"
        )
        VALUES ($1, $2, true, $3)
        RETURNING "id"
      `,
    [guildId, `Naval Roles ${suffix}`, ADMIN_USER_ID],
  );

  const presetId = requireReturnedId(
    presetResult.rows[0]?.id,

    "role-request preset",
  );

  return {
    guildId,

    eventTypeId,

    audienceId,

    presetId,
  };
}

function buildCreateInput(
  fixture: SourceFixture,

  overrides: Partial<CreateEventTemplateInput> = {},
): CreateEventTemplateInput {
  return {
    guildDatabaseId: fixture.guildId,

    eventTypeId: fixture.eventTypeId,

    audienceId: fixture.audienceId,

    roleRequestPresetId: fixture.presetId,

    name: "Sunday Naval",

    description: "Reusable naval event.",

    timezone: "Europe/London",

    localStartTime: "19:00",

    durationMinutes: 60,

    signupsEnabled: true,

    attendanceCloseMinutesBefore: 60,

    showDetailedDeadline: false,

    publicationMode: "scheduled",

    publishMinutesBeforeStart: 180,

    publicationChannelId: PUBLICATION_CHANNEL_ID,

    createdByUserId: ADMIN_USER_ID,

    ...overrides,
  };
}

function futureStart(): Date {
  return new Date(Date.now() + 6 * 60 * 60_000);
}

function requireReturnedId(
  value: number | undefined,

  description: string,
): number {
  if (value === undefined) {
    throw new Error(
      `Expected ${description} fixture creation to return an ID.`,
    );
  }

  return value;
}

async function waitForBlockedDatabaseQuery(
  pool: Pool,

  queryPattern: string,
): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      blocked: boolean;
    }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM "pg_stat_activity"
          WHERE
            "datname" = current_database()
            AND "state" = 'active'
            AND "wait_event_type" = 'Lock'
            AND "query" ILIKE $1
        ) AS "blocked"
      `,
      [queryPattern],
    );

    if (result.rows[0]?.blocked) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(
    `Timed out waiting for blocked PostgreSQL query matching ${queryPattern}.`,
  );
}
