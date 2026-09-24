import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import {
  addEventTemplateReminder,
  createEventTemplate,
  editEventTemplate,
  editEventTemplateReminder,
  getEventTemplate,
  listEventTemplates,
  removeEventTemplateReminder,
  replaceEventTemplateOrganiserDefaults,
  replaceEventTemplatePingRoles,
  replaceEventTemplateReminders,
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

const SECOND_PING_ROLE_ID = "990000000000000008";

const THIRD_PING_ROLE_ID = "990000000000000009";

const PRIMARY_ORGANISER_ID = "990000000000000006";

const BACKUP_ORGANISER_ID = "990000000000000010";

const REMINDER_CHANNEL_ID = "990000000000000007";

const SECOND_REMINDER_CHANNEL_ID = "990000000000000011";

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

  it("prevents an active recurring template from being changed to immediate publication", async () => {
    // Arrange
    const fixture = await createSourceFixture(
      pool,
      DISCORD_GUILD_ID,
      "recurrence-publication",
    );

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    await pool.query(
      `
        INSERT INTO
          "event_template_recurrences" (
            "template_id",
            "recurrence_rule",
            "start_date",
            "active",
            "created_by_user_id"
          )
        VALUES (
          $1,
          'FREQ=WEEKLY;BYDAY=MO',
          '2026-10-05',
          true,
          $2
        )
      `,
      [created.template.id, ADMIN_USER_ID],
    );

    // Act
    const blocked = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      publicationMode: "immediate",

      publishMinutesBeforeStart: null,
    });

    // Assert
    expect(blocked.kind).toBe("invalid_input");

    const unchanged = await pool.query<{
      publication_mode: string;
    }>(
      `
          SELECT
            "publication_mode"
          FROM
            "event_templates"
          WHERE
            "id" = $1
        `,
      [created.template.id],
    );

    expect(unchanged.rows).toEqual([
      {
        publication_mode: "scheduled",
      },
    ]);

    /*
     * An inactive recurrence may coexist with an immediate reusable template.
     *
     * This lets administrators temporarily use the same template for one-off
     * immediate generation. Reactivating recurrence is guarded separately.
     */
    await pool.query(
      `
        UPDATE
          "event_template_recurrences"
        SET
          "active" = false
        WHERE
          "template_id" = $1
      `,
      [created.template.id],
    );

    const allowed = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      publicationMode: "immediate",

      publishMinutesBeforeStart: null,
    });

    expect(allowed.kind).toBe("updated");

    if (allowed.kind !== "updated") {
      throw new Error(
        `Expected immediate publication to become valid after recurrence deactivation, received "${allowed.kind}".`,
      );
    }

    expect(allowed.template.publicationMode).toBe("immediate");
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

  it("replaces, orders and clears the complete template ping-role collection", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected ping-role fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Act: initial replacement
    const firstReplacement = await replaceEventTemplatePingRoles({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      pingRoles: [
        {
          discordRoleId: `  ${SECOND_PING_ROLE_ID}  `,

          roleNameSnapshot: "  Events  ",
        },
        {
          discordRoleId: PING_ROLE_ID,

          roleNameSnapshot: "Naval",
        },
      ],
    });

    // Assert
    expect(firstReplacement).toEqual({
      kind: "updated",

      pingRoles: [
        {
          discordRoleId: SECOND_PING_ROLE_ID,

          roleNameSnapshot: "Events",

          sortOrder: 0,
        },
        {
          discordRoleId: PING_ROLE_ID,

          roleNameSnapshot: "Naval",

          sortOrder: 1,
        },
      ],
    });

    const shown = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(shown.kind).toBe("found");

    if (shown.kind !== "found") {
      throw new Error(
        "Expected template with replaced ping roles to remain readable.",
      );
    }

    expect(shown.template.pingRoles).toEqual([
      {
        discordRoleId: SECOND_PING_ROLE_ID,

        roleNameSnapshot: "Events",

        sortOrder: 0,
      },
      {
        discordRoleId: PING_ROLE_ID,

        roleNameSnapshot: "Naval",

        sortOrder: 1,
      },
    ]);

    /*
     * Repeating the same canonical collection is idempotent.
     */
    expect(
      await replaceEventTemplatePingRoles({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        pingRoles: [
          {
            discordRoleId: SECOND_PING_ROLE_ID,

            roleNameSnapshot: "Events",
          },
          {
            discordRoleId: PING_ROLE_ID,

            roleNameSnapshot: "Naval",
          },
        ],
      }),
    ).toEqual({
      kind: "unchanged",

      pingRoles: [
        {
          discordRoleId: SECOND_PING_ROLE_ID,

          roleNameSnapshot: "Events",

          sortOrder: 0,
        },
        {
          discordRoleId: PING_ROLE_ID,

          roleNameSnapshot: "Naval",

          sortOrder: 1,
        },
      ],
    });

    /*
     * An empty replacement explicitly clears the collection.
     */
    expect(
      await replaceEventTemplatePingRoles({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        pingRoles: [],
      }),
    ).toEqual({
      kind: "updated",

      pingRoles: [],
    });

    const cleared = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(cleared.kind).toBe("found");

    if (cleared.kind !== "found") {
      throw new Error("Expected cleared template to remain readable.");
    }

    expect(cleared.template.pingRoles).toEqual([]);
  });

  it("rejects invalid or duplicate template ping roles without changing the existing collection", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected ping-role validation fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const initial = await replaceEventTemplatePingRoles({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      pingRoles: [
        {
          discordRoleId: PING_ROLE_ID,

          roleNameSnapshot: "Naval",
        },
      ],
    });

    expect(initial.kind).toBe("updated");

    // Act / Assert: duplicate ID after normalisation
    expect(
      await replaceEventTemplatePingRoles({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        pingRoles: [
          {
            discordRoleId: PING_ROLE_ID,

            roleNameSnapshot: "Naval",
          },
          {
            discordRoleId: ` ${PING_ROLE_ID} `,

            roleNameSnapshot: "Duplicate",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "duplicate_discord_role",
    });

    // Act / Assert: blank Discord role ID
    expect(
      await replaceEventTemplatePingRoles({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        pingRoles: [
          {
            discordRoleId: "   ",

            roleNameSnapshot: "Naval",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_discord_role_id",
    });

    // Act / Assert: invalid readable snapshot
    expect(
      await replaceEventTemplatePingRoles({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        pingRoles: [
          {
            discordRoleId: SECOND_PING_ROLE_ID,

            roleNameSnapshot: "   ",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_role_name",
    });

    /*
     * None of the failed replacements touched the existing collection.
     */
    const stored = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(stored.kind).toBe("found");

    if (stored.kind !== "found") {
      throw new Error(
        "Expected template to remain readable after rejected ping-role replacements.",
      );
    }

    expect(stored.template.pingRoles).toEqual([
      {
        discordRoleId: PING_ROLE_ID,

        roleNameSnapshot: "Naval",

        sortOrder: 0,
      },
    ]);
  });

  it("treats template ping-role replacement as guild-scoped administration", async () => {
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
        `Expected ping-role ownership fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Act / Assert
    expect(
      await replaceEventTemplatePingRoles({
        guildDatabaseId: foreignFixture.guildId,

        templateId: created.template.id,

        pingRoles: [
          {
            discordRoleId: PING_ROLE_ID,

            roleNameSnapshot: "Naval",
          },
        ],
      }),
    ).toEqual({
      kind: "template_not_found",
    });

    const storedCount = await pool.query<{
      count: number;
    }>(
      `
          SELECT COUNT(*)::int AS "count"
          FROM "event_template_ping_roles"
          WHERE "template_id" = $1
        `,
      [created.template.id],
    );

    expect(storedCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("replaces, canonicalises and clears the complete template organiser-default collection", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected organiser fixture creation to succeed, received "${created.kind}".`,
      );
    }

    /*
     * Input order is deliberately backup-first.
     */
    const firstReplacement = await replaceEventTemplateOrganiserDefaults({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      organiserDefaults: [
        {
          slot: "backup",

          discordUserId: `  ${BACKUP_ORGANISER_ID}  `,

          displayNameSnapshot: "  Backup Organiser  ",
        },
        {
          slot: "primary",

          discordUserId: PRIMARY_ORGANISER_ID,

          displayNameSnapshot: "Primary Organiser",
        },
      ],
    });

    expect(firstReplacement).toEqual({
      kind: "updated",

      organiserDefaults: [
        {
          slot: "primary",

          discordUserId: PRIMARY_ORGANISER_ID,

          displayNameSnapshot: "Primary Organiser",
        },
        {
          slot: "backup",

          discordUserId: BACKUP_ORGANISER_ID,

          displayNameSnapshot: "Backup Organiser",
        },
      ],
    });

    const shown = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(shown.kind).toBe("found");

    if (shown.kind !== "found") {
      throw new Error(
        "Expected template with organiser defaults to remain readable.",
      );
    }

    expect(shown.template.organiserDefaults).toEqual([
      {
        slot: "primary",

        discordUserId: PRIMARY_ORGANISER_ID,

        displayNameSnapshot: "Primary Organiser",
      },
      {
        slot: "backup",

        discordUserId: BACKUP_ORGANISER_ID,

        displayNameSnapshot: "Backup Organiser",
      },
    ]);

    /*
     * Canonical state is idempotent regardless of input order.
     */
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "backup",

            discordUserId: BACKUP_ORGANISER_ID,

            displayNameSnapshot: "Backup Organiser",
          },
          {
            slot: "primary",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "Primary Organiser",
          },
        ],
      }),
    ).toEqual({
      kind: "unchanged",

      organiserDefaults: [
        {
          slot: "primary",

          discordUserId: PRIMARY_ORGANISER_ID,

          displayNameSnapshot: "Primary Organiser",
        },
        {
          slot: "backup",

          discordUserId: BACKUP_ORGANISER_ID,

          displayNameSnapshot: "Backup Organiser",
        },
      ],
    });

    /*
     * Empty replacement explicitly clears organiser defaults.
     */
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [],
      }),
    ).toEqual({
      kind: "updated",

      organiserDefaults: [],
    });

    const cleared = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(cleared.kind).toBe("found");

    if (cleared.kind !== "found") {
      throw new Error("Expected cleared template to remain readable.");
    }

    expect(cleared.template.organiserDefaults).toEqual([]);
  });

  it("rejects invalid template organiser defaults without changing the existing collection", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected organiser validation fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const initial = await replaceEventTemplateOrganiserDefaults({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      organiserDefaults: [
        {
          slot: "primary",

          discordUserId: PRIMARY_ORGANISER_ID,

          displayNameSnapshot: "Primary Organiser",
        },
      ],
    });

    expect(initial.kind).toBe("updated");

    // Backup without primary.
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "backup",

            discordUserId: BACKUP_ORGANISER_ID,

            displayNameSnapshot: "Backup Organiser",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "backup_requires_primary",
    });

    // Runtime-invalid slot.
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "cover",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "Cover Organiser",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_slot",
    });

    // Duplicate slot.
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "Primary Organiser",
          },
          {
            slot: "primary",

            discordUserId: BACKUP_ORGANISER_ID,

            displayNameSnapshot: "Another Primary",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "duplicate_slot",
    });

    // Same Discord user in both slots.
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "Primary Organiser",
          },
          {
            slot: "backup",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "Same User",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "duplicate_discord_user",
    });

    // Blank user ID.
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: "   ",

            displayNameSnapshot: "Primary Organiser",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_discord_user_id",
    });

    // Blank display snapshot.
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "   ",
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_display_name",
    });

    /*
     * All rejected calls happened before mutation.
     */
    const stored = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(stored.kind).toBe("found");

    if (stored.kind !== "found") {
      throw new Error(
        "Expected template to remain readable after rejected organiser replacements.",
      );
    }

    expect(stored.template.organiserDefaults).toEqual([
      {
        slot: "primary",

        discordUserId: PRIMARY_ORGANISER_ID,

        displayNameSnapshot: "Primary Organiser",
      },
    ]);
  });

  it("treats template organiser-default replacement as guild-scoped administration", async () => {
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
        `Expected organiser ownership fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Act / Assert
    expect(
      await replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: foreignFixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "Primary Organiser",
          },
        ],
      }),
    ).toEqual({
      kind: "template_not_found",
    });

    const storedCount = await pool.query<{
      count: number;
    }>(
      `
          SELECT COUNT(*)::int AS "count"
          FROM "event_template_organiser_defaults"
          WHERE "template_id" = $1
        `,
      [created.template.id],
    );

    expect(storedCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("serialises organiser-default replacement behind an in-flight generation snapshot", async () => {
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
        `Expected organiser concurrency fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const initialReplacement = await replaceEventTemplateOrganiserDefaults({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      organiserDefaults: [
        {
          slot: "primary",

          discordUserId: PRIMARY_ORGANISER_ID,

          displayNameSnapshot: "Old Primary Organiser",
        },
      ],
    });

    expect(initialReplacement.kind).toBe("updated");

    const blockerClient = await pool.connect();

    let blockerTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let replacementPromise: ReturnType<
      typeof replaceEventTemplateOrganiserDefaults
    > | null = null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

      /*
       * Generation locks the template parent FOR SHARE before reading the
       * event type. Pause it there so organiser replacement attempts FOR
       * UPDATE while that shared source lock is definitely held.
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

      let replacementResolved = false;

      replacementPromise = replaceEventTemplateOrganiserDefaults({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        organiserDefaults: [
          {
            slot: "primary",

            discordUserId: PRIMARY_ORGANISER_ID,

            displayNameSnapshot: "New Primary Organiser",
          },
          {
            slot: "backup",

            discordUserId: BACKUP_ORGANISER_ID,

            displayNameSnapshot: "New Backup Organiser",
          },
        ],
      }).then((result) => {
        replacementResolved = true;

        return result;
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_templates"%for update%',
      );

      expect(replacementResolved).toBe(false);

      /*
       * Generation owns the shared source lock first and therefore snapshots
       * the old complete organiser-default collection.
       */
      await blockerClient.query("COMMIT");

      blockerTransactionOpen = false;

      const generationResult = await generationPromise;

      const replacementResult = await replacementPromise;

      expect(generationResult.kind).toBe("generated");

      if (generationResult.kind !== "generated") {
        throw new Error(
          `Expected in-flight generation to succeed, received "${generationResult.kind}".`,
        );
      }

      expect(replacementResult.kind).toBe("updated");

      const firstEventOrganisers = await pool.query<{
        slot: string;

        discord_user_id: string;

        display_name_snapshot: string;
      }>(
        `
            SELECT
              "slot",
              "discord_user_id",
              "display_name_snapshot"
            FROM "event_organiser_assignments"
            WHERE "event_id" = $1
            ORDER BY
              CASE "slot"
                WHEN 'primary' THEN 0
                WHEN 'backup' THEN 1
                ELSE 2
              END
          `,
        [generationResult.event.id],
      );

      expect(firstEventOrganisers.rows).toEqual([
        {
          slot: "primary",

          discord_user_id: PRIMARY_ORGANISER_ID,

          display_name_snapshot: "Old Primary Organiser",
        },
      ]);

      /*
       * A later generation sees the complete replacement source.
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

      const secondEventOrganisers = await pool.query<{
        slot: string;

        discord_user_id: string;

        display_name_snapshot: string;
      }>(
        `
            SELECT
              "slot",
              "discord_user_id",
              "display_name_snapshot"
            FROM "event_organiser_assignments"
            WHERE "event_id" = $1
            ORDER BY
              CASE "slot"
                WHEN 'primary' THEN 0
                WHEN 'backup' THEN 1
                ELSE 2
              END
          `,
        [secondGeneration.event.id],
      );

      expect(secondEventOrganisers.rows).toEqual([
        {
          slot: "primary",

          discord_user_id: PRIMARY_ORGANISER_ID,

          display_name_snapshot: "New Primary Organiser",
        },
        {
          slot: "backup",

          discord_user_id: BACKUP_ORGANISER_ID,

          display_name_snapshot: "New Backup Organiser",
        },
      ]);

      /*
       * The first event owns its old snapshot permanently.
       */
      const firstAfterReplacement = await pool.query<{
        display_name_snapshot: string;
      }>(
        `
            SELECT "display_name_snapshot"
            FROM "event_organiser_assignments"
            WHERE
              "event_id" = $1
              AND "slot" = 'primary'
          `,
        [generationResult.event.id],
      );

      expect(firstAfterReplacement.rows).toEqual([
        {
          display_name_snapshot: "Old Primary Organiser",
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

      if (replacementPromise) {
        pendingOperations.push(replacementPromise);
      }

      await Promise.allSettled(pendingOperations);

      blockerClient.release();
    }
  });

  it("replaces, canonicalises and clears the complete template reminder collection", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected reminder fixture creation to succeed, received "${created.kind}".`,
      );
    }

    /*
     * Input order is deliberately signup-close first.
     */
    const firstReplacement = await replaceEventTemplateReminders({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminders: [
        {
          timingReference: "  signup_close  ",

          minutesBefore: 15,

          message: "  Signups close soon.  ",

          channelId: `  ${SECOND_REMINDER_CHANNEL_ID}  `,

          pingEventRoles: false,
        },
        {
          timingReference: "event_start",

          minutesBefore: 30,

          message: "  Event starts soon.  ",

          channelId: null,

          pingEventRoles: true,
        },
      ],
    });

    expect(firstReplacement.kind).toBe("updated");

    if (firstReplacement.kind !== "updated") {
      throw new Error(
        `Expected reminder replacement to succeed, received "${firstReplacement.kind}".`,
      );
    }

    expect(
      firstReplacement.reminders.map((reminder) => ({
        timingReference: reminder.timingReference,

        minutesBefore: reminder.minutesBefore,

        message: reminder.message,

        channelId: reminder.channelId,

        pingEventRoles: reminder.pingEventRoles,
      })),
    ).toEqual([
      {
        timingReference: "event_start",

        minutesBefore: 30,

        message: "Event starts soon.",

        channelId: null,

        pingEventRoles: true,
      },
      {
        timingReference: "signup_close",

        minutesBefore: 15,

        message: "Signups close soon.",

        channelId: SECOND_REMINDER_CHANNEL_ID,

        pingEventRoles: false,
      },
    ]);

    expect(
      firstReplacement.reminders.every((reminder) => reminder.id > 0),
    ).toBe(true);

    /*
     * Reordering the same logical definitions remains idempotent.
     */
    const unchanged = await replaceEventTemplateReminders({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminders: [
        {
          timingReference: "signup_close",

          minutesBefore: 15,

          message: "Signups close soon.",

          channelId: SECOND_REMINDER_CHANNEL_ID,

          pingEventRoles: false,
        },
        {
          timingReference: "event_start",

          minutesBefore: 30,

          message: "Event starts soon.",

          channelId: null,

          pingEventRoles: true,
        },
      ],
    });

    expect(unchanged).toEqual({
      kind: "unchanged",

      reminders: firstReplacement.reminders,
    });

    /*
     * Empty replacement explicitly clears reminder definitions.
     */
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [],
      }),
    ).toEqual({
      kind: "updated",

      reminders: [],
    });

    const cleared = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(cleared.kind).toBe("found");

    if (cleared.kind !== "found") {
      throw new Error("Expected cleared template to remain readable.");
    }

    expect(cleared.template.reminders).toEqual([]);
  });

  it("rejects invalid template reminder definitions without changing the existing collection", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected reminder validation fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const initial = await replaceEventTemplateReminders({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminders: [
        {
          timingReference: "event_start",

          minutesBefore: 30,

          message: "Existing reminder.",

          channelId: REMINDER_CHANNEL_ID,

          pingEventRoles: true,
        },
      ],
    });

    expect(initial.kind).toBe("updated");

    // Unsupported timing language.
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "role_requests_open",

            minutesBefore: 10,

            message: "Invalid timing.",

            channelId: null,

            pingEventRoles: true,
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_timing_reference",
    });

    // Negative offset.
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "event_start",

            minutesBefore: -1,

            message: "Invalid offset.",

            channelId: null,

            pingEventRoles: true,
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_minutes_before",
    });

    // Blank message.
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "event_start",

            minutesBefore: 10,

            message: "   ",

            channelId: null,

            pingEventRoles: true,
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_message",
    });

    // Explicit fixed destination cannot be blank.
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "event_start",

            minutesBefore: 10,

            message: "Reminder.",

            channelId: "   ",

            pingEventRoles: true,
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "invalid_channel_id",
    });

    /*
     * Disable signups while keeping the existing event-start reminder.
     */
    const disabled = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      signupsEnabled: false,
    });

    expect(disabled.kind).toBe("updated");

    // Signup-close now has no valid reference point.
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "signup_close",

            minutesBefore: 10,

            message: "Signups close soon.",

            channelId: null,

            pingEventRoles: false,
          },
        ],
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "signup_close_requires_signups",
    });

    /*
     * Rejected replacements never changed the existing event-start reminder.
     */
    const stored = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(stored.kind).toBe("found");

    if (stored.kind !== "found") {
      throw new Error(
        "Expected template to remain readable after rejected reminder replacements.",
      );
    }

    expect(
      stored.template.reminders.map((reminder) => ({
        timingReference: reminder.timingReference,

        minutesBefore: reminder.minutesBefore,

        message: reminder.message,

        channelId: reminder.channelId,

        pingEventRoles: reminder.pingEventRoles,
      })),
    ).toEqual([
      {
        timingReference: "event_start",

        minutesBefore: 30,

        message: "Existing reminder.",

        channelId: REMINDER_CHANNEL_ID,

        pingEventRoles: true,
      },
    ]);
  });

  it("prevents disabling signups while signup-close template reminders still exist", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected signup-reminder fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const reminderReplacement = await replaceEventTemplateReminders({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminders: [
        {
          timingReference: "signup_close",

          minutesBefore: 15,

          message: "Signups close soon.",

          channelId: null,

          pingEventRoles: false,
        },
      ],
    });

    expect(reminderReplacement.kind).toBe("updated");

    // Act / Assert
    expect(
      await editEventTemplate({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        signupsEnabled: false,
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "signup_close_requires_signups",
    });

    const beforeRepair = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(beforeRepair.kind).toBe("found");

    if (beforeRepair.kind !== "found") {
      throw new Error(
        "Expected template to remain readable after rejected signup disable.",
      );
    }

    expect(beforeRepair.template.signupsEnabled).toBe(true);

    expect(beforeRepair.template.reminders).toHaveLength(1);

    /*
     * Repair the dependent source first, then the core edit becomes valid.
     */
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [],
      }),
    ).toEqual({
      kind: "updated",

      reminders: [],
    });

    const disabled = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      signupsEnabled: false,
    });

    expect(disabled.kind).toBe("updated");

    if (disabled.kind !== "updated") {
      throw new Error(
        `Expected signups to be disabled after clearing signup-close reminders, received "${disabled.kind}".`,
      );
    }

    expect(disabled.template.signupsEnabled).toBe(false);
  });

  it("treats template reminder replacement as guild-scoped administration", async () => {
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
        `Expected reminder ownership fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Act / Assert
    expect(
      await replaceEventTemplateReminders({
        guildDatabaseId: foreignFixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "event_start",

            minutesBefore: 30,

            message: "Reminder.",

            channelId: null,

            pingEventRoles: true,
          },
        ],
      }),
    ).toEqual({
      kind: "template_not_found",
    });

    const storedCount = await pool.query<{
      count: number;
    }>(
      `
          SELECT COUNT(*)::int AS "count"
          FROM "event_template_reminders"
          WHERE "template_id" = $1
        `,
      [created.template.id],
    );

    expect(storedCount.rows).toEqual([
      {
        count: 0,
      },
    ]);
  });

  it("serialises reminder replacement behind an in-flight generation snapshot", async () => {
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
        `Expected reminder concurrency fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const initialReplacement = await replaceEventTemplateReminders({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminders: [
        {
          timingReference: "event_start",

          minutesBefore: 30,

          message: "Old reminder.",

          channelId: REMINDER_CHANNEL_ID,

          pingEventRoles: true,
        },
      ],
    });

    expect(initialReplacement.kind).toBe("updated");

    const blockerClient = await pool.connect();

    let blockerTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let replacementPromise: ReturnType<
      typeof replaceEventTemplateReminders
    > | null = null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

      /*
       * Generation locks the template parent FOR SHARE before reading the
       * event type. Pause it there while the shared source lock is held.
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

      let replacementResolved = false;

      replacementPromise = replaceEventTemplateReminders({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminders: [
          {
            timingReference: "event_start",

            minutesBefore: 10,

            message: "New start reminder.",

            channelId: null,

            pingEventRoles: true,
          },
          {
            timingReference: "signup_close",

            minutesBefore: 15,

            message: "New signup reminder.",

            channelId: REMINDER_CHANNEL_ID,

            pingEventRoles: false,
          },
        ],
      }).then((result) => {
        replacementResolved = true;

        return result;
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_templates"%for update%',
      );

      expect(replacementResolved).toBe(false);

      /*
       * The in-flight generation owns the old complete reminder source graph.
       */
      await blockerClient.query("COMMIT");

      blockerTransactionOpen = false;

      const generationResult = await generationPromise;

      const replacementResult = await replacementPromise;

      expect(generationResult.kind).toBe("generated");

      if (generationResult.kind !== "generated") {
        throw new Error(
          `Expected in-flight generation to succeed, received "${generationResult.kind}".`,
        );
      }

      expect(replacementResult.kind).toBe("updated");

      const firstEventReminders = await pool.query<{
        timing_reference: string;

        minutes_before: number;

        message: string;

        channel_id: string;

        ping_event_roles: boolean;
      }>(
        `
            SELECT
              "timing_reference",
              "minutes_before",
              "message",
              "channel_id",
              "ping_event_roles"
            FROM "event_reminders"
            WHERE "event_id" = $1
            ORDER BY "id"
          `,
        [generationResult.event.id],
      );

      expect(firstEventReminders.rows).toEqual([
        {
          timing_reference: "event_start",

          minutes_before: 30,

          message: "Old reminder.",

          channel_id: REMINDER_CHANNEL_ID,

          ping_event_roles: true,
        },
      ]);

      /*
       * A later occurrence sees the complete replacement definition set.
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

      const secondEventReminders = await pool.query<{
        timing_reference: string;

        minutes_before: number;

        message: string;

        channel_id: string;

        ping_event_roles: boolean;
      }>(
        `
            SELECT
              "timing_reference",
              "minutes_before",
              "message",
              "channel_id",
              "ping_event_roles"
            FROM "event_reminders"
            WHERE "event_id" = $1
            ORDER BY
              "timing_reference",
              "minutes_before"
          `,
        [secondGeneration.event.id],
      );

      expect(secondEventReminders.rows).toEqual([
        {
          timing_reference: "event_start",

          minutes_before: 10,

          message: "New start reminder.",

          channel_id: PUBLICATION_CHANNEL_ID,

          ping_event_roles: true,
        },
        {
          timing_reference: "signup_close",

          minutes_before: 15,

          message: "New signup reminder.",

          channel_id: REMINDER_CHANNEL_ID,

          ping_event_roles: false,
        },
      ]);

      /*
       * The first occurrence permanently retains its old reminder snapshot.
       */
      const firstAfterReplacement = await pool.query<{
        message: string;
      }>(
        `
            SELECT "message"
            FROM "event_reminders"
            WHERE "event_id" = $1
          `,
        [generationResult.event.id],
      );

      expect(firstAfterReplacement.rows).toEqual([
        {
          message: "Old reminder.",
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

      if (replacementPromise) {
        pendingOperations.push(replacementPromise);
      }

      await Promise.allSettled(pendingOperations);

      blockerClient.release();
    }
  });

  it("adds, edits and removes individual template reminder definitions", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate(buildCreateInput(fixture));

    if (created.kind !== "created") {
      throw new Error(
        `Expected reminder CRUD fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Add
    const added = await addEventTemplateReminder({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminder: {
        timingReference: "  event_start  ",

        minutesBefore: 30,

        message: "  Event starts soon.  ",

        channelId: null,

        pingEventRoles: true,
      },
    });

    expect(added.kind).toBe("created");

    if (added.kind !== "created") {
      throw new Error(
        `Expected reminder creation to succeed, received "${added.kind}".`,
      );
    }

    expect(added.reminder).toEqual({
      id: expect.any(Number),

      timingReference: "event_start",

      minutesBefore: 30,

      message: "Event starts soon.",

      channelId: null,

      pingEventRoles: true,
    });

    // Edit
    const edited = await editEventTemplateReminder({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminderId: added.reminder.id,

      timingReference: "signup_close",

      minutesBefore: 15,

      message: "  Signups close soon.  ",

      channelId: REMINDER_CHANNEL_ID,

      pingEventRoles: false,
    });

    expect(edited.kind).toBe("updated");

    if (edited.kind !== "updated") {
      throw new Error(
        `Expected reminder edit to succeed, received "${edited.kind}".`,
      );
    }

    expect(edited.reminder).toEqual({
      id: added.reminder.id,

      timingReference: "signup_close",

      minutesBefore: 15,

      message: "Signups close soon.",

      channelId: REMINDER_CHANNEL_ID,

      pingEventRoles: false,
    });

    /*
     * Repeating the same requested values is idempotent.
     */
    expect(
      await editEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminderId: added.reminder.id,

        message: "Signups close soon.",
      }),
    ).toMatchObject({
      kind: "unchanged",
    });

    // Remove
    expect(
      await removeEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminderId: added.reminder.id,
      }),
    ).toEqual({
      kind: "removed",

      reminderId: added.reminder.id,
    });

    expect(
      await removeEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminderId: added.reminder.id,
      }),
    ).toEqual({
      kind: "reminder_not_found",
    });

    const shown = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(shown.kind).toBe("found");

    if (shown.kind !== "found") {
      throw new Error(
        "Expected template to remain readable after reminder removal.",
      );
    }

    expect(shown.template.reminders).toEqual([]);
  });

  it("rejects individual signup-close reminder mutations while template signups are disabled", async () => {
    // Arrange
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const created = await createEventTemplate({
      ...buildCreateInput(fixture),

      signupsEnabled: false,
    });

    if (created.kind !== "created") {
      throw new Error(
        `Expected no-signups template fixture creation to succeed, received "${created.kind}".`,
      );
    }

    // Signup-close cannot be added.
    expect(
      await addEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminder: {
          timingReference: "signup_close",

          minutesBefore: 10,

          message: "Signups close soon.",

          channelId: null,

          pingEventRoles: false,
        },
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "signup_close_requires_signups",
    });

    // Event-start remains valid.
    const added = await addEventTemplateReminder({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminder: {
        timingReference: "event_start",

        minutesBefore: 10,

        message: "Event starts soon.",

        channelId: null,

        pingEventRoles: false,
      },
    });

    expect(added.kind).toBe("created");

    if (added.kind !== "created") {
      throw new Error(
        `Expected event-start reminder creation to succeed, received "${added.kind}".`,
      );
    }

    // It cannot then be edited into an invalid signup-close definition.
    expect(
      await editEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminderId: added.reminder.id,

        timingReference: "signup_close",
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "signup_close_requires_signups",
    });

    const shown = await getEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,
    });

    expect(shown.kind).toBe("found");

    if (shown.kind !== "found") {
      throw new Error("Expected template to remain readable.");
    }

    expect(shown.template.reminders).toEqual([
      expect.objectContaining({
        id: added.reminder.id,

        timingReference: "event_start",

        message: "Event starts soon.",
      }),
    ]);
  });

  it("keeps individual reminder mutation scoped to the owning template and guild", async () => {
    const fixture = await createSourceFixture(pool, DISCORD_GUILD_ID, "main");

    const foreignFixture = await createSourceFixture(
      pool,
      OTHER_DISCORD_GUILD_ID,
      "foreign",
    );

    const first = await createEventTemplate(buildCreateInput(fixture));

    const second = await createEventTemplate({
      ...buildCreateInput(fixture),

      name: "Second Template",
    });

    if (first.kind !== "created" || second.kind !== "created") {
      throw new Error("Expected reminder ownership fixtures to be created.");
    }

    const added = await addEventTemplateReminder({
      guildDatabaseId: fixture.guildId,

      templateId: first.template.id,

      reminder: {
        timingReference: "event_start",

        minutesBefore: 30,

        message: "Reminder.",

        channelId: null,

        pingEventRoles: true,
      },
    });

    if (added.kind !== "created") {
      throw new Error(
        `Expected reminder fixture creation to succeed, received "${added.kind}".`,
      );
    }

    expect(
      await editEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: second.template.id,

        reminderId: added.reminder.id,

        message: "Wrong template.",
      }),
    ).toEqual({
      kind: "reminder_not_found",
    });

    expect(
      await removeEventTemplateReminder({
        guildDatabaseId: foreignFixture.guildId,

        templateId: first.template.id,

        reminderId: added.reminder.id,
      }),
    ).toEqual({
      kind: "template_not_found",
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
    expect(templates[0]).toMatchObject({
      eventTypeName: "Naval main",

      audienceName: "EU main",

      roleRequestPresetName: null,
    });

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

    expect(result.template).toMatchObject({
      eventTypeName: "Naval main",

      audienceName: "EU main",

      roleRequestPresetName: null,
    });

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

  it("serialises ping-role replacement behind an in-flight generation snapshot", async () => {
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
        `Expected ping-role concurrency fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const initialReplacement = await replaceEventTemplatePingRoles({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      pingRoles: [
        {
          discordRoleId: PING_ROLE_ID,

          roleNameSnapshot: "Old Naval Role",
        },
      ],
    });

    expect(initialReplacement.kind).toBe("updated");

    const blockerClient = await pool.connect();

    let blockerTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let replacementPromise: ReturnType<
      typeof replaceEventTemplatePingRoles
    > | null = null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

      /*
       * Generation takes the template parent FOR SHARE before reading
       * event_types. Pause it there while the source lock is definitely held.
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

      let replacementResolved = false;

      replacementPromise = replaceEventTemplatePingRoles({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        pingRoles: [
          {
            discordRoleId: SECOND_PING_ROLE_ID,

            roleNameSnapshot: "New Events Role",
          },
          {
            discordRoleId: THIRD_PING_ROLE_ID,

            roleNameSnapshot: "New Naval Role",
          },
        ],
      }).then((result) => {
        replacementResolved = true;

        return result;
      });

      await waitForBlockedDatabaseQuery(
        pool,

        '%from "event_templates"%for update%',
      );

      expect(replacementResolved).toBe(false);

      /*
       * Generation acquired the shared source lock first, so it must snapshot
       * the old complete collection before replacement can commit.
       */
      await blockerClient.query("COMMIT");

      blockerTransactionOpen = false;

      const generationResult = await generationPromise;

      const replacementResult = await replacementPromise;

      expect(generationResult.kind).toBe("generated");

      if (generationResult.kind !== "generated") {
        throw new Error(
          `Expected in-flight generation to succeed, received "${generationResult.kind}".`,
        );
      }

      expect(replacementResult.kind).toBe("updated");

      const firstEventRoles = await pool.query<{
        discord_role_id: string;

        role_name: string;

        sort_order: number;
      }>(
        `
            SELECT
              "discord_role_id",
              "role_name",
              "sort_order"
            FROM "event_ping_roles"
            WHERE "event_id" = $1
            ORDER BY
              "sort_order",
              "discord_role_id"
          `,
        [generationResult.event.id],
      );

      expect(firstEventRoles.rows).toEqual([
        {
          discord_role_id: PING_ROLE_ID,

          role_name: "Old Naval Role",

          sort_order: 0,
        },
      ]);

      /*
       * A later occurrence sees the complete replacement collection.
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

      const secondEventRoles = await pool.query<{
        discord_role_id: string;

        role_name: string;

        sort_order: number;
      }>(
        `
            SELECT
              "discord_role_id",
              "role_name",
              "sort_order"
            FROM "event_ping_roles"
            WHERE "event_id" = $1
            ORDER BY
              "sort_order",
              "discord_role_id"
          `,
        [secondGeneration.event.id],
      );

      expect(secondEventRoles.rows).toEqual([
        {
          discord_role_id: SECOND_PING_ROLE_ID,

          role_name: "New Events Role",

          sort_order: 0,
        },
        {
          discord_role_id: THIRD_PING_ROLE_ID,

          role_name: "New Naval Role",

          sort_order: 1,
        },
      ]);

      /*
       * The first generated event remains independent after the source edit.
       */
      const firstEventRolesAfterEdit = await pool.query<{
        discord_role_id: string;

        role_name: string;

        sort_order: number;
      }>(
        `
            SELECT
              "discord_role_id",
              "role_name",
              "sort_order"
            FROM "event_ping_roles"
            WHERE "event_id" = $1
            ORDER BY
              "sort_order",
              "discord_role_id"
          `,
        [generationResult.event.id],
      );

      expect(firstEventRolesAfterEdit.rows).toEqual(firstEventRoles.rows);
    } finally {
      if (blockerTransactionOpen) {
        await blockerClient.query("ROLLBACK").catch(() => undefined);
      }

      const pendingOperations: Promise<unknown>[] = [];

      if (generationPromise) {
        pendingOperations.push(generationPromise);
      }

      if (replacementPromise) {
        pendingOperations.push(replacementPromise);
      }

      await Promise.allSettled(pendingOperations);

      blockerClient.release();
    }
  });

  it("serialises individual reminder editing behind an in-flight generation snapshot", async () => {
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
        `Expected reminder-edit concurrency fixture creation to succeed, received "${created.kind}".`,
      );
    }

    const added = await addEventTemplateReminder({
      guildDatabaseId: fixture.guildId,

      templateId: created.template.id,

      reminder: {
        timingReference: "event_start",

        minutesBefore: 30,

        message: "Old reminder.",

        channelId: REMINDER_CHANNEL_ID,

        pingEventRoles: true,
      },
    });

    if (added.kind !== "created") {
      throw new Error(
        `Expected reminder fixture creation to succeed, received "${added.kind}".`,
      );
    }

    const blockerClient = await pool.connect();

    let blockerTransactionOpen = false;

    let generationPromise: ReturnType<typeof generateEventFromTemplate> | null =
      null;

    let editPromise: ReturnType<typeof editEventTemplateReminder> | null = null;

    try {
      await blockerClient.query("BEGIN");

      blockerTransactionOpen = true;

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

      await waitForBlockedDatabaseQuery(pool, '%from "event_types"%');

      let editResolved = false;

      editPromise = editEventTemplateReminder({
        guildDatabaseId: fixture.guildId,

        templateId: created.template.id,

        reminderId: added.reminder.id,

        message: "New reminder.",
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

      expect(editResult.kind).toBe("updated");

      if (generationResult.kind !== "generated") {
        throw new Error(
          `Expected generation to succeed, received "${generationResult.kind}".`,
        );
      }

      const firstEventReminder = await pool.query<{
        message: string;
      }>(
        `
            SELECT "message"
            FROM "event_reminders"
            WHERE "event_id" = $1
          `,
        [generationResult.event.id],
      );

      expect(firstEventReminder.rows).toEqual([
        {
          message: "Old reminder.",
        },
      ]);

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

      const secondEventReminder = await pool.query<{
        message: string;
      }>(
        `
            SELECT "message"
            FROM "event_reminders"
            WHERE "event_id" = $1
          `,
        [secondGeneration.event.id],
      );

      expect(secondEventReminder.rows).toEqual([
        {
          message: "New reminder.",
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
