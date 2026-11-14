import {
  GatewayClient,
  GatewayClientRequestError,
  type GatewayClientOptions,
} from '@openclaw/gateway-client';
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from '@openclaw/gateway-protocol/client-info';
import { readConnectErrorDetailCode } from '@openclaw/gateway-protocol/connect-error-details';
import { SERVER_VERSION } from '../config/constants.js';
import { gatewayDiscoveryAuth } from './gateway-discovery-auth.js';
import type { GatewayConfig } from './types.js';

export type DiscoveryClient = Pick<GatewayClient, 'start' | 'request' | 'stopAndWait'>;
export type DiscoveryClientFactory = (options: GatewayClientOptions) => DiscoveryClient;
export type GatewayRosterLoader = (
  config: GatewayConfig,
  env: NodeJS.ProcessEnv
) => Promise<unknown>;
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

type ModelRequest =
  | { method: 'models.list'; params: { agentId: string; view: 'configured' } }
  | { method: 'sessions.patch'; params: { key: string; model: string } };

export async function gatewayModelRequest(
  config: GatewayConfig,
  request: ModelRequest,
  env = process.env,
  createClient?: DiscoveryClientFactory
): Promise<any> {
  return requestGateway(config, env, createClient, request);
}

export async function discoverGatewayAgents(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
  createClient?: DiscoveryClientFactory
): Promise<unknown> {
  return requestGateway(config, env, createClient);
}

/** Closed roster/model operations; never accepts client-supplied RPC methods. */
async function requestGateway(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
  createClient: DiscoveryClientFactory = (options) => new GatewayClient(options),
  modelRequest?: ModelRequest
): Promise<unknown> {
  const fail = (reason: string) =>
    new Error((modelRequest ? 'Gateway models: ' : 'Gateway agent discovery: ') + reason);
  if (modelRequest && !['device', 'local-shared-token'].includes(env.MCP_MODEL_AUTH ?? 'device'))
    throw fail('invalid MCP_MODEL_AUTH');
  let url: URL;
  try {
    url = new URL(config.url);
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
    throw fail('use HTTPS (or loopback HTTP) without URL credentials, query or fragment');
  }
  const localShared = modelRequest && env.MCP_MODEL_AUTH === 'local-shared-token';
  if (localShared && (!['127.0.0.1', '[::1]'].includes(url.hostname) || !config.token))
    throw fail('local-shared-token model access requires literal loopback and a Gateway token');
  const scopes =
    modelRequest?.method === 'sessions.patch'
      ? ['operator.read', 'operator.write']
      : ['operator.read'];
  let auth: ReturnType<typeof gatewayDiscoveryAuth>;
  try {
    auth = gatewayDiscoveryAuth(url.toString(), env, { identityOnly: !!localShared });
  } catch {
    throw fail(
      'cannot load private device state; check the discovery state directory and permissions'
    );
  }
  if (!auth.hasToken && !config.token)
    throw fail('a configured Gateway token is required for first pairing');

  let client: DiscoveryClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason = 'connection or ' + (modelRequest?.method ?? 'agents.list') + ' request failed';
  let connecting = true;
  let result: unknown;
  let failure: Error | undefined;
  try {
    let accept!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, rejectReady) => {
      accept = resolve;
      reject = rejectReady;
    });
    const rejectConnection = (error?: Error) => {
      if (!connecting) return;
      const code = readConnectErrorDetailCode(
        error && (error as Error & { details?: unknown }).details
      );
      if (code === 'PAIRING_REQUIRED') {
        reason =
          'pairing required for device ' +
          auth.identity.deviceId +
          '; review and approve its current request with openclaw devices list/approve on this Gateway, then retry';
      } else if (code === 'AUTH_SCOPE_MISMATCH') {
        reason = 'device token lacks ' + scopes.join('/') + '; review the device pairing grant';
      } else if (code?.startsWith('AUTH_')) {
        reason = 'Gateway authentication failed; check the configured token or device grant';
      }
      reject(fail(reason));
    };
    timer = setTimeout(() => {
      reason = 'connection readiness timed out';
      reject(fail(reason));
    }, READY_TIMEOUT_MS);
    client = createClient({
      url: url.toString(),
      token: localShared ? config.token : auth.hasToken ? undefined : config.token,
      deviceIdentity: auth.identity,
      hostDeps: auth.hostDeps,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: 'openclaw-mcp agent discovery',
      clientVersion: SERVER_VERSION,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      role: 'operator',
      scopes,
      caps: modelRequest ? ['model-selection-policy'] : [],
      minProtocol: 4,
      maxProtocol: 4,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => accept(),
      onConnectError: rejectConnection,
      onReconnectPaused: () => rejectConnection(),
      onClose: () => rejectConnection(),
    });
    // Attach a rejection handler before start(), including synchronous transport failures.
    const started = ready.then(() => {
      connecting = false;
    });
    try {
      client.start();
    } catch {
      rejectConnection();
    }
    await started;
    clearTimeout(timer);
    result = await client.request(
      modelRequest?.method ?? 'agents.list',
      modelRequest?.params ?? {},
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
  } catch (error) {
    failure =
      modelRequest && error instanceof GatewayClientRequestError
        ? new Error('Gateway model selection: ' + error.message)
        : fail(reason);
  } finally {
    connecting = false;
    clearTimeout(timer);
    if (client) {
      try {
        await client.stopAndWait({ timeoutMs: 1_000 });
      } catch {
        // Do not expose transport error text or credentials during shutdown.
        failure ??= fail('connection cleanup failed');
      }
    }
  }
  if (failure) throw failure;
  return result;
}
