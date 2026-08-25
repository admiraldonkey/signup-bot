export const INTEGRATION_DATABASE_NAME = "holdfast_events_test";

export const INTEGRATION_DATABASE_USER = "holdfast_test";

export const INTEGRATION_DATABASE_PASSWORD = "integration_test_only";

export const INTEGRATION_DATABASE_APPLICATION_NAME =
  "holdfast_integration_tests";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function prepareIntegrationDatabaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);

  url.searchParams.set("sslmode", "disable");
  url.searchParams.set(
    "application_name",
    INTEGRATION_DATABASE_APPLICATION_NAME,
  );

  const preparedUrl = url.toString();

  assertSafeIntegrationDatabaseUrl(preparedUrl);

  return preparedUrl;
}

export function assertSafeIntegrationDatabaseUrl(rawUrl: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Integration test DATABASE_URL is not a valid URL.");
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(
      `Refusing integration database access: unexpected protocol "${url.protocol}".`,
    );
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (databaseName !== INTEGRATION_DATABASE_NAME) {
    throw new Error(
      `Refusing integration database access: expected database "${INTEGRATION_DATABASE_NAME}", received "${databaseName}".`,
    );
  }

  if (username !== INTEGRATION_DATABASE_USER) {
    throw new Error(
      `Refusing integration database access: expected user "${INTEGRATION_DATABASE_USER}", received "${username}".`,
    );
  }

  if (password !== INTEGRATION_DATABASE_PASSWORD) {
    throw new Error(
      "Refusing integration database access: the database password does not match the disposable test credential.",
    );
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing integration database access: host "${url.hostname}" is not a recognised loopback host.`,
    );
  }

  if (
    url.searchParams.get("application_name") !==
    INTEGRATION_DATABASE_APPLICATION_NAME
  ) {
    throw new Error(
      `Refusing integration database access: application_name must be "${INTEGRATION_DATABASE_APPLICATION_NAME}".`,
    );
  }

  return url;
}
