import type { Pool } from "pg";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIntegrationPool } from "../../support/integration-database.js";

describe("event-template schema reconciliation", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createIntegrationPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies the reconciled template schema through the migration chain", async () => {
    const tables = await pool.query<{
      organiser_defaults: string | null;
      ping_roles: string | null;
      reminders: string | null;
      obsolete_role_options: string | null;
    }>(`
      SELECT
        to_regclass(
          'public.event_template_organiser_defaults'
        )::text AS organiser_defaults,
        to_regclass(
          'public.event_template_ping_roles'
        )::text AS ping_roles,
        to_regclass(
          'public.event_template_reminders'
        )::text AS reminders,
        to_regclass(
          'public.template_role_options'
        )::text AS obsolete_role_options
    `);

    expect(tables.rows).toEqual([
      {
        organiser_defaults: "event_template_organiser_defaults",
        ping_roles: "event_template_ping_roles",
        reminders: "event_template_reminders",
        obsolete_role_options: null,
      },
    ]);

    const templateColumns = await pool.query<{
      column_name: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT
        "column_name",
        "is_nullable"
      FROM "information_schema"."columns"
      WHERE
        "table_schema" = 'public'
        AND "table_name" = 'event_templates'
      ORDER BY "column_name"
    `);

    const templateColumnsByName = new Map(
      templateColumns.rows.map((column) => [column.column_name, column]),
    );

    expect(templateColumnsByName.get("audience_id")).toEqual({
      column_name: "audience_id",
      is_nullable: "YES",
    });

    expect(templateColumnsByName.get("role_request_preset_id")).toEqual({
      column_name: "role_request_preset_id",
      is_nullable: "YES",
    });

    expect(templateColumnsByName.get("signups_enabled")).toEqual({
      column_name: "signups_enabled",
      is_nullable: "NO",
    });

    expect(templateColumnsByName.get("show_detailed_deadline")).toEqual({
      column_name: "show_detailed_deadline",
      is_nullable: "NO",
    });

    expect(templateColumnsByName.get("publication_mode")).toEqual({
      column_name: "publication_mode",
      is_nullable: "NO",
    });

    expect(templateColumnsByName.get("publish_minutes_before_start")).toEqual({
      column_name: "publish_minutes_before_start",
      is_nullable: "YES",
    });

    expect(templateColumnsByName.get("publication_channel_id")).toEqual({
      column_name: "publication_channel_id",
      is_nullable: "YES",
    });

    expect(templateColumnsByName.get("created_by_user_id")).toEqual({
      column_name: "created_by_user_id",
      is_nullable: "NO",
    });

    expect(templateColumnsByName.get("duration_minutes")).toEqual({
      column_name: "duration_minutes",
      is_nullable: "NO",
    });

    for (const obsoleteColumn of [
      "recurrence_rule",
      "attendance_open_minutes_before",
      "role_requests_open_minutes_before",
      "attendance_channel_id",
      "role_request_channel_id",
      "ping_role_id",
    ]) {
      expect(templateColumnsByName.has(obsoleteColumn)).toBe(false);
    }

    const roleOptionColumns = await pool.query<{
      column_name: string;
    }>(`
      SELECT "column_name"
      FROM "information_schema"."columns"
      WHERE
        "table_schema" = 'public'
        AND "table_name" = 'event_role_options'
    `);

    expect(
      roleOptionColumns.rows.some(
        (column) => column.column_name === "source_template_role_option_id",
      ),
    ).toBe(false);

    const eventColumns = await pool.query<{
      column_name: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT
        "column_name",
        "is_nullable"
      FROM "information_schema"."columns"
      WHERE
        "table_schema" = 'public'
        AND "table_name" = 'events'
        AND "column_name" = 'template_source_updated_at'
    `);

    expect(eventColumns.rows).toEqual([
      {
        column_name: "template_source_updated_at",

        is_nullable: "YES",
      },
    ]);
  });

  it("uses the intended ownership behaviour for template foreign keys", async () => {
    const constraints = await pool.query<{
      conname: string;
      definition: string;
    }>(`
      SELECT
        "conname",
        pg_get_constraintdef("oid") AS "definition"
      FROM "pg_constraint"
      WHERE "conname" IN (
        'evt_tpl_org_tpl_fk',
        'evt_tpl_ping_roles_tpl_fk',
        'evt_tpl_reminders_tpl_fk',
        'evt_tpl_audience_fk',
        'evt_tpl_preset_fk',
        'events_template_id_event_templates_id_fk'
      )
      ORDER BY "conname"
    `);

    const definitions = new Map(
      constraints.rows.map((constraint) => [
        constraint.conname,
        constraint.definition,
      ]),
    );

    expect(definitions.get("evt_tpl_org_tpl_fk")).toContain(
      "ON DELETE CASCADE",
    );

    expect(definitions.get("evt_tpl_ping_roles_tpl_fk")).toContain(
      "ON DELETE CASCADE",
    );

    expect(definitions.get("evt_tpl_reminders_tpl_fk")).toContain(
      "ON DELETE CASCADE",
    );

    expect(definitions.get("evt_tpl_audience_fk")).toContain(
      "ON DELETE SET NULL",
    );

    expect(definitions.get("evt_tpl_preset_fk")).toContain(
      "ON DELETE SET NULL",
    );

    expect(
      definitions.get("events_template_id_event_templates_id_fk"),
    ).toContain("ON DELETE RESTRICT");
  });

  it("enforces template publication and organiser source constraints", async () => {
    const constraints = await pool.query<{
      conname: string;
    }>(`
      SELECT "conname"
      FROM "pg_constraint"
      WHERE "conname" IN (
        'evt_tpl_pub_mode_chk',
        'evt_tpl_pub_offset_chk',
        'evt_tpl_org_slot_chk',
        'evt_tpl_org_defaults_pk',
        'evt_tpl_ping_roles_pk'
      )
      ORDER BY "conname"
    `);

    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "evt_tpl_org_defaults_pk",
      "evt_tpl_org_slot_chk",
      "evt_tpl_ping_roles_pk",
      "evt_tpl_pub_mode_chk",
      "evt_tpl_pub_offset_chk",
    ]);
  });
});
