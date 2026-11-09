import { assertServiceProvenance, DiscordError } from './discord-channels.js';
import type { DiscordConfig } from './discord.js';
import type { InstanceConfig } from './types.js';

type ReadScope = {
  guildId: string;
  accountId: string;
  agentId: string;
  permissionAgentId?: string;
};
export type ReadRequest =
  | { action: 'channel-list' }
  | { action: 'channel-info' | 'permissions'; channelId: string }
  | {
      action: 'thread-list';
      channelId: string;
      includeArchived?: boolean;
      before?: string;
      limit?: number;
    }
  | { action: 'read'; channelId: string; messageId: string; limit: 1 };
export type DiscordReader = (scope: ReadScope, request: ReadRequest) => Promise<any>;
const snowflake = /^[1-9][0-9]{16,19}$/;
const scopeKey = (s: ReadScope) => JSON.stringify([s.guildId, s.accountId, s.agentId]);

/** Fixed service reads through the existing authorized HTTP tool surface. */
export function channelReader(
  instances: InstanceConfig[],
  config: DiscordConfig,
  fetcher = fetch
): DiscordReader | undefined {
  if (config.gatewayReadsEnabled !== true || !config.cliGatewayInstance) return undefined;
  const matches = instances.filter((i) => i.name === config.cliGatewayInstance);
  if (matches.length !== 1 || !matches[0].token)
    throw new DiscordError('READ_GATEWAY_CONFIGURATION_INVALID');
  const instance = { ...matches[0] };
  const policies = config.creationPolicies ?? [];
  if (policies.some((p) => p.instance !== instance.name))
    throw new DiscordError('READ_GATEWAY_MISMATCH');
  const scopes = new Set(
    [...config.targets, ...(config.discoveryScopes ?? []), ...policies].map(scopeKey)
  );
  const url = new URL('/tools/invoke', instance.url);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new DiscordError('INSECURE_GATEWAY_URL');
  return async (scope, request) => {
    assertServiceProvenance();
    const permissionScope =
      scope && config.importedRouteAgent && scope.permissionAgentId
        ? { ...scope, agentId: scope.permissionAgentId }
        : scope;
    if (!permissionScope || !scopes.has(scopeKey(permissionScope)))
      throw new DiscordError('READ_SCOPE_DENIED');
    const keys: Record<ReadRequest['action'], string[]> = {
      'channel-list': ['action'],
      'channel-info': ['action', 'channelId'],
      permissions: ['action', 'channelId'],
      'thread-list': ['action', 'channelId', 'includeArchived', 'before', 'limit'],
      read: ['action', 'channelId', 'messageId', 'limit'],
    };
    if (
      !request ||
      !Object.hasOwn(keys, request.action) ||
      Object.keys(request).some((key) => !keys[request.action].includes(key)) ||
      (request.action !== 'channel-list' &&
        (typeof request.channelId !== 'string' || !snowflake.test(request.channelId)))
    )
      throw new DiscordError('READ_ACTION_DENIED');
    if (
      request.action === 'thread-list' &&
      ((request.includeArchived !== undefined && typeof request.includeArchived !== 'boolean') ||
        (request.limit !== undefined &&
          (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) ||
        (request.before !== undefined &&
          (typeof request.before !== 'string' ||
            !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(
              request.before
            ) ||
            !Number.isFinite(Date.parse(request.before)))) ||
        (!request.includeArchived && (request.before !== undefined || request.limit !== undefined)))
    )
      throw new DiscordError('READ_ACTION_DENIED');
    if (
      request.action === 'read' &&
      (typeof request.messageId !== 'string' ||
        !snowflake.test(request.messageId) ||
        request.limit !== 1)
    )
      throw new DiscordError('READ_ACTION_DENIED');
    if (request.action !== 'channel-list' && config.channelBlacklist?.includes(request.channelId))
      throw new DiscordError('CHANNEL_POLICY_DENIED');
    const args = {
      ...request,
      channel: 'discord',
      accountId: scope.accountId,
      ...(['channel-list', 'thread-list'].includes(request.action)
        ? { guildId: scope.guildId }
        : {}),
    };
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + instance.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'message',
          sessionKey: 'agent:' + scope.agentId + ':main',
          args,
        }),
      });
    } catch {
      throw new DiscordError('GATEWAY_READ_FAILED');
    }
    if (!response.ok) throw new DiscordError('GATEWAY_HTTP_' + response.status);
    try {
      const body: any = await response.json();
      if (body?.ok !== true || body.result?.isError) throw new Error();
      const result =
        body.result?.details ??
        (body.result?.content?.[0]?.type === 'text'
          ? JSON.parse(body.result.content[0].text)
          : body.result);
      if (!result || result.ok !== true || result.isError || result.partial) throw new Error();
      if (request.action === 'channel-list' && !Array.isArray(result.channels)) throw new Error();
      if (
        request.action === 'channel-info' &&
        (!result.channel ||
          typeof result.channel !== 'object' ||
          Array.isArray(result.channel) ||
          result.channel.id !== request.channelId ||
          result.channel.guild_id !== scope.guildId ||
          !Number.isInteger(result.channel.type))
      )
        throw new Error();
      if (
        request.action === 'thread-list' &&
        !Array.isArray(result.threads) &&
        !Array.isArray(result.threads?.threads)
      )
        throw new Error();
      if (
        request.action === 'permissions' &&
        (result.permissions?.channelId !== request.channelId ||
          result.permissions?.guildId !== scope.guildId ||
          !Array.isArray(result.permissions?.permissions))
      )
        throw new Error();
      if (
        request.action === 'read' &&
        (result.channelId !== request.channelId ||
          !Array.isArray(result.messages) ||
          result.messages.some(
            (m: any) =>
              m.id !== request.messageId || (m.channel_id && m.channel_id !== request.channelId)
          ))
      )
        throw new Error();
      return result;
    } catch {
      throw new DiscordError('GATEWAY_READ_UNVERIFIED');
    }
  };
}
