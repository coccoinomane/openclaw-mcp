# OpenClaw Plugin for Claude Code

Connect Claude Code to your OpenClaw AI assistant. Each MCP deployment connects to one OpenClaw installation and can expose several agents. Use separate MCP deployments for additional installations. Chat, check status, and delegate tasks.

The `openclaw-mcp` launcher is the bridge itself, not the OpenClaw CLI. The current fork needs no OpenClaw executable: direct chat uses HTTP, optional roster discovery uses the Gateway SDK, and Discord uses SDK agent calls plus fixed HTTP/REST adapters. The packaged npm launcher below targets upstream; use the fork build from the [repository installation guide](../../../README.md#install-this-fork) for these features.

## What's Included

- **MCP Server** - Connects Claude Code to OpenClaw gateway
- **Skills** - Auto-triggers for OpenClaw interactions
- **Agents** - `task-delegator` for async task management
- **Commands** - `/claw:chat`, `/claw:status`

## Installation

```bash
claude plugin install openclaw
```

**Required environment variables:**
```
OPENCLAW_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
```

For the fork's Discord integration, configure the SDK service identity for the same Gateway connection; there is no CLI transport selector. See [Discord setup](../../../docs/discord-skills.md) and the [upgrade checklist](../../../docs/discord-sdk.md#upgrade-from-cli-based-releases). Agent discovery accepts `MCP_AGENT_DISCOVERY=gateway` or an unset/static roster only.

## Commands

### /claw:chat

Send a message to OpenClaw:

```
/claw:chat What's the weather like?
```

### /claw:status

Check OpenClaw gateway health:

```
/claw:status
```

## Agents

Spawn the task delegator for long-running tasks:

```
spawn task-delegator to research and summarize the latest AI news
spawn task-delegator to monitor my inbox for the next hour
```

## Async Tasks

For long operations, use async mode:

```
openclaw_chat_async message="Complex research task..."
→ Returns task_id

openclaw_task_status task_id="..."
→ Check progress
```

## Links

- [Repository](https://github.com/freema/openclaw-mcp)
- [OpenClaw](https://github.com/openclaw/openclaw)
