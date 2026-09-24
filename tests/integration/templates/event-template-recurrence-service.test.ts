import type { Pool } from "pg";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool as applicationPool } from "../../../src/db/client.js";
import { editEventTemplate } from "../../../src/templates/event-template-admin-service.js";
import {
  createEventTemplateRecurrence,
  editEventTemplateRecurrence,
  getEventTemplateRecurrence,
  listEventTemplateRecurrences,
  setEventTemplateRecurrenceActive,
} from "../../../src/templates/event-template-recurrence-service.js";
import {
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

const DISCORD_GUILD_ID = "992000000000000001";

const OTHER_DISCORD_GUILD_ID = "992000000000000002";

const ADMIN_USER_ID = "992000000000000003";

describe("event template recurrence service", () => {
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

  it("creates one normalised recurrence for a guild-owned template", async () => {
    const fixture = await createTemplateFixture(
      pool,
      DISCORD_GUILD_ID,
      "main",
      "20:00",
    );

    const result = await createEventTemplateRecurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      recurrenceRule: "rrule:freq=weekly;byday=mo",

      startDate: "2026-10-05",

      createdByUserId: ADMIN_USER_ID,
    });

    expect(result.kind).toBe("created");

    if (result.kind !== "created") {
      throw new Error(
        `Expected recurrence creation to succeed, received "${result.kind}".`,
      );
    }

    expect(result.recurrence).toMatchObject({
      templateId: fixture.templateId,

      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

      startDate: "2026-10-05",

      active: true,

      createdByUserId: ADMIN_USER_ID,

      createdAt: expect.any(Date),

      updatedAt: expect.any(Date),
    });
  });

  it("rejects recurrence creation when the template has no reusable local start time", async () => {
    const fixture = await createTemplateFixture(
      pool,
      DISCORD_GUILD_ID,
      "main",
      null,
    );

    expect(
      await createEventTemplateRecurrence({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

        startDate: "2026-10-05",

        createdByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "invalid_input",

      reason: "template_missing_local_start_time",
    });
  });

  it("treats another guild's template as not found", async () => {
    const ownFixture = await createTemplateFixture(
      pool,
      DISCORD_GUILD_ID,
      "own",
      "20:00",
    );

    const foreignFixture = await createTemplateFixture(
      pool,
      OTHER_DISCORD_GUILD_ID,
      "foreign",
      "20:00",
    );

    expect(
      await createEventTemplateRecurrence({
        guildDatabaseId: ownFixture.guildId,

        templateId: foreignFixture.templateId,

        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

        startDate: "2026-10-05",

        createdByUserId: ADMIN_USER_ID,
      }),
    ).toEqual({
      kind: "template_not_found",
    });
  });

  it("returns the existing recurrence instead of creating a second series for one template", async () => {
    const fixture = await createTemplateFixture(
      pool,
      DISCORD_GUILD_ID,
      "main",
      "20:00",
    );

    const first = await createEventTemplateRecurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

      startDate: "2026-10-05",

      createdByUserId: ADMIN_USER_ID,
    });

    if (first.kind !== "created") {
      throw new Error("Expected first recurrence creation to succeed.");
    }

    const second = await createEventTemplateRecurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      recurrenceRule: "FREQ=WEEKLY;BYDAY=TU",

      startDate: "2026-10-06",

      createdByUserId: ADMIN_USER_ID,
    });

    expect(second).toEqual({
      kind: "recurrence_already_exists",

      recurrence: first.recurrence,
    });
  });

  it("edits recurrence source state without changing its identity", async () => {
    const fixture = await createRecurrenceFixture(pool);

    const result = await editEventTemplateRecurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",

      startDate: "2026-10-12",
    });

    expect(result.kind).toBe("updated");

    if (result.kind !== "updated") {
      throw new Error(
        `Expected recurrence editing to succeed, received "${result.kind}".`,
      );
    }

    expect(result.recurrence).toMatchObject({
      id: fixture.recurrenceId,

      recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",

      startDate: "2026-10-12",

      active: true,
    });
  });

  it("supports reversible recurrence lifecycle without changing the template lifecycle", async () => {
    const fixture = await createRecurrenceFixture(pool);

    const deactivated = await setEventTemplateRecurrenceActive({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      active: false,
    });

    expect(deactivated.kind).toBe("updated");

    const inspected = await getEventTemplateRecurrence({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,
    });

    expect(inspected.kind).toBe("found");

    if (inspected.kind !== "found") {
      throw new Error("Expected recurrence inspection to succeed.");
    }

    expect(inspected.recurrence.active).toBe(false);

    expect(inspected.recurrence.templateActive).toBe(true);

    const repeated = await setEventTemplateRecurrenceActive({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      active: false,
    });

    expect(repeated.kind).toBe("unchanged");
  });

  it("lists only recurrence series owned by the requested guild", async () => {
    const first = await createTemplateFixture(
      pool,
      DISCORD_GUILD_ID,
      "alpha",
      "20:00",
    );

    const second = await createTemplateFixture(
      pool,
      DISCORD_GUILD_ID,
      "beta",
      "19:00",
    );

    const foreign = await createTemplateFixture(
      pool,
      OTHER_DISCORD_GUILD_ID,
      "foreign",
      "18:00",
    );

    for (const fixture of [first, second, foreign]) {
      const created = await createEventTemplateRecurrence({
        guildDatabaseId: fixture.guildId,

        templateId: fixture.templateId,

        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

        startDate: "2026-10-05",

        createdByUserId: ADMIN_USER_ID,
      });

      expect(created.kind).toBe("created");
    }

    const listed = await listEventTemplateRecurrences(first.guildId);

    expect(listed.map((recurrence) => recurrence.templateName)).toEqual([
      "Template alpha",
      "Template beta",
    ]);
  });

  it("prevents clearing template local time while recurrence provenance depends on it", async () => {
    const fixture = await createRecurrenceFixture(pool);

    const result = await editEventTemplate({
      guildDatabaseId: fixture.guildId,

      templateId: fixture.templateId,

      localStartTime: null,
    });

    expect(result).toEqual({
      kind: "invalid_input",

      reason: "recurrence_requires_local_start_time",
    });

    const stored = await pool.query<{
      local_start_time: string | null;
    }>(
      `
              SELECT
                "local_start_time"
              FROM "event_templates"
              WHERE "id" = $1
            `,
      [fixture.templateId],
    );

    expect(stored.rows).toEqual([
      {
        local_start_time: "20:00",
      },
    ]);
  });
});

