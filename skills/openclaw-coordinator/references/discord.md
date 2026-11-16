# Discord forwarding and delegation

Use the advertised MCP Discord tools to create or continue the thread and its associated OpenClaw conversation. Do not also create a session with a separate spawn mechanism. If Discord tools are unavailable, explain that limitation rather than inventing an alternative route.

## Choose where the work continues

Honor an explicit destination. When branching work from an existing Discord thread, its parent channel is the natural default. If the work belongs elsewhere, choose the appropriate authorized channel. Ask only when the destination remains genuinely ambiguous.

Reuse a relevant thread when continuing the same work. Search active threads first; include archived threads when the user refers to a particular earlier conversation. An explicit request for new, separate threads takes precedence over reuse. Create one focused assignment per requested branch.

Creating a channel is a separate decision from creating a thread. Use the channel-creation workflow only when the user authorizes it.

## Forward or delegate

Infer the appropriate approach from the request and available context:

- **Forwarding:** preserve a self-contained work request, removing instructions that were only about finding or selecting its destination.
- **Handoff:** prepare a self-contained assignment with the relevant decisions, materials and constraints from the originating conversation. Preserve the user's intent; do not add unrequested work.
- **Fork:** inherit a source session's history when the new branch needs detailed conversational context. Add a focused new assignment rather than repeating the inherited history.

The prompt submitted to the destination must be visible in Discord, as message text or a complete attachment. For a handoff or forwarding, include the source OpenClaw session key and the source Discord link when available, so the receiving agent can retrieve more context if needed. Other usable conversation links may also serve as references. Do not invent source identifiers or require an external client to have a Discord origin. Without source references, provide enough context in the assignment itself.

## Fork availability

Use `fork_from_session` on the new-thread tool when the advertised schema supports it. The fork inherits history through the last completed turn, so include any relevant decisions from the current, unfinished turn in the new assignment. An explicit model choice applies to the child only; otherwise the fork keeps inherited model settings.

Use only native same-agent forks. Obtain the source key from trusted runtime context or session lookup tools, not by guessing from a Discord ID. An external client may supply a known, accessible OpenClaw source session too. Forking creates a new conversation; it does not replace the history of an existing destination thread.

If source and destination agents differ, use a handoff instead. If the user explicitly requested a fork and it is unavailable or incompatible, explain the limitation before substituting a handoff. Never copy transcript messages into a session to simulate a native fork.

## Return the destination

After the MCP confirms handoff, notify the user in the originating conversation with the destination links. On Discord, use native thread mentions such as `<#THREAD_ID>`; elsewhere use the returned Discord URLs. Include every destination when splitting work across threads.

Do not wait for answers before returning the links. The user continues in those threads; this workflow does not collect results back into the source conversation. A queued handoff confirms accepted work, not a completed answer. Explain partial results or failures and retain any available destination link.

Inbox-specific rules, such as always routing incoming work elsewhere or sending silent link-only acknowledgments, belong to the inbox's local instructions.
