import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({
  poolErrorHandler: null as ((error: unknown) => void) | null,
}));

vi.mock("pg", () => ({
  Pool: class {
    on(event: string, handler: (error: unknown) => void): this {
      if (event === "error") {
        pgMock.poolErrorHandler = handler;
      }

      return this;
    }
  },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({})),
}));

describe("PostgreSQL client", () => {
  beforeAll(async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test-user:test-password@localhost:5432/test-database",
    );
    vi.stubEnv("DATABASE_TLS", "false");

    await import("../../../src/db/client.js");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("logs only sanitised PostgreSQL pool error fields", () => {
    // Arrange
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const cause = Object.assign(
      new Error("Connection terminated unexpectedly"),
      {
        code: "ECONNRESET",
      },
    );

    const error = Object.assign(
      new Error("terminating connection due to administrator command"),
      {
        code: "57P01",
        cause,
        client: {
          connectionParameters: {
            user: "private-user",
            password: "private-password",
            host: "private-host",
            database: "private-database",
          },
          secretKey: "private-secret-key",
          socket: {
            internalState: "private-socket-state",
          },
        },
      },
    );

    if (!pgMock.poolErrorHandler) {
      throw new Error("PostgreSQL pool error handler was not registered.");
    }

    // Act
    pgMock.poolErrorHandler(error);

    // Assert
    expect(consoleErrorSpy).toHaveBeenCalledOnce();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Unexpected PostgreSQL pool error:",
      {
        message: "terminating connection due to administrator command",
        code: "57P01",
        causeMessage: "Connection terminated unexpectedly",
        causeCode: "ECONNRESET",
      },
    );

    const loggedArguments = consoleErrorSpy.mock.calls[0];

    expect(JSON.stringify(loggedArguments)).not.toContain("private-user");
    expect(JSON.stringify(loggedArguments)).not.toContain("private-password");
    expect(JSON.stringify(loggedArguments)).not.toContain("private-host");
    expect(JSON.stringify(loggedArguments)).not.toContain("private-database");
    expect(JSON.stringify(loggedArguments)).not.toContain("private-secret-key");
    expect(JSON.stringify(loggedArguments)).not.toContain(
      "private-socket-state",
    );

    consoleErrorSpy.mockRestore();
  });
});
