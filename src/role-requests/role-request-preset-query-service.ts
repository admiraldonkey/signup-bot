import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";

import {
  roleRequestPresetGroupOptions,
  roleRequestPresetGroups,
  roleRequestPresetOptionQualificationRoles,
  roleRequestPresetOptions,
  roleRequestPresets,
} from "../db/schema.js";

export type RoleRequestPresetSummary = {
  id: number;

  name: string;

  description: string | null;

  active: boolean;

  activeOptionCount: number;

  activeGroupCount: number;

  createdByUserId: string;

  createdAt: Date;

  updatedAt: Date;
};

export type RoleRequestPresetDetails = {
  id: number;

  name: string;

  description: string | null;

  active: boolean;

  createdByUserId: string;

  createdAt: Date;

  updatedAt: Date;

  options: {
    id: number;

    key: string;

    displayName: string;

    description: string | null;

    requestRestriction: string;

    capacity: number | null;

    sortOrder: number;

    active: boolean;

    qualificationRoles: {
      discordRoleId: string;

      roleNameSnapshot: string;

      qualificationLevel: string;
    }[];
  }[];

  groups: {
    id: number;

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
  }[];
};

export type ListRoleRequestPresetsInput = {
  guildDatabaseId: number;

  includeInactive?: boolean;
};

export type GetRoleRequestPresetDetailsInput = {
  guildDatabaseId: number;

  presetId: number;
};

export type GetRoleRequestPresetDetailsResult =
  | {
      kind: "found";

      preset: RoleRequestPresetDetails;
    }
  | {
      kind: "not_found";
    };

/**
 * Lists reusable role-request presets owned by one guild.
 *
 * Summary counts intentionally include only active child configuration
 * because they describe what would currently be available to a newly-created
 * event if that preset were applied.
 */
export async function listRoleRequestPresets(
  input: ListRoleRequestPresetsInput,
): Promise<RoleRequestPresetSummary[]> {
  const whereClause =
    input.includeInactive === true
      ? eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId)
      : and(
          eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId),

          eq(roleRequestPresets.active, true),
        );

  const presets = await db
    .select({
      id: roleRequestPresets.id,

      name: roleRequestPresets.name,

      description: roleRequestPresets.description,

      active: roleRequestPresets.active,

      createdByUserId: roleRequestPresets.createdByUserId,

      createdAt: roleRequestPresets.createdAt,

      updatedAt: roleRequestPresets.updatedAt,
    })
    .from(roleRequestPresets)
    .where(whereClause)
    .orderBy(
      asc(roleRequestPresets.name),

      asc(roleRequestPresets.id),
    );

  if (presets.length === 0) {
    return [];
  }

  const presetIds = presets.map((preset) => preset.id);

  const [optionCounts, groupCounts] = await Promise.all([
    db
      .select({
        presetId: roleRequestPresetOptions.presetId,

        count: sql<number>`count(*)::int`,
      })
      .from(roleRequestPresetOptions)
      .where(
        and(
          inArray(roleRequestPresetOptions.presetId, presetIds),

          eq(roleRequestPresetOptions.active, true),
        ),
      )
      .groupBy(roleRequestPresetOptions.presetId),

    db
      .select({
        presetId: roleRequestPresetGroups.presetId,

        count: sql<number>`count(*)::int`,
      })
      .from(roleRequestPresetGroups)
      .where(
        and(
          inArray(roleRequestPresetGroups.presetId, presetIds),

          eq(roleRequestPresetGroups.active, true),
        ),
      )
      .groupBy(roleRequestPresetGroups.presetId),
  ]);

  const optionCountByPresetId = new Map(
    optionCounts.map((row) => [row.presetId, row.count]),
  );

  const groupCountByPresetId = new Map(
    groupCounts.map((row) => [row.presetId, row.count]),
  );

  return presets.map((preset) => ({
    ...preset,

    activeOptionCount: optionCountByPresetId.get(preset.id) ?? 0,

    activeGroupCount: groupCountByPresetId.get(preset.id) ?? 0,
  }));
}

/**
 * Reads one complete reusable preset definition for administration.
 *
 * The parent preset is locked FOR SHARE for the duration of the read.
 * Compliant preset mutations take FOR UPDATE on the same parent row, so this
 * function sees either the complete state before an edit or the complete
 * state after it rather than a mixture of both.
 *
 * Inactive children are intentionally included. This is an administration
 * view, not the filtered application snapshot.
 */
