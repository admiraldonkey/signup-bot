import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";

import {
  INTEGRATION_DATABASE_NAME,
  INTEGRATION_DATABASE_PASSWORD,
  INTEGRATION_DATABASE_USER,
  prepareIntegrationDatabaseUrl,
} from "./integration-database-safety.js";

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase(INTEGRATION_DATABASE_NAME)
    .withUsername(INTEGRATION_DATABASE_USER)
    .withPassword(INTEGRATION_DATABASE_PASSWORD)
    .start();

  try {
    const databaseUrl = prepareIntegrationDatabaseUrl(
      container.getConnectionUri(),
    );

    const guardToken = randomUUID();

    const migrationPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
    });

    try {
      const migrationDb = drizzle({
        client: migrationPool,
      });

      /*
       * Apply the real migration files committed to this repository.
       *
       * We deliberately do not use drizzle-kit push here. Deployment uses
       * migrations, so the integration suite should prove that the actual
       * migration chain works from an empty PostgreSQL database.
       */
      await migrate(migrationDb, {
        migrationsFolder: resolve(process.cwd(), "drizzle"),
      });

      /*
       * This schema exists only inside the disposable test database.
       *
       * The random token proves that later destructive reset operations are
       * connected to the exact database created by this test run, rather
       * than merely to some database with a similar-looking name.
       */
      await migrationPool.query('CREATE SCHEMA "test_harness"');

      await migrationPool.query(`
        CREATE TABLE "test_harness"."database_guard" (
          "token" text PRIMARY KEY
        )
      `);

      await migrationPool.query(
        `
          INSERT INTO "test_harness"."database_guard" ("token")
          VALUES ($1)
        `,
        [guardToken],
      );
    } finally {
      await migrationPool.end();
    }

    project.provide("integrationDatabaseUrl", databaseUrl);

    project.provide("integrationDatabaseGuardToken", guardToken);

    return async () => {
      await container.stop();
    };
  } catch (error) {
    await container.stop();
    throw error;
  }
}
