import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * Unit and integration tests require different runner configuration,
     * but coverage should represent both suites as one application-level
     * report.
     */
    projects: ["./vitest.config.ts", "./vitest.integration.config.ts"],

    coverage: {
      provider: "v8",

      reporter: ["text", "html"],

      reportsDirectory: "coverage",

      include: ["src/**/*.ts"],
    },
  },
});
