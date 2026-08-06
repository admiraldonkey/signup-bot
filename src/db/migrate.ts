import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db } from "./client.js";

export async function runMigrations(): Promise<void> {
  console.log("Checking database migrations...");

  await migrate(db, {
    migrationsFolder: "./drizzle",
  });

  console.log("Database migrations are up to date.");
}
