# Multi-agent configuration reference

For a first setup, start with [Use more than one OpenClaw agent](multiagent.md). This page covers configuration fields, routing rules and compatibility details.

## Choose a catalog source

An instance is a named connection from the MCP server to an OpenClaw Gateway. Several agents can share that connection, and each can work with or without Discord. All authenticated clients can select every configured agent. Use separate deployments when callers need different permissions.

Existing `OPENCLAW_INSTANCES`, `OPENCLAW_AGENT_ID` and model defaults remain valid. Agents named by existing Discord targets/scopes also enter the generic catalog when `MCP_DISCORD_CLI_GATEWAY_INSTANCE` identifies their instance, or when there is only one instance. Creation-policy agents enter their policy's named instance. With multiple instances and no CLI association, target/scope agent association is not guessed; configure it or list those agents explicitly. With no catalog, discovery includes locally known configured/model agent IDs; an unknown Gateway default is not guessed. Explicit agent selection must name a catalog or locally known default agent. Omitting `agent_id` retains existing routing.

### Explicit catalog, including remote instances

Set `MCP_AGENT_CATALOG` to a JSON array. Each entry names an existing instance and has an `agents` array. Optional `bindings` use OpenClaw route match objects. This example has one agent with Discord routing and another with none:

```json
[
  {
    "instance": "local",
    "agents": [{"id": "assistant"}, {"id": "writer"}],
    "bindings": [
      {
        "agentId": "assistant",
        "match": {
          "channel": "discord",
          "accountId": "default",
          "guildId": "111111111111111111"
        }
      }
    ]
  }
]
```

The instance must already exist in `OPENCLAW_INSTANCES`. With the legacy single-Gateway environment variables its name is `default`, so use `"instance":"default"` instead. Credentials remain in the existing instance configuration; catalogs contain no tokens. Agent IDs are 1–64 ASCII alphanumeric, dash or underscore characters, starting with an alphanumeric character, and are normalized to lowercase.

Alternatively add the same `agents` and optional `bindings` properties directly to an `OPENCLAW_INSTANCES` item. Do not combine inline, explicit catalog and CLI sources for the same instance. Duplicate agents, unknown instances and bindings to absent roster agents fail startup. Catalog order and roster `isDefault` do not replace the instance's existing default/model selection.

### Gateway SDK roster

Set `MCP_AGENT_DISCOVERY=gateway` to read `agents.list` from **every configured instance**, using its existing URL and token. No CLI command, `config.get`, binding lookup, or model turn is used. The service creates a separate short-lived authenticated connection per instance, requests `operator.read`, waits up to 15 seconds for readiness and up to 30 seconds for the roster, then closes it. Startup waits for all connection cleanup and fails if any instance fails. There is no automatic CLI fallback or runtime refresh.

Both official packages are pinned to `2026.10.9`, targeting the matching Gateway’s v4 protocol. Node >=22.19.0 is required; Docker uses Node 24. Fake-transport tests cover the adapter; deployments still need an authenticated read-only compatibility check with their actual Gateway. Gateways behind edge-auth proxies requiring extra headers are not configured by this minimal adapter.

The loader keeps agent IDs only and excludes system agents. It does not adopt `defaultId`, enforce `selectionRequired`, or change an existing configured/model default. `is_default` keeps its existing meaning. Remote URLs must use HTTPS; HTTP is limited to loopback, and embedded URL credentials, query strings and fragments are rejected. The URL’s path is preserved for WebSocket connection.

On first use, a persistent Ed25519 device identity is created. If approval is required, the error identifies the device; approve its current request on that Gateway and restart the MCP service. The client identifies itself as `openclaw-mcp agent discovery` in the supported backend category, with its own signed identity. Device keys and tokens are private files under `~/.openclaw-mcp/gateway-discovery`; `MCP_AGENT_DISCOVERY_STATE_DIR` optionally selects an absolute persistent directory. Instance name and endpoint both partition storage. Keep one running service per state directory; use a new directory for an independent deployment. POSIX permissions are checked (0700 directory, 0600 files); on Windows, the operator must restrict the directory’s ACL.

The state-directory setting is only valid in Gateway mode. `MCP_AGENT_DISCOVERY_INSTANCE` and `MCP_AGENT_DISCOVERY_EXECUTABLE` are CLI-only and must be removed when switching. Existing static catalogs and CLI mode remain supported when Gateway discovery is off. A static `agents` list cannot be combined with Gateway discovery; duplicate sources fail before connection.

Bindings remain manual. Omit `bindings` to retain existing Discord targets/scopes, or provide a bindings-only `MCP_AGENT_CATALOG` entry in Gateway mode:

```json
[
  {
    "instance": "default",
    "bindings": [
      {
        "agentId": "writer",
        "match": {"channel": "discord", "accountId": "default", "guildId": "111111111111111111"}
      }
    ]
  }
]
```

Inline instance `bindings` are also supported. Every binding agent must exist in the discovered roster; existing binding validation and Discord permissions are unchanged. An explicit empty `bindings` array still means no imported routes, so do not add one merely to enable discovery. No Discord adapter or chat transport changes are included.

