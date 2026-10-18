# MCP conversation continuity

Save `session_id` and `instance` from every chat response and send both on each follow-up turn. Omitting `session_id` starts a new conversation, even on the same MCP connection. Both `openclaw_chat` and `openclaw_chat_async` allocate the key before submitting or queueing work.

```json
{"name":"openclaw_chat","arguments":{"message":"Remember the release name","instance":"work"}}
```

A synchronous response keeps the assistant's text in the original first content block. An additional text block makes the conversation metadata available to clients that only read text; SDK clients can read `structuredContent` directly.

```json
{
  "content": [
    {"type":"text","text":"What release name should I remember?"},
    {"type":"text","text":"{\"session_id\":\"agent:research:mcp:mcp.example.com:desktop:work:550e8400-e29b-41d4-a716-446655440000\",\"instance\":\"work\"}"}
  ],
  "structuredContent": {
    "session_id":"agent:research:mcp:mcp.example.com:desktop:work:550e8400-e29b-41d4-a716-446655440000",
    "instance":"work"
  }
}
```

Send the returned key unchanged on the next turn:

```json
{"name":"openclaw_chat","arguments":{"message":"The release is Aurora","session_id":"agent:research:mcp:mcp.example.com:desktop:work:550e8400-e29b-41d4-a716-446655440000","instance":"work"}}
```

Supplied keys keep the existing validation: they must be nonempty strings, at most 256 characters after trimming, with prohibited control characters rejected. Leading/trailing whitespace is trimmed as before. Validated keys are passed through without adding a prefix, renaming, or generating a replacement. Invalid supplied keys fail before Gateway submission.

## Routing and labels

New keys have this form when the target agent is known:

```text
agent:<agent-id>:mcp:<server-label>:<client-label>:<instance-label>:<uuid>
```

The target is the selected instance's configured `agentId` (including the CLI's existing `OPENCLAW_AGENT_ID` fallback). Otherwise, an explicit agent model such as `openclaw/research`, `openclaw:research`, or `agent:research` supplies it. Agent IDs are lowercased and validated, never truncated or rewritten into a different agent. The configured agent header takes precedence over the model target. Existing headers and model values sent to Gateway remain unchanged.

For `openclaw`, `openclaw/default`, and models whose agent cannot be determined locally, keys use `mcp:<server-label>:<client-label>:<instance-label>:<uuid>`. The Gateway resolves an unqualified key according to its default/legacy session routing. The bridge cannot discover the Gateway's configured default from a chat-completion response and never guesses `main`. Configure an explicit agent per instance when deterministic routing is required, particularly with multiple Gateway agents or defaults that may change. Reuse the same instance as well as the key; keys do not move conversation history between Gateways.

