import {
  GatewayClient,
  GatewayClientRequestError,
  type GatewayClientOptions,
} from '@openclaw/gateway-client';
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from '@openclaw/gateway-protocol/client-info';
import { readConnectErrorDetailCode } from '@openclaw/gateway-protocol/connect-error-details';
import { join } from 'node:path';
import { SERVER_VERSION } from '../config/constants.js';
import { assertServiceProvenance, DiscordError } from './discord-channels.js';
import { gatewayDiscoveryAuth } from './gateway-discovery-auth.js';
import type { DiscordConfig } from './discord.js';
import type { InstanceConfig } from './types.js';

export type AgentReceipt = { runId: string; sessionKey: string; agentId: string };
export type DiscordAgentRequest = {
  message: string;
  agentId: string;
  sessionKey: string;
  threadId: string;
  accountId: string;
  idempotencyKey: string;
};
export interface DiscordAgentTransport {
  ready(): Promise<void>;
  run(
    request: DiscordAgentRequest,
    accepted: (receipt: AgentReceipt) => Promise<void>
  ): Promise<any>;
  cancel(receipt: AgentReceipt): Promise<void>;
}
export type AgentClient = Pick<GatewayClient, 'start' | 'request' | 'stopAndWait'>;
export type AgentClientFactory = (options: GatewayClientOptions) => AgentClient;
const scopes = ['operator.read', 'operator.write'];
const observationBudgetMs = 630_000;

function receipt(value: any, expected: Pick<AgentReceipt, 'sessionKey' | 'agentId'>): AgentReceipt {
  if (
    !value ||
    typeof value.runId !== 'string' ||
    !value.runId.trim() ||
    value.runId.length > 256 ||
    value.sessionKey !== expected.sessionKey ||
    value.agentId !== expected.agentId
  )
    throw new DiscordError('SDK_ACCEPTANCE_IDENTITY_MISMATCH', true);
  return { runId: value.runId, sessionKey: value.sessionKey, agentId: value.agentId };
}
function requestFailure(error: unknown, uncertain: boolean): DiscordError {
  // Transport errors and observation failures never authorize a second dispatch.
  if (error instanceof DiscordError) return error;
  if (error instanceof GatewayClientRequestError)
    return new DiscordError(
      'SDK_REQUEST_REJECTED',
      uncertain || !['FORBIDDEN', 'INVALID_REQUEST'].includes(error.gatewayCode)
    );
  return new DiscordError('SDK_OUTCOME_UNKNOWN', true);
}

