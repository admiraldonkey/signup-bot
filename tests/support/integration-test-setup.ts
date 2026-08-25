import { inject } from "vitest";

import { assertSafeIntegrationDatabaseUrl } from "./integration-database-safety.js";

const databaseUrl = inject("integrationDatabaseUrl");

assertSafeIntegrationDatabaseUrl(databaseUrl);

/*
 * Production database modules read DATABASE_URL when they are imported.
 *
 * Vitest setup files run before the test file in the same worker process,
 * so production modules imported by an integration test will see this
 * disposable Testcontainers database rather than the developer's .env
 * DATABASE_URL.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = databaseUrl;
process.env.DATABASE_TLS = "false";
