# Discord setup and access

Enable MCP_DISCORD_ENABLED and configure the [SDK identity](discord-sdk.md), private journal directory and [credentials](configuration.md). No local destination lists are used.

## Tools

- openclaw_discord_channels: current channels and creation_guilds for the selected agent.
- openclaw_discord_threads: active or archived public threads; archived results support timestamp pagination.
- openclaw_discord_ask: new thread, published prompt and queued agent. Optional same-agent fork_from_session, new-session model and display source.
- openclaw_discord_reply: publish and queue in an existing unlocked public thread.
- openclaw_discord_send: publish and queue in a text channel.
- openclaw_discord_create_channel: guild_id, account_id, optional category_id, name, operation_id and authorize_create=true.
- openclaw_discord_operation: read durable status without repeating effects.

Channel/thread operations take concrete target (parent channel ID), guild_id and account_id. Replies also take channel_id (thread ID). Select agent_id first. Direct IDs receive the same checks as discovered destinations.

## Checks

Only the selected agent’s supported server/channel bindings grant access. Their union is independent of other agents. Threads inherit the verified parent. No binding means no write. Channel creation requires a server binding, creation opt-in and guild-level bot permissions.

Metadata, guild membership and bot permissions must be verifiable. Unsupported conditions grant nothing. Bindings reload before effects. Gateway and Discord enforce their own gates; there is no transport fallback after denial.

Access does not model inbound routing, runtime ownership, roles, broadcast or ACP. Human responses may follow different routing. Reads and effects are not atomic; see [limits](multiagent-reference.md).

## Recovery

Retain an unpredictable operation_id. Identical repeats read existing results; conflicting arguments fail. Unknown creation, publication, fork or run outcomes require inspection, never an automatic retry with a new ID.

Journals retain links and partial effects. Shutdown drains accepted work; crashes never resume it. Preserve journals and session claims through upgrades. Status remains readable for the stored selected agent after binding removal, without authorizing writes.

Source is display text only. A server-owned forwarding header applies to new-thread requests, not replies or agent input. Publication disables mentions and verifies exact message IDs. A queue response is a handoff link, not proof of answer delivery.
