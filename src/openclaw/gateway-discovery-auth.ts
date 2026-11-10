import { Buffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DeviceIdentity, GatewayClientHostDeps } from '@openclaw/gateway-client';

type Token = { token: string; scopes: string[] };
const MAX_STATE_BYTES = 32 * 1024;

function privateEntry(stat: Stats, directory = false): void {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Invalid discovery state');
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
  )
    throw new Error('Discovery state must be private to its owner');
}

function readState(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    privateEntry(stat);
    if (stat.size > MAX_STATE_BYTES) throw new Error('Discovery state is too large');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

function publicBytes(pem: string): Buffer {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid discovery key');
  const jwk = key.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Invalid discovery key');
  return Buffer.from(jwk.x, 'base64url');
}

function validateIdentity(value: unknown): DeviceIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid discovery identity');
  const identity = value as DeviceIdentity;
  if (typeof identity.privateKeyPem !== 'string' || typeof identity.publicKeyPem !== 'string')
    throw new Error('Invalid discovery identity');
  const bytes = publicBytes(identity.publicKeyPem);
  const derived = createPublicKey(createPrivateKey(identity.privateKeyPem)).export({
    format: 'jwk',
  });
  if (
    derived.x !== bytes.toString('base64url') ||
    identity.deviceId !== createHash('sha256').update(bytes).digest('hex')
  )
    throw new Error('Invalid discovery identity');
  return {
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
  };
}

/** This integration owns its keys; it never opens OpenClaw's CLI identity files. */
export function gatewayDiscoveryAuth(
  url: string,
  env: NodeJS.ProcessEnv,
  options: { existingOnly?: boolean; identityOnly?: boolean } = {}
): {
  identity: DeviceIdentity;
  hasToken: boolean;
  hostDeps: GatewayClientHostDeps;
} {
  const directory =
    env.MCP_AGENT_DISCOVERY_STATE_DIR || join(homedir(), '.openclaw-mcp', 'gateway-discovery');
  if (!isAbsolute(directory)) throw new Error('Discovery state directory must be absolute');
  if (!options.existingOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateEntry(lstatSync(directory), true);
  // Bind storage to the full endpoint, never just device/role.
  const key = createHash('sha256')
    .update(JSON.stringify([url]))
    .digest('hex');
  const identityPath = join(directory, key + '.identity.json');
  const tokenPath = join(directory, key + '.operator.json');
  let value = readState(identityPath);
  if (value === undefined && options.existingOnly) throw new Error('Approved device required');
  if (value === undefined) {
    const pair = generateKeyPairSync('ed25519');
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const created: DeviceIdentity = {
      deviceId: createHash('sha256').update(publicBytes(publicKeyPem)).digest('hex'),
      publicKeyPem,
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    try {
      writeFileSync(identityPath, JSON.stringify(created), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    value = readState(identityPath);
  }
  const identity = validateIdentity(value);
  const loadToken = (): Token | null => {
    const value = readState(tokenPath);
    if (value === undefined) return null;
    const token = value as Token;
    if (
      !token ||
      typeof token.token !== 'string' ||
      !token.token ||
      !Array.isArray(token.scopes) ||
      token.scopes.some((scope) => typeof scope !== 'string')
    )
      throw new Error('Invalid discovery device token');
    return { token: token.token, scopes: token.scopes };
  };
  const checkOwner = (deviceId: string, role: string) => {
    if (deviceId !== identity.deviceId || role !== 'operator')
      throw new Error('Discovery credential scope mismatch');
  };
  const hostDeps: GatewayClientHostDeps = {
    signDevicePayload: (privateKey, payload) =>
      Buffer.from(sign(null, Buffer.from(payload), privateKey)).toString('base64url'),
    publicKeyRawBase64UrlFromPem: (pem) => publicBytes(pem).toString('base64url'),
    loadDeviceAuthToken: ({ deviceId, role }) => {
      checkOwner(deviceId, role);
      return loadToken();
    },
    storeDeviceAuthToken: ({
      deviceId,
      role,
      token,
      scopes,
      expectedToken,
      assertCurrent,
      signal,
    }) => {
      checkOwner(deviceId, role);
      signal?.throwIfAborted();
      assertCurrent?.();
      const previous = loadToken();
      if (expectedToken !== undefined && (previous?.token ?? null) !== expectedToken) return;
      const temporary = tokenPath + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temporary, JSON.stringify({ token, scopes }), { flag: 'wx', mode: 0o600 });
        assertCurrent?.();
        renameSync(temporary, tokenPath);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // Preserve the original write failure; any orphan stays in the private directory.
        }
      }
    },
    clearDeviceAuthToken: ({ deviceId, role, expectedToken, assertCurrent, signal }) => {
      checkOwner(deviceId, role);
      signal?.throwIfAborted();
      assertCurrent?.();
      const previous = loadToken();
      if (!previous || (expectedToken !== undefined && previous.token !== expectedToken)) return;
      unlinkSync(tokenPath);
    },
    // SDK logging is deliberately silent; callers receive only fixed error categories.
    redactForLog: () => '[gateway discovery]',
  };
  if (options.identityOnly) {
    // Shared-token mode must neither consume nor alter a device-token grant.
    return {
      identity,
      hasToken: false,
      hostDeps: {
        signDevicePayload: hostDeps.signDevicePayload,
        publicKeyRawBase64UrlFromPem: hostDeps.publicKeyRawBase64UrlFromPem,
        redactForLog: hostDeps.redactForLog,
        loadDeviceAuthToken: () => null,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
    };
  }
  return { identity, hasToken: loadToken() !== null, hostDeps };
}
