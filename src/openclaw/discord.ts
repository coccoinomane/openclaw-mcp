import {
  assertChannelAllowed,
  assertTargetAllowed,
  channelAllowed,
  dynamicTarget,
  scopeKey,
  type DiscoveryScope,
} from './discord-policy.js';
import type { RequestPublisher } from './discord-request.js';
import {
  ChannelCreation,
  DiscordError,
  assertServiceProvenance,
  type CreationPolicy,
  type ChannelInvoker,
  type AdmittedTarget,
} from './discord-channels.js';
import type { DiscordAgentTransport } from './discord-agent.js';
import type { DiscordReader } from './discord-read.js';
import {
  ThreadGatewayUnavailable,
  type ThreadInvoker,
  type ThreadMemberAdder,
} from './discord-thread.js';
import { log } from '../utils/logger.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface DiscordSelectors {
  instance?: string;
  agent_id?: string;
}
export interface DiscordConfig {
  /** Imported static bindings only restrict/reassign already admitted routes. */
  importedRouteAgent?: (target: AdmittedTarget, channelId: string) => string | undefined;
  agentTransport?: 'cli' | 'sdk';
  executable: string;
  stateDir: string;
  discoveryScopes?: DiscoveryScope[];
  channelWhitelist?: string[];
  channelBlacklist?: string[];
  creationPolicies?: CreationPolicy[];
  cliGatewayInstance?: string;
  gatewayReadsEnabled?: boolean;
  cliTimeoutMs?: number;
  maxOperations?: number;
  threadCreateMode?: 'cli' | 'gateway';
  threadMember?: { userId: string; accountId: string };
  forwardingRequesterName?: string;
  acknowledgeInboundRouting?: boolean;
  targets: Array<{
    name: string;
    guildId: string;
    channelId: string;
    accountId: string;
    agentId: string;
    normalRouting?: boolean;
  }>;
}
export type CliRunner = (executable: string, args: string[], timeout: number) => Promise<unknown>;
const snowflake = /^[1-9][0-9]{16,19}$/;
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function check(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid ' + label);
}
export function loadDiscordConfig(env = process.env): DiscordConfig | undefined {
  if (env.MCP_DISCORD_ENABLED !== 'true') return undefined;
  const config: DiscordConfig = {
    agentTransport: (env.MCP_DISCORD_AGENT_TRANSPORT || 'cli') as 'cli' | 'sdk',
    executable: env.MCP_DISCORD_EXECUTABLE || 'openclaw',
    stateDir: env.MCP_DISCORD_STATE_DIR || '',
    targets: JSON.parse(env.MCP_DISCORD_TARGETS || '[]'),
    discoveryScopes: JSON.parse(env.MCP_DISCORD_DISCOVERY_SCOPES ?? '[]'),
    channelWhitelist: JSON.parse(env.MCP_DISCORD_CHANNEL_WHITELIST ?? '[]'),
    channelBlacklist: JSON.parse(env.MCP_DISCORD_CHANNEL_BLACKLIST ?? '[]'),
    creationPolicies:
      env.MCP_DISCORD_CHANNEL_CREATE_ENABLED === 'true'
        ? JSON.parse(env.MCP_DISCORD_CREATION_POLICIES || '[]')
        : undefined,
    cliGatewayInstance: env.MCP_DISCORD_CLI_GATEWAY_INSTANCE,
    gatewayReadsEnabled: env.MCP_DISCORD_GATEWAY_READS_ENABLED === 'true',
    threadCreateMode: (env.MCP_DISCORD_THREAD_CREATE_MODE || 'cli') as 'cli' | 'gateway',
    threadMember:
      env.MCP_DISCORD_THREAD_MEMBER_ENABLED === 'true'
        ? {
            userId: env.MCP_DISCORD_THREAD_MEMBER_USER_ID || '',
            accountId: env.MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID || '',
          }
        : undefined,
    forwardingRequesterName: env.MCP_DISCORD_FORWARDING_REQUESTER_NAME || undefined,
    maxOperations: Number(env.MCP_DISCORD_MAX_OPERATIONS ?? 4),
    cliTimeoutMs: env.MCP_DISCORD_CLI_TIMEOUT_MS
      ? Number(env.MCP_DISCORD_CLI_TIMEOUT_MS)
      : undefined,
    acknowledgeInboundRouting: env.MCP_DISCORD_ACKNOWLEDGE_INBOUND_ROUTING === 'true',
  };
  validateConfig(config);
  return config;
}
function validateConfig(config: DiscordConfig) {
  if (config.agentTransport !== undefined && !['cli', 'sdk'].includes(config.agentTransport))
    throw new DiscordError('AGENT_TRANSPORT_INVALID');
  if (
    config.agentTransport === 'sdk' &&
    (!config.cliGatewayInstance ||
      !config.gatewayReadsEnabled ||
      config.threadCreateMode !== 'gateway')
  )
    throw new DiscordError('SDK_REQUIRES_GATEWAY_READS_AND_CREATE');
  for (const [label, values] of Object.entries({
    targets: config.targets,
    discoveryScopes: config.discoveryScopes === undefined ? [] : config.discoveryScopes,
    creationPolicies: config.creationPolicies === undefined ? [] : config.creationPolicies,
  })) {
    if (
      !Array.isArray(values) ||
      values.some((v) => !v || typeof v !== 'object' || Array.isArray(v))
    )
      throw new Error('Invalid Discord ' + label);
  }
  for (const values of [config.channelWhitelist, config.channelBlacklist]) {
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.some((v) => typeof v !== 'string' || !snowflake.test(v)) ||
        new Set(values).size !== values.length)
    )
      throw new Error('Invalid Discord channel policy IDs');
  }
  const scopes = new Set<string>();
  for (const scope of config.discoveryScopes ?? []) {
    if (
      Object.keys(scope).some(
        (k) => !['guildId', 'accountId', 'agentId', 'normalRouting'].includes(k)
      )
    )
      throw new Error('Invalid discovery scope field');
    check(scope.guildId, snowflake, 'scope guild ID');
    check(scope.accountId, slug, 'scope account');
    check(scope.agentId, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'scope agent');
    if (scopes.has(scopeKey(scope))) throw new Error('Duplicate discovery scope');
    scopes.add(scopeKey(scope));
  }
  for (const t of [
    ...config.targets,
    ...(config.discoveryScopes ?? []),
    ...(config.creationPolicies ?? []),
  ]) {
    if (t.normalRouting !== undefined && typeof t.normalRouting !== 'boolean')
      throw new Error('Invalid normalRouting');
  }
  if (
    !Number.isInteger(config.maxOperations ?? 4) ||
    (config.maxOperations ?? 4) < 1 ||
    (config.maxOperations ?? 4) > 16
  )
    throw new DiscordError('OPERATION_LIMIT_INVALID');
  if (
    config.threadCreateMode !== undefined &&
    !['cli', 'gateway'].includes(config.threadCreateMode)
  )
    throw new DiscordError('THREAD_CREATE_MODE_INVALID');
  if (config.threadCreateMode === 'gateway' && !config.cliGatewayInstance)
    throw new DiscordError('THREAD_GATEWAY_CONFIGURATION_INVALID');
  if (
    config.forwardingRequesterName !== undefined &&
    (typeof config.forwardingRequesterName !== 'string' ||
      !config.forwardingRequesterName.trim() ||
      config.forwardingRequesterName.length > 100 ||
      [...config.forwardingRequesterName].some((c) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c)) ||
      new TextDecoder().decode(new TextEncoder().encode(config.forwardingRequesterName)) !==
        config.forwardingRequesterName)
  )
    throw new DiscordError('FORWARDING_REQUESTER_NAME_INVALID');
  if (config.threadMember) {
    check(config.threadMember.userId, snowflake, 'thread member user ID');
    check(config.threadMember.accountId, slug, 'thread member account');
    if (
      [
        ...config.targets,
        ...(config.discoveryScopes ?? []),
        ...(config.creationPolicies ?? []),
      ].some((t) => t.accountId !== config.threadMember!.accountId)
    )
      throw new DiscordError('THREAD_MEMBER_ACCOUNT_MISMATCH');
  }
  if (
    config.cliTimeoutMs !== undefined &&
    (!Number.isInteger(config.cliTimeoutMs) ||
      config.cliTimeoutMs < 1000 ||
      config.cliTimeoutMs > 180000)
  )
    throw new Error('MCP_DISCORD_CLI_TIMEOUT_MS must be an integer from 1000 to 180000');
  if (!isAbsolute(config.stateDir)) throw new Error('MCP_DISCORD_STATE_DIR must be absolute');
  if (!config.executable || config.executable.includes('\0')) throw new Error('Invalid executable');
  if (
    !Array.isArray(config.targets) ||
    (!config.targets.length && !config.discoveryScopes?.length && !config.creationPolicies?.length)
  )
    throw new Error('Discord allowlist is empty');
  if (config.creationPolicies) {
    if (
      !config.creationPolicies.length ||
      !config.cliGatewayInstance ||
      config.acknowledgeInboundRouting !== true
    )
      throw new DiscordError('CREATION_ROUTING_ACKNOWLEDGEMENT_REQUIRED');
    const policies = new Set<string>();
    for (const p of config.creationPolicies) {
      check(p.name, slug, 'creation policy');
      check(p.guildId, snowflake, 'guild ID');
      check(p.categoryId, snowflake, 'category ID');
      check(p.accountId, slug, 'account');
      check(p.agentId, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'agent');
      if (p.instance !== config.cliGatewayInstance || policies.has(p.name))
        throw new DiscordError('CREATION_GATEWAY_MISMATCH');
      policies.add(p.name);
    }
  }
  const names = new Set<string>();
  for (const t of config.targets) {
    check(t.name, slug, 'target name');
    check(t.guildId, snowflake, 'guild ID');
    check(t.channelId, snowflake, 'channel ID');
    check(t.accountId, slug, 'account');
    check(t.agentId, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'agent');
    if (t.name.startsWith('created-')) throw new Error('Reserved target prefix');
    if (names.has(t.name)) throw new Error('Duplicate target name');
    names.add(t.name);
  }
}
export const runCli: CliRunner = (executable, args, timeout) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let firstStdoutMs: number | null = null;
    let exitMs: number | null = null;
    let closeMs: number | null = null;
    // Inherit provenance unchanged, including OPENCLAW_SHELL and caller identity.
    const child = execFile(
      executable,
      args,
      { shell: false, env: process.env, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const callbackMs = elapsed();
        let parsed: any;
        let validJson = false;
        try {
          parsed = JSON.parse(stdout);
          validJson = true;
        } catch {
          /* Never log process output. */
        }
        if (error) {
          const timedOut = error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const classification = timedOut ? 'CLI_TIMEOUT' : 'CLI_EXIT_NONZERO';
          log(
            'Discord CLI diagnostic ' +
              JSON.stringify({
                classification,
                elapsed_ms: callbackMs,
                first_stdout_ms: firstStdoutMs,
                exit_ms: exitMs,
                close_ms: closeMs,
                callback_ms: callbackMs,
                signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(error.signal ?? '')
                  ? error.signal
                  : error.signal
                    ? 'OTHER'
                    : null,
                code:
                  typeof error.code === 'number'
                    ? error.code
                    : ['ENOENT', 'EACCES', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(
                          error.code ?? ''
                        )
                      ? error.code
                      : error.code
                        ? 'OTHER'
                        : null,
                stdout_bytes: new TextEncoder().encode(stdout).length,
                stderr_bytes: new TextEncoder().encode(stderr).length,
                valid_json: validJson,
              })
          );
          // Keep known identities for recovery, but never accept failed stdout as success.
          if (validJson && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            resolve({ ...parsed, _cliFailure: true, _cliCode: classification });
          } else {
            reject(new DiscordError(classification, true));
          }
          return;
        }
        if (validJson) resolve(parsed);
        else reject(new DiscordError('CLI_INVALID_JSON', true));
      }
    );
    child.stdout?.once('data', () => {
      firstStdoutMs = elapsed();
    });
    child.once?.('exit', () => {
      exitMs = elapsed();
    });
    // execFile invokes its callback from close; record close before that listener.
    child.prependOnceListener?.('close', () => {
      closeMs = elapsed();
    });
    // EOF is hygiene for noninteractive commands, not a proven timeout fix.
    // These invocations never consume prompts from stdin. Deliver EOF to CLI startup.
    if (args[0] === 'message' || (args[0] === 'agent' && args.includes('--message-file')))
      child.stdin?.end();
  });
