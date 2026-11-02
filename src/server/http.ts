/**
 * HTTP Transport for remote MCP access
 *
 * Provides a full Express HTTP server with:
 * - Modern Streamable HTTP transport (POST/GET/DELETE /mcp) — primary
 * - Legacy SSE transport (GET /sse + POST /messages) — deprecated, kept for backward compat
 * - OAuth 2.1 authentication via MCP SDK (mcpAuthRouter + requireBearerAuth)
 * - .well-known discovery endpoints for OAuth metadata
 * - CORS support
 * - Health check endpoint
 * - Graceful shutdown
 */

import { randomUUID, createHash } from 'node:crypto';
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Request, Response, NextFunction } from 'express';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InitializeRequestSchema, JSONRPCRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { httpDiagnostics } from './http-diagnostics.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { OpenClawAuthProvider, type AuthProviderConfig } from '../auth/provider.js';
import { log, logError } from '../utils/logger.js';
import {
  createMcpServer,
  createModernMcpServer,
  type ToolRegistrationDeps,
} from './tools-registration.js';

export interface HttpServerConfig {
  port: number;
  host: string;
  /** Override the OAuth issuer URL (e.g., https://mcp.example.com behind a reverse proxy) */
  issuerUrl?: string;
  /**
   * Express `trust proxy` setting. Required when behind a reverse proxy that
   * sets `X-Forwarded-For` — otherwise `express-rate-limit` (used by the MCP
   * SDK auth handlers) throws `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on `/token`.
   * Accepts `true` / `false`, a hop count (e.g. `1`), or an IP/CIDR string or
   * keyword (`loopback`, `linklocal`, `uniquelocal`). Undefined leaves the
   * Express default (`false`) untouched.
   */
  trustProxy?: boolean | number | string;
  /** Auth is enabled when authConfig is provided */
  authConfig?: AuthProviderConfig;
}

/**
 * Parse the TRUST_PROXY env var / --trust-proxy CLI flag into an
 * Express-compatible value. Returns `undefined` when the input is empty so
 * callers can skip `app.set('trust proxy', …)` entirely.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  return trimmed;
}

// --- CORS helpers ---

/**
 * Load CORS configuration from environment.
 *
 * Defaults to CORS disabled. Sending `Access-Control-Allow-Origin: *` by
 * default let any web page drive this server through a visitor's browser;
 * enabling cross-origin access is now an explicit opt-in via `CORS_ORIGINS`.
 * Set `CORS_ORIGINS=*` to restore the old behaviour, or list the origins you
 * actually serve. Non-browser clients (Claude.ai, Claude Desktop, Inspector
 * over stdio) are unaffected — CORS only applies to browsers.
 */
export function loadCorsConfig(): { origins: string[]; enabled: boolean } {
  const corsOrigins = process.env.CORS_ORIGINS;

  if (!corsOrigins || corsOrigins.toLowerCase() === 'none') {
    return { origins: [], enabled: false };
  }

  if (corsOrigins === '*') {
    return { origins: ['*'], enabled: true };
  }

  return {
    origins: corsOrigins
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: true,
  };
}

/**
 * Check if origin is allowed by CORS config
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(1); // ".example.com"
      try {
        const originHost = new URL(origin).hostname;
        return originHost === domain.slice(1) || originHost.endsWith(domain);
      } catch {
        return false;
      }
    }
    return origin === allowed || origin === `https://${allowed}` || origin === `http://${allowed}`;
  });
}

// --- Session tracking ---

interface LegacySseSession {
  transport: SSEServerTransport;
  server: Server;
}

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

// --- Main server factory ---

/**
 * Create and start the HTTP server with Streamable HTTP + legacy SSE transports.
 */
