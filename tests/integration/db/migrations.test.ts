import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertIntegrationDatabaseIsDisposable,
  createIntegrationPool,
  resetIntegrationDatabase,
} from "../../support/integration-database.js";

describe("PostgreSQL integration test database", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createIntegrationPool();

    await assertIntegrationDatabaseIsDisposable(pool);
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs against PostgreSQL 17 in the disposable test database", async () => {
    const result = await pool.query<{
      database_name: string;
      version_num: string;
    }>(`
      SELECT
        current_database() AS database_name,
        current_setting('server_version_num') AS version_num
    `);

    const row = result.rows[0];

    expect(row).toBeDefined();
    expect(row?.database_name).toBe("holdfast_events_test");

    const versionNumber = Number(row?.version_num);

    expect(Math.floor(versionNumber / 10_000)).toBe(17);
  });

  it("applies the checked-in Drizzle migration chain to an empty database", async () => {
    const migrationsResult = await pool.query<{
      count: number;
    }>(`
      SELECT COUNT(*)::int AS count
      FROM "drizzle"."__drizzle_migrations"
    `);

    expect(migrationsResult.rows[0]?.count).toBeGreaterThan(0);

    const tablesResult = await pool.query<{
      tablename: string;
    }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const tableNames = tablesResult.rows.map((row) => row.tablename);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "discord_guilds",
        "events",
        "event_organiser_assignments",
        "role_request_groups",
        "scheduled_actions",
      ]),
    );
  });

  it("resets application data without deleting migration or test-harness metadata", async () => {
    await pool.query(`
      INSERT INTO "discord_guilds" (
        "discord_guild_id",
        "name"
      )
      VALUES (
        'integration-test-guild',
        'Integration Test Guild'
      )
    `);

    const beforeReset = await pool.query<{
      count: number;
    }>(`
      SELECT COUNT(*)::int AS count
      FROM "discord_guilds"
    `);

    expect(beforeReset.rows[0]?.count).toBe(1);

    await resetIntegrationDatabase(pool);

    const afterReset = await pool.query<{
      count: number;
    }>(`
      SELECT COUNT(*)::int AS count
      FROM "discord_guilds"
    `);

    expect(afterReset.rows[0]?.count).toBe(0);

    const migrationsResult = await pool.query<{
      count: number;
    }>(`
      SELECT COUNT(*)::int AS count
      FROM "drizzle"."__drizzle_migrations"
    `);

    expect(migrationsResult.rows[0]?.count).toBeGreaterThan(0);

    const guardResult = await pool.query<{
      count: number;
    }>(`
      SELECT COUNT(*)::int AS count
      FROM "test_harness"."database_guard"
    `);

    expect(guardResult.rows[0]?.count).toBe(1);
  });
});
