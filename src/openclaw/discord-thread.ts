import { assertTargetAllowed } from './discord-policy.js';
import { assertServiceProvenance, DiscordError, type AdmittedTarget } from './discord-channels.js';
import type { DiscordConfig } from './discord.js';
import type { GatewayConfig } from './types.js';
import { createHash } from 'node:crypto';
import { channelReader } from './discord-read.js';

export type ThreadInvoker = (
  target: AdmittedTarget,
  title: string,
  operation: string,
  starterSaved?: (messageId: string) => Promise<void>
) => Promise<any>;

/** Fixed message/thread-create request; never a general Gateway proxy. */
export function threadInvoker(
  gateway: GatewayConfig,
  config: DiscordConfig,
  fetcher = fetch,
  env = process.env
): ThreadInvoker {
  const { url: gatewayUrl, token } = gateway;
  if (!token) throw new DiscordError('THREAD_GATEWAY_CONFIGURATION_INVALID');
  const url = new URL('/tools/invoke', gatewayUrl);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new DiscordError('INSECURE_GATEWAY_URL');
  return async (target, title, operation, starterSaved) => {
    assertServiceProvenance();
    assertTargetAllowed(config, target, undefined, 'THREAD_SCOPE_DENIED');
    if (
      !snowflake.test(target.channelId) ||
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 100 ||
      [...title].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(operation)
    )
      throw new DiscordError('THREAD_ARGUMENTS_INVALID');
    let messageId: string | undefined;
    if ((config.threadCreationMode ?? 'silent-starter') === 'silent-starter') {
      const botToken = env.DISCORD_BOT_TOKEN;
      if (!botToken || /\s/.test(botToken)) throw new DiscordError('STARTER_CREDENTIAL_MISSING');
      if (target.accountId !== config.threadMember?.accountId)
        throw new DiscordError('STARTER_ACCOUNT_MISMATCH');
      if (!starterSaved) throw new DiscordError('STARTER_JOURNAL_REQUIRED');
      const { permissions: p } = await channelReader(
        gateway,
        config,
        fetcher
      )(target, {
        action: 'permissions',
        channelId: target.channelId,
      });
      if (
        !p ||
        p.channelId !== target.channelId ||
        p.guildId !== target.guildId ||
        p.isDm !== false ||
        ![0, 5].includes(p.channelType) ||
        !Array.isArray(p.permissions) ||
        ![
          'ViewChannel',
          'SendMessages',
          'ReadMessageHistory',
          'CreatePublicThreads',
          'SendMessagesInThreads',
        ].every((name) => p.permissions.includes(name))
      )
        throw new DiscordError('STARTER_PERMISSIONS_DENIED');
      const endpoint = 'https://discord.com/api/v10/channels/' + target.channelId + '/messages';
      const request = async (method: 'POST' | 'GET', suffix = '') => {
        try {
          return await fetcher(endpoint + suffix, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
            headers: { Authorization: 'Bot ' + botToken, 'Content-Type': 'application/json' },
            ...(method === 'POST'
              ? {
                  body: JSON.stringify({
                    content: title,
                    flags: 4 | 4096,
                    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
                    nonce: createHash('sha256')
                      .update('thread-starter:' + operation)
                      .digest('hex')
                      .slice(0, 25),
                    enforce_nonce: true,
                  }),
                }
              : {}),
          });
        } catch {
          throw new DiscordError('STARTER_OUTCOME_UNKNOWN', true);
        }
      };
      const sent = await request('POST');
      if (!sent.ok) throw new DiscordError('STARTER_HTTP_' + sent.status, true);
      let posted: any;
      try {
        posted = await sent.json();
      } catch {
        throw new DiscordError('STARTER_UNVERIFIED', true);
      }
      if (typeof posted.id !== 'string' || !snowflake.test(posted.id))
        throw new DiscordError('STARTER_UNVERIFIED', true);
      messageId = posted.id;
      await starterSaved(messageId!);
      const read = await request('GET', '/' + messageId);
      if (!read.ok) throw new DiscordError('STARTER_READ_HTTP_' + read.status, true);
      let verified: any;
      try {
        verified = await read.json();
      } catch {
        throw new DiscordError('STARTER_UNVERIFIED', true);
      }
      if (
        verified.id !== messageId ||
        verified.channel_id !== target.channelId ||
        verified.author?.bot !== true ||
        verified.author?.id !== posted.author?.id ||
        verified.content !== title ||
        !Number.isInteger(verified.flags) ||
        (verified.flags & 4100) !== 4100 ||
        verified.mention_everyone !== false ||
        !Array.isArray(verified.mentions) ||
        verified.mentions.length ||
        !Array.isArray(verified.mention_roles) ||
        verified.mention_roles.length
      )
        throw new DiscordError('STARTER_UNVERIFIED', true);
    }
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'message',
          sessionKey: 'agent:' + target.agentId + ':main',
          idempotencyKey: operation,
          args: {
            action: 'thread-create',
            channel: 'discord',
            accountId: target.accountId,
            channelId: target.channelId,
            threadName: title,
            ...(messageId ? { messageId } : {}),
          },
        }),
      });
    } catch (error) {
      // A refused connection cannot have dispatched the mutation. Timeouts/reset errors can.
      if ((error as any)?.code === 'ECONNREFUSED' || (error as any)?.cause?.code === 'ECONNREFUSED')
        throw new DiscordError('THREAD_GATEWAY_UNREACHABLE');
      throw new DiscordError('GATEWAY_OUTCOME_UNKNOWN', true);
    }
    // Even a 404 may conceal a policy denial; no HTTP reply authorizes another create.
    if (!response.ok) throw new DiscordError('GATEWAY_HTTP_' + response.status, true);
    try {
      const body: any = await response.json();
      const result =
        body.result?.details ??
        (body.result?.content?.[0]?.type === 'text'
          ? JSON.parse(body.result.content[0].text)
          : body.result);
      const failed =
        body.ok !== true || body.result?.isError || result?.ok !== true || result?.isError;
      // Preserve a known identity even when the tool reports a partial/failed write.
      if (
        typeof result?.thread?.id === 'string' &&
        snowflake.test(result.thread.id) &&
        (!messageId || result.thread.id === messageId)
      )
        return { thread: { id: result.thread.id }, partial: Boolean(failed || result.partial) };
      throw new Error();
    } catch {
      throw new DiscordError('GATEWAY_RESULT_UNCONFIRMED', true);
    }
  };
}