export async function getRoleRequestPresetDetails(
  input: GetRoleRequestPresetDetailsInput,
): Promise<GetRoleRequestPresetDetailsResult> {
  return db.transaction(async (transaction) => {
    const [preset] = await transaction
      .select({
        id: roleRequestPresets.id,

        name: roleRequestPresets.name,

        description: roleRequestPresets.description,

        active: roleRequestPresets.active,

        createdByUserId: roleRequestPresets.createdByUserId,

        createdAt: roleRequestPresets.createdAt,

        updatedAt: roleRequestPresets.updatedAt,
      })
      .from(roleRequestPresets)
      .where(
        and(
          eq(roleRequestPresets.id, input.presetId),

          eq(roleRequestPresets.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("share");

    if (!preset) {
      return {
        kind: "not_found",
      } as const;
    }

    const options = await transaction
      .select({
        id: roleRequestPresetOptions.id,

        key: roleRequestPresetOptions.key,

        displayName: roleRequestPresetOptions.displayName,

        description: roleRequestPresetOptions.description,

        requestRestriction: roleRequestPresetOptions.requestRestriction,

        capacity: roleRequestPresetOptions.capacity,

        sortOrder: roleRequestPresetOptions.sortOrder,

        active: roleRequestPresetOptions.active,
      })
      .from(roleRequestPresetOptions)
      .where(eq(roleRequestPresetOptions.presetId, preset.id))
      .orderBy(
        asc(roleRequestPresetOptions.sortOrder),

        asc(roleRequestPresetOptions.id),
      );

    const groups = await transaction
      .select({
        id: roleRequestPresetGroups.id,

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
      })
      .from(roleRequestPresetGroups)
      .where(eq(roleRequestPresetGroups.presetId, preset.id))
      .orderBy(
        asc(roleRequestPresetGroups.sortOrder),

        asc(roleRequestPresetGroups.id),
      );

    const optionIds = options.map((option) => option.id);

    const groupIds = groups.map((group) => group.id);

    const qualificationRows =
      optionIds.length === 0
        ? []
        : await transaction
            .select({
              presetOptionId:
                roleRequestPresetOptionQualificationRoles.presetOptionId,

              discordRoleId:
                roleRequestPresetOptionQualificationRoles.discordRoleId,

              roleNameSnapshot:
                roleRequestPresetOptionQualificationRoles.roleNameSnapshot,

              qualificationLevel:
                roleRequestPresetOptionQualificationRoles.qualificationLevel,
            })
            .from(roleRequestPresetOptionQualificationRoles)
            .where(
              inArray(
                roleRequestPresetOptionQualificationRoles.presetOptionId,
                optionIds,
              ),
            )
            .orderBy(
              asc(roleRequestPresetOptionQualificationRoles.presetOptionId),

              /*
               * Present fully-qualified roles before roles which require
               * supervision. Within each level, use the snapshotted role
               * name and Discord ID for deterministic administration
               * output.
               */
              asc(roleRequestPresetOptionQualificationRoles.qualificationLevel),

              asc(roleRequestPresetOptionQualificationRoles.roleNameSnapshot),

              asc(roleRequestPresetOptionQualificationRoles.discordRoleId),
            );

    const mappingRows =
      groupIds.length === 0
        ? []
        : await transaction
            .select({
              groupId: roleRequestPresetGroupOptions.groupId,

              presetOptionId: roleRequestPresetGroupOptions.presetOptionId,

              sortOrder: roleRequestPresetGroupOptions.sortOrder,
            })
            .from(roleRequestPresetGroupOptions)
            .where(inArray(roleRequestPresetGroupOptions.groupId, groupIds))
            .orderBy(
              asc(roleRequestPresetGroupOptions.groupId),

              asc(roleRequestPresetGroupOptions.sortOrder),

              asc(roleRequestPresetGroupOptions.presetOptionId),
            );

    const qualificationRolesByOptionId = new Map<
      number,
      {
        discordRoleId: string;

        roleNameSnapshot: string;

        qualificationLevel: string;
      }[]
    >();

    for (const row of qualificationRows) {
      const existing =
        qualificationRolesByOptionId.get(row.presetOptionId) ?? [];

      existing.push({
        discordRoleId: row.discordRoleId,

        roleNameSnapshot: row.roleNameSnapshot,

        qualificationLevel: row.qualificationLevel,
      });

      qualificationRolesByOptionId.set(row.presetOptionId, existing);
    }

    const optionIdsByGroupId = new Map<number, number[]>();

    for (const row of mappingRows) {
      const existing = optionIdsByGroupId.get(row.groupId) ?? [];

      existing.push(row.presetOptionId);

      optionIdsByGroupId.set(row.groupId, existing);
    }

    return {
      kind: "found",

      preset: {
        ...preset,

        options: options.map((option) => ({
          ...option,

          qualificationRoles: qualificationRolesByOptionId.get(option.id) ?? [],
        })),

        groups: groups.map((group) => ({
          ...group,

          presetOptionIds: optionIdsByGroupId.get(group.id) ?? [],
        })),
      },
    } as const;
  });
}
