import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";

import {
  discordGuilds,
  roleRequestPresetOptionQualificationRoles,
  roleRequestPresetOptions,
  roleRequestPresets,
} from "../db/schema.js";

export type CreateRoleRequestPresetInput = {
  guildDatabaseId: number;

  name: string;

  description: string | null;

  createdByUserId: string;
};

export type CreateRoleRequestPresetResult =
  | {
      kind: "created";

      preset: {
        id: number;

        name: string;

        description: string | null;

        active: boolean;

        createdByUserId: string;
      };
    }
  | {
      kind: "guild_not_found";
    }
  | {
      kind: "name_conflict";

      name: string;
    }
  | {
      kind: "invalid_input";

      reason: "invalid_name";
    };

export type PresetQualificationRoleInput = {
  discordRoleId: string;

  roleNameSnapshot: string;

  qualificationLevel: string;
};

export type AddPresetRoleOptionInput = {
  guildDatabaseId: number;

  presetId: number;

  displayName: string;

  description: string | null;

  requestRestriction: string;

  capacity: number | null;

  qualificationRoles: PresetQualificationRoleInput[];
};

export type AddPresetRoleOptionResult =
  | {
      kind: "added";

      option: {
        id: number;

        presetId: number;

        key: string;

        displayName: string;

        description: string | null;

        requestRestriction: "open" | "qualified_only";

        capacity: number | null;

        sortOrder: number;

        active: boolean;
      };
    }
  | {
      kind: "preset_not_found";
    }
  | {
      kind: "key_conflict";

      key: string;
    }
  | {
      kind: "invalid_input";

      reason:
        | "invalid_name"
        | "invalid_request_restriction"
        | "invalid_capacity"
        | "invalid_qualification_level"
        | "invalid_qualification_role_id"
        | "invalid_qualification_role_name"
        | "duplicate_qualification_role"
        | "everyone_qualification_role"
        | "missing_qualification_roles";

      discordRoleId?: string;
    };

type RequestRestriction = "open" | "qualified_only";

type QualificationLevel = "qualified" | "supervision_required";

type NormalisedQualificationRole = {
  discordRoleId: string;

  roleNameSnapshot: string;

  qualificationLevel: QualificationLevel;
};

/**
 * Creates the reusable preset parent record.
 *
 * This operation deliberately creates only the preset identity. Role options
 * and request groups are separate authoritative mutations so future Discord
 * administration can build/edit a preset incrementally.
 */
export async function createRoleRequestPreset(
  input: CreateRoleRequestPresetInput,
): Promise<CreateRoleRequestPresetResult> {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 100) {
    return {
      kind: "invalid_input",

      reason: "invalid_name",
    };
  }

  const description = normaliseOptionalText(input.description);

  return db.transaction(async (transaction) => {
    /*
     * Keep the owning guild stable until the child insert commits.
     *
     * Normal command callers will already have resolved guild
     * configuration, but future non-command callers should receive a
     * domain result rather than an opaque foreign-key failure.
     */
    const [guild] = await transaction
      .select({
        id: discordGuilds.id,
      })
      .from(discordGuilds)
      .where(eq(discordGuilds.id, input.guildDatabaseId))
      .limit(1)
      .for("share");

    if (!guild) {
      return {
        kind: "guild_not_found",
      } as const;
    }

    const [preset] = await transaction
      .insert(roleRequestPresets)
      .values({
        ownerGuildId: input.guildDatabaseId,

        name,

        description,

        active: true,

        createdByUserId: input.createdByUserId,
      })
      .onConflictDoNothing({
        target: [roleRequestPresets.ownerGuildId, roleRequestPresets.name],
      })
      .returning({
        id: roleRequestPresets.id,

        name: roleRequestPresets.name,

        description: roleRequestPresets.description,

        active: roleRequestPresets.active,

        createdByUserId: roleRequestPresets.createdByUserId,
      });

    if (!preset) {
      return {
        kind: "name_conflict",

        name,
      } as const;
    }

    return {
      kind: "created",

      preset,
    } as const;
  });
}

