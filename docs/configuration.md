# Configuration

All configuration can be done via environment variables. Copy `.env.example` to `.env` for local development.

## Environment Variables

### OpenClaw Connection

| Variable                 | Description                             | Default                  |
| ------------------------ | --------------------------------------- | ------------------------ |
| `OPENCLAW_URL`           | OpenClaw gateway URL                    | `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for gateway authentication | (none)                   |
| `OPENCLAW_AGENT_ID`      | Named agent to route requests to        | (none)                   |
| `OPENCLAW_TIMEOUT_MS`    | Request timeout in milliseconds         | `120000` (2 min)         |
| `OPENCLAW_MODEL`         | Model name for chat completions         | `openclaw`               |

`OPENCLAW_AGENT_ID` is sent as the `x-openclaw-agent-id` header. When unset, the gateway uses its default agent.

> **Note:** An unrecognized `OPENCLAW_AGENT_ID` is rejected by the gateway with `400 Bad Request` (`"Unknown agent '<id>'."`) — it does **not** silently fall back to the default agent. A typo will surface as a loud error, not a silent misroute.

### One Gateway per MCP deployment

One MCP deployment connects to one OpenClaw installation. Configure its URL and credential with `OPENCLAW_URL` and `OPENCLAW_GATEWAY_TOKEN`. Direct chat, agent discovery and Discord all use this connection. Multiple agents on that Gateway remain supported; use `agent_id` to select one.

Use separate MCP deployments for multiple OpenClaw installations. Give each deployment its own connection settings, client endpoint and private state directories. Tool callers cannot choose another Gateway.

### Deployment preparation

This is a breaking configuration change with no runtime compatibility mode. Before upgrading:

- Drain active work and preserve operation records and uncertain session claims. Do not replay an uncertain write after the upgrade.
- Configure one Gateway URL/token per deployment. Remove obsolete connection-list and Gateway-selector settings from the service environment and launcher allowlists.
- Change `MCP_AGENT_CATALOG` to one object such as `{"agents":[{"id":"main"},{"id":"research"}],"bindings":[]}`. Keep bindings only when you intend to supply routing; omit `agents` for a bindings-only catalog with Gateway discovery. Arrays of connection catalogs are not supported.
- Keep `agentId` in Discord creation policies; remove their old connection selector. Update clients to retain `session_id` and optional `agent_id`, with no connection selector in tool calls or response parsing.
- Prepare SDK identity state for the normalized WebSocket endpoint. The filename prefix is `SHA256(JSON.stringify([url]))`, where `url` is the normalized `ws:` or `wss:` URL. The service does not read old name-qualified identity filenames or migrate them at runtime. An operator must provision or migrate the integration-owned identity and matching approved token before enabling Discord writes. Preserve private permissions and never substitute CLI identity state.
- Review existing Discord journals and admissions before deployment. Changed policy fingerprints can invalidate old admissions; preserve evidence and reconcile it under operator control rather than deleting records to force retries.

See [SDK authentication](discord-sdk.md#service-authentication) and [CLI release upgrades](discord-sdk.md#upgrade-from-cli-based-releases). No Gateway restart, credential edit or live migration is implied by these instructions.

### Discord and Gateway SDK settings

The bridge never invokes the OpenClaw CLI. Discord uses SDK agent calls plus fixed Gateway HTTP and Discord REST adapters. These settings supplement the existing Gateway URL/token, bot credentials, allowed destinations and private operation state:

| Variable | Purpose | Default |
| --- | --- | --- |
| `MCP_AGENT_CATALOG` | One object with `agents` and optional `bindings`; a bindings-only object is allowed with Gateway discovery. | Unset |
| `MCP_AGENT_DISCOVERY` | `gateway` reads the configured Gateway roster at startup; unset uses static catalogs/configured agents. No `cli` mode. | Unset |
| `MCP_AGENT_DISCOVERY_STATE_DIR` | Private persistent discovery identity/token directory; valid only with Gateway discovery. | `~/.openclaw-mcp/gateway-discovery` |
| `MCP_DISCORD_SDK_AUTH` | `device`, or explicitly authorized `local-shared-token` on literal loopback only. | `device` |
| `MCP_DISCORD_SDK_STATE_DIR` | Private pre-provisioned Discord integration identity/device state. | `gateway-sdk` inside `MCP_DISCORD_STATE_DIR` |

See [Discord configuration](discord-skills.md), [SDK authentication](discord-sdk.md#service-authentication) and [multi-agent configuration](multiagent-reference.md). The removed transport/executable/read/create selectors have no compatibility aliases; follow the [upgrade checklist](discord-sdk.md#upgrade-from-cli-based-releases).

### Server Settings (HTTP transport)

| Variable      | Description                                                       | Default                  |
| ------------- | ----------------------------------------------------------------- | ------------------------ |
| `PORT`        | HTTP server port                                                  | `3000`                   |
| `HOST`        | HTTP server host                                                  | `0.0.0.0`                |
| `DEBUG`       | Enable debug logging                                              | `false`                  |
| `TRUST_PROXY` | Express `trust proxy` setting (required behind a reverse proxy)   | (unset — trust nothing)  |

**`TRUST_PROXY` values:**

| Value          | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| (unset)        | Express default — do not trust any proxy                                       |
| `1`            | Trust one hop — typical when there is a single reverse proxy in front          |
| `true`         | Trust every proxy — only safe on a fully private network                       |
| `loopback`     | Trust `127.0.0.1` and `::1`                                                    |
| `10.0.0.0/8`   | Trust a specific IP or CIDR range                                              |

When `TRUST_PROXY` is unset and a reverse proxy injects an `X-Forwarded-For` header, the MCP SDK's `/token` handler crashes with `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` and OAuth fails. Set this whenever the server is behind Caddy, nginx, Traefik, Cloudflare Tunnel, ngrok, or any other proxy.

### CORS Configuration

| Variable       | Description                       | Default            |
| -------------- | --------------------------------- | ------------------ |
| `CORS_ORIGINS` | Allowed origins (comma-separated) | _(CORS disabled)_  |

CORS is **off unless you opt in**. With it off the server sends no
`Access-Control-Allow-Origin` header, so browsers refuse cross-origin calls to
it. Non-browser clients — Claude.ai, Claude Desktop, and anything speaking
stdio — are unaffected; set this only when a web page has to reach the server
directly.

**CORS_ORIGINS examples:**

- _(unset)_ or `none` — CORS disabled (default)
- `https://claude.ai` — Single origin
- `https://claude.ai,https://your-app.com` — Multiple origins
- `*.example.com` — Wildcard subdomain
- `*` — Allow all origins. Lets any web page drive this server through a
  visitor's browser; do not use in production.

