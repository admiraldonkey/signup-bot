export function isDiscordErrorCode(error: unknown, code: number): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (
    (
      error as {
        code?: unknown;
      }
    ).code === code
  );
}
