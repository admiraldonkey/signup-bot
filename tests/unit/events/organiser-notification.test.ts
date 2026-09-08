import { ChannelType, type Guild } from "discord.js";

import { describe, expect, it, vi } from "vitest";

import { sendOrganiserMissingAtStartAlert } from "../../../src/events/organiser-notification.js";

const EVENT_ID = 42;

const EVENT_ADMIN_CHANNEL_ID = "990000000000000001";

const EVENT_ORGANISER_ROLE_ID = "990000000000000002";

describe("organiser notification", () => {
  it("posts an urgent claimable alert when an event starts without an organiser", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "990000000000000003",
    });

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

    expect(result).toBe("pinged");

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
});
