# Choose an agent

Call openclaw_agents to read the current Gateway roster. Select agent_id before choosing a session or Discord destination. Discovery and validation refresh on every call.

OPENCLAW_AGENT_IS_MANDATORY=true requires agent_id on every agent-scoped tool, ignoring OPENCLAW_DEFAULT_AGENT_ID. Otherwise an explicit ID wins over that default; missing both is an error.

For Discord, call openclaw_discord_channels with the selected agent. Reuse the concrete channel_id, server_id and discord_account_id. Every write checks current bindings again.

A server binding grants its supported channels. A channel binding grants that channel and its verified threads. Only the selected agent’s bindings matter: A bound to a server and B bound to one channel can both access that channel. B cannot access unrelated channels or create new ones.

This access rule does not predict inbound routing. Runtime ownership, roles, broadcast and ACP are not evaluated. Every authenticated client sees all Gateway agents; this is a shared trusted service.

See [configuration](configuration.md), [Discord access](discord-skills.md) and [SDK identity](discord-sdk.md).