/**
 * Adds one logical requestable role to a reusable preset.
 *
 * Qualification-role metadata is created in the same transaction as the
 * option so a qualified-only option can never become visible without the
 * rules required to interpret it.
 *
 * Mutating an existing preset takes FOR UPDATE on the preset parent. Preset
 * application takes FOR SHARE on the same row, giving the source snapshot a
 * stable shared/exclusive lock contract.
 */
export async function addPresetRoleOption(
  input: AddPresetRoleOptionInput,
): Promise<AddPresetRoleOptionResult> {
  const displayName = input.displayName.trim();

  const key = makeRoleOptionKey(displayName);

  if (displayName.length === 0 || displayName.length > 100 || key === null) {
    return {
      kind: "invalid_input",

      reason: "invalid_name",
    };
  }

  if (!isRequestRestriction(input.requestRestriction)) {
    return {
      kind: "invalid_input",

      reason: "invalid_request_restriction",
    };
  }

  /*
   * Capture the narrowed value before entering the asynchronous transaction.
   *
   * TypeScript does not preserve narrowing on a mutable object property
   * across a callback boundary, whereas this local constant remains
   * permanently narrowed to the supported domain values.
   */
  const requestRestriction = input.requestRestriction;

  if (
    input.capacity !== null &&
    (!Number.isSafeInteger(input.capacity) || input.capacity <= 0)
  ) {
    return {
      kind: "invalid_input",

      reason: "invalid_capacity",
    };
  }

  const qualificationResult = normaliseQualificationRoles(
    input.qualificationRoles,
  );

  if (!qualificationResult.ok) {
    return {
      kind: "invalid_input",

      reason: qualificationResult.reason,

      ...(qualificationResult.discordRoleId
        ? {
            discordRoleId: qualificationResult.discordRoleId,
          }
        : {}),
    };
  }

  const qualificationRoles = qualificationResult.roles;

  if (
    requestRestriction === "qualified_only" &&
    qualificationRoles.length === 0
  ) {
    return {
      kind: "invalid_input",

      reason: "missing_qualification_roles",
    };
  }

  const description = normaliseOptionalText(input.description);

  return db.transaction(async (transaction) => {
    /*
     * Application takes FOR SHARE on this parent. Every mutation service
     * should take FOR UPDATE so application can never observe a preset
     * halfway through an administrative edit.
     */
    const [preset] = await transaction
      .select({
        id: roleRequestPresets.id,

        ownerGuildId: roleRequestPresets.ownerGuildId,
      })
      .from(roleRequestPresets)
      .where(
        and(
          eq(roleRequestPresets.id, input.presetId),

          eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("update");

    if (!preset) {
      return {
        kind: "preset_not_found",
      } as const;
    }

    /*
     * Discord's @everyone role has the same snowflake as the guild.
     *
     * Resolve the owning Discord guild from authoritative database state
     * rather than asking callers to duplicate this rule.
     */
    const [guild] = await transaction
      .select({
        discordGuildId: discordGuilds.discordGuildId,
      })
      .from(discordGuilds)
      .where(eq(discordGuilds.id, preset.ownerGuildId))
      .limit(1);

    if (!guild) {
      throw new Error(
        `Preset #${preset.id} references missing guild #${preset.ownerGuildId}.`,
      );
    }

    const everyoneRole = qualificationRoles.find(
      (role) => role.discordRoleId === guild.discordGuildId,
    );

    if (everyoneRole) {
      return {
        kind: "invalid_input",

        reason: "everyone_qualification_role",

        discordRoleId: everyoneRole.discordRoleId,
      } as const;
    }

    /*
     * Parent FOR UPDATE serialises normal option additions, so max+1 is
     * deterministic between service callers even when several admins are
     * editing the same preset.
     */
    const [sortRow] = await transaction
      .select({
        maximum: sql<number>`coalesce(max(${roleRequestPresetOptions.sortOrder}), -1)::int`,
      })
      .from(roleRequestPresetOptions)
      .where(eq(roleRequestPresetOptions.presetId, preset.id));

    const sortOrder = (sortRow?.maximum ?? -1) + 1;

    /*
     * The database unique constraint remains the final authority for key
     * conflicts. Using ON CONFLICT also keeps a non-service writer from
     * turning a normal duplicate into a partially-created option.
     */
    const [option] = await transaction
      .insert(roleRequestPresetOptions)
      .values({
        presetId: preset.id,

        key,

        displayName,

        description,

        requestRestriction,

        capacity: input.capacity,

        sortOrder,

        active: true,
      })
      .onConflictDoNothing({
        target: [
          roleRequestPresetOptions.presetId,

          roleRequestPresetOptions.key,
        ],
      })
      .returning({
        id: roleRequestPresetOptions.id,

        presetId: roleRequestPresetOptions.presetId,

        key: roleRequestPresetOptions.key,

        displayName: roleRequestPresetOptions.displayName,

        description: roleRequestPresetOptions.description,

        requestRestriction: roleRequestPresetOptions.requestRestriction,

        capacity: roleRequestPresetOptions.capacity,

        sortOrder: roleRequestPresetOptions.sortOrder,

        active: roleRequestPresetOptions.active,
      });

    if (!option) {
      return {
        kind: "key_conflict",

        key,
      } as const;
    }

    if (qualificationRoles.length > 0) {
      await transaction
        .insert(roleRequestPresetOptionQualificationRoles)
        .values(
          qualificationRoles.map((role) => ({
            presetOptionId: option.id,

            discordRoleId: role.discordRoleId,

            roleNameSnapshot: role.roleNameSnapshot,

            qualificationLevel: role.qualificationLevel,
          })),
        );
    }

    /*
     * Treat child mutation as modification of the preset as a whole.
     * This will make future list/edit UIs report a meaningful updatedAt.
     */
    const now = new Date();

    await transaction
      .update(roleRequestPresets)
      .set({
        updatedAt: now,
      })
      .where(eq(roleRequestPresets.id, preset.id));

    return {
      kind: "added",

      option: {
        ...option,

        requestRestriction,
      },
    } as const;
  });
}

function normaliseQualificationRoles(roles: PresetQualificationRoleInput[]):
  | {
      ok: true;

      roles: NormalisedQualificationRole[];
    }
  | {
      ok: false;

      reason:
        | "invalid_qualification_level"
        | "invalid_qualification_role_id"
        | "invalid_qualification_role_name"
        | "duplicate_qualification_role";

      discordRoleId?: string;
    } {
  const normalised: NormalisedQualificationRole[] = [];

  const seenRoleIds = new Set<string>();

  for (const role of roles) {
    const discordRoleId = role.discordRoleId.trim();

    if (discordRoleId.length === 0) {
      return {
        ok: false,

        reason: "invalid_qualification_role_id",
      };
    }

    if (seenRoleIds.has(discordRoleId)) {
      return {
        ok: false,

        reason: "duplicate_qualification_role",

        discordRoleId,
      };
    }

    if (!isQualificationLevel(role.qualificationLevel)) {
      return {
        ok: false,

        reason: "invalid_qualification_level",

        discordRoleId,
      };
    }

    const roleNameSnapshot = role.roleNameSnapshot.trim();

    if (roleNameSnapshot.length === 0 || roleNameSnapshot.length > 100) {
      return {
        ok: false,

        reason: "invalid_qualification_role_name",

        discordRoleId,
      };
    }

    seenRoleIds.add(discordRoleId);

    normalised.push({
      discordRoleId,

      roleNameSnapshot,

      qualificationLevel: role.qualificationLevel,
    });
  }

  return {
    ok: true,

    roles: normalised,
  };
}

function isRequestRestriction(value: string): value is RequestRestriction {
  return value === "open" || value === "qualified_only";
}

function isQualificationLevel(value: string): value is QualificationLevel {
  return value === "qualified" || value === "supervision_required";
}

function makeRoleOptionKey(displayName: string): string | null {
  const key = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return key || null;
}

function normaliseOptionalText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed || null;
}