/** Fixed agent/wait/abort calls, using an operator-approved service device. */
export function discordAgentTransport(
  instances: InstanceConfig[],
  config: DiscordConfig,
  env: NodeJS.ProcessEnv = process.env,
  createClient: AgentClientFactory = (options) => new GatewayClient(options)
): DiscordAgentTransport | undefined {
  if (config.agentTransport !== 'sdk') return undefined;
  const matches = instances.filter((i) => i.name === config.cliGatewayInstance);
  if (matches.length !== 1) throw new DiscordError('SDK_GATEWAY_CONFIGURATION_INVALID');
  const instance = matches[0];
  let url: URL;
  try {
    url = new URL(instance.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error();
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  } catch {
    throw new DiscordError('INSECURE_GATEWAY_URL');
  }

  async function connect(): Promise<AgentClient> {
    assertServiceProvenance(env);
    assertServiceProvenance();
    let auth: ReturnType<typeof gatewayDiscoveryAuth>;
    try {
      auth = gatewayDiscoveryAuth(
        instance.name,
        url.toString(),
        {
          ...env,
          MCP_AGENT_DISCOVERY_STATE_DIR:
            env.MCP_DISCORD_SDK_STATE_DIR || join(config.stateDir, 'gateway-sdk'),
        },
        { existingOnly: true }
      );
      const token = await auth.hostDeps.loadDeviceAuthToken!({
        deviceId: auth.identity.deviceId,
        role: 'operator',
      });
      if (!token?.token || !scopes.every((scope) => token.scopes?.includes(scope)))
        throw new Error();
    } catch {
      throw new DiscordError('SDK_APPROVED_DEVICE_REQUIRED');
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    const timer = setTimeout(() => reject(new DiscordError('SDK_CONNECT_TIMEOUT')), 15_000);
    let client: AgentClient | undefined;
    const options: GatewayClientOptions = {
      url: url.toString(),
      deviceIdentity: auth.identity,
      hostDeps: {
        ...auth.hostDeps,
        beforeConnect: () => {
          assertServiceProvenance(env);
          assertServiceProvenance();
        },
      },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: 'openclaw-mcp Discord service',
      clientVersion: SERVER_VERSION,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      role: 'operator',
      scopes,
      caps: [],
      minProtocol: 4,
      maxProtocol: 4,
      requestTimeoutMs: 30_000,
      onHelloOk: (hello) => {
        if (!scopes.every((scope) => hello.auth?.scopes?.includes(scope)))
          reject(new DiscordError('SDK_SCOPE_DENIED'));
        else resolve();
      },
      onConnectError: (error) => {
        const code = readConnectErrorDetailCode((error as Error & { details?: unknown }).details);
        reject(
          new DiscordError(
            code === 'PAIRING_REQUIRED' ? 'SDK_APPROVED_DEVICE_REQUIRED' : 'SDK_AUTH_FAILED'
          )
        );
      },
      onReconnectPaused: () => reject(new DiscordError('SDK_AUTH_FAILED')),
      onClose: () => reject(new DiscordError('SDK_CONNECTION_CLOSED')),
    };
    try {
      // Install a handler before a synchronous start failure can reject readiness.
      const started = ready.then(() => undefined);
      try {
        client = createClient(options);
        client.start();
      } catch {
        reject(new DiscordError('SDK_CONNECT_FAILED'));
      }
      await started;
      return client;
    } catch (error) {
      if (client) await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function close(client: AgentClient) {
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
  return {
    async ready() {
      const client = await connect();
      await close(client);
    },
    async run(input, accepted) {
      assertServiceProvenance();
      const client = await connect();
      let owned: AgentReceipt | undefined;
      let persistence = Promise.resolve();
      let persistenceError: unknown;
      const capture = (value: unknown) => {
        persistence = persistence
          .then(async () => {
            const next = receipt(value, input);
            if (owned && owned.runId !== next.runId)
              throw new DiscordError('SDK_ACCEPTANCE_IDENTITY_MISMATCH', true);
            if (!owned) {
              await accepted(next);
              owned = next;
            }
          })
          .catch((error) => {
            persistenceError ??= error;
          });
      };
      let result: any;
      let failure: unknown;
      const deadline = Date.now() + observationBudgetMs;
      try {
        result = await client.request(
          'agent',
          {
            message: input.message,
            agentId: input.agentId,
            sessionKey: input.sessionKey,
            deliver: true,
            replyChannel: 'discord',
            replyTo: 'channel:' + input.threadId,
            replyAccountId: input.accountId,
            timeout: 600,
            idempotencyKey: input.idempotencyKey,
          },
          { expectFinal: true, timeoutMs: observationBudgetMs, onAccepted: capture }
        );
        if (result?.admissionPending === true)
          throw new DiscordError('SDK_ACCEPTANCE_UNCONFIRMED', true);
        if (result?.status === 'in_flight' || result?.status === 'accepted') capture(result);
      } catch (error) {
        failure = error;
      } finally {
        await close(client);
      }
      await persistence;
      if (persistenceError) throw new DiscordError('SDK_ACCEPTANCE_UNCONFIRMED', true);
      if (owned && result?.runId !== undefined && result.runId !== owned.runId)
        throw new DiscordError('SDK_RESULT_IDENTITY_MISMATCH', true);
      if (
        (result?.sessionKey !== undefined && result.sessionKey !== input.sessionKey) ||
        (result?.agentId !== undefined && result.agentId !== input.agentId)
      )
        throw new DiscordError('SDK_RESULT_IDENTITY_MISMATCH', true);
      if (failure && !owned) throw requestFailure(failure, false);
      if (!failure && !['accepted', 'in_flight'].includes(result?.status)) return result;
      if (!owned) throw new DiscordError('SDK_ACCEPTANCE_UNCONFIRMED', true);
      // Observe only a durably accepted run. Never resubmit agent after disconnect.
      while (Date.now() < deadline) {
        let observer: AgentClient | undefined;
        try {
          observer = await connect();
          const remaining = Math.max(1, Math.min(30_000, deadline - Date.now()));
          result = await observer.request<any>(
            'agent.wait',
            { runId: owned.runId, timeoutMs: remaining },
            { timeoutMs: remaining + 5_000 }
          );
          if (result?.runId !== owned.runId)
            throw new DiscordError('SDK_RESULT_IDENTITY_MISMATCH', true);
          if (['ok', 'error', 'aborted'].includes(result?.status))
            return { ...result, deliveryStatus: result.terminalDelivery };
          if (!['pending', 'timeout'].includes(result?.status))
            throw new DiscordError('SDK_OBSERVATION_UNCONFIRMED', true);
        } catch (error) {
          throw requestFailure(error, true);
        } finally {
          if (observer) await close(observer);
        }
        // Queued observations can return immediately; do not poll in a tight loop.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new DiscordError('SDK_OBSERVATION_TIMEOUT', true);
    },
    async cancel(owned) {
      assertServiceProvenance();
      const client = await connect();
      try {
        const result = await client.request<any>(
          'chat.abort',
          {
            sessionKey: owned.sessionKey,
            agentId: owned.agentId,
            runId: owned.runId,
          },
          { timeoutMs: 30_000 }
        );
        if (
          result?.ok !== true ||
          result.aborted !== true ||
          !Array.isArray(result.runIds) ||
          !result.runIds.includes(owned.runId)
        )
          throw new DiscordError('SDK_CANCEL_UNCONFIRMED', true);
      } catch (error) {
        throw requestFailure(error, true);
      } finally {
        await close(client);
      }
    },
  };
}
