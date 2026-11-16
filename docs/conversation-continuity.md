# MCP conversation continuity

Save `session_id` and `agent_id` (when present) from every chat response and send them on each follow-up turn. Omitting `session_id` starts a new conversation, even on the same MCP connection. Both `openclaw_chat` and `openclaw_chat_async` allocate the key before submitting or queueing work.

```json
{"name":"openclaw_chat","arguments":{"message":"Remember the release name","agent_id":"research"}}
```

A synchronous response keeps the assistant's text in the original first content block. An additional text block makes the conversation metadata available to clients that only read text; SDK clients can read `structuredContent` directly.

```json
{
  "content": [
    {"type":"text","text":"What release name should I remember?"},
    {"type":"text","text":"\n\n{\"session_id\":\"agent:research:mcp:mcp.example.com:desktop:550e8400-e29b-41d4-a716-446655440000\",\"agent_id\":\"research\"}"}
  ],
  "structuredContent": {
    "session_id":"agent:research:mcp:mcp.example.com:desktop:550e8400-e29b-41d4-a716-446655440000",
    "agent_id":"research"
  }
}
```

Send the returned key unchanged on the next turn:

```json
{"name":"openclaw_chat","arguments":{"message":"The release is Aurora","session_id":"agent:research:mcp:mcp.example.com:desktop:550e8400-e29b-41d4-a716-446655440000","agent_id":"research"}}
```

Supplied keys keep the existing validation: they must be nonempty strings, at most 256 characters after trimming, with prohibited control characters rejected. Leading/trailing whitespace is trimmed as before. Validated keys are passed through without adding a prefix, renaming, or generating a replacement. A supplied `agent:<id>:` key that disagrees with explicit `agent_id` fails before submission. The configured default is also checked against a qualified supplied key. Invalid supplied keys fail before Gateway submission.

## Routing and labels

New keys have this form when the target agent is known:

```text
agent:<agent-id>:mcp:<server-label>:<client-label>:<uuid>
```

Select agent_id explicitly or configure OPENCLAW_DEFAULT_AGENT_ID. Mandatory mode ignores that default. Selection is validated against the current Gateway roster; no model alias or Gateway fallback supplies an agent. Newly generated keys are always agent-qualified. A supplied agent-qualified key must agree with the selected/default agent.

The server label is the hostname of configured `MCP_ISSUER_URL` / `--issuer-url`, if present, including when OAuth is disabled. Otherwise it is the local OS hostname, with `local` as the empty-label fallback. This works deterministically for stdio without new configuration. Host and forwarded HTTP headers never supply this label. A hostname can change after a machine/container rename; already returned keys remain reusable.

The client label comes from that MCP connection's initialize `clientInfo.name`, with `unknown` as the fallback when unavailable or empty after sanitization. It is an untrusted display label, not an authenticated identity. Two clients may claim the same name. Labels are lowercase ASCII letters, digits, dots, underscores and dashes, limited to 40 characters each. Separators and control characters are replaced so labels cannot inject `agent:`, `cron:`, `subagent:`, or `acp:` namespaces. The UUID, rather than the labels, makes conversations distinct. Truncation or sanitization can make labels look alike without causing shared conversations. Even with a 64-character agent ID, generated keys fit the existing 256-character validation limit.

The exact effective request key is sent in `x-openclaw-session-key` and the existing JSON `session_id` field. Gateway may canonicalize an unqualified key for internal storage. The returned value is the request key to reuse, not a claim about the Gateway's internal storage identifier. See the [Gateway HTTP API](https://docs.openclaw.ai/gateway/openai-http-api).

## Async work and failures

Async tools retain their existing JSON first text block and add `structuredContent` with the same object. Enqueue persists the selected agent for worker execution and adds `agent_id` when known, plus `session_id` alongside the existing `task_id`, `status`, and `message` fields. Status responses include it while pending, running, completed, failed, or cancelled. Task-list entries also include it. Completed status responses retain the existing string `result`; failed status responses retain the existing `error` field. For example, the structured status object is:

```json
{
  "task_id":"task_698d9175-3b09-4b71-8f11-7f9f6812ac0b",
  "type":"chat",
  "status":"completed",
  "agent_id":"research",
  "session_id":"agent:research:mcp:mcp.example.com:desktop:550e8400-e29b-41d4-a716-446655440000",
  "created_at":"2026-10-19T00:00:00.000Z",
  "started_at":"2026-10-19T00:00:00.100Z",
  "completed_at":"2026-10-19T00:00:01.000Z",
  "result":"I will remember Aurora."
}
```

Use the task ID to poll the existing task rather than enqueueing the same message again. Cancellation still applies only to pending jobs; successful cancellation returns the conversation key. A rejected cancellation of an owned running/completed/failed job also includes the key. Unknown and other clients' task IDs still return the same not-found error without disclosing metadata.

Synchronous Gateway failures retain `isError: true` and the original `Error: ...` first text block, with conversation metadata added after allocation. The Gateway may have accepted work before a timeout, connection loss, or invalid response. The bridge does not retry. Save the returned key and investigate the result before deciding whether to send another message; reusing a key does not make message delivery idempotent. Pre-submission validation or agent-selection errors need not include a key. An MCP disconnection can prevent delivery of any response; there is no new persistence or recovery mechanism for that case.

Async failed jobs continue to be successful status queries containing `status: "failed"` and `error`; this feature does not change that signaling. The key stays on the task through failure and cancellation until existing expiry cleanup removes it. Queue capacity and process-local storage are unchanged. Queue-capacity exhaustion retains the existing MCP protocol error without conversation metadata; no Gateway request has been submitted in that case. Restarting the MCP server loses task records. Connection ownership, cleanup timing, OAuth policy and authorization are unchanged.

## Client compatibility

MCP transport session IDs, async task IDs, and Gateway conversation keys have separate purposes. An MCP connection owns its async tasks. A Gateway key selects conversation history. Neither the display labels nor possession of a conversation key creates a new authorization policy; caller-supplied keys retain the previous Gateway access semantics.

The supported tools are registered on Streamable HTTP, legacy SSE, and stdio. The added `openclaw_agents` discovery tool declares an object output schema. Existing generic tools retain their optional structured metadata contract. The installed MCP SDK accepts optional object-valued `structuredContent` while requiring normal `content`; introducing a required output schema would also constrain validation-error results that have no conversation key. Async `structuredContent` mirrors the existing JSON object. Sync `structuredContent` contains metadata only, leaving the assistant reply as text.

Clients that render all text blocks can save the extra JSON metadata block even if they ignore structured output. Clients that only read `content[0].text` keep their old assistant-text behavior but must be updated to read another block or `structuredContent` to gain continuity. Clients that assume exactly one sync content block or reject unknown JSON properties may need adaptation. The extra metadata may be displayed in the conversation UI. Client-specific rendering in desktop/web products has not been verified.

To verify locally, install worktree-local dependencies with `npm ci --ignore-scripts`, then run `npm run test:run`, `npm run typecheck`, and `npm run build`. Tests use loopback mock Gateways and child processes with explicit environments; they do not use production credentials. Passing tests establish request-key reuse, response contracts, task ownership, and transport propagation. They do not establish a particular deployed Gateway's default-agent routing or history-retention policy.

See [multiagent configuration](multiagent.md) for catalog sources, exact configuration, shared trust and Discord mapping restrictions.
