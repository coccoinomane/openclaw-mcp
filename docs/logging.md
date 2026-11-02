# Logging

## Overview

The MCP server logs operational events to **stderr** using the `[openclaw-mcp]` prefix. Stderr is used (instead of stdout) because the stdio MCP transport uses stdout for protocol messages.

## Log Levels

| Level | Prefix | When |
|-------|--------|------|
| Info | `[openclaw-mcp]` | Normal operations — startup, connections, shutdown |
| Error | `[openclaw-mcp] ERROR:` | Failures — connection errors, invalid config, fatal errors |
| Debug | `[openclaw-mcp] DEBUG:` | Verbose output — only when `DEBUG=true` or `NODE_ENV=development` |

## What Gets Logged

### Startup

- Server name and version
- OpenClaw gateway URL (host only, no tokens)
- Transport type (stdio or HTTP)
- Whether a gateway token is configured (yes/no, not the token itself)
- OAuth client ID (when auth is enabled)
- Listening address and port (HTTP mode)
- CORS origins configuration

### Connections (SSE/HTTP transport)

- SSE session connected/disconnected (with session ID)
- Streamable HTTP session initialized/closed (without session ID)

### HTTP request diagnostics

Each /mcp request that reaches application middleware produces one bounded JSON
log line prefixed with `HTTP`. It records a timestamp, a server-generated
request ID (also returned as `X-Request-Id`), HTTP method and path without query,
allowlisted MCP method/tool name, protocol version, selected transport branch,
session-present/session-known booleans, HTTP status and error category. Unknown
client labels are replaced with `other`. No session IDs, arguments, prompts,
response contents, authorization headers or client-supplied correlation IDs are
included. These diagnostics do not require debug mode.

The middleware runs before bearer authentication and origin checks, so their
401/403 responses are visible. Host validation and JSON parsing happen earlier
inside the SDK; requests rejected there are not covered. HTTP 200 means transport
success, not necessarily tool success: JSON-RPC errors and tool-level errors can
also travel in a successful HTTP response.

For stateful (2025-era) Streamable HTTP, an unknown or deleted session returns
HTTP 404 / JSON-RPC -32001. The client must initialize a new session without the
old session header. A non-initialize request missing its session header returns
HTTP 400 / -32000 without creating a server or executing tools. No tool request
is automatically replayed. Modern stateless traffic keeps its existing routing.

When reporting a failure, include the time, HTTP status and `X-Request-Id` if
available. A client-visible -32603 alone does not establish whether the failure
came from the transport, client or a tool.

### Errors

- Gateway connection failures
- Request timeouts
- Invalid client configuration (missing secrets, bad client ID format)
- Session errors

### What Is NOT Logged (Info/Error levels)

- **Message content** — user messages and OpenClaw responses are never logged
- **Authentication tokens** — Bearer tokens, client secrets, gateway tokens
- **Request/response bodies** — only error messages, not full payloads
- **User-identifiable information** — no IPs, user agents, or personal data

### Debug Level (`DEBUG=true`)

> **Warning:** Debug mode is a diagnostic tool. It logs request and response payloads which may contain user message content. Do not enable in production under normal operation — use it only for active troubleshooting, then disable it.

When debug logging is enabled, the following **are** logged for troubleshooting:

- **Request bodies** — outgoing payloads sent to the gateway (truncated to 4096 chars)
- **Error response bodies** — full error responses from the gateway (truncated to 4096 chars)

Credentials are still redacted by the sanitization layer. Headers (including Authorization) are never logged, even in debug mode.

## Sensitive Data Redaction

The logger automatically redacts patterns that look like credentials:

- `Bearer <token>` -> `[REDACTED]`
- `api_key=<value>` -> `[REDACTED]`
- `token=<value>` -> `[REDACTED]`
- `secret=<value>` -> `[REDACTED]`
- `password=<value>` -> `[REDACTED]`

This is a safety net — the code avoids logging sensitive values in the first place, but the redaction layer catches accidental exposure.

## Log Destination

| Transport | Destination | Notes |
|-----------|-------------|-------|
| stdio | stderr | Cannot use stdout (reserved for MCP protocol) |
| HTTP | stderr | Same format, same destination |
| Docker | `docker logs openclaw-mcp` | stderr is captured by Docker's log driver |

## Docker Log Management

When running in Docker, logs are managed by the Docker log driver:

```bash
# View logs
docker logs openclaw-mcp

# Follow logs
docker logs -f openclaw-mcp

# Last 100 lines
docker logs --tail 100 openclaw-mcp
```

To configure log rotation in `docker-compose.yml`:

```yaml
services:
  mcp-bridge:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

## Enabling Debug Logs

Set either environment variable:

```bash
DEBUG=true        # Explicit debug flag
NODE_ENV=development  # Development mode
```

Debug logs include request/response bodies for troubleshooting (truncated to 4096 chars). Credentials are still redacted, and headers (including Authorization) are never logged.