This distinction is deliberate: Gateway accepts the explicit session-key header verbatim, and agent execution can derive its agent from that key. A bare key alone therefore cannot preserve an explicitly configured non-default agent. Using only a generated OpenAI `user` value would let Gateway construct its own qualified key, but would not let this bridge return that exact key before submission or reuse it through the existing `session_id` contract. See [Gateway request-context resolution](https://github.com/openclaw/openclaw/blob/main/src/gateway/http-utils.ts), [agent invocation](https://github.com/openclaw/openclaw/blob/main/src/gateway/openai-compatible-agent-run.ts), and [session-key routing](https://github.com/openclaw/openclaw/blob/main/src/routing/session-key.ts). These source links track Gateway main; deployments should verify their installed Gateway's routing behavior.

The server label is the hostname of configured `MCP_ISSUER_URL` / `--issuer-url`, if present, including when OAuth is disabled. Otherwise it is the local OS hostname, with `local` as the empty-label fallback. This works deterministically for stdio without new configuration. Host and forwarded HTTP headers never supply this label. A hostname can change after a machine/container rename; already returned keys remain reusable.

The client label comes from that MCP connection's initialize `clientInfo.name`, with `unknown` as the fallback when unavailable or empty after sanitization. It is an untrusted display label, not an authenticated identity. Two clients may claim the same name. Labels are lowercase ASCII letters, digits, dots, underscores and dashes, limited to 40 characters each. Separators and control characters are replaced so labels cannot inject `agent:`, `cron:`, `subagent:`, or `acp:` namespaces. The UUID, rather than the labels, makes conversations distinct. Truncation or sanitization can make labels look alike without causing shared conversations. Even with a 64-character agent ID, generated keys fit the existing 256-character validation limit.

The exact effective request key is sent in `x-openclaw-session-key` and the existing JSON `session_id` field. Gateway may canonicalize an unqualified key for internal storage. The returned value is the request key to reuse, not a claim about the Gateway's internal storage identifier. See the [Gateway HTTP API](https://docs.openclaw.ai/gateway/openai-http-api).

## Async work and failures

Async tools retain their existing JSON first text block and add `structuredContent` with the same object. Enqueue adds `session_id` alongside the existing `task_id`, `status`, `instance`, and `message` fields. Status responses include it while pending, running, completed, failed, or cancelled. Task-list entries also include it. Completed status responses retain the existing string `result`; failed status responses retain the existing `error` field. For example, the structured status object is:

```json
{
  "task_id":"task_698d9175-3b09-4b71-8f11-7f9f6812ac0b",
  "type":"chat",
  "status":"completed",
  "instance":"work",
  "session_id":"agent:research:mcp:mcp.example.com:desktop:work:550e8400-e29b-41d4-a716-446655440000",
  "created_at":"2026-10-19T00:00:00.000Z",
  "started_at":"2026-10-19T00:00:00.100Z",
  "completed_at":"2026-10-19T00:00:01.000Z",
  "result":"I will remember Aurora."
}
```

Use the task ID to poll the existing task rather than enqueueing the same message again. Cancellation still applies only to pending jobs; successful cancellation returns the conversation key. A rejected cancellation of an owned running/completed/failed job also includes the key. Unknown and other clients' task IDs still return the same not-found error without disclosing metadata.

Synchronous Gateway failures retain `isError: true` and the original `Error: ...` first text block, with conversation metadata added after allocation. The Gateway may have accepted work before a timeout, connection loss, or invalid response. The bridge does not retry. Save the returned key and investigate the result before deciding whether to send another message; reusing a key does not make message delivery idempotent. Pre-submission validation or instance-resolution errors need not include a key. An MCP disconnection can prevent delivery of any response; there is no new persistence or recovery mechanism for that case.

Async failed jobs continue to be successful status queries containing `status: "failed"` and `error`; this feature does not change that signaling. The key stays on the task through failure and cancellation until existing expiry cleanup removes it. Queue capacity and process-local storage are unchanged. Queue-capacity exhaustion retains the existing MCP protocol error without conversation metadata; no Gateway request has been submitted in that case. Restarting the MCP server loses task records. Connection ownership, cleanup timing, OAuth policy and authorization are unchanged.

## Client compatibility

MCP transport session IDs, async task IDs, and Gateway conversation keys have separate purposes. An MCP connection owns its async tasks. A Gateway key selects conversation history. Neither the display labels nor possession of a conversation key creates a new authorization policy; caller-supplied keys retain the previous Gateway access semantics.

All seven existing tools remain registered on Streamable HTTP, legacy SSE, and stdio. The tools previously declared no `outputSchema`, and that remains unchanged. The installed MCP SDK accepts optional object-valued `structuredContent` while requiring normal `content`; introducing a required output schema would also constrain validation-error results that have no conversation key. Async `structuredContent` mirrors the existing JSON object. Sync `structuredContent` contains metadata only, leaving the assistant reply as text.

Clients that render all text blocks can save the extra JSON metadata block even if they ignore structured output. Clients that only read `content[0].text` keep their old assistant-text behavior but must be updated to read another block or `structuredContent` to gain continuity. Clients that assume exactly one sync content block or reject unknown JSON properties may need adaptation. The extra metadata may be displayed in the conversation UI. Client-specific rendering in desktop/web products has not been verified.

To verify locally, install worktree-local dependencies with `npm ci --ignore-scripts`, then run `npm run test:run`, `npm run typecheck`, and `npm run build`. Tests use loopback mock Gateways and child processes with explicit environments; they do not use production credentials. Passing tests establish request-key reuse, response contracts, task ownership, and transport propagation. They do not establish a particular deployed Gateway's default-agent routing or history-retention policy.