async function createRecurrenceFixture(pool: Pool): Promise<{
  guildId: number;

  templateId: number;

  recurrenceId: number;
}> {
  const template = await createTemplateFixture(
    pool,
    DISCORD_GUILD_ID,
    "main",
    "20:00",
  );

  const recurrence = await createEventTemplateRecurrence({
    guildDatabaseId: template.guildId,

    templateId: template.templateId,

    recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",

    startDate: "2026-10-05",

    createdByUserId: ADMIN_USER_ID,
  });

  if (recurrence.kind !== "created") {
    throw new Error(
      `Expected recurrence fixture creation to succeed, received "${recurrence.kind}".`,
    );
  }

  return {
    guildId: template.guildId,

    templateId: template.templateId,

    recurrenceId: recurrence.recurrence.id,
  };
}

async function createTemplateFixture(
  pool: Pool,
  discordGuildId: string,
  suffix: string,
  localStartTime: string | null,
): Promise<{
  guildId: number;

  eventTypeId: number;

  templateId: number;
}> {
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
          $2
        )
        ON CONFLICT (
          "discord_guild_id"
        )
        DO UPDATE SET
          "name" =
            "discord_guilds"."name"
        RETURNING "id"
      `,
    [discordGuildId, `Recurrence ${suffix}`],
  );

  const guildId = guildResult.rows[0]?.id;

  if (!guildId) {
    throw new Error("Expected guild fixture creation to return an ID.");
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
        VALUES (
          $1,
          $2,
          $3
        )
        RETURNING "id"
      `,
    [guildId, `naval-${suffix}`, `Naval ${suffix}`],
  );

  const eventTypeId = eventTypeResult.rows[0]?.id;

  if (!eventTypeId) {
    throw new Error("Expected event-type fixture creation to return an ID.");
  }

  const templateResult = await pool.query<{
    id: number;
  }>(
    `
        INSERT INTO "event_templates" (
          "owner_guild_id",
          "event_type_id",
          "name",
          "timezone",
          "local_start_time",
          "created_by_user_id"
        )
        VALUES (
          $1,
          $2,
          $3,
          'Europe/London',
          $4,
          $5
        )
        RETURNING "id"
      `,
    [guildId, eventTypeId, `Template ${suffix}`, localStartTime, ADMIN_USER_ID],
  );

  const templateId = templateResult.rows[0]?.id;

  if (!templateId) {
    throw new Error("Expected template fixture creation to return an ID.");
  }

  return {
    guildId,

    eventTypeId,

    templateId,
  };
}
