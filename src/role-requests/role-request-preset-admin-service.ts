import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";

import {
  discordGuilds,
  roleRequestPresetGroupOptions,
  roleRequestPresetGroups,
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

export type SetRoleRequestPresetActiveInput = {
  guildDatabaseId: number;

  presetId: number;

  active: boolean;
};

export type SetRoleRequestPresetActiveResult =
  | {
      kind: "updated";

      preset: {
        id: number;

        name: string;

        active: boolean;
      };
    }
  | {
      kind: "unchanged";

      preset: {
        id: number;

        name: string;

        active: boolean;
      };
    }
  | {
      kind: "preset_not_found";
    };

export type SetRoleRequestPresetOptionActiveInput = {
  guildDatabaseId: number;

  presetId: number;

  presetOptionId: number;

  active: boolean;
};

export type SetRoleRequestPresetOptionActiveResult =
  | {
      kind: "updated";

      option: {
        id: number;

        presetId: number;

        displayName: string;

        active: boolean;
      };

      /*
       * Active groups which became unusable because this deactivation removed
       * their final active mapped role option.
       *
       * The groups themselves remain active and their mappings are preserved.
       */
      newlyInvalidActiveGroups: {
        id: number;

        name: string;
      }[];
    }
  | {
      kind: "unchanged";

      option: {
        id: number;

        presetId: number;

        displayName: string;

        active: boolean;
      };
    }
  | {
      kind: "preset_not_found";
    }
  | {
      kind: "option_not_found";
    };

export type SetRoleRequestPresetGroupActiveInput = {
  guildDatabaseId: number;

  presetId: number;

  presetGroupId: number;

  active: boolean;
};

export type SetRoleRequestPresetGroupActiveResult =
  | {
      kind: "updated";

      group: {
        id: number;

        presetId: number;

        name: string;

        active: boolean;
      };
    }
  | {
      kind: "unchanged";

      group: {
        id: number;

        presetId: number;

        name: string;

        active: boolean;
      };
    }
  | {
      kind: "preset_not_found";
    }
  | {
      kind: "group_not_found";
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

export type PresetNotifyRoleInput = {
  discordRoleId: string;

  roleNameSnapshot: string;
};

export type AddPresetRequestGroupInput = {
  guildDatabaseId: number;

  presetId: number;

  name: string;

  description: string | null;

  presetOptionIds: number[];

  /*
   * Null means "resolve the guild's current default role-request channel
   * when this preset is applied to an event".
   */
  channelId: string | null;

  notifyRole: PresetNotifyRoleInput | null;

  requiresPositiveSignup: boolean;

  openMinutesBeforeStart: number;

  closeMinutesBeforeStart: number;
};

export type AddPresetRequestGroupResult =
  | {
      kind: "added";

      group: {
        id: number;

        presetId: number;

        name: string;

        description: string | null;

        channelId: string | null;

        notifyRoleId: string | null;

        notifyRoleNameSnapshot: string | null;

        requiresPositiveSignup: boolean;

        openMinutesBeforeStart: number;

        closeMinutesBeforeStart: number;

        sortOrder: number;

        active: boolean;

        presetOptionIds: number[];
      };
    }
  | {
      kind: "preset_not_found";
    }
  | {
      kind: "invalid_input";

      reason:
        | "invalid_name"
        | "no_options"
        | "invalid_option_id"
        | "duplicate_option"
        | "option_not_found_or_inactive"
        | "invalid_channel_id"
        | "invalid_notify_role_id"
        | "invalid_notify_role_name"
        | "everyone_notify_role"
        | "invalid_open_offset"
        | "invalid_close_offset"
        | "invalid_group_window";

      presetOptionId?: number;

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
 * Activates or deactivates one reusable role-request preset.
 *
 * This changes only the availability of the reusable parent preset. Child
 * options/groups keep their own active states, and event-level snapshots
 * created by earlier applications are independent and therefore unaffected.
 *
 * Preset application takes FOR SHARE on this same parent row. Taking
 * FOR UPDATE here preserves the existing mutation/application lock contract:
 * an application sees either the complete state before this lifecycle change
 * or the complete state after it.
 */
export async function setRoleRequestPresetActive(
  input: SetRoleRequestPresetActiveInput,
): Promise<SetRoleRequestPresetActiveResult> {
  return db.transaction(async (transaction) => {
    const [preset] = await transaction
      .select({
        id: roleRequestPresets.id,

        name: roleRequestPresets.name,

        active: roleRequestPresets.active,
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

    if (preset.active === input.active) {
      return {
        kind: "unchanged",

        preset,
      } as const;
    }

    const [updatedPreset] = await transaction
      .update(roleRequestPresets)
      .set({
        active: input.active,

        updatedAt: new Date(),
      })
      .where(eq(roleRequestPresets.id, preset.id))
      .returning({
        id: roleRequestPresets.id,

        name: roleRequestPresets.name,

        active: roleRequestPresets.active,
      });

    if (!updatedPreset) {
      throw new Error(
        `Role-request preset #${preset.id} disappeared while its lifecycle state was being changed.`,
      );
    }

    return {
      kind: "updated",

      preset: updatedPreset,
    } as const;
  });
}

/**
 * Activates or deactivates one logical role option belonging to a reusable
 * role-request preset.
 *
 * The option's qualification rows and group mappings are deliberately
 * preserved. Application filters inactive options from future snapshots.
 *
 * Deactivating an option may therefore leave an otherwise-active group with
 * no active mapped options. Those groups are reported to the caller but are
 * not silently deactivated or rewritten.
 *
 * As with other preset mutations, the preset parent is locked FOR UPDATE so
 * application cannot observe the source graph halfway through this change.
 */
export async function setRoleRequestPresetOptionActive(
  input: SetRoleRequestPresetOptionActiveInput,
): Promise<SetRoleRequestPresetOptionActiveResult> {
  return db.transaction(async (transaction) => {
    const [preset] = await transaction
      .select({
        id: roleRequestPresets.id,
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

    const [option] = await transaction
      .select({
        id: roleRequestPresetOptions.id,

        presetId: roleRequestPresetOptions.presetId,

        displayName: roleRequestPresetOptions.displayName,

        active: roleRequestPresetOptions.active,
      })
      .from(roleRequestPresetOptions)
      .where(
        and(
          eq(roleRequestPresetOptions.id, input.presetOptionId),

          eq(roleRequestPresetOptions.presetId, preset.id),
        ),
      )
      .limit(1);

    if (!option) {
      return {
        kind: "option_not_found",
      } as const;
    }

    if (option.active === input.active) {
      return {
        kind: "unchanged",

        option,
      } as const;
    }

    const newlyInvalidActiveGroups: {
      id: number;

      name: string;
    }[] = [];

    if (!input.active) {
      /*
       * Work out which active groups currently depend on this option as
       * their final active mapped option.
       *
       * This is calculated while the target option is still active, under
       * the preset parent's mutation lock.
       */
      const activeGroups = await transaction
        .select({
          id: roleRequestPresetGroups.id,

          name: roleRequestPresetGroups.name,
        })
        .from(roleRequestPresetGroups)
        .where(
          and(
            eq(roleRequestPresetGroups.presetId, preset.id),

            eq(roleRequestPresetGroups.active, true),
          ),
        );

      if (activeGroups.length > 0) {
        const activeGroupIds = activeGroups.map((group) => group.id);

        const mappings = await transaction
          .select({
            groupId: roleRequestPresetGroupOptions.groupId,

            presetOptionId: roleRequestPresetGroupOptions.presetOptionId,
          })
          .from(roleRequestPresetGroupOptions)
          .where(
            inArray(roleRequestPresetGroupOptions.groupId, activeGroupIds),
          );

        const activeOptions = await transaction
          .select({
            id: roleRequestPresetOptions.id,
          })
          .from(roleRequestPresetOptions)
          .where(
            and(
              eq(roleRequestPresetOptions.presetId, preset.id),

              eq(roleRequestPresetOptions.active, true),
            ),
          );

        const activeOptionIds = new Set(
          activeOptions.map((activeOption) => activeOption.id),
        );

        /*
         * Evaluate the state that will exist after this option is retired.
         */
        activeOptionIds.delete(option.id);

        for (const group of activeGroups) {
          const groupMappings = mappings.filter(
            (mapping) => mapping.groupId === group.id,
          );

          const mapsTargetOption = groupMappings.some(
            (mapping) => mapping.presetOptionId === option.id,
          );

          if (!mapsTargetOption) {
            continue;
          }

          const keepsActiveOption = groupMappings.some((mapping) =>
            activeOptionIds.has(mapping.presetOptionId),
          );

          if (!keepsActiveOption) {
            newlyInvalidActiveGroups.push({
              id: group.id,

              name: group.name,
            });
          }
        }
      }
    }

    const now = new Date();

    const [updatedOption] = await transaction
      .update(roleRequestPresetOptions)
      .set({
        active: input.active,

        updatedAt: now,
      })
      .where(eq(roleRequestPresetOptions.id, option.id))
      .returning({
        id: roleRequestPresetOptions.id,

        presetId: roleRequestPresetOptions.presetId,

        displayName: roleRequestPresetOptions.displayName,

        active: roleRequestPresetOptions.active,
      });

    if (!updatedOption) {
      throw new Error(
        `Preset role option #${option.id} disappeared while its lifecycle state was being changed.`,
      );
    }

    /*
     * Child mutation also changes the reusable preset as a whole.
     */
    await transaction
      .update(roleRequestPresets)
      .set({
        updatedAt: now,
      })
      .where(eq(roleRequestPresets.id, preset.id));

    return {
      kind: "updated",

      option: updatedOption,

      newlyInvalidActiveGroups,
    } as const;
  });
}

/**
 * Activates or deactivates one request group belonging to a reusable
 * role-request preset.
 *
 * Group-option mappings are deliberately preserved. An inactive group is
 * simply excluded from future preset applications and can later be restored
 * without reconstructing its configuration.
 *
 * Existing event-level snapshots remain independent and are unaffected.
 *
 * As with every preset child mutation, the preset parent is locked FOR UPDATE
 * so application cannot observe the reusable source halfway through this
 * lifecycle change.
 */
export async function setRoleRequestPresetGroupActive(
  input: SetRoleRequestPresetGroupActiveInput,
): Promise<SetRoleRequestPresetGroupActiveResult> {
  return db.transaction(async (transaction) => {
    const [preset] = await transaction
      .select({
        id: roleRequestPresets.id,
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

    const [group] = await transaction
      .select({
        id: roleRequestPresetGroups.id,

        presetId: roleRequestPresetGroups.presetId,

        name: roleRequestPresetGroups.name,

        active: roleRequestPresetGroups.active,
      })
      .from(roleRequestPresetGroups)
      .where(
        and(
          eq(roleRequestPresetGroups.id, input.presetGroupId),

          eq(roleRequestPresetGroups.presetId, preset.id),
        ),
      )
      .limit(1);

    if (!group) {
      return {
        kind: "group_not_found",
      } as const;
    }

    if (group.active === input.active) {
      return {
        kind: "unchanged",

        group,
      } as const;
    }

    const now = new Date();

    const [updatedGroup] = await transaction
      .update(roleRequestPresetGroups)
      .set({
        active: input.active,

        updatedAt: now,
      })
      .where(eq(roleRequestPresetGroups.id, group.id))
      .returning({
        id: roleRequestPresetGroups.id,

        presetId: roleRequestPresetGroups.presetId,

        name: roleRequestPresetGroups.name,

        active: roleRequestPresetGroups.active,
      });

    if (!updatedGroup) {
      throw new Error(
        `Preset request group #${group.id} disappeared while its lifecycle state was being changed.`,
      );
    }

    /*
     * Child mutation changes the reusable preset as a whole, matching the
     * option/group creation and option-lifecycle behaviour.
     */
    await transaction
      .update(roleRequestPresets)
      .set({
        updatedAt: now,
      })
      .where(eq(roleRequestPresets.id, preset.id));

    return {
      kind: "updated",

      group: updatedGroup,
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

/**
 * Adds one reusable role-request group to a preset.
 *
 * The caller supplies preset option IDs in presentation order. The group and
 * every group->option mapping are persisted atomically.
 *
 * channelId deliberately remains nullable here:
 *
 * - non-null means the preset has an explicit Discord destination snapshot;
 * - null means resolve the guild's current default role-request channel when
 *   the preset is later applied to an event.
 *
 * As with every preset mutation, the preset parent is locked FOR UPDATE.
 * Preset application takes FOR SHARE on the same row, preventing application
 * from observing half of an administrative edit.
 */
export async function addPresetRequestGroup(
  input: AddPresetRequestGroupInput,
): Promise<AddPresetRequestGroupResult> {
  const name = input.name.trim();

  if (name.length === 0 || name.length > 100) {
    return {
      kind: "invalid_input",

      reason: "invalid_name",
    };
  }

  if (input.presetOptionIds.length === 0) {
    return {
      kind: "invalid_input",

      reason: "no_options",
    };
  }

  const seenOptionIds = new Set<number>();

  for (const presetOptionId of input.presetOptionIds) {
    if (!isPostgresPositiveInteger(presetOptionId)) {
      return {
        kind: "invalid_input",

        reason: "invalid_option_id",

        presetOptionId,
      };
    }

    if (seenOptionIds.has(presetOptionId)) {
      return {
        kind: "invalid_input",

        reason: "duplicate_option",

        presetOptionId,
      };
    }

    seenOptionIds.add(presetOptionId);
  }

  let channelId: string | null = null;

  if (input.channelId !== null) {
    channelId = input.channelId.trim();

    if (channelId.length === 0) {
      return {
        kind: "invalid_input",

        reason: "invalid_channel_id",
      };
    }
  }

  let notifyRole: {
    discordRoleId: string;

    roleNameSnapshot: string;
  } | null = null;

  if (input.notifyRole !== null) {
    const discordRoleId = input.notifyRole.discordRoleId.trim();

    if (discordRoleId.length === 0) {
      return {
        kind: "invalid_input",

        reason: "invalid_notify_role_id",
      };
    }

    const roleNameSnapshot = input.notifyRole.roleNameSnapshot.trim();

    if (roleNameSnapshot.length === 0 || roleNameSnapshot.length > 100) {
      return {
        kind: "invalid_input",

        reason: "invalid_notify_role_name",

        discordRoleId,
      };
    }

    notifyRole = {
      discordRoleId,

      roleNameSnapshot,
    };
  }

  if (!isPostgresInteger(input.openMinutesBeforeStart)) {
    return {
      kind: "invalid_input",

      reason: "invalid_open_offset",
    };
  }

  if (!isPostgresInteger(input.closeMinutesBeforeStart)) {
    return {
      kind: "invalid_input",

      reason: "invalid_close_offset",
    };
  }

  /*
   * Positive values are before event start.
   *
   * Therefore:
   *
   * open 60 / close 0   -> valid
   * open 60 / close -10 -> valid
   * open 0  / close 60  -> invalid
   *
   * A strict comparison also rejects zero-length request windows.
   */
  if (input.openMinutesBeforeStart <= input.closeMinutesBeforeStart) {
    return {
      kind: "invalid_input",

      reason: "invalid_group_window",
    };
  }

  const description = normaliseOptionalText(input.description);

  return db.transaction(async (transaction) => {
    /*
     * Every compliant preset mutation takes this exclusive parent lock.
     *
     * applyRoleRequestPresetToEvent() takes FOR SHARE on the same row, so
     * application sees either the complete old preset or the complete new
     * preset, never a half-created group.
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
     * Resolve the owning Discord guild only for stable snowflake semantics,
     * not for live Discord validation.
     *
     * The future command adapter remains responsible for checking whether
     * selected roles/channels currently exist and are usable.
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

    if (notifyRole?.discordRoleId === guild.discordGuildId) {
      return {
        kind: "invalid_input",

        reason: "everyone_notify_role",

        discordRoleId: notifyRole.discordRoleId,
      } as const;
    }

    /*
     * Only active options belonging to this exact preset may be exposed by
     * a new reusable group.
     */
    const availableOptions = await transaction
      .select({
        id: roleRequestPresetOptions.id,
      })
      .from(roleRequestPresetOptions)
      .where(
        and(
          eq(roleRequestPresetOptions.presetId, preset.id),

          eq(roleRequestPresetOptions.active, true),

          inArray(roleRequestPresetOptions.id, input.presetOptionIds),
        ),
      );

    const availableOptionIds = new Set(
      availableOptions.map((option) => option.id),
    );

    const unavailableOptionId = input.presetOptionIds.find(
      (presetOptionId) => !availableOptionIds.has(presetOptionId),
    );

    if (unavailableOptionId !== undefined) {
      return {
        kind: "invalid_input",

        reason: "option_not_found_or_inactive",

        presetOptionId: unavailableOptionId,
      } as const;
    }

    /*
     * The parent lock serialises normal group additions, making max+1
     * deterministic between service callers.
     */
    const [sortRow] = await transaction
      .select({
        maximum: sql<number>`coalesce(max(${roleRequestPresetGroups.sortOrder}), -1)::int`,
      })
      .from(roleRequestPresetGroups)
      .where(eq(roleRequestPresetGroups.presetId, preset.id));

    const sortOrder = (sortRow?.maximum ?? -1) + 1;

    const [group] = await transaction
      .insert(roleRequestPresetGroups)
      .values({
        presetId: preset.id,

        name,

        description,

        channelId,

        notifyRoleId: notifyRole?.discordRoleId ?? null,

        notifyRoleNameSnapshot: notifyRole?.roleNameSnapshot ?? null,

        requiresPositiveSignup: input.requiresPositiveSignup,

        openMinutesBeforeStart: input.openMinutesBeforeStart,

        closeMinutesBeforeStart: input.closeMinutesBeforeStart,

        sortOrder,

        active: true,
      })
      .returning({
        id: roleRequestPresetGroups.id,

        presetId: roleRequestPresetGroups.presetId,

        name: roleRequestPresetGroups.name,

        description: roleRequestPresetGroups.description,

        channelId: roleRequestPresetGroups.channelId,

        notifyRoleId: roleRequestPresetGroups.notifyRoleId,

        notifyRoleNameSnapshot: roleRequestPresetGroups.notifyRoleNameSnapshot,

        requiresPositiveSignup: roleRequestPresetGroups.requiresPositiveSignup,

        openMinutesBeforeStart: roleRequestPresetGroups.openMinutesBeforeStart,

        closeMinutesBeforeStart:
          roleRequestPresetGroups.closeMinutesBeforeStart,

        sortOrder: roleRequestPresetGroups.sortOrder,

        active: roleRequestPresetGroups.active,
      });

    if (!group) {
      throw new Error(
        `Failed to create a role-request group for preset #${preset.id}.`,
      );
    }

    /*
     * Preserve the administrator's supplied option order rather than the
     * unspecified order returned by PostgreSQL above.
     */
    await transaction.insert(roleRequestPresetGroupOptions).values(
      input.presetOptionIds.map((presetOptionId, index) => ({
        groupId: group.id,

        presetOptionId,

        sortOrder: index,
      })),
    );

    const now = new Date();

    await transaction
      .update(roleRequestPresets)
      .set({
        updatedAt: now,
      })
      .where(eq(roleRequestPresets.id, preset.id));

    return {
      kind: "added",

      group: {
        ...group,

        presetOptionIds: [...input.presetOptionIds],
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

const POSTGRES_INTEGER_MIN = -2_147_483_648;

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function isPostgresInteger(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= POSTGRES_INTEGER_MIN &&
    value <= POSTGRES_INTEGER_MAX
  );
}

function isPostgresPositiveInteger(value: number): boolean {
  return isPostgresInteger(value) && value > 0;
}