const snowflake = /^[1-9][0-9]{16,19}$/;
export type ThreadMemberAdder = (target: AdmittedTarget, threadId: string) => Promise<void>;

/** Called only after the service durably records and verifies its newly created thread. */
export function threadMemberAdder(
  config: DiscordConfig,
  env = process.env,
  fetcher = fetch
): ThreadMemberAdder | undefined {
  if (!config.threadMember) return undefined;
  const { userId, accountId } = config.threadMember;
  if (!snowflake.test(userId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountId))
    throw new DiscordError('THREAD_MEMBER_CONFIGURATION_INVALID');
  const token = env.DISCORD_BOT_TOKEN;
  if (!token || /\s/.test(token)) throw new DiscordError('THREAD_MEMBER_CREDENTIAL_MISSING');
  return async (target, threadId) => {
    assertServiceProvenance();
    assertTargetAllowed(config, target, threadId, 'THREAD_MEMBER_SCOPE_DENIED');
    if (
      target.accountId !== accountId ||
      !snowflake.test(threadId) ||
      threadId === target.channelId
    )
      throw new DiscordError('THREAD_MEMBER_SCOPE_DENIED');
    const url = 'https://discord.com/api/v10/channels/' + threadId + '/thread-members/' + userId;
    const request = async (method: 'PUT' | 'GET') => {
      try {
        return await fetcher(url, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: { Authorization: 'Bot ' + token },
        });
      } catch {
        throw new DiscordError('THREAD_MEMBER_OUTCOME_UNKNOWN', true);
      }
    };
    const added = await request('PUT');
    if (added.status !== 204) throw new DiscordError('THREAD_MEMBER_HTTP_' + added.status, true);
    const readback = await request('GET');
    if (readback.status !== 200)
      throw new DiscordError('THREAD_MEMBER_READ_HTTP_' + readback.status, true);
    try {
      const member: any = await readback.json();
      if (member.id !== threadId || member.user_id !== userId) throw new Error();
    } catch {
      throw new DiscordError('THREAD_MEMBER_UNVERIFIED', true);
    }
  };
}
