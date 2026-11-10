# Multi-agent configuration reference

For a first setup, start with [Use more than one OpenClaw agent](multiagent.md). This page covers configuration fields and routing rules.

## Choose a catalog source

One MCP deployment connects to one OpenClaw Gateway using `OPENCLAW_URL` and `OPENCLAW_GATEWAY_TOKEN`. Several agents can share that connection, and each can work with or without Discord. Use separate MCP deployments for multiple OpenClaw installations or when callers need different permissions. All authenticated clients can select every configured agent.

`OPENCLAW_AGENT_ID` and model defaults select the default agent. Agents named by configured Discord targets, discovery scopes and creation policies also enter the generic catalog. With no catalog, discovery includes locally known configured/model agent IDs; an unknown Gateway default is not guessed. Explicit agent selection must name a catalog or locally known default agent. Omitting `agent_id` retains default routing.

### Explicit catalog

Set `MCP_AGENT_CATALOG` to one JSON object with an `agents` array and optional `bindings`. Bindings use OpenClaw route match objects. This example has one agent with Discord routing and another with none:

```json
{
  "agents": [{"id": "main"}, {"id": "research"}],
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "guildId": "111111111111111111"
      }
    }
  ]
}
```

Credentials remain in the Gateway connection settings; catalogs contain no tokens. Agent IDs are 1–64 ASCII alphanumeric, dash or underscore characters, starting with an alphanumeric character, and are normalized to lowercase.

Do not combine a static roster with Gateway discovery. Duplicate agents and bindings to absent roster agents fail startup. Catalog order does not replace `OPENCLAW_AGENT_ID` or the configured model default.

### Gateway SDK roster

Set `MCP_AGENT_DISCOVERY=gateway` to read `agents.list` from the configured Gateway using its URL and token. No CLI command, `config.get`, binding lookup, or model turn is used. The service creates a short-lived authenticated connection, requests `operator.read`, waits up to 15 seconds for readiness and up to 30 seconds for the roster, then closes it. Startup waits for connection cleanup and fails if discovery fails. There is no automatic CLI fallback or runtime refresh.

Both official packages are pinned to `2026.10.9`, targeting the matching Gateway’s v4 protocol. Node >=22.19.0 is required; Docker uses Node 24. Fake-transport tests cover the adapter; deployments still need an authenticated read-only compatibility check with their actual Gateway. Gateways behind edge-auth proxies requiring extra headers are not configured by this minimal adapter.

The loader keeps agent IDs only and excludes system agents. It does not adopt `defaultId`, enforce `selectionRequired`, or change an existing configured/model default. `is_default` keeps its existing meaning. Remote URLs must use HTTPS; HTTP is limited to loopback, and embedded URL credentials, query strings and fragments are rejected. The URL’s path is preserved for WebSocket connection.

On first use, a persistent Ed25519 device identity is created. If approval is required, the error identifies the device; approve its current request on that Gateway and restart the MCP service. The client identifies itself as `openclaw-mcp agent discovery` in the supported backend category, with its own signed identity. Device keys and tokens are private files under `~/.openclaw-mcp/gateway-discovery`; `MCP_AGENT_DISCOVERY_STATE_DIR` optionally selects an absolute persistent directory. Storage is keyed by the normalized WebSocket URL: `SHA256(JSON.stringify([url]))`. Keep one running service per state directory; use a new directory for an independent deployment. POSIX permissions are checked (0700 directory, 0600 files); on Windows, the operator must restrict the directory’s ACL.

