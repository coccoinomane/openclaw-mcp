import { GatewayClient, type GatewayClientOptions } from '@openclaw/gateway-client';
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from '@openclaw/gateway-protocol/client-info';
import { readConnectErrorDetailCode } from '@openclaw/gateway-protocol/connect-error-details';
import { SERVER_VERSION } from '../config/constants.js';
import { gatewayDiscoveryAuth } from './gateway-discovery-auth.js';
import type { InstanceConfig } from './types.js';

export type DiscoveryClient = Pick<GatewayClient, 'start' | 'request' | 'stopAndWait'>;
export type DiscoveryClientFactory = (options: GatewayClientOptions) => DiscoveryClient;
export type GatewayRosterLoader = (
  config: InstanceConfig,
  env: NodeJS.ProcessEnv
) => Promise<unknown>;
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Only agents.list is exposed here; this is not a general RPC adapter. */
export async function discoverGatewayAgents(
  config: InstanceConfig,
  env: NodeJS.ProcessEnv = process.env,
  createClient: DiscoveryClientFactory = (options) => new GatewayClient(options)
): Promise<unknown> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.name))
    throw new Error('Invalid discovery instance name');
  const fail = (reason: string) =>
    new Error('Gateway agent discovery for instance "' + config.name + '": ' + reason);
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
  let auth: ReturnType<typeof gatewayDiscoveryAuth>;
  try {
    auth = gatewayDiscoveryAuth(config.name, url.toString(), env);
  } catch {
    throw fail(
      'cannot load private device state; check the discovery state directory and permissions'
    );
  }
  if (!auth.hasToken && !config.token)
    throw fail('a configured Gateway token is required for first pairing');

  let client: DiscoveryClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason = 'connection or agents.list request failed';
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
        reason = 'device token lacks operator.read; review the device pairing grant';
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
      token: auth.hasToken ? undefined : config.token,
      deviceIdentity: auth.identity,
      hostDeps: auth.hostDeps,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: 'openclaw-mcp agent discovery',
      clientVersion: SERVER_VERSION,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      role: 'operator',
      scopes: ['operator.read'],
      caps: [],
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
    result = await client.request('agents.list', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    failure = fail(reason);
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
