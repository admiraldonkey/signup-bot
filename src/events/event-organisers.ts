// import { and, asc, eq } from "drizzle-orm";

// import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// import { db } from "../db/client.js";

// import { eventOrganiserAssignments } from "../db/schema.js";

// export type OrganiserSlot = "primary" | "backup";

// export type OrganiserStatus =
//   | "pending"
//   | "confirmed"
//   | "declined"
//   | "replaced"
//   | "removed";

// export interface CurrentEventOrganiser {
//   id: number;
//   slot: OrganiserSlot;
//   discordUserId: string;
//   displayNameSnapshot: string;
//   status: OrganiserStatus;
//   assignedByUserId: string;
//   assignedAt: Date;
//   respondedAt: Date | null;
// }

// export async function getCurrentEventOrganisers(
//   eventId: number,
// ): Promise<CurrentEventOrganiser[]> {
//   return db
//     .select({
//       id: eventOrganiserAssignments.id,

//       slot: eventOrganiserAssignments.slot,

//       discordUserId: eventOrganiserAssignments.discordUserId,

//       displayNameSnapshot: eventOrganiserAssignments.displayNameSnapshot,

//       status: eventOrganiserAssignments.status,

//       assignedByUserId: eventOrganiserAssignments.assignedByUserId,

//       assignedAt: eventOrganiserAssignments.assignedAt,

//       respondedAt: eventOrganiserAssignments.respondedAt,
//     })
//     .from(eventOrganiserAssignments)
//     .where(
//       and(
//         eq(eventOrganiserAssignments.eventId, eventId),

//         eq(eventOrganiserAssignments.isCurrent, true),
//       ),
//     )
//     .orderBy(asc(eventOrganiserAssignments.id));
// }

// export function formatOrganiserStatus(status: OrganiserStatus): string {
//   switch (status) {
//     case "pending":
//       return "🟡 Awaiting confirmation";

//     case "confirmed":
//       return "✅ Confirmed";

//     case "declined":
//       return "❌ Declined";

//     case "replaced":
//       return "Replaced";

//     case "removed":
//       return "Removed";
//   }
// }

// export function formatOrganiserSummary(
//   organisers: CurrentEventOrganiser[],
// ): string {
//   const primary = organisers.find((organiser) => organiser.slot === "primary");

//   const backup = organisers.find((organiser) => organiser.slot === "backup");

//   const lines = [
//     primary
//       ? [
//           "**Primary:**",
//           `<@${primary.discordUserId}>`,
//           `— ${formatOrganiserStatus(primary.status)}`,
//         ].join(" ")
//       : "**Primary:** Not assigned",
//   ];

//   if (backup) {
//     lines.push(
//       [
//         "**Backup:**",
//         `<@${backup.discordUserId}>`,
//         `— ${formatOrganiserStatus(backup.status)}`,
//       ].join(" "),
//     );
//   }

//   return lines.join("\n");
// }

// export function buildOrganiserCustomId(
//   eventId: number,
//   response: "confirm" | "decline",
// ): string {
//   return `organiser:${eventId}:${response}`;
// }

// export function parseOrganiserCustomId(customId: string): {
//   eventId: number;
//   response: "confirm" | "decline";
// } | null {
//   const match = /^organiser:(\d+):(confirm|decline)$/.exec(customId);

//   if (!match) {
//     return null;
//   }

//   const eventId = Number(match[1]);

//   if (!Number.isSafeInteger(eventId) || eventId <= 0) {
//     return null;
//   }

//   return {
//     eventId,

//     response: match[2] as "confirm" | "decline",
//   };
// }

// export function buildOrganiserButtons(
//   eventId: number,
//   disabled = false,
// ): ActionRowBuilder<ButtonBuilder> {
//   return new ActionRowBuilder<ButtonBuilder>().addComponents(
//     new ButtonBuilder()
//       .setCustomId(buildOrganiserCustomId(eventId, "confirm"))
//       .setLabel("Confirm organiser")
//       .setEmoji("✅")
//       .setStyle(ButtonStyle.Success)
//       .setDisabled(disabled),

//     new ButtonBuilder()
//       .setCustomId(buildOrganiserCustomId(eventId, "decline"))
//       .setLabel("Decline organiser")
//       .setEmoji("❌")
//       .setStyle(ButtonStyle.Secondary)
//       .setDisabled(disabled),
//   );
// }