function payload(value: any): any {
  const result = value?.payload ?? value;
  const failed =
    value?._cliFailure ||
    value?.ok === false ||
    value?.isError === true ||
    result?.ok === false ||
    result?.isError === true;
  // A known thread survives a failing exit; never hide its identity or run into it.
  if (failed && result?.thread?.id) return { ...result, partial: true };
  if (!result || failed) throw new DiscordError(value?._cliCode ?? 'CLI_ACTION_REJECTED', true);
  return result;
}
interface Operation {
  instance?: string;
  agent_id?: string;
  fingerprint: string;
  kind?: 'thread_reply';
  owner?: string;
  request_status?:
    | 'pending'
    | 'publishing'
    | 'sent'
    | 'verified'
    | 'failed'
    | 'partial'
    | 'unknown';
  request_verified?: boolean;
  request_message_ids?: string[];
  status:
    | 'creating'
    | 'creation_unknown'
    | 'created'
    | 'creation_partial'
    | 'queued'
    | 'running'
    | 'completed'
    | 'run_failed'
    | 'run_unknown';
  operation_id: string;
  target: string;
  channel_id?: string;
  session_key?: string;
  discord_url?: string;
  run_id?: string;
  agent_transport?: 'cli' | 'sdk';
  agent_idempotency_key?: string;
  cancellation_status?: 'requested' | 'acknowledged' | 'unknown';
  delivery_status?: string;
  delivery_verified?: boolean;
  message_id?: string;
  generation_status?: string;
  thread_create_transport?: 'cli' | 'gateway';
  thread_create_fallback?: string;
  member_status?: 'disabled' | 'pending' | 'adding' | 'verified' | 'failed' | 'unknown';
  member_verified?: boolean;
  member_error_code?: string;
  handoff?: string;
  recovery?: string;
  error_code?: string;
}
/** Optional extra route verification. Normal routing is an operator prerequisite. */
export type DiscordRouteResolver = (
  target: AdmittedTarget,
  channelId: string
) => Promise<{
  channelId: string;
  guildId: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
  kind: 'ordinary' | 'bound' | 'subagent' | 'unknown';
}>;
export class DiscordService {
  private readonly creation?: ChannelCreation;
  private readonly owner = randomUUID();
  private readonly workers = new Set<Promise<unknown>>();
  private readonly active = new Set<string>();
  private readonly preparations = new Map<string, number>();
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private closing = false;
  async shutdown() {
    this.closing = true;
    await this.drain();
  }
  async drain() {
    while (this.workers.size) await Promise.allSettled([...this.workers]);
  }

