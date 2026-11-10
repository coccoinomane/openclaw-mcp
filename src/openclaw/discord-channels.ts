import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayConfig } from './types.js';

export interface CreationPolicy {
  name: string;
  guildId: string;
  categoryId: string;
  accountId: string;
  agentId: string;
  normalRouting?: boolean;
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
      ([key, value]) => value && /^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)
    )
  ) {
    throw new DiscordError('AGENT_PROVENANCE_DENIED');
  }
}
export type ChannelInvoker = (
  policy: CreationPolicy,
  name: string,
  topic: string | undefined,
  operation: string
) => Promise<any>;
/** Closed API: callers cannot select a tool, action, URL, headers or arbitrary arguments. */
export function channelInvoker(gateway: GatewayConfig, fetcher = fetch): ChannelInvoker {
  const { url: gatewayUrl, token } = gateway;
  return async (policy, name, topic, operation) => {
    assertServiceProvenance();
    if (!token) throw new DiscordError('GATEWAY_CREDENTIAL_MISSING');
    const url = new URL('/tools/invoke', gatewayUrl);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new DiscordError('INSECURE_GATEWAY_URL');
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
  /** Original MCP permission scope, retained across imported route reassignment. */
  permissionAgentId?: string;
  name: string;
  guildId: string;
  channelId: string;
  accountId: string;
  agentId: string;
  categoryId?: string;
  normalRouting?: boolean;
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
    readonly policies: CreationPolicy[],
    private invoke: ChannelInvoker,
    private inspect: (p: CreationPolicy, id: string) => Promise<any>
  ) {}
  async admitted(): Promise<AdmittedTarget[]> {
    await privateState(this.stateDir);
    const targets: AdmittedTarget[] = [];
    for (const file of await readdir(this.stateDir)) {
      if (!/^[a-zA-Z0-9_-]{16,100}[.]json$/.test(file)) continue;
      let record: any;
      try {
        record = JSON.parse(await readFile(join(this.stateDir, file), 'utf8'));
      } catch (error) {
        // An exclusive claim may exist before its first synced record is written.
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (record.kind !== 'channel_create' || record.status !== 'completed') continue;
      const policy = this.policies.find(
        (p) => p.name === record.policy && hash(p) === record.policy_digest
      );
      if (!policy || !/^[1-9][0-9]{16,19}$/.test(record.channel_id)) continue;
      targets.push({
        name: 'created-' + record.channel_id,
        channelId: record.channel_id,
        guildId: policy.guildId,
        accountId: policy.accountId,
        agentId: policy.agentId,
        categoryId: policy.categoryId,
        normalRouting: policy.normalRouting,
      });
    }
    return targets;
  }
  async create(input: any) {
    assertServiceProvenance();
    const p = this.policies.find((p) => p.name === input.policy);
    if (!p) throw new DiscordError('CREATION_POLICY_DENIED');
    if (input.authorize_create !== true || input.authorize_admission !== true)
      throw new DiscordError('EXPLICIT_AUTHORIZATION_REQUIRED');
    if (
      typeof input.operation_id !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(input.operation_id) ||
      typeof input.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.name) ||
      (input.topic !== undefined &&
        (typeof input.topic !== 'string' ||
          input.topic.length > 1024 ||
          [...input.topic].some((c) => c.charCodeAt(0) < 32)))
    )
      throw new DiscordError('INVALID_CREATION_ARGUMENTS');
    await privateState(this.stateDir);
    const path = join(this.stateDir, input.operation_id + '.json');
    const fingerprint = hash([p, input.name, input.topic]);
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
      if (previous.kind !== 'channel_create' || previous.fingerprint !== fingerprint)
        throw new DiscordError('OPERATION_CONFLICT');
      return this.publicResult(previous);
    }
    const record: any = {
      kind: 'channel_create',
      agent_id: p.agentId,
      policy: p.name,
      policy_digest: hash(p),
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
      const category = await this.inspect(p, p.categoryId);
      if (category?.id !== p.categoryId || category.guild_id !== p.guildId || category.type !== 4)
        throw new DiscordError('CATEGORY_VERIFICATION_FAILED');
      dispatched = true;
      const result = await this.invoke(p, input.name, input.topic, input.operation_id);
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
        verified.parent_id !== p.categoryId ||
        verified.type !== 0
      )
        throw new DiscordError('CREATED_CHANNEL_VERIFICATION_FAILED');
      record.status = 'completed';
      record.target = 'created-' + c.id;
      record.routing = 'operator-configured normal inbound routing; no runtime binding changes';
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
    const result = { ...record };
    delete result.fingerprint;
    delete result.policy_digest;
    return result;
  }
}
