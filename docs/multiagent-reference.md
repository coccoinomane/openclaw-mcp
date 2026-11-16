# Agent and binding reference

MCP reads agents.list for discovery and validation, and config.get for Discord access. Snapshots must be valid with equal, nonempty configRevisionHash and appliedConfigHash. Reads use the persistent MCP device identity with operator.read. Denial never triggers a transport fallback.

Supported route bindings have agentId and match.channel=discord, plus concrete guildId and/or peer {kind: channel|group, id: channel ID}. accountId is concrete or *. Omission means literal default, not channels.discord.defaultAccount. Wildcards expand configured enabled accounts. Guild constraints apply to peer bindings too.

Only the selected agent’s bindings are unioned. Other agents never subtract access. Unsupported conditions, ACP, wildcard/direct peers and generic account/channel bindings grant nothing. Thread-specific bindings grant nothing: verified parent access is required.

Creation requires a peer-free server binding, creation opt-in and verified bot ManageChannels or Administrator at guild role level. A category is optional and must belong to that guild. Category overwrites are not proof of guild permissions.

Bindings are reread before effects, including background dispatch. Config reads and writes are not atomic; configuration or permissions may change between them. The write API has no revision precondition. Discord and Gateway still enforce their own permissions.

Keep MCP_AGENT_DISCOVERY_STATE_DIR private and persistent (0700 directories, 0600 files). It stores authentication identity, not a static roster. Retain it across upgrades.
