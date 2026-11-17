# Configuration

All configuration can be done via environment variables. Copy `.env.example` to `.env` for local development.

## Environment Variables

### Gateway and agents

- OPENCLAW_URL: one Gateway endpoint (default http://127.0.0.1:18789).
- OPENCLAW_GATEWAY_TOKEN: private Gateway credential.
- OPENCLAW_TIMEOUT_MS: HTTP timeout, default 120000.
- OPENCLAW_DEFAULT_AGENT_ID: optional default.
- OPENCLAW_AGENT_IS_MANDATORY: false by default. True requires agent_id in schemas and validation, ignoring the default.

Select agent_id, then the configured default. Missing both fails, without Gateway fallback. The roster reloads for every discovery/validation. The HTTP model field is built internally; LLM selection remains available through model tools.

### Identity and Discord

- MCP_AGENT_DISCOVERY_STATE_DIR: persistent private device identity, default ~/.openclaw-mcp/gateway-discovery. This is authentication state, not a discovery mode.
- MCP_DISCORD_ENABLED and MCP_DISCORD_CHANNEL_CREATE_ENABLED: separate opt-ins, both false by default.
- MCP_DISCORD_STATE_DIR: absolute private journal directory.
- MCP_DISCORD_SDK_AUTH: device (default), or explicitly authorized local-shared-token on literal loopback.
- MCP_DISCORD_SDK_STATE_DIR: approved integration identity, default gateway-sdk within the journal directory.
- MCP_DISCORD_THREAD_CREATION_MODE: silent-starter (default) or classic.
- MCP_DISCORD_THREAD_MEMBER_ENABLED, MCP_DISCORD_THREAD_MEMBER_USER_ID, MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID: optional membership and direct bot account configuration.
- DISCORD_BOT_TOKEN: private direct credential for that account. Other accounts fail closed.
- MCP_DISCORD_FORWARDING_REQUESTER_NAME: optional trusted display attribution.
- MCP_DISCORD_MAX_OPERATIONS: 1–16, default 4.

The publisher uses the configured thread-member account for asks, replies and channel messages. Enable it for these operations. Discovery needs no direct bot credential; channel creation needs it to verify guild-level permissions.

Discord bindings come from valid config.get snapshots with matching configRevisionHash/appliedConfigHash. See [access rules](discord-skills.md).

### Breaking upgrade

Remove obsolete agent/model connection selectors, static catalogs, destination lists, discovery scopes, creation policies and channel whitelist/blacklist settings. Their JSON fields and CLI aliases are unsupported; no automatic migration is provided.

Drain active work first. Preserve private identities, operation journals and uncertain session claims. Do not bypass changed fingerprints with new operation IDs. Reconcile old evidence manually before deployment. This change does not authorize restarts or live Discord tests.

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

Generated keys contain the selected agent and trusted issuer/host label. Client names are display labels only. Reuse session_key and agent_id together. A supplied agent-qualified session cannot override selection. Every authenticated MCP client can select every Gateway agent; authentication does not isolate tenants.

### Session model selection

`openclaw_models` lists selectable models for `agent_id` (the configured default when omitted). `openclaw_chat` accepts `model` only when starting a new session; `openclaw_discord_ask` applies it to the newly created thread session. Follow-ups keep the selection. Discord reply and async chat do not expose an override. A failed selection stops the turn; preserve the returned conversation/thread and operation identifiers rather than retrying blindly.

The Gateway performs model-policy validation. Listing availability is not a credential or inference test. Model calls reuse the MCP-owned discovery identity/state: `MCP_MODEL_AUTH=device` (default) requires a paired device with `operator.read` for listing and `operator.write` for selection. `local-shared-token` is restricted to literal loopback with the configured Gateway token; it does not require an admin scope.
