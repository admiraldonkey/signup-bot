import { Pool } from "pg";
import { inject } from "vitest";

import {
  INTEGRATION_DATABASE_NAME,
  INTEGRATION_DATABASE_USER,
  assertSafeIntegrationDatabaseUrl,
} from "./integration-database-safety.js";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function getIntegrationDatabaseUrl(): string {
  const databaseUrl = inject("integrationDatabaseUrl");

  assertSafeIntegrationDatabaseUrl(databaseUrl);

  return databaseUrl;
}

export function createIntegrationPool(): Pool {
  return new Pool({
    connectionString: getIntegrationDatabaseUrl(),
    max: 5,
  });
}

export async function assertIntegrationDatabaseIsDisposable(
  pool: Pool,
): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `Refusing destructive database test operation because NODE_ENV is "${process.env.NODE_ENV ?? "<unset>"}", not "test".`,
    );
  }

  const databaseUrl = getIntegrationDatabaseUrl();

  assertSafeIntegrationDatabaseUrl(databaseUrl);

  const identityResult = await pool.query<{
    database_name: string;
    user_name: string;
  }>(`
    SELECT
      current_database() AS database_name,
      current_user AS user_name
  `);

  const identity = identityResult.rows[0];

  if (!identity) {
    throw new Error("Could not verify integration database identity.");
  }

  if (identity.database_name !== INTEGRATION_DATABASE_NAME) {
    throw new Error(
      `Refusing destructive database test operation: PostgreSQL reports database "${identity.database_name}", expected "${INTEGRATION_DATABASE_NAME}".`,
    );
  }

  if (identity.user_name !== INTEGRATION_DATABASE_USER) {
    throw new Error(
      `Refusing destructive database test operation: PostgreSQL reports user "${identity.user_name}", expected "${INTEGRATION_DATABASE_USER}".`,
    );
  }

  const expectedGuardToken = inject("integrationDatabaseGuardToken");

  const guardResult = await pool.query<{
    token: string;
  }>(`
    SELECT "token"
    FROM "test_harness"."database_guard"
  `);

  if (
    guardResult.rows.length !== 1 ||
    guardResult.rows[0]?.token !== expectedGuardToken
  ) {
    throw new Error(
      "Refusing destructive database test operation: the Testcontainers database guard token is missing or incorrect.",
    );
  }
}

export async function resetIntegrationDatabase(pool: Pool): Promise<void> {
  await assertIntegrationDatabaseIsDisposable(pool);

  const tablesResult = await pool.query<{
    tablename: string;
  }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const tableNames = tablesResult.rows.map((row) => row.tablename);

  /*
   * These tables are part of the core application schema. Their absence
   * strongly suggests migrations did not complete or we are connected to
   * something other than the expected test database.
   */
  if (
    !tableNames.includes("discord_guilds") ||
    !tableNames.includes("events")
  ) {
    throw new Error(
      "Refusing database reset because the expected migrated application tables are missing.",
    );
  }

  if (tableNames.length === 0) {
    throw new Error(
      "Refusing database reset because no public application tables were found.",
    );
  }

  const qualifiedTableNames = tableNames
    .map((tableName) => `"public".${quoteIdentifier(tableName)}`)
    .join(", ");

  await pool.query(`
    TRUNCATE TABLE ${qualifiedTableNames}
    RESTART IDENTITY
    CASCADE
  `);
}