  constructor(
    readonly config: DiscordConfig,
    private readonly runner: CliRunner = runCli,
    invoke?: ChannelInvoker,
    private readonly resolveRoute?: DiscordRouteResolver,
    private readonly reader?: DiscordReader,
    private readonly invokeThread?: ThreadInvoker,
    private readonly addThreadMember?: ThreadMemberAdder,
    private readonly publishRequest?: RequestPublisher,
    private readonly agent?: DiscordAgentTransport
  ) {
    validateConfig(config);
    if (config.agentTransport === 'sdk' && (!agent || !reader))
      throw new DiscordError('SDK_ADAPTER_REQUIRED');
    if (config.threadCreateMode === 'gateway' && !invokeThread)
      throw new DiscordError('THREAD_ADAPTER_REQUIRED');
    if (config.threadMember && !addThreadMember)
      throw new DiscordError('THREAD_MEMBER_ADAPTER_REQUIRED');
    if (config.creationPolicies) {
      if (!invoke) throw new DiscordError('CREATION_ADAPTER_REQUIRED');
      this.creation = new ChannelCreation(
        config.stateDir,
        config.creationPolicies,
        invoke,
        async (p, id) => {
          if (id !== p.categoryId) {
            assertChannelAllowed(this.config, id);
            if (
              this.config.importedRouteAgent &&
              this.config.importedRouteAgent({ ...p, channelId: id }, id) !== p.agentId
            )
              throw new DiscordError('CREATION_ROUTE_CONFLICT');
          } else if (this.config.channelBlacklist?.includes(id))
            throw new DiscordError('CHANNEL_POLICY_DENIED');
          return (await this.readInfo({ ...p, channelId: id }, id)).channel;
        }
      );
    }
  }
  private async ordinaryRoute(t: AdmittedTarget, channelId: string) {
    if (
      this.config.importedRouteAgent &&
      this.config.importedRouteAgent(t, channelId) !== t.agentId
    )
      throw new DiscordError('ROUTE_MISMATCH');
    if (!this.resolveRoute) return 'agent:' + t.agentId + ':discord:channel:' + channelId;
    let route;
    try {
      route = await this.resolveRoute(t, channelId);
    } catch {
      throw new DiscordError('ROUTE_UNVERIFIED');
    }
    if (
      !route ||
      route.channelId !== channelId ||
      route.guildId !== t.guildId ||
      route.accountId !== t.accountId
    )
      throw new DiscordError('ROUTE_UNVERIFIED');
    if (route.kind !== 'ordinary') throw new DiscordError('NONORDINARY_ROUTE_DENIED');
    if (
      route.agentId !== t.agentId ||
      route.sessionKey !== 'agent:' + t.agentId + ':discord:channel:' + channelId
    )
      throw new DiscordError('ROUTE_MISMATCH');
    return route.sessionKey;
  }
  private route(t: AdmittedTarget, channelId = t.channelId): AdmittedTarget {
    if (!this.config.importedRouteAgent) return t;
    const agentId = this.config.importedRouteAgent(t, channelId);
    if (!agentId) throw new DiscordError('IMPORTED_ROUTE_UNMAPPED');
    return { ...t, permissionAgentId: t.permissionAgentId ?? t.agentId, agentId };
  }
  private matches(t: { agentId: string; instance?: string }, input: DiscordSelectors) {
    return (
      (input.agent_id === undefined || input.agent_id === t.agentId) &&
      (input.instance === undefined ||
        input.instance === (t.instance ?? this.config.cliGatewayInstance))
    );
  }
  private assertSelectors(t: { agentId: string; instance?: string }, input: DiscordSelectors) {
    if (!this.matches(t, input)) throw new DiscordError('ROUTE_SELECTOR_CONFLICT');
  }
  private policyRoute(p: CreationPolicy) {
    // A new channel has no peer binding. Its guild/account route must match the policy.
    if (
      this.config.importedRouteAgent &&
      this.config.importedRouteAgent({ ...p, channelId: '' }, '') !== p.agentId
    )
      throw new DiscordError('CREATION_ROUTE_CONFLICT');
    return p;
  }
  async createChannel(input: any) {
    if (!this.creation) throw new DiscordError('CHANNEL_CREATION_DISABLED');
    const policy = this.config.creationPolicies?.find((p) => p.name === input.policy);
    if (policy) {
      this.assertSelectors(policy, input);
      this.policyRoute(policy);
    }
    if (policy && this.config.channelBlacklist?.includes(policy.categoryId))
      throw new DiscordError('CHANNEL_POLICY_DENIED');
    const result = await this.creation.create(input);
    return { ...result, instance: policy?.instance, agent_id: policy?.agentId };
  }
  private async target(name: unknown, channelId?: string) {
    const targets = [...this.config.targets, ...((await this.creation?.admitted()) ?? [])];
    let t = targets.find((item) => item.name === name);
    if (!t && typeof name === 'string') {
      const match = /^discord-[a-f0-9]{64}-([1-9][0-9]{16,19})$/.exec(name);
      if (match) {
        t = this.config.discoveryScopes
          ?.map((s) => dynamicTarget(s, match[1]))
          .find((candidate) => candidate.name === name);
        // A crafted dynamic ID must retain narrower legacy/admission constraints.
        if (t) {
          const existing = targets.find(
            (item) => item.channelId === t!.channelId && scopeKey(item) === scopeKey(t!)
          );
          if (existing) t = { ...existing, name: t.name };
        }
      }
    }
    if (!t) throw new Error('Target is not allowlisted');
    assertTargetAllowed(this.config, t);
    return this.route(t, channelId);
  }
  private async cli(t: DiscordConfig['targets'][number], args: string[]) {
    if (this.config.agentTransport === 'sdk') throw new DiscordError('CLI_DISABLED');
    return payload(
      await this.runner(
        this.config.executable,
        ['message', ...args, '--channel', 'discord', '--account', t.accountId, '--json'],
        this.config.cliTimeoutMs ?? 30000
      )
    );
  }
  private async readInfo(t: AdmittedTarget, id: string) {
    check(id, snowflake, 'channel ID');
    return this.reader && this.config.gatewayReadsEnabled === true && this.config.cliGatewayInstance
      ? this.reader(t, { action: 'channel-info', channelId: id })
      : this.cli(t, ['channel', 'info', '--target', 'channel:' + id]);
  }
  private verifyChannel(t: AdmittedTarget, id: string, c: any, parent = false) {
    assertTargetAllowed(this.config, t, id);
    if (!c || c.id !== id || c.guild_id !== t.guildId || !Number.isInteger(c.type))
      throw new Error('Channel guild could not be verified');
    if (id === t.channelId && t.categoryId && c.parent_id !== t.categoryId)
      throw new DiscordError('ADMITTED_CHANNEL_MOVED');
    const thread = [10, 11, 12].includes(c.type);
    if (thread && this.config.channelBlacklist?.includes(c.parent_id))
      throw new DiscordError('CHANNEL_POLICY_DENIED');
    if (
      parent
        ? id !== t.channelId || ![0, 5, 15, 16].includes(c.type)
        : id !== t.channelId && (!thread || c.parent_id !== t.channelId)
    ) {
      throw new Error('Channel is outside allowed target');
    }
    return c;
  }
  private async info(t: AdmittedTarget, id: string, parent = false) {
    assertTargetAllowed(this.config, t, id);
    return this.verifyChannel(t, id, (await this.readInfo(t, id)).channel, parent);
  }
  async channels(input: DiscordSelectors = {}) {
    const channels = [];
    const targets = [...this.config.targets, ...((await this.creation?.admitted()) ?? [])].filter(
      (t) => channelAllowed(this.config, t.channelId)
    );
    // One live list per guild/account/agent, scoped to this request only.
    const lists = new Map<string, Map<string, any>>();
    for (const t of [
      ...targets,
      ...(this.config.discoveryScopes ?? []).map((s) => dynamicTarget(s, s.guildId)),
    ]) {
      const key = scopeKey(t);
      if (lists.has(key)) continue;
      const data =
        this.reader && this.config.gatewayReadsEnabled === true && this.config.cliGatewayInstance
          ? await this.reader(t, { action: 'channel-list' })
          : await this.cli(t, ['channel', 'list', '--guild-id', t.guildId]);
      if (
        !data ||
        data.ok === false ||
        data.isError ||
        data.partial ||
        !Array.isArray(data.channels)
      )
        throw new DiscordError('CHANNEL_LIST_UNVERIFIED');
      const byId = new Map<string, any>();
      for (const c of data.channels) {
        if (
          !c ||
          typeof c.id !== 'string' ||
          !snowflake.test(c.id) ||
          byId.has(c.id) ||
          c.guild_id !== t.guildId ||
          !Number.isInteger(c.type)
        )
          throw new DiscordError('CHANNEL_LIST_UNVERIFIED');
        byId.set(c.id, c);
      }
      lists.set(key, byId);
    }
    for (const scope of this.config.discoveryScopes ?? []) {
      for (const c of lists.get(scopeKey(scope))!.values()) {
        if (![0, 5, 15, 16].includes(c.type) || !channelAllowed(this.config, c.id)) continue;
        // Keep legacy aliases and category-admission checks when scopes overlap.
        if (!targets.some((t) => scopeKey(t) === scopeKey(scope) && t.channelId === c.id))
          targets.push(dynamicTarget(scope, c.id));
      }
    }
    for (const t of targets) {
      const list = lists.get(scopeKey(t))!;
      // A complete live list may no longer contain a deleted or inaccessible legacy target.
      if (!list.has(t.channelId)) continue;
      const c = this.verifyChannel(t, t.channelId, list.get(t.channelId), true);
      const category = c.parent_id == null ? undefined : list.get(c.parent_id);
      if (
        c.parent_id != null &&
        (!category ||
          category.id !== c.parent_id ||
          category.guild_id !== t.guildId ||
          category.type !== 4)
      )
        throw new DiscordError('CATEGORY_VERIFICATION_FAILED');
      if (
        typeof c.name !== 'string' ||
        (c.topic != null && typeof c.topic !== 'string') ||
        (category && typeof category.name !== 'string')
      )
        throw new DiscordError('CHANNEL_METADATA_UNVERIFIED');
      let routed;
      try {
        routed = this.route(t);
      } catch (error) {
        if (error instanceof DiscordError && error.code === 'IMPORTED_ROUTE_UNMAPPED') continue;
        throw error;
      }
      if (!this.matches(routed, input)) continue;
      channels.push({
        instance: this.config.cliGatewayInstance,
        agent_id: routed.agentId,
        account_id: routed.accountId,
        target: t.name,
        channel_id: c.id,
        guild_id: t.guildId,
        name: c.name,
        topic: c.topic ?? null,
        category_id: c.parent_id ?? null,
        category_name: category?.name ?? null,
        discord_url: 'https://discord.com/channels/' + t.guildId + '/' + c.id,
      });
    }
    return {
      channels,
      creation_policies: (this.config.creationPolicies ?? [])
        .filter((p) => {
          if (!this.matches(p, input)) return false;
          try {
            this.policyRoute(p);
            return true;
          } catch {
            return false;
          }
        })
        .map((p) => ({
          instance: p.instance,
          agent_id: p.agentId,
          account_id: p.accountId,
          policy: p.name,
          guild_id: p.guildId,
          category_id: p.categoryId,
          agent: p.agentId,
        })),
    };
  }
  async threads(input: any) {
    const t = await this.target(input.target);
    this.assertSelectors(t, input);
    if (input.archived !== undefined && typeof input.archived !== 'boolean')
      throw new Error('Invalid archived flag');
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new Error('Invalid limit');
    if (
      input.before !== undefined &&
      (typeof input.before !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(input.before) ||
        !Number.isFinite(Date.parse(input.before)))
    )
      throw new Error('Invalid archive timestamp');
    if (!input.archived && (input.before !== undefined || input.limit !== undefined))
      throw new Error('Pagination is only supported for archived public threads');
    await this.info(t, t.channelId, true);
    const args = ['thread', 'list', '--guild-id', t.guildId, '--channel-id', t.channelId];
    if (input.archived) args.push('--include-archived');
    if (input.before) args.push('--before', input.before);
    if (input.limit) args.push('--limit', String(input.limit));
    const data =
      this.config.agentTransport === 'sdk'
        ? await this.reader!(t, {
            action: 'thread-list',
            channelId: t.channelId,
            includeArchived: input.archived,
            before: input.before,
            limit: input.limit,
          })
        : await this.cli(t, args);
    const raw = Array.isArray(data.threads) ? data : data.threads;
    if (!raw || !Array.isArray(raw.threads)) throw new Error('Unexpected thread list');
    const threads = raw.threads
      .filter(
        (c: any) =>
          c &&
          typeof c.id === 'string' &&
          snowflake.test(c.id) &&
          !this.config.channelBlacklist?.includes(c.id) &&
          c.guild_id === t.guildId &&
          c.parent_id === t.channelId &&
          [10, 11, 12].includes(c.type)
      )
      .map((c: any) => ({
        channel_id: c.id,
        name: c.name,
        archived: c.thread_metadata?.archived,
        archive_timestamp: c.thread_metadata?.archive_timestamp,
        discord_url: 'https://discord.com/channels/' + t.guildId + '/' + c.id,
      }));
    return {
      instance: this.config.cliGatewayInstance,
      agent_id: t.agentId,
      account_id: t.accountId,
      threads,
      has_more: raw.has_more === true,
      next_before:
        raw.has_more === true ? raw.threads.at(-1)?.thread_metadata?.archive_timestamp : undefined,
      pagination: input.archived ? 'archived_public_timestamp' : 'none',
    };
  }
  private path(id: unknown) {
    check(id, /^[a-zA-Z0-9_-]{16,100}$/, 'operation ID');
    return join(this.config.stateDir, id + '.json');
  }
  async status(id: unknown, input: DiscordSelectors = {}) {
    const result: Operation = JSON.parse(await readFile(this.path(id), 'utf8'));
    if ((result as any).kind === 'channel_create') {
      if (
        !this.creation ||
        !this.config.creationPolicies?.some((p) => p.name === (result as any).policy)
      )
        throw new DiscordError('CREATION_POLICY_DENIED');
      if (result.channel_id) assertChannelAllowed(this.config, result.channel_id);
      const policy = this.config.creationPolicies!.find((p) => p.name === (result as any).policy)!;
      this.assertSelectors(
        {
          agentId: result.agent_id ?? policy.agentId,
          instance: result.instance ?? policy.instance,
        },
        input
      );
      if (
        (result.agent_id && result.agent_id !== policy.agentId) ||
        (result.instance && result.instance !== policy.instance)
      )
        throw new DiscordError('ROUTE_MISMATCH');
      this.policyRoute(policy);
      return {
        ...this.creation.publicResult(result),
        instance: policy.instance,
        agent_id: policy.agentId,
      };
    }
    const t = await this.target(result.target, result.channel_id);
    const sessionAgent =
      typeof result.session_key === 'string'
        ? /^agent:([a-z0-9][a-z0-9_-]{0,63}):discord:channel:/.exec(result.session_key)?.[1]
        : undefined;
    const storedAgent = result.agent_id ?? sessionAgent;
    if (result.agent_id && sessionAgent && result.agent_id !== sessionAgent)
      throw new DiscordError('ROUTE_MISMATCH');
    this.assertSelectors(
      {
        agentId: storedAgent ?? t.agentId,
        instance: result.instance ?? this.config.cliGatewayInstance,
      },
      input
    );
    if (
      (storedAgent && storedAgent !== t.agentId) ||
      (result.instance && result.instance !== this.config.cliGatewayInstance)
    )
      throw new DiscordError('ROUTE_MISMATCH');
    assertTargetAllowed(this.config, t, result.channel_id);
    return this.publicResult({ ...result, ...(storedAgent ? { agent_id: storedAgent } : {}) });
  }
  /** Host-only explicit cancellation; MCP request disconnects never call this. */
  async cancel(id: string, input: DiscordSelectors = {}) {
    assertServiceProvenance();
    const current = await this.status(id, input);
    const cancel = this.cancellations.get(id);
    if (
      this.config.agentTransport !== 'sdk' ||
      !cancel ||
      !this.active.has(id) ||
      current.status !== 'running' ||
      !current.run_id
    )
      throw new DiscordError('OWNED_ACCEPTED_RUN_REQUIRED');
    const cancellation = cancel();
    this.workers.add(cancellation);
    try {
      await cancellation;
      return await this.status(id, input);
    } finally {
      this.workers.delete(cancellation);
    }
  }
  private publicResult(op: Operation) {
    const result: Partial<Operation> = { ...op };
    delete result.fingerprint;
    delete result.owner;
    // Old process work is never resumed. Reads never rewrite records or repeat effects.
    if (
      ['creating', 'created', 'queued', 'running'].includes(op.status) &&
      (op.owner !== this.owner || !this.active.has(op.operation_id))
    ) {
      result.status =
        op.channel_id || op.kind === 'thread_reply' ? 'run_unknown' : 'creation_unknown';
      result.error_code = 'OPERATION_INTERRUPTED';
      result.recovery =
        'Service ownership ended. Inspect the existing thread; never replay this operation.';
      if (op.request_status === 'publishing' || op.request_status === 'sent')
        result.request_status = 'unknown';
      if (op.member_status === 'adding') result.member_status = 'unknown';
    }
    if (result.discord_url && !result.handoff)
      result.handoff =
        'Continue on Discord: ' +
        result.discord_url +
        ' (operation ' +
        result.status +
        '; first response not confirmed)';
    return { ...result, retry_safe: false };
  }
  async ask(input: any) {
    if (input.mode !== 'new_thread') throw new DiscordError('CONTINUE_UNSUPPORTED');
    return this.enqueue(input);
  }
  async reply(input: any) {
    if (
      !input ||
      Object.keys(input).some(
        (key) =>
          !['target', 'channel_id', 'operation_id', 'prompt', 'instance', 'agent_id'].includes(key)
      )
    )
      throw new DiscordError('REPLY_ARGUMENTS_INVALID');
    check(input.channel_id, snowflake, 'thread ID');
    return this.enqueue({ ...input, mode: 'reply' });
  }
  private async enqueue(input: any) {
    this.path(input.operation_id);
    const existing = await readFile(this.path(input.operation_id), 'utf8').then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      }
    );
    if (
      !existing &&
      !this.active.has(input.operation_id) &&
      (this.closing || this.active.size >= (this.config.maxOperations ?? 4))
    )
      throw new DiscordError(this.closing ? 'SERVICE_STOPPING' : 'OPERATION_CAPACITY');
    const reserved = !existing && !this.active.has(input.operation_id);
    if (reserved) this.active.add(input.operation_id);
    this.preparations.set(input.operation_id, (this.preparations.get(input.operation_id) ?? 0) + 1);
    const task = this.prepare(input);
    this.workers.add(task);
    try {
      return await task;
    } finally {
      this.workers.delete(task);
      const remaining = this.preparations.get(input.operation_id)! - 1;
      if (remaining) this.preparations.set(input.operation_id, remaining);
      else {
        this.preparations.delete(input.operation_id);
        if (!this.background.has(input.operation_id)) this.active.delete(input.operation_id);
      }
    }
  }
  private async verifyReply(t: AdmittedTarget, id: string, prompt: string) {
    await this.info(t, t.channelId, true);
    const thread = await this.info(t, id);
    if (id === t.channelId || ![10, 11].includes(thread.type))
      throw new DiscordError('PUBLIC_THREAD_REQUIRED');
    if (
      thread.thread_metadata?.locked !== false ||
      typeof thread.thread_metadata?.archived !== 'boolean'
    )
      throw new DiscordError('THREAD_LOCKED_OR_UNVERIFIED');
    const permissions =
      this.config.agentTransport === 'sdk'
        ? await this.reader!(t, { action: 'permissions', channelId: id })
        : await this.cli(t, ['permissions', '--target', 'channel:' + id]);
    const p = permissions.permissions;
    if (
      !p ||
      p.channelId !== id ||
      p.guildId !== t.guildId ||
      p.isDm !== false ||
      p.channelType !== thread.type ||
      !Array.isArray(p.permissions) ||
      ![
        'ViewChannel',
        'SendMessagesInThreads',
        'ReadMessageHistory',
        ...(prompt.length > 2000 ? ['AttachFiles'] : []),
      ].every((name) => p.permissions.includes(name))
    )
      throw new DiscordError('THREAD_PERMISSIONS_DENIED');
    return this.ordinaryRoute(t, id);
  }
  private readonly background = new Set<string>();
  private async claimSession(key: string, operation: string) {
    const path = join(
      this.config.stateDir,
      'session-' + createHash('sha256').update(key).digest('hex') + '.lock'
    );
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new DiscordError('SESSION_BUSY_OR_UNCERTAIN');
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ operation_id: operation, owner: this.owner }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.config.stateDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    let released = false;
    return async () => {
      if (released) return;
      await rm(path);
      released = true;
      const directory = await open(this.config.stateDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
  }
  private async prepare(input: any) {
    const replying = input.mode === 'reply';
    if (
      replying ||
      this.config.agentTransport === 'sdk' ||
      this.config.threadCreateMode === 'gateway' ||
      this.config.threadMember
    )
      assertServiceProvenance();
    const t = await this.target(input.target, replying ? input.channel_id : undefined);
    this.assertSelectors(t, input);
    const path = this.path(input.operation_id);

    if (
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      new TextEncoder().encode(input.prompt).length > 1024 * 1024 ||
      input.prompt.includes('\0') ||
      new TextDecoder().decode(new TextEncoder().encode(input.prompt)) !== input.prompt
    )
      throw new Error('Invalid prompt');
    if (input.mode === 'new_thread') {
      if (
        typeof input.title !== 'string' ||
        !input.title.trim() ||
        input.title.length > 100 ||
        [...input.title].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        input.title.startsWith('-') ||
        input.channel_id !== undefined
      )
        throw new Error('Invalid thread title or channel_id');
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([t, input.mode, input.title, input.channel_id, input.prompt]))
      .digest('hex');
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const state = await lstat(this.config.stateDir);
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0)
      throw new Error('State directory must be private (0700) and not a symlink');
    const syncDirectory = async () => {
      const directory = await open(this.config.stateDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    // Exclusive durable claim: never replay a write, even after process failure.
    let file;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: Operation;
      try {
        previous = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        throw new Error(
          'Operation is being reserved or needs operator recovery; do not retry with a new ID'
        );
      }
      if (previous.fingerprint !== fingerprint)
        throw new Error('Operation ID already used with different arguments');
      assertTargetAllowed(this.config, t, previous.channel_id);
      return this.publicResult(previous);
    }
    const op: Operation = {
      fingerprint,
      instance: this.config.cliGatewayInstance,
      agent_id: t.agentId,
      agent_transport: this.config.agentTransport ?? 'cli',
      ...(this.config.agentTransport === 'sdk'
        ? {
            agent_idempotency_key:
              'discord-run-' +
              createHash('sha256')
                .update(JSON.stringify([this.config.cliGatewayInstance, input.operation_id]))
                .digest('hex'),
          }
        : {}),
      ...(replying ? { kind: 'thread_reply' as const } : {}),
      owner: this.owner,
      request_status: 'pending',
      request_verified: false,
      request_message_ids: [],
      operation_id: input.operation_id,
      target: t.name,
      status: input.mode === 'new_thread' ? 'creating' : 'created',
      member_status: !replying && this.config.threadMember ? 'pending' : 'disabled',
      member_verified: false,
    };
    try {
      await file.writeFile(JSON.stringify(op));
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory();
    let saves = Promise.resolve();
    const save = () => {
      const snapshot = JSON.stringify(op);
      const saved = saves.then(async () => {
        const temporary = path + '.tmp';
        const handle = await open(temporary, 'w', 0o600);
        try {
          await handle.writeFile(snapshot);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        await syncDirectory();
      });
      saves = saved.catch(() => undefined);
      return saved;
    };
    let releaseSession: (() => Promise<void>) | undefined;
    let dir: string | undefined;
    let dispatched = false;
    let createDispatched = false;
    try {
      if (this.config.acknowledgeInboundRouting !== true || t.normalRouting !== true)
        throw new DiscordError('NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED');
      if (!this.publishRequest) throw new DiscordError('REQUEST_PUBLISHER_REQUIRED');
      if (this.config.agentTransport === 'sdk') await this.agent!.ready();
      const parent = await this.info(t, t.channelId, true);
      if ([15, 16].includes(parent.type)) throw new DiscordError('FORUM_MEDIA_WRITES_UNSUPPORTED');
      let id = input.channel_id;
      if (replying) {
        op.session_key = await this.verifyReply(t, id, input.prompt);
        op.channel_id = id;
        op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
        releaseSession = await this.claimSession(op.session_key, input.operation_id);
        await save();
      }
      if (input.mode === 'new_thread') {
        await this.ordinaryRoute(t, t.channelId);
        createDispatched = true;
        const createCli = () =>
          this.cli(t, [
            'thread',
            'create',
            '--target',
            'channel:' + t.channelId,
            '--thread-name',
            input.title,
          ]);
        let created;
        op.thread_create_transport = this.config.threadCreateMode === 'gateway' ? 'gateway' : 'cli';
        await save();
        if (op.thread_create_transport === 'gateway') {
          try {
            created = await this.invokeThread!(t, input.title, input.operation_id);
          } catch (error) {
            if (
              !(error instanceof ThreadGatewayUnavailable) ||
              this.config.agentTransport === 'sdk'
            )
              throw error;
            op.thread_create_transport = 'cli';
            op.thread_create_fallback = error.code;
            await save();
            created = await createCli();
          }
        } else created = await createCli();
        id = created.thread?.id;
        check(id, snowflake, 'created thread ID');
        if (id === t.channelId) throw new DiscordError('CREATED_THREAD_ID_INVALID', true);
        op.channel_id = id;
        op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
        op.status = created.partial ? 'creation_partial' : 'created';
        await save();
        if (created.partial) {
          op.recovery =
            'Thread created with partial result. Inspect it; no agent turn was started.';
          await save();
          return this.publicResult(op);
        }
      }
      await this.info(t, id);
      op.channel_id = id;
      op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
      op.session_key = await this.ordinaryRoute(t, id);
      if (!replying && this.config.threadMember) {
        op.member_status = 'adding';
        await save();
        try {
          await this.addThreadMember!(t, id);
          op.member_status = 'verified';
          op.member_verified = true;
        } catch (error) {
          op.member_status =
            error instanceof DiscordError && !error.uncertain ? 'failed' : 'unknown';
          op.member_error_code =
            error instanceof DiscordError ? error.code : 'THREAD_MEMBER_UNVERIFIED';
          await save();
          throw new DiscordError('THREAD_MEMBER_NOT_VERIFIED');
        }
        await save();
      }
      let promptFile: string | undefined;
      if (this.config.agentTransport !== 'sdk') {
        dir = await mkdtemp(join(tmpdir(), 'openclaw-mcp-'));
        promptFile = join(dir, 'prompt.txt');
        await writeFile(promptFile, input.prompt, { mode: 0o600 });
      }
      if (replying) await this.verifyReply(t, id, input.prompt);
      op.request_status = 'publishing';
      await save();
      try {
        await this.publishRequest!(
          t,
          id,
          input.prompt,
          input.operation_id,
          async (messageId) => {
            op.request_message_ids = [messageId];
            op.request_status = 'sent';
            await save();
          },
          input.mode === 'new_thread'
        );
        if (!op.request_message_ids?.length)
          throw new DiscordError('REQUEST_RESULT_UNVERIFIED', true);
        op.request_status = 'verified';
        op.request_verified = true;
      } catch (error) {
        op.request_status = op.request_message_ids?.length
          ? 'partial'
          : error instanceof DiscordError && !error.uncertain
            ? 'failed'
            : 'unknown';
        throw error;
      }
      op.status = 'queued';
      op.generation_status = 'queued';
      await save();
      const accepted = this.publicResult(op);
      this.background.add(input.operation_id);
      const directory = dir;
      const worker = (async () => {
        // Handoff is independent of generation and of any transport abort signal.
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          op.status = 'running';
          op.generation_status = 'running';
          await save();
          assertTargetAllowed(this.config, t, id);
          if (replying) await this.verifyReply(t, id, input.prompt);
          dispatched = true;
          const result: any =
            this.config.agentTransport === 'sdk'
              ? await this.agent!.run(
                  {
                    message: input.prompt,
                    agentId: t.agentId,
                    sessionKey: op.session_key!,
                    threadId: id,
                    accountId: t.accountId,
                    idempotencyKey: op.agent_idempotency_key!,
                  },
                  async (receipt) => {
                    if (
                      receipt.sessionKey !== op.session_key ||
                      receipt.agentId !== t.agentId ||
                      !receipt.runId ||
                      (op.run_id && receipt.runId !== op.run_id)
                    )
                      throw new DiscordError('SDK_ACCEPTANCE_IDENTITY_MISMATCH', true);
                    op.run_id = receipt.runId;
                    op.generation_status = 'accepted';
                    await save();
                    let cancellation: Promise<void> | undefined;
                    this.cancellations.set(input.operation_id, () => {
                      cancellation ??= (async () => {
                        op.cancellation_status = 'requested';
                        await save();
                        try {
                          await this.agent!.cancel(receipt);
                          op.cancellation_status = 'acknowledged';
                        } catch (error) {
                          op.cancellation_status = 'unknown';
                          await save();
                          throw error;
                        }
                        await save();
                      })();
                      return cancellation;
                    });
                  }
                )
              : await this.runner(
                  this.config.executable,
                  [
                    'agent',
                    '--agent',
                    t.agentId,
                    '--session-key',
                    op.session_key,
                    '--message-file',
                    promptFile!,
                    '--deliver',
                    '--reply-channel',
                    'discord',
                    '--reply-to',
                    'channel:' + id,
                    '--reply-account',
                    t.accountId,
                    '--timeout',
                    '600',
                    '--json',
                  ],
                  630000
                );
          op.run_id = typeof result?.runId === 'string' ? result.runId : op.run_id;
          const delivery =
            result?.deliveryStatus ??
            result?.result?.deliveryStatus ??
            result?.delivery ??
            result?.result?.delivery;
          const deliveryStatus = typeof delivery === 'string' ? delivery : delivery?.status;
          op.delivery_status = [
            'sent',
            'delivered',
            'failed',
            'partial_failed',
            'suppressed',
          ].includes(deliveryStatus)
            ? deliveryStatus
            : 'unverified';
          op.delivery_verified = false;
          const messageId = delivery?.messageId;
          if (typeof messageId === 'string' && snowflake.test(messageId)) {
            op.message_id = messageId;
            // One exact-ID read, never a text match or a scan of unrelated messages.
            try {
              const readback =
                this.config.agentTransport === 'sdk'
                  ? await this.reader!(t, { action: 'read', channelId: id, messageId, limit: 1 })
                  : await this.cli(t, [
                      'read',
                      '--target',
                      'channel:' + id,
                      '--message-id',
                      messageId,
                      '--limit',
                      '1',
                    ]);
              op.delivery_verified =
                readback.channelId === id &&
                Array.isArray(readback.messages) &&
                readback.messages.some(
                  (m: any) => m.id === messageId && (!m.channel_id || m.channel_id === id)
                );
            } catch {
              /* Delivery may have succeeded; a failed read does not authorize retry. */
            }
          }
          op.error_code = result?._cliFailure ? result._cliCode : undefined;
          op.status = result?._cliFailure
            ? result._cliCode === 'CLI_TIMEOUT'
              ? 'run_unknown'
              : 'run_failed'
            : ['ok', 'completed'].includes(result?.status)
              ? 'completed'
              : ['error', 'aborted'].includes(result?.status) || result?.ok === false
                ? 'run_failed'
                : 'run_unknown';
          op.generation_status = op.status;
          op.handoff = 'Continue on Discord: ' + op.discord_url;
          if (
            (op.delivery_status !== 'sent' && op.delivery_status !== 'delivered') ||
            !op.delivery_verified
          )
            op.handoff +=
              ' (first-response delivery ' +
              op.delivery_status +
              '; ' +
              (op.delivery_verified ? 'message verified' : 'not independently verified') +
              ')';
          if (op.status !== 'completed')
            op.recovery =
              'Inspect the existing conversation before authorizing a new turn. Never repeat this operation with a new ID blindly.';
          await save();
        } catch (error) {
          op.status =
            dispatched && !(error instanceof DiscordError && !error.uncertain)
              ? 'run_unknown'
              : 'run_failed';
          op.generation_status = op.status;
          op.error_code = error instanceof DiscordError ? error.code : 'UNVERIFIED_RESULT';
          await save();
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
          // Ambiguous dispatch retains the durable claim for operator recovery.
          if (!dispatched || op.status === 'completed') await releaseSession?.();
        }
      })();
      // Handle failures saving state or cleaning files as well as runner rejection.
      const owned = worker
        .catch(() => {
          log('Discord worker failed; operation requires inspection');
        })
        .finally(() => {
          this.cancellations.delete(input.operation_id);
          this.background.delete(input.operation_id);
          this.active.delete(input.operation_id);
          this.workers.delete(owned);
        });
      this.workers.add(owned);
      dir = undefined; // worker owns the prompt until generation and cleanup finish
      return accepted;
    } catch (error) {
      op.error_code = error instanceof DiscordError ? error.code : 'UNVERIFIED_RESULT';
      op.status = dispatched
        ? 'run_unknown'
        : op.channel_id || input.mode === 'continue'
          ? 'run_failed'
          : createDispatched
            ? 'creation_unknown'
            : 'run_failed';
      op.recovery =
        'Inspect Discord and gateway logs. This operation is never automatically replayed; preserve its ID. An interrupted creating/running record also requires inspection.';
      await save();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
      if (
        !this.background.has(input.operation_id) &&
        !['unknown', 'partial', 'publishing', 'sent'].includes(op.request_status ?? '')
      )
        await releaseSession?.();
    }
    return this.publicResult(op);
  }
}
