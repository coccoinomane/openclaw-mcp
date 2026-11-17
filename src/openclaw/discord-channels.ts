import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayConfig } from './types.js';

export interface ChannelDestination {
  guildId: string;
  categoryId?: string;
  accountId: string;
  agentId: string;
}
export const operationSchemaVersion = 2;
export function assertOperationVersion(record: any) {
  if (record?.schema_version !== operationSchemaVersion)
    throw new DiscordError('OPERATION_SCHEMA_UNSUPPORTED');
}
export class DiscordError extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false
  ) {
    super(code);
  }
}
export function assertServiceProvenance(env = process.env) {
  if (
    Object.entries(env).some(
      ([key, value]) =>
        !['OPENCLAW_DEFAULT_AGENT_ID', 'OPENCLAW_AGENT_IS_MANDATORY'].includes(key) &&
        value &&
        /^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)
    )
  ) {
    throw new DiscordError('AGENT_PROVENANCE_DENIED');
  }
}
export type ChannelInvoker = (
  policy: ChannelDestination,
  name: string,
  topic: string | undefined,
  operation: string
) => Promise<any>;
/** Closed API: callers cannot select a tool, action, URL, headers or arbitrary arguments. */
export function channelInvoker(
  gateway: GatewayConfig,
  fetcher = fetch,
  env = process.env,
  authorize?: (destination: ChannelDestination) => Promise<void>
): ChannelInvoker {
  const { url: gatewayUrl, token } = gateway;
  return async (policy, name, topic, operation) => {
    assertServiceProvenance();
    if (!token) throw new DiscordError('GATEWAY_CREDENTIAL_MISSING');
    const url = new URL('/tools/invoke', gatewayUrl);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new DiscordError('INSECURE_GATEWAY_URL');
    // Guild-level role permissions, without channel overwrites. No fallback after denial.
    await verifyGuildManageChannels(policy, env, fetcher);
    if (!authorize) throw new DiscordError('CREATION_AUTHORIZER_REQUIRED');
    await authorize(policy);
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'message',
          sessionKey: 'agent:' + policy.agentId + ':main',
          idempotencyKey: operation,
          args: {
            action: 'channel-create',
            channel: 'discord',
            accountId: policy.accountId,
            guildId: policy.guildId,
            parentId: policy.categoryId,
            name,
            topic,
            channelType: 0,
          },
        }),
      });
    } catch {
      throw new DiscordError('GATEWAY_OUTCOME_UNKNOWN', true);
    }
    if ([401, 403, 404, 429].includes(response.status))
      throw new DiscordError('GATEWAY_HTTP_' + response.status);
    if (!response.ok) throw new DiscordError('GATEWAY_HTTP_' + response.status, true);
    try {
      const body: any = await response.json();
      if (body.ok !== true || body.result?.isError) throw new Error();
      const result =
        body.result?.details ??
        (body.result?.content?.[0]?.type === 'text'
          ? JSON.parse(body.result.content[0].text)
          : body.result);
      if (!result || result.ok !== true) throw new Error();
      return result;
    } catch {
      throw new DiscordError('GATEWAY_RESULT_UNCONFIRMED', true);
    }
  };
}
export type AdmittedTarget = {
  name: string;
  guildId: string;
  channelId: string;
  accountId: string;
  agentId: string;
  categoryId?: string;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function privateState(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const state = await lstat(dir);
  if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077)
    throw new DiscordError('STATE_DIRECTORY_NOT_PRIVATE');
}
async function syncDir(dir: string) {
  const h = await open(dir, 'r');
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function save(path: string, record: any, dir: string) {
  const h = await open(path + '.tmp', 'w', 0o600);
  try {
    await h.writeFile(JSON.stringify(record));
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(path + '.tmp', path);
  await syncDir(dir);
}
export class ChannelCreation {
  constructor(
    readonly stateDir: string,
    private invoke: ChannelInvoker,
    private inspect: (p: ChannelDestination, id: string) => Promise<any>,
    private authorize: (p: ChannelDestination) => Promise<void>
  ) {}
  async create(input: any, p: ChannelDestination) {
    assertServiceProvenance();
    if (input.authorize_create !== true) throw new DiscordError('EXPLICIT_AUTHORIZATION_REQUIRED');
    if (
      typeof input.operation_id !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(input.operation_id) ||
      typeof input.channel_name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.channel_name) ||
      (input.channel_topic !== undefined &&
        (typeof input.channel_topic !== 'string' ||
          input.channel_topic.length > 1024 ||
          [...input.channel_topic].some((c) => c.charCodeAt(0) < 32)))
    )
      throw new DiscordError('INVALID_CREATION_ARGUMENTS');
    await privateState(this.stateDir);
    const path = join(this.stateDir, input.operation_id + '.json');
    const fingerprint = hash([p, input.channel_name, input.channel_topic]);
    let h;
    try {
      h = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: any;
      try {
        previous = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        throw new DiscordError('OPERATION_RESERVED_OR_DAMAGED');
      }
      assertOperationVersion(previous);
      if (previous.kind !== 'channel_create' || previous.fingerprint !== fingerprint)
        throw new DiscordError('OPERATION_CONFLICT');
      return this.publicResult(previous);
    }
    const record: any = {
      schema_version: operationSchemaVersion,
      kind: 'channel_create',
      agent_id: p.agentId,
      server_id: p.guildId,
      discord_account_id: p.accountId,
      category_id: p.categoryId,
      fingerprint,
      operation_id: input.operation_id,
      status: 'creating',
      retry_safe: false,
    };
    try {
      await h.writeFile(JSON.stringify(record));
      await h.sync();
    } finally {
      await h.close();
    }
    await syncDir(this.stateDir);
    let dispatched = false;
    try {
      if (p.categoryId) {
        const category = await this.inspect(p, p.categoryId);
        if (category?.id !== p.categoryId || category.guild_id !== p.guildId || category.type !== 4)
          throw new DiscordError('CATEGORY_VERIFICATION_FAILED');
      }
      await this.authorize(p);
      dispatched = true;
      const result = await this.invoke(
        p,
        input.channel_name,
        input.channel_topic,
        input.operation_id
      );
      const c = result.channel;
      if (typeof c?.id !== 'string' || !/^[1-9][0-9]{16,19}$/.test(c.id))
        throw new DiscordError('CREATED_CHANNEL_ID_MISSING', true);
      record.channel_id = c.id;
      record.discord_url = 'https://discord.com/channels/' + p.guildId + '/' + c.id;
      record.status = 'created_unadmitted';
      await save(path, record, this.stateDir);
      const verified = await this.inspect(p, c.id);
      if (
        result.partial ||
        verified?.id !== c.id ||
        verified.guild_id !== p.guildId ||
        (verified.parent_id ?? undefined) !== p.categoryId ||
        verified.type !== 0
      )
        throw new DiscordError('CREATED_CHANNEL_VERIFICATION_FAILED');
      record.status = 'completed';
      record.routing =
        'Access follows current selected-agent bindings; inbound routing is unchanged';
      await save(path, record, this.stateDir);
    } catch (error) {
      record.error_code = error instanceof DiscordError ? error.code : 'UNVERIFIED_RESULT';
      record.status = record.channel_id
        ? 'created_unadmitted'
        : dispatched && (!(error instanceof DiscordError) || error.uncertain)
          ? 'creation_unknown'
          : 'creation_rejected';
      record.recovery =
        'Do not repeat with a new ID. Inspect Discord and gateway logs; retain this operation record. No automatic admission or retry after an uncertain result.';
      await save(path, record, this.stateDir);
    }
    return this.publicResult(record);
  }
  publicResult(record: any) {
    assertOperationVersion(record);
    const result = { ...record };
    delete result.fingerprint;
    delete result.schema_version;
    return result;
  }
}

/** The configured direct bot credential is restricted to its declared account. */
export async function verifyGuildManageChannels(
  destination: ChannelDestination,
  env = process.env,
  fetcher = fetch
) {
  if (
    destination.accountId !== env.MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID ||
    !env.DISCORD_BOT_TOKEN ||
    /\s/.test(env.DISCORD_BOT_TOKEN)
  )
    throw new DiscordError('GUILD_PERMISSION_CREDENTIAL_UNAVAILABLE');
  const get = async (path: string) => {
    let response: Response;
    try {
      response = await fetcher('https://discord.com/api/v10/' + path, {
        headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new DiscordError('GUILD_PERMISSIONS_UNVERIFIED');
    }
    if (!response.ok) throw new DiscordError('GUILD_PERMISSIONS_UNVERIFIED');
    try {
      return (await response.json()) as any;
    } catch {
      throw new DiscordError('GUILD_PERMISSIONS_UNVERIFIED');
    }
  };
  const me = await get('users/@me');
  if (!me?.bot || typeof me.id !== 'string' || !/^[1-9][0-9]{16,19}$/.test(me.id))
    throw new DiscordError('GUILD_PERMISSIONS_UNVERIFIED');
  const member = await get('guilds/' + destination.guildId + '/members/' + me.id);
  const roles = await get('guilds/' + destination.guildId + '/roles');
  if (member?.user?.id !== me.id || !Array.isArray(member.roles) || !Array.isArray(roles))
    throw new DiscordError('GUILD_PERMISSIONS_UNVERIFIED');
  let bits = 0n;
  for (const id of [destination.guildId, ...member.roles]) {
    const role = roles.find((r: any) => r.id === id);
    if (!role || typeof role.permissions !== 'string' || !/^[0-9]+$/.test(role.permissions))
      throw new DiscordError('GUILD_PERMISSIONS_UNVERIFIED');
    bits |= BigInt(role.permissions);
  }
  if (!(bits & (8n | 16n))) throw new DiscordError('GUILD_MANAGE_CHANNELS_DENIED');
}
