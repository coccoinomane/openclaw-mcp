# Coordinator skill distribution

This repository exposes [openclaw-coordinator](../skills/openclaw-coordinator/SKILL.md) through MCP Skills and legacy MCP resources. It guides any MCP client through direct requests, asynchronous tasks and Discord destinations. It does not assume that the caller is OpenClaw or has a Discord conversation.

## Discord coordination companion plugin

The OpenClaw-specific workflow lives in a separate repository: [openclaw-discord-coordination](https://github.com/coccoinomane/openclaw-discord-coordination). The companion installs the local discord-thread-coordination skill. It requires this MCP already configured with Discord tools available; it does not install, start or configure the MCP itself.

The Discord skill is not included in this server's skill catalog or package. The generic MCP skill is not installed by the Discord plugin. Clients that only need the MCP do not need the Discord plugin.

See the separate repository for installation instructions. The older Claude Code integration under plugins/claude/openclaw is unchanged.

## Review scope

The new-thread tool supports native same-agent forks through fork_from_session_key; reply remains unchanged. The source key can come from a prior MCP response, not only OpenClaw runtime context. No local plugin installation, deployment or inbox changes are performed by this PR.

After installing the Discord companion plugin, an inbox can keep its local routing rule and refer to discord-thread-coordination. Other Discord conversations use that skill when opening or resuming threads or splitting work across them.
