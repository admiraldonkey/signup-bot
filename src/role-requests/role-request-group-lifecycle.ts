export type RoleRequestGroupLifecycleState =
  | "planned"
  | "pending_publication"
  | "open"
  | "closed";

export type RoleRequestGroupLifecycleInput = {
  opensAt: Date;

  closesAt: Date;

  closedAt: Date | null;

  messageId: string | null;
};

/**
 * Resolves the administrator-facing lifecycle state of one role-request
 * group from authoritative event-level snapshot state.
 *
 * A group is not considered open merely because its scheduled opening time
 * has arrived. Until Discord publication succeeds and messageId is linked,
 * members do not have a usable request message, so the more accurate state
 * is pending publication.
 */
export function resolveRoleRequestGroupLifecycleState(
  group: RoleRequestGroupLifecycleInput,

  now = new Date(),
): RoleRequestGroupLifecycleState {
  if (group.closedAt !== null || group.closesAt <= now) {
    return "closed";
  }

  if (group.messageId !== null) {
    return "open";
  }

  if (group.opensAt > now) {
    return "planned";
  }

  return "pending_publication";
}
