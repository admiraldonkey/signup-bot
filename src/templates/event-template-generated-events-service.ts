import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  eventRecurrenceOccurrences,
  events,
  eventTemplates,
  scheduledActions,
} from "../db/schema.js";

export type TemplateGeneratedEventRevisionState =
  | "current"
  | "older"
  | "unknown";

export type TemplateGeneratedEventSummary = {
  id: number;

  name: string;

  startsAt: Date;

  status: "scheduled" | "open" | "closed" | "cancelled" | "completed";

  publishedAt: Date | null;

  publicationActionStatus:
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled"
    | null;

  publicationDueAt: Date | null;

  recurrenceOccurrenceDate: string | null;

  templateSourceUpdatedAt: Date | null;

  templateRevisionState: TemplateGeneratedEventRevisionState;
};

export type ListGeneratedEventsForTemplateInput = {
  guildDatabaseId: number;

  templateId: number;

  /*
   * False by default.
   *
   * The normal administrator view shows events whose current startsAt value
   * has not yet passed. This deliberately follows the ordinary event snapshot
   * rather than the original recurrence slot.
   */
  includePast?: boolean;

  /*
   * Production callers omit this.
   *
   * Tests and deterministic administrative tooling may supply one stable
   * current instant.
   */
  now?: Date;
};

export type ListGeneratedEventsForTemplateResult =
  | {
      kind: "found";

      template: {
        id: number;

        name: string;

        updatedAt: Date;
      };

      events: TemplateGeneratedEventSummary[];
    }
  | {
      kind: "template_not_found";
    };

/**
 * Lists ordinary events previously generated from one guild-owned template.
 *
 * Runtime event configuration is read from the event and its event-owned
 * durable state. The current template is used only to establish ownership,
 * identify the source and compare exact source-revision provenance.
 *
 * Recurrence provenance is optional because one-off template generation and
 * automatic recurrence both produce ordinary events.
 */
export async function listGeneratedEventsForTemplate(
  input: ListGeneratedEventsForTemplateInput,
): Promise<ListGeneratedEventsForTemplateResult> {
  const includePast = input.includePast ?? false;

  const now = input.now ?? new Date();

  return db.transaction(async (transaction) => {
    /*
     * This is both the authoritative guild-ownership check and a stable current
     * template revision for the duration of inspection.
     *
     * Template mutations use FOR UPDATE on this row. FOR SHARE therefore stops
     * the current-revision comparison changing halfway through this read.
     */
    const [template] = await transaction
      .select({
        id: eventTemplates.id,

        name: eventTemplates.name,

        updatedAt: eventTemplates.updatedAt,
      })
      .from(eventTemplates)
      .where(
        and(
          eq(eventTemplates.id, input.templateId),

          eq(eventTemplates.ownerGuildId, input.guildDatabaseId),
        ),
      )
      .limit(1)
      .for("share");

    if (!template) {
      return {
        kind: "template_not_found",
      } as const;
    }

    const eventFilter = includePast
      ? and(
          eq(events.templateId, template.id),

          eq(events.ownerGuildId, input.guildDatabaseId),
        )
      : and(
          eq(events.templateId, template.id),

          eq(events.ownerGuildId, input.guildDatabaseId),

          gte(events.startsAt, now),
        );

    const rows = await transaction
      .select({
        id: events.id,

        name: events.name,

        startsAt: events.startsAt,

        status: events.status,

        publishedAt: events.publishedAt,

        publicationActionStatus: scheduledActions.status,

        publicationDueAt: scheduledActions.dueAt,

        recurrenceOccurrenceDate: eventRecurrenceOccurrences.occurrenceDate,

        templateSourceUpdatedAt: events.templateSourceUpdatedAt,
      })
      .from(events)
      .leftJoin(
        eventRecurrenceOccurrences,

        eq(eventRecurrenceOccurrences.eventId, events.id),
      )
      .leftJoin(
        scheduledActions,

        and(
          eq(scheduledActions.eventId, events.id),

          eq(scheduledActions.actionKey, "publish_event"),
        ),
      )
      .where(eventFilter)
      .orderBy(
        asc(events.startsAt),

        asc(events.id),
      );

    const generatedEvents: TemplateGeneratedEventSummary[] = rows.map(
      (event) => ({
        ...event,

        templateRevisionState: templateRevisionState(
          event.templateSourceUpdatedAt,

          template.updatedAt,
        ),
      }),
    );

    return {
      kind: "found",

      template,

      events: generatedEvents,
    } as const;
  });
}

function templateRevisionState(
  sourceRevision: Date | null,
  currentRevision: Date,
): TemplateGeneratedEventRevisionState {
  if (sourceRevision === null) {
    return "unknown";
  }

  return sourceRevision.getTime() === currentRevision.getTime()
    ? "current"
    : "older";
}
