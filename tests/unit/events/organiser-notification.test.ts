import { ChannelType, type Guild } from "discord.js";

import { describe, expect, it, vi } from "vitest";

import {
  sendOrganiserAssignmentNotification,
  sendOrganiserCoverRequest,
  sendOrganiserMissingAtStartAlert,
  sendOrganiserPendingWarning,
} from "../../../src/events/organiser-notification.js";

const EVENT_ID = 42;

const ASSIGNMENT_ID = 84;

const EVENT_ADMIN_CHANNEL_ID = "990000000000000001";

const EVENT_ORGANISER_ROLE_ID = "990000000000000002";

const ORGANISER_USER_ID = "990000000000000004";

function createUnknownChannelError(): {
  code: number;
  message: string;
} {
  return {
    code: 10003,

    message: "Unknown Channel",
  };
}

describe("organiser notification", () => {
  it("posts an urgent claimable alert when an event starts without an organiser", async () => {
    const sentMessage = {
      id: "990000000000000003",

      delete: vi.fn().mockResolvedValue(undefined),
    };

    const send = vi.fn().mockResolvedValue(sentMessage);

    const channel = {
      id: EVENT_ADMIN_CHANNEL_ID,

      type: ChannelType.GuildText,

      isSendable: () => true,

      permissionsFor: () => ({
        has: () => true,
      }),

      send,
    };

    const role = {
      id: EVENT_ORGANISER_ROLE_ID,

      name: "Event Organisers",

      mentionable: true,
    };

    const guild = {
      channels: {
        fetch: vi.fn().mockResolvedValue(channel),
      },

      roles: {
        fetch: vi.fn().mockResolvedValue(role),
      },

      members: {
        me: {},
      },
    } as unknown as Guild;

    const result = await sendOrganiserMissingAtStartAlert({
      guild,

      eventId: EVENT_ID,

      eventName: "Naval Event",

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

      eventOrganiserRoleId: EVENT_ORGANISER_ROLE_ID,
    });

    expect(result).toEqual({
      kind: "sent",

      delivery: "pinged",

      channelId: EVENT_ADMIN_CHANNEL_ID,

      messageId: "990000000000000003",

      message: sentMessage,
    });

    expect(send).toHaveBeenCalledTimes(1);

    const payload = send.mock.calls[0]?.[0] as
      | {
          content?: string;
        }
      | undefined;

    expect(payload?.content).toContain(
      "🚨 **Event has started without an organiser**",
    );

    expect(payload?.content).toContain(
      "**Naval Event** (#42) has started and still has no confirmed organiser.",
    );

    expect(payload?.content).toContain(`<@&${EVENT_ORGANISER_ROLE_ID}>`);
  });

  it("treats a deleted Event Administration channel as a definitive failed assignment fallback", async () => {
    const memberSend = vi
      .fn()
      .mockRejectedValue(new Error("Direct messages disabled."));

    const channelFetch = vi.fn().mockRejectedValue(createUnknownChannelError());

    const guild = {
      channels: {
        fetch: channelFetch,
      },

      members: {
        fetch: vi.fn().mockResolvedValue({
          send: memberSend,
        }),
      },
    } as unknown as Guild;

    const result = await sendOrganiserAssignmentNotification({
      guild,

      assignmentId: ASSIGNMENT_ID,

      eventId: EVENT_ID,

      eventName: "Naval Event",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

      organiserDmsEnabled: true,
    });

    expect(result).toBe("failed");

    expect(memberSend).toHaveBeenCalledTimes(1);

    expect(channelFetch).toHaveBeenCalledWith(EVENT_ADMIN_CHANNEL_ID);
  });

  it("propagates an unexpected assignment fallback failure instead of treating it as channel deletion", async () => {
    const transientError = new Error(
      "Temporary Discord channel fetch failure.",
    );

    const guild = {
      channels: {
        fetch: vi.fn().mockRejectedValue(transientError),
      },

      members: {
        /*
         * Skip the DM path so this regression isolates the configured
         * administrative destination.
         */
        fetch: vi.fn(),
      },
    } as unknown as Guild;

    await expect(
      sendOrganiserAssignmentNotification({
        guild,

        assignmentId: ASSIGNMENT_ID,

        eventId: EVENT_ID,

        eventName: "Naval Event",

        discordUserId: ORGANISER_USER_ID,

        slot: "primary",

        eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

        organiserDmsEnabled: false,
      }),
    ).rejects.toBe(transientError);
  });

  it("treats a deleted Event Administration channel as definitive non-delivery for an organiser warning", async () => {
    const channelFetch = vi.fn().mockRejectedValue(createUnknownChannelError());

    const guild = {
      channels: {
        fetch: channelFetch,
      },
    } as unknown as Guild;

    const result = await sendOrganiserPendingWarning({
      guild,

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

      eventId: EVENT_ID,

      eventName: "Naval Event",

      discordUserId: ORGANISER_USER_ID,

      slot: "primary",

      responseDeadlineAt: new Date("2026-09-18T21:00:00Z"),
    });

    expect(result).toBeNull();

    expect(channelFetch).toHaveBeenCalledWith(EVENT_ADMIN_CHANNEL_ID);
  });

  it("propagates an unexpected organiser-warning delivery failure", async () => {
    const transientError = new Error(
      "Temporary Discord warning transport failure.",
    );

    const guild = {
      channels: {
        fetch: vi.fn().mockRejectedValue(transientError),
      },
    } as unknown as Guild;

    await expect(
      sendOrganiserPendingWarning({
        guild,

        eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

        eventId: EVENT_ID,

        eventName: "Naval Event",

        discordUserId: ORGANISER_USER_ID,

        slot: "primary",

        responseDeadlineAt: new Date("2026-09-18T21:00:00Z"),
      }),
    ).rejects.toBe(transientError);
  });

  it("treats a deleted Event Administration channel as definitive non-delivery for general cover", async () => {
    const channelFetch = vi.fn().mockRejectedValue(createUnknownChannelError());

    const guild = {
      channels: {
        fetch: channelFetch,
      },

      roles: {
        fetch: vi.fn().mockResolvedValue({
          id: EVENT_ORGANISER_ROLE_ID,

          name: "Event Organisers",

          mentionable: true,
        }),
      },

      members: {
        me: {},
      },
    } as unknown as Guild;

    const result = await sendOrganiserCoverRequest({
      guild,

      eventId: EVENT_ID,

      eventName: "Naval Event",

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

      eventOrganiserRoleId: EVENT_ORGANISER_ROLE_ID,
    });

    expect(result).toEqual({
      kind: "failed",

      delivery: "failed",
    });

    expect(channelFetch).toHaveBeenCalledWith(EVENT_ADMIN_CHANNEL_ID);
  });

  it("propagates an unexpected general-cover delivery failure", async () => {
    const transientError = new Error(
      "Temporary Discord cover transport failure.",
    );

    const guild = {
      channels: {
        fetch: vi.fn().mockRejectedValue(transientError),
      },

      roles: {
        fetch: vi.fn().mockResolvedValue({
          id: EVENT_ORGANISER_ROLE_ID,

          name: "Event Organisers",

          mentionable: true,
        }),
      },

      members: {
        me: {},
      },
    } as unknown as Guild;

    await expect(
      sendOrganiserCoverRequest({
        guild,

        eventId: EVENT_ID,

        eventName: "Naval Event",

        eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

        eventOrganiserRoleId: EVENT_ORGANISER_ROLE_ID,
      }),
    ).rejects.toBe(transientError);
  });

  it("treats a deleted Event Administration channel as definitive non-delivery for the missing-at-start alert", async () => {
    const guild = {
      channels: {
        fetch: vi.fn().mockRejectedValue(createUnknownChannelError()),
      },

      roles: {
        fetch: vi.fn().mockResolvedValue({
          id: EVENT_ORGANISER_ROLE_ID,

          name: "Event Organisers",

          mentionable: true,
        }),
      },

      members: {
        me: {},
      },
    } as unknown as Guild;

    const result = await sendOrganiserMissingAtStartAlert({
      guild,

      eventId: EVENT_ID,

      eventName: "Naval Event",

      eventAdminChannelId: EVENT_ADMIN_CHANNEL_ID,

      eventOrganiserRoleId: EVENT_ORGANISER_ROLE_ID,
    });

    expect(result).toEqual({
      kind: "failed",

      delivery: "failed",
    });
  });
});
