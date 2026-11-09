# Multiagent configuration

## Choose a catalog source

Each named instance is one configured Gateway. An agent belongs to that instance and can have zero or more Discord routes. All authenticated clients can select every configured agent. Use separate deployments when callers need different permissions.

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

Pass optional `agent_id` with `instance` to `openclaw_chat` or `openclaw_chat_async`. Save the returned instance, agent ID and session key. An explicit agent that conflicts with a supplied `agent:<id>:` session fails before submission. Without an explicit selector, existing supplied-session behavior is preserved. Worker execution retains the queued explicit agent without mutating a shared client.

`openclaw_status` accepts the same selection but still measures Gateway reachability. Task status/cancel infer the stored route; optional `instance` and `agent_id` assert it and reject conflicts. Task list can filter by agent. Ownership checks are unchanged.

Discord channels accepts optional `instance` and `agent_id` filters. Ask, reply, thread reads and channel creation select their route from the existing target or policy; optional selectors must agree. Operation status infers its stored route and rejects conflicting selectors. Reuse the exact original operation ID and arguments for recovery.

## Discord mapping and permission boundaries

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

## Verify a deployment

Why: an agent catalog describes available routing, while Discord policy controls where the service may act.

Do: review the catalog source and instance association; check discovery with `openclaw_agents`; compare filtered `openclaw_discord_channels` results against explicit allowed scopes and creation policies. Review the Gateway's ordinary inbound routing before enabling writes. Do not use a write as a discovery probe.

Pass when: all intended generic agents appear, agents without Discord mappings can be selected for chat, denied guilds/channels remain absent, channel overrides show the intended agent, and selector conflicts fail. Automated tests cover these contracts with synthetic local fixtures; deployment-specific Gateway identity and permissions require operator verification.