### Local CLI snapshot

Set these operator-side environment variables:

| Variable | Value |
| --- | --- |
| `MCP_AGENT_DISCOVERY` | `cli` to opt in; omit to disable |
| `MCP_AGENT_DISCOVERY_INSTANCE` | Required configured instance name corresponding to this local CLI's Gateway |
| `MCP_AGENT_DISCOVERY_EXECUTABLE` | Optional executable path; defaults to `openclaw` on the service PATH |

The loader runs exactly `agents list --json` followed by `agents bindings --json`, once at startup. It uses argument arrays with no shell, a 30-second timeout per command and a 4 MiB output limit. Nonzero exit, invalid JSON and invalid catalog data fail startup. Diagnostic stderr is not returned to clients. Do not point local discovery at an unrelated remote instance: instance association is an operator assertion, not remotely verified identity.

The inspected CLI emits roster rows as an array with `id` and additional metadata, and binding rows as an array of `{agentId,match,description}`. The loader keeps IDs and binding matches only. `agents list --bindings --json` adds formatted binding descriptions in the inspected implementation; those are not parsed as routing matches. No full configuration export is used. Paths, provider details, credentials and CLI descriptions are absent from `openclaw_agents` output.

The separate exports are not an atomic snapshot. Keep routing configuration stable while starting the service. Restart through the normal deployment process after changing agents or bindings; this version has no runtime refresh. An explicit empty `bindings` array is an authoritative empty routing snapshot: Discord destinations without a matching imported route are hidden/rejected. Omit `bindings` to retain manually configured Discord routing.

## Tool contract

`openclaw_agents` accepts optional `instance` and returns:

```json
{
  "agents": [
    {"instance": "local", "agent_id": "assistant", "is_default": true},
    {"instance": "local", "agent_id": "writer", "is_default": false}
  ],
  "total": 2
}
```

`is_default` identifies the locally known configured/model default, not a live availability probe. The discovery tool declares and validates an object output schema on every transport.

Pass optional `agent_id` with `instance` to `openclaw_chat` or `openclaw_chat_async`. Save the returned instance, agent ID and session key. An explicit agent that conflicts with a supplied `agent:<id>:` session fails before submission. Without an explicit selector, existing supplied-session behavior is preserved. If a legacy session names an agent absent from the catalog, continuation metadata omits `agent_id`; reuse its unchanged `session_id` and `instance`. Explicit selection of that unknown agent remains rejected. Worker execution retains the queued explicit agent without mutating a shared client.

`openclaw_status` accepts the same selection but still measures Gateway reachability. Task status/cancel infer the stored route; optional `instance` and `agent_id` assert it and reject conflicts. Task list can filter by agent. Agent selectors normalize to lowercase across enqueue, status, cancel and list; instance names remain case-sensitive. Ownership checks are unchanged.

Discord channels accepts optional `instance` and `agent_id` filters. Ask, reply, thread reads and channel creation select their route from the existing target or policy; optional selectors must agree. Operation status infers its stored route and rejects conflicting selectors. Reuse the exact original operation ID and arguments for recovery.

## Discord routing and permissions

Discord remains opt-in. Bindings alone do not enable it. For imported bindings, configure `MCP_DISCORD_CLI_GATEWAY_INSTANCE` to the same configured instance as the local Discord CLI adapters. Existing targets, discovery scopes, channel whitelist/blacklist and creation policies continue to define allowed destinations. Imported routes can reassign agents only within those scopes; they never admit another guild/account or enable creation.

A guild route and a channel override can coexist:

```json
[
  {"agentId":"assistant","match":{"channel":"discord","accountId":"default","guildId":"111111111111111111"}},
  {"agentId":"writer","match":{"channel":"discord","accountId":"default","guildId":"111111111111111111","peer":{"kind":"channel","id":"222222222222222222"}}}
]
```

Supported ordinary routing uses exact peer, verified parent peer, wildcard peer, guild, account and channel-wide bindings in precedence order. `group` and `channel` peer kinds are equivalent. Omitted `accountId` means `default`; `*` matches any account already admitted by MCP. Within a tier, the first matching binding wins. A route may cover several guilds by adding bindings. Existing target IDs remain usable after routing is resolved; selector conflicts fail rather than overriding the target.

Unsupported match dimensions fail clearly. Role-dependent/team routing, runtime thread rebindings and custom session overrides are outside this implementation. The sanitized CLI export omits session overrides, so the operator must verify ordinary canonical Discord sessions before setting existing normal-routing acknowledgements. `normalRouting` and the global inbound-routing acknowledgement remain required for writes. There is no assumed exact-route API.

Creation still needs an explicit creation policy and both `authorize_create` and `authorize_admission`. Imported routing must agree with that policy; adding an agent does not authorize creating channels. A new channel's routing is checked before admission. The adapters retain the existing single configured bot account; multi-account credentials are not imported.

The global forwarding requester name remains the operator's single-owner attribution for new-thread requests, regardless of selected agent. See [the threat model](threat-model.md) for shared access and existing operation/session ownership limits.
