export function formatUserMentions(
  userIds: readonly string[],
  maxLength = 1000,
): string {
  if (userIds.length === 0) {
    return "None";
  }

  let output = "";
  let shown = 0;

  for (const userId of userIds) {
    const line = `<@${userId}>\n`;

    /*
     * Leave enough room for a "+ N more" suffix.
     */
    if (output.length + line.length > maxLength - 30) {
      break;
    }

    output += line;
    shown += 1;
  }

  const remaining = userIds.length - shown;

  if (remaining > 0) {
    output += `+ ${remaining} more`;
  }

  return output.trim();
}
