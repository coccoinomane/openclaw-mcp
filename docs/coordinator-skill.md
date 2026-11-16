# Coordinator skill distribution

The canonical skill is [openclaw-coordinator](../skills/openclaw-coordinator/SKILL.md). Its two workflows cover direct requests and Discord coordination; references are loaded only when needed.

The same directory is available through two paths:

- The MCP server exposes it through MCP Skills and resource reads.
- The root `plugin.json` makes this repository an Agent Plugins content bundle. OpenClaw versions supporting that format discover the root `skills/` directory when the bundle is installed.

For an extracted package or checkout, install the content bundle with `openclaw plugins install /path/to/openclaw-mcp`. This makes the skill available locally; it does not start or configure another MCP server. Keep using the existing MCP connection. Verify bundle detection and skill availability with OpenClaw's plugin and skill inspection tools for the intended agent.

There is one source directory, with no synchronization process, symlink or runtime plugin code. The older Claude Code integration under `plugins/claude/openclaw` is a separate package and is unchanged here. Do not install both packages merely to obtain this skill.

## Review scope

The skill describes forwarding, contextual handoffs and conditional same-agent forks. The fork backend and `fork_from_session` parameter are not implemented by this change. No skill installation, deployment or live inbox changes are performed by this PR.

After installation, an inbox can keep only its local routing rule: delegate work using this skill rather than performing it in the inbox, and return silent destination links. Other conversations use the skill when asked to create or resume threads.