export async function createHttpServer(
  config: HttpServerConfig,
  deps: ToolRegistrationDeps
): Promise<void> {
  // Configured issuer only; Host and forwarded headers are untrusted labels.
  const registrationDeps = { ...deps, issuerUrl: config.issuerUrl ?? deps.issuerUrl };
  const authEnabled = !!config.authConfig?.clientId;
  const corsConfig = loadCorsConfig();

  // Active sessions
  const legacySseSessions = new Map<string, LegacySseSession>();
  const streamableSessions = new Map<string, StreamableSession>();

  // Express app from SDK (includes JSON body parser + DNS rebinding protection)
  const app = createMcpExpressApp({ host: config.host });

  // Configure Express `trust proxy` when running behind a reverse proxy.
  // Without this, `express-rate-limit` (used by the MCP SDK auth handlers)
  // crashes /token with ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  if (config.trustProxy !== undefined) {
    app.set('trust proxy', config.trustProxy);
    log(`Trust proxy: ${JSON.stringify(config.trustProxy)}`);
  }

  app.use(httpDiagnostics((id) => streamableSessions.has(id)));

  // A missing Origin is normal for native clients. A browser origin must be
  // same-origin with the trusted issuer/bind address, or explicitly allowlisted.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const localOrigins = [
      'http://localhost:' + config.port,
      'http://127.0.0.1:' + config.port,
      'http://[::1]:' + config.port,
    ];
    const trustedOrigins = config.issuerUrl
      ? [new URL(config.issuerUrl).origin, ...localOrigins]
      : localOrigins;
    if (origin && !isOriginAllowed(origin, [...trustedOrigins, ...corsConfig.origins])) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });

  // --- CORS middleware (before auth so preflight works) ---
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!corsConfig.enabled) {
      next();
      return;
    }

    const origin = req.headers.origin as string | undefined;
    const allowedOrigin = corsConfig.origins.includes('*')
      ? '*'
      : origin && isOriginAllowed(origin, corsConfig.origins)
        ? origin
        : undefined;

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, X-Request-Id');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // --- OAuth routes (if auth enabled) ---
  let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

  if (authEnabled) {
    const provider = new OpenClawAuthProvider(config.authConfig!);
    const issuerUrl = config.issuerUrl
      ? new URL(config.issuerUrl)
      : new URL(`http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

    // Install OAuth endpoints: /authorize, /token, /register, /revoke
    // and .well-known discovery metadata
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        scopesSupported: ['mcp:tools'],
      })
    );

    // Protected Resource Metadata (RFC 9728)
    // Tells clients (Inspector, Claude.ai) where the OAuth server is.
    // This is read-only metadata — no security implications.
    app.get('/.well-known/oauth-protected-resource/:path', (req: Request, res: Response) => {
      res.json({
        resource: `${issuerUrl.toString()}${req.params.path}`,
        authorization_servers: [issuerUrl.toString()],
        scopes_supported: ['mcp:tools'],
      });
    });

    // Bearer auth middleware for protected routes
    authMiddleware = requireBearerAuth({ verifier: provider });
  }

  // --- Health check (no auth) ---
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      legacySseSupported: true,
      auth: authEnabled,
    });
  });

  // Helper to conditionally apply auth middleware
  const withAuth = (handler: (req: Request, res: Response) => Promise<void>) => {
    if (authMiddleware) {
      return [authMiddleware, async (req: Request, res: Response) => handler(req, res)] as const;
    }
    return [async (req: Request, res: Response) => handler(req, res)] as const;
  };

  // --- Legacy SSE transport (GET /sse + POST /messages) — deprecated ---

  app.get(
    '/sse',
    ...withAuth(async (req: Request, res: Response) => {
      log('Legacy SSE transport is deprecated; prefer Streamable HTTP at /mcp');
      const transport = new SSEServerTransport('/messages', res as unknown as ServerResponse);
      const server = createMcpServer(registrationDeps);

      const sessionId = transport.sessionId;
      legacySseSessions.set(sessionId, { transport, server });
      log(`SSE session connected: ${sessionId}`);

      transport.onclose = () => {
        legacySseSessions.delete(sessionId);
        log(`SSE session disconnected: ${sessionId}`);
      };

      try {
        await server.connect(transport);
      } catch (error) {
        legacySseSessions.delete(sessionId);
        logError(`Failed to connect SSE session ${sessionId}`, error);
      }
    })
  );

  app.post(
    '/messages',
    ...withAuth(async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      const session = legacySseSessions.get(sessionId);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      try {
        await session.transport.handlePostMessage(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
      } catch (error) {
        logError(`Error handling message for session ${sessionId}`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    })
  );

  // --- Modern Streamable HTTP transport (ALL /mcp) ---

  // Modern HTTP has no connection identity. Authenticated tokens retain task ownership
  // across requests; anonymous modern requests cannot share asynchronous task state.
  const modern = createMcpHandler(
    (ctx) => {
      const owner = ctx.authInfo?.token
        ? 'modern:' + createHash('sha256').update(ctx.authInfo.token).digest('hex')
        : undefined;
      return createModernMcpServer(registrationDeps, owner);
    },
    { legacy: 'reject' }
  );
  const modernNode = toNodeHandler(modern);
  const handleStreamableRequest = async (req: Request, res: Response) => {
    const legacy = await isLegacyRequest(await toWebRequest(req, req.body), req.body);
    res.locals.mcpDiagnostic.branch = legacy ? 'legacy' : 'modern';
    if (!legacy) {
      await modernNode(req, res, req.body);
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && streamableSessions.has(sessionId)) {
      // Existing session
      const session = streamableSessions.get(sessionId)!;
      try {
        await session.transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
      } catch (error) {
        res.locals.mcpDiagnostic.category = 'transport_exception';
        logError('Error in streamable session');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
      return;
    }

    // Never recreate a lost session or replay its request. The client must initialize again.
    if (sessionId) {
      res.locals.mcpDiagnostic.category = 'unknown_session';
      res
        .status(404)
        .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
      return;
    }
    if (
      req.method !== 'POST' ||
      !JSONRPCRequestSchema.safeParse(req.body).success ||
      !InitializeRequestSchema.safeParse(req.body).success
    ) {
      res.locals.mcpDiagnostic.category =
        req.body?.method === 'initialize' ? 'invalid_initialize' : 'missing_session';
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Bad Request: Mcp-Session-Id header is required; initialize a new session first',
        },
      });
      return;
    }

    // New session (validated initialization request only).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        streamableSessions.set(newSessionId, { transport, server });
        log('Streamable session initialized');
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        streamableSessions.delete(sid);
        log('Streamable session closed');
      }
    };

    const server = createMcpServer(registrationDeps);

    try {
      await server.connect(transport);
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (error) {
      res.locals.mcpDiagnostic.category = 'transport_exception';
      logError('Failed to initialize streamable session');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    } finally {
      // Header validation can reject an initialize request before it acquires a session.
      if (!transport.sessionId) await server.close();
    }
  };

  app.get('/mcp', ...withAuth(handleStreamableRequest));
  app.post('/mcp', ...withAuth(handleStreamableRequest));
  app.delete('/mcp', ...withAuth(handleStreamableRequest));

  // --- Start server ---

  const httpServer: HttpServer = app.listen(config.port, config.host, () => {
    log(`HTTP server listening on ${config.host}:${config.port}`);
    log(`Auth enabled: ${authEnabled}`);
    log(`CORS origins: ${corsConfig.enabled ? corsConfig.origins.join(', ') : 'disabled'}`);

    if (corsConfig.origins.includes('*')) {
      logError(
        'WARNING: CORS_ORIGINS=* allows any web page to call this server from a browser. ' +
          'List explicit origins instead.'
      );
    }

    if (authEnabled) {
      log('OAuth 2.1 authentication is REQUIRED for all connections');
      log('Endpoints:');
      log('  GET  /.well-known/oauth-authorization-server          - OAuth metadata');
      log('  GET  /.well-known/oauth-protected-resource/mcp        - Protected resource metadata');
      log('  POST /authorize                                       - Authorization');
      log('  POST /token                                           - Token exchange');
    } else {
      log('WARNING: Auth is DISABLED - server is open to anyone!');
    }

    log('MCP Endpoints:');
    log('  GET  /health   - Health check (no auth)');
    log('  ALL  /mcp      - Streamable HTTP (primary)');
    log('  GET  /sse      - Legacy SSE stream (deprecated)');
    log('  POST /messages - Legacy SSE messages (deprecated)');
  });

  // --- Graceful shutdown ---

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('Shutting down HTTP server...');
    // Accepted Discord work keeps ownership during shutdown. Hard termination is fail-closed.
    const forced = setTimeout(() => process.exit(1), 660000);
    const draining = deps.discord?.shutdown();
    await draining;
    clearTimeout(forced);
    await modern.close();

    // Close all legacy SSE sessions
    for (const [id, session] of legacySseSessions) {
      try {
        await session.server.close();
      } catch (error) {
        logError(`Error closing SSE session ${id}`, error);
      }
    }
    legacySseSessions.clear();

    // Close all streamable sessions
    for (const [id, session] of streamableSessions) {
      try {
        await session.server.close();
      } catch (error) {
        logError(`Error closing streamable session ${id}`, error);
      }
    }
    streamableSessions.clear();

    httpServer.close(() => {
      log('HTTP server stopped');
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => {
      logError('Forced shutdown after timeout');
      process.exit(1);
    }, 5000);
  };

  (process as NodeJS.Process).on('SIGTERM', shutdown);
  (process as NodeJS.Process).on('SIGINT', shutdown);
}
