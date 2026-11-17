import type { DiscordAccess } from '../openclaw/discord-bindings.js';

/** Isolates state/transport tests from live binding tests. */
export function fixtureAccess(targets: any[]): DiscordAccess {
  return {
    channels: async () => ({
      channels: targets.map((t) => ({
        agent_id: t.agentId,
        discord_account_id: t.accountId,
        channel_id: t.channelId,
        server_id: t.guildId,
        channel_name: 'Work',
        channel_topic: null,
        category_id: null,
        category_name: null,
        discord_url: 'https://discord.com/channels/' + t.guildId + '/' + t.channelId,
      })),
      creation_servers: [],
    }),
    select: async (id?: string) => id ?? targets[0]?.agentId ?? 'main',
    assert: async (t: any) => {
      if (
        !targets.some(
          (x) =>
            x.agentId === t.agentId &&
            x.accountId === t.accountId &&
            x.channelId === t.channelId &&
            x.guildId === t.guildId
        )
      )
        throw new Error('BINDING_ACCESS_DENIED');
    },
    assertCreate: async () => {},
    target: async (input: any) => {
      const t = targets.find(
        (x) => x.name === input.channel_id || x.channelId === input.channel_id
      );
      if (!t || (input.agent_id && input.agent_id !== t.agentId))
        throw new Error('BINDING_ACCESS_DENIED');
      return { ...t };
    },
  } as unknown as DiscordAccess;
}
export function fixturePermissions(guild: string, id: string, parent: string) {
  return {
    channelId: id,
    guildId: guild,
    channelType: id === parent ? 0 : 11,
    isDm: false,
    permissions: [
      'ViewChannel',
      'SendMessages',
      'ReadMessageHistory',
      'CreatePublicThreads',
      'SendMessagesInThreads',
      'AttachFiles',
    ],
  };
}