The state-directory setting is only valid in Gateway mode. `MCP_AGENT_DISCOVERY` accepts only `gateway`; leave it unset for static catalogs and locally known configured agents. CLI discovery settings have been removed without compatibility aliases. A static `agents` list cannot be combined with Gateway discovery; duplicate sources fail before connection. See [upgrading from CLI-based releases](discord-sdk.md#upgrade-from-cli-based-releases) and [deployment preparation](configuration.md#deployment-preparation).

Bindings remain manual. Omit `bindings` to retain existing Discord targets/scopes, or provide a bindings-only `MCP_AGENT_CATALOG` object in Gateway mode:

```json
{
  "bindings": [
    {
      "agentId": "research",
      "match": {"channel": "discord", "accountId": "default", "guildId": "111111111111111111"}
    }
  ]
}
```

Every binding agent must exist in the discovered roster; existing binding validation and Discord permissions are unchanged. An explicit empty `bindings` array still means no imported routes, so do not add one merely to enable discovery. Selecting a roster source does not change Discord permissions or the HTTP chat transport.

## Tool contract

`openclaw_agents` takes no arguments and returns:

```json
{
  "agents": [
    {"agent_id": "main", "is_default": true},
    {"agent_id": "research", "is_default": false}
  ],
  "total": 2
}
```

`is_default` identifies the locally known configured/model default, not a live availability probe. The discovery tool declares and validates an object output schema on every transport.

Pass optional `agent_id` to `openclaw_chat` or `openclaw_chat_async`. Save the returned agent ID and session key. An explicit agent that conflicts with a supplied `agent:<id>:` session fails before submission. Without an explicit selector, existing supplied-session behavior is preserved. If a legacy session names an agent absent from the catalog, continuation metadata omits `agent_id`; reuse its unchanged `session_id`. Explicit selection of that unknown agent remains rejected. Worker execution retains the queued explicit agent without mutating a shared client.

`openclaw_status` accepts the same agent selection but still measures Gateway reachability. Task status/cancel infer the stored agent; optional `agent_id` asserts it and rejects conflicts. Task list can filter by agent. Agent selectors normalize to lowercase across enqueue, status, cancel and list. Ownership checks are unchanged.

Discord channels accepts an optional `agent_id` filter. Ask, reply, thread reads and channel creation select their route from the existing target or policy; optional `agent_id` must agree. Operation status infers its stored agent and rejects a conflicting selector. Reuse the exact original operation ID and arguments for recovery.

## Discord routing and permissions

Discord remains opt-in. Bindings alone do not enable it. All Discord SDK/HTTP adapters use the same Gateway connection as direct chat. Existing targets, discovery scopes, channel whitelist/blacklist and creation policies continue to define allowed destinations. Imported routes can reassign agents only within those scopes; they never admit another guild/account or enable creation.

A guild route and a channel override can coexist in the `bindings` array:

```json
[
  {"agentId":"main","match":{"channel":"discord","accountId":"default","guildId":"111111111111111111"}},
  {"agentId":"research","match":{"channel":"discord","accountId":"default","guildId":"111111111111111111","peer":{"kind":"channel","id":"222222222222222222"}}}
]
```

Supported ordinary routing uses exact peer, verified parent peer, wildcard peer, guild, account and channel-wide bindings in precedence order. `group` and `channel` peer kinds are equivalent. Omitted `accountId` means `default`; `*` matches any account already admitted by MCP. Within a tier, the first matching binding wins. A route may cover several guilds by adding bindings. Existing target IDs remain usable after routing is resolved; selector conflicts fail rather than overriding the target.

Unsupported match dimensions fail clearly. Role-dependent/team routing, runtime thread rebindings and custom session overrides are outside this implementation. A manual binding list cannot prove actual runtime session routing; the operator must verify ordinary canonical Discord sessions before setting normal-routing acknowledgements. `normalRouting` and the global inbound-routing acknowledgement remain required for writes. There is no assumed exact-route API.

Creation still needs an explicit creation policy and both `authorize_create` and `authorize_admission`. Imported routing must agree with that policy; adding an agent does not authorize creating channels. A new channel’s routing is checked before admission. The adapters retain the existing single configured bot account; multi-account credentials are not imported.

The global forwarding requester name remains the operator’s single-owner attribution for new-thread requests, regardless of selected agent. See [the threat model](threat-model.md) for shared access and existing operation/session ownership limits.
