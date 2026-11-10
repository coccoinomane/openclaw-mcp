---
name: openclaw-management
description: This skill should be used when the user wants to interact with OpenClaw, delegate tasks to their AI assistant, or check gateway status. Activates for AI assistant delegation and orchestration.
---

When the user wants to interact with OpenClaw or delegate tasks, use the OpenClaw MCP tools.

## When to Use This Skill

Activate when the user:

- Wants to chat with OpenClaw ("Ask Claw to...", "Tell my assistant...")
- Delegates tasks ("Have OpenClaw research...", "Let Claw handle...")
- Checks status ("Is OpenClaw running?")
- Manages tasks ("Check task progress", "Cancel that task")

## Tools Reference

| Task | Tool |
|------|------|
| Discover agents | `openclaw_agents` |
| Chat (sync) | `openclaw_chat` |
| Chat (async) | `openclaw_chat_async` |
| Task status | `openclaw_task_status` |
| List tasks | `openclaw_task_list` |
| Cancel task | `openclaw_task_cancel` |
| Gateway health | `openclaw_status` |

## Sync vs Async

**Use sync (`openclaw_chat`):**
- Quick questions
- Simple commands
- When you need immediate response

**Use async (`openclaw_chat_async`):**
- Research tasks
- Long-running operations
- Tasks that might timeout

## Example Workflows

**Quick question:**
```
openclaw_chat message="What's the weather?"
```

**Long task:**
```
openclaw_chat_async message="Research competitors and write a report"
→ { task_id: "task_abc123" }

openclaw_task_status task_id="task_abc123"
→ { status: "running" }

# ... poll until complete ...

openclaw_task_status task_id="task_abc123"
→ { status: "completed", result: "..." }
```

## Agent selection

One MCP deployment connects to one OpenClaw installation; additional installations need separate deployments. Use `openclaw_agents` to discover the configured roster. Pass `agent_id` to chat or async chat when choosing an agent. Generic chat works without Discord. Save the returned `agent_id` and `session_id` for follow-ups; an explicit agent must agree with an agent-qualified session key. Status and cancellation use the task's stored route and retain existing ownership checks.

All authenticated clients share access to every configured agent. Selecting an agent does not change caller identity or the operator's Discord forwarding attribution. For Discord work use the packaged coordinator workflow and discover permitted targets; selectors cannot override target or creation-policy routing.
