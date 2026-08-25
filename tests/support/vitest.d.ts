import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
    integrationDatabaseGuardToken: string;
  }
}

export {};
