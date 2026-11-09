import { assertServiceProvenance, DiscordError } from './discord-channels.js';
import type { DiscordConfig } from './discord.js';
import type { InstanceConfig } from './types.js';

type ReadScope = {
  guildId: string;
  accountId: string;
  agentId: string;
  permissionAgentId?: string;
};
type ReadRequest = { action: 'channel-list' } | { action: 'channel-info'; channelId: string };
export type DiscordReader = (scope: ReadScope, request: ReadRequest) => Promise<any>;
const snowflake = /^[1-9][0-9]{16,19}$/;
const scopeKey = (s: ReadScope) => JSON.stringify([s.guildId, s.accountId, s.agentId]);

/** Service-only metadata reads. No client-selected actions, credentials or endpoints. */
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
    if (
      !request ||
      !['channel-list', 'channel-info'].includes(request.action) ||
      Object.keys(request).some(
        (key) =>
          !['action', ...(request.action === 'channel-info' ? ['channelId'] : [])].includes(key)
      ) ||
      (request.action === 'channel-info' &&
        (typeof request.channelId !== 'string' || !snowflake.test(request.channelId)))
    )
      throw new DiscordError('READ_ACTION_DENIED');
    if (request.action === 'channel-info' && config.channelBlacklist?.includes(request.channelId))
      throw new DiscordError('CHANNEL_POLICY_DENIED');
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
          args: {
            action: request.action,
            channel: 'discord',
            accountId: scope.accountId,
            ...(request.action === 'channel-list'
              ? { guildId: scope.guildId }
              : { channelId: request.channelId }),
          },
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
      if (
        request.action === 'channel-list'
          ? !Array.isArray(result.channels)
          : !result.channel ||
            typeof result.channel !== 'object' ||
            Array.isArray(result.channel) ||
            result.channel.id !== request.channelId ||
            result.channel.guild_id !== scope.guildId ||
            !Number.isInteger(result.channel.type)
      )
        throw new Error();
      return result;
    } catch {
      throw new DiscordError('GATEWAY_READ_UNVERIFIED');
    }
  };
}
