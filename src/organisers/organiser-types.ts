export type OrganiserAssignmentSlot = "primary" | "backup" | "cover";

export type EditableOrganiserSlot = Exclude<OrganiserAssignmentSlot, "cover">;

export type OrganiserAssignmentStatus =
  | "pending"
  | "confirmed"
  | "declined"
  | "timed_out"
  | "replaced"
  | "removed";

export type OrganiserResponseAction = "confirm" | "decline";
