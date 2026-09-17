export const MAX_ROLE_REQUEST_GROUP_NOTIFICATION_ROLES = 4;

export type RoleRequestGroupNotificationRoleInput = {
  discordRoleId: string;

  roleNameSnapshot: string;
};

export type NormalisedRoleRequestGroupNotificationRole = {
  discordRoleId: string;

  roleNameSnapshot: string;

  sortOrder: number;
};

export type NormaliseRoleRequestGroupNotificationRolesResult =
  | {
      ok: true;

      roles: NormalisedRoleRequestGroupNotificationRole[];
    }
  | {
      ok: false;

      reason:
        | "too_many_notification_roles"
        | "invalid_notify_role_id"
        | "invalid_notify_role_name"
        | "duplicate_notification_role";

      discordRoleId?: string;
    };

export function normaliseRoleRequestGroupNotificationRoles(
  roles: RoleRequestGroupNotificationRoleInput[],
): NormaliseRoleRequestGroupNotificationRolesResult {
  if (roles.length > MAX_ROLE_REQUEST_GROUP_NOTIFICATION_ROLES) {
    return {
      ok: false,

      reason: "too_many_notification_roles",
    };
  }

  const seenRoleIds = new Set<string>();

  const normalised: NormalisedRoleRequestGroupNotificationRole[] = [];

  for (const [index, role] of roles.entries()) {
    const discordRoleId = role.discordRoleId.trim();

    if (discordRoleId.length === 0) {
      return {
        ok: false,

        reason: "invalid_notify_role_id",
      };
    }

    if (seenRoleIds.has(discordRoleId)) {
      return {
        ok: false,

        reason: "duplicate_notification_role",

        discordRoleId,
      };
    }

    const roleNameSnapshot = role.roleNameSnapshot.trim();

    if (roleNameSnapshot.length === 0 || roleNameSnapshot.length > 100) {
      return {
        ok: false,

        reason: "invalid_notify_role_name",

        discordRoleId,
      };
    }

    seenRoleIds.add(discordRoleId);

    normalised.push({
      discordRoleId,

      roleNameSnapshot,

      sortOrder: index,
    });
  }

  return {
    ok: true,

    roles: normalised,
  };
}