### Authentication (OAuth 2.1)

The server uses the MCP SDK's built-in OAuth 2.1 server with authorization code + PKCE flow. This is what Claude.ai requires for custom MCP connectors.

| Variable            | Description                                                 | Required                   |
| ------------------- | ----------------------------------------------------------- | -------------------------- |
| `AUTH_ENABLED`      | Enable OAuth authentication (`true`/`false`)                | Yes for production         |
| `MCP_CLIENT_ID`     | OAuth client ID (e.g., `openclaw`)                          | When auth enabled          |
| `MCP_CLIENT_SECRET` | OAuth client secret                                         | When auth enabled          |
| `MCP_ISSUER_URL`    | OAuth issuer URL override (e.g., `https://mcp.example.com`) | When behind HTTPS proxy    |
| `MCP_REDIRECT_URIS` | Allowed redirect URIs (comma-separated)                     | Recommended for production |
| `MCP_DANGEROUSLY_ALLOW_DCR`        | Enable Dynamic Client Registration (`true`/`false`)         | Dev only (see below)       |
| `MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC` | Escape hatch to allow DCR on non-loopback binds             | Never, unless you mean it  |

**Client ID validation rules:**

- 3-64 characters
- Alphanumeric, dashes, underscores only
- Must start with a letter or digit

**Client Secret requirements:**

- Minimum 32 characters
- Generate a secure one: `openssl rand -hex 32`

When auth is enabled, the server exposes these OAuth 2.1 endpoints:

- `GET /.well-known/oauth-authorization-server` — OAuth server metadata
- `GET /.well-known/oauth-protected-resource/mcp` — Protected resource metadata
- `GET /authorize` — Authorization endpoint (auto-approves for pre-configured client)
- `POST /token` — Token exchange (requires client_secret)
- `POST /revoke` — Token revocation

Dynamic client registration is **disabled by default** — only the pre-configured client (from `MCP_CLIENT_ID` + `MCP_CLIENT_SECRET`) can authenticate. This prevents anyone who knows the server URL from self-registering and bypassing auth.

#### Redirect URI allow-list

`MCP_REDIRECT_URIS` restricts which `redirect_uri` values the `/authorize` endpoint accepts for the pre-configured client. When unset, any redirect URI is accepted (the client secret verified during token exchange remains the actual auth gate) — set it in production so authorization codes can only be delivered to callbacks you trust.

Claude.ai uses exactly this callback (note the `/api/mcp/auth_callback` path):

```bash
MCP_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback
```

Matching is exact (scheme, host, path). A common mistake is registering `https://claude.ai/oauth/callback`, which does **not** match and makes Claude.ai fail with `Unregistered redirect_uri`. If you also connect other clients (e.g. MCP Inspector), append their callbacks to the comma-separated list — loopback callbacks (`http://localhost/...`, `http://127.0.0.1/...`) match on any port per RFC 8252.

#### Cursor / Windsurf compatibility (dev only)

Cursor and Windsurf only support MCP servers that expose OAuth 2.0 Dynamic Client Registration (RFC 7591). To let them connect, set `MCP_DANGEROUSLY_ALLOW_DCR=true`. The server will then advertise a `/register` endpoint and accept ad-hoc client registrations (kept in an in-memory FIFO store, capped at 100 entries).

`MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` are still required — DCR augments the pre-configured client, it does not replace it. If you are only running Cursor locally you can use any valid values for them; they simply remain unused.

**This is dev-only.** With DCR enabled alongside the server's auto-approve authorization flow, any client that can reach the server can register itself and obtain a token. To prevent accidental exposure the server refuses to start when `MCP_DANGEROUSLY_ALLOW_DCR=true` and `HOST` is not loopback (`127.0.0.1`, `localhost`, or `::1`). If you genuinely need DCR on a non-loopback bind (e.g., inside a trusted private network), also set `MCP_DANGEROUSLY_ALLOW_DCR_PUBLIC=true`.

For production with Claude.ai, keep DCR disabled and use the pre-configured `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET`.

## Conversation labels and routing

Generated conversation keys use the configured issuer hostname (`MCP_ISSUER_URL` / `--issuer-url`), or the OS hostname when no issuer is configured. Client initialize names supply display labels only. An explicit target agent is included in generated keys; if none is known locally, Gateway default routing applies. For deterministic multi-agent routing, configure `OPENCLAW_AGENT_ID` or select `agent_id` explicitly, and reuse the returned `session_id` and optional `agent_id` together through the same MCP deployment. See [conversation continuity](conversation-continuity.md) for the full response contract and limitations.

## Agent selection

See [multiagent configuration](multiagent.md) for Gateway SDK roster discovery, explicit catalogs, `agent_id` selectors, Discord mapping precedence and the shared trust model. Every authenticated client can select every configured agent; generic chat requires no Discord mapping.

### Session model selection

`openclaw_models` lists selectable models for `agent_id` (the configured default when omitted). `openclaw_chat` accepts `model` only when starting a new session; `openclaw_discord_ask` applies it to the newly created thread session. Follow-ups keep the selection. Discord reply and async chat do not expose an override. A failed selection stops the turn; preserve the returned conversation/thread and operation identifiers rather than retrying blindly.

The Gateway performs model-policy validation. Listing availability is not a credential or inference test. Model calls reuse the MCP-owned discovery identity/state: `MCP_MODEL_AUTH=device` (default) requires a paired device with `operator.read` for listing and `operator.write` for selection. `local-shared-token` is restricted to literal loopback with the configured Gateway token; it does not require an admin scope.
