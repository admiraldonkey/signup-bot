import type { OrganiserAssignmentSlot } from "../organisers/organiser-types.js";

export function formatOrganiserSlot(slot: OrganiserAssignmentSlot): string {
  switch (slot) {
    case "primary":
      return "primary organiser";

    case "backup":
      return "backup organiser";

    case "cover":
      return "cover organiser";
  }
}
