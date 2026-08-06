import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not configured.");
}

function readBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["true", "1", "yes"].includes(value.trim().toLowerCase());
}

const databaseTlsEnabled = readBoolean(process.env.DATABASE_TLS);

export const pool = new Pool({
  connectionString: databaseUrl,

  /*
   * Northflank has TLS enabled on the addon, so validate the certificate
   * using the certificate authorities installed in the container.
   */
  ssl: databaseTlsEnabled
    ? {
        rejectUnauthorized: true,
      }
    : undefined,

  /*
   * Small bot so restrict db connections.
   */
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

export const db = drizzle({
  client: pool,
  schema,
});
