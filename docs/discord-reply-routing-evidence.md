# Installed routing evidence

Rechecked against installed OpenClaw 2026.10.9 and @openclaw/discord 2026.10.9, not the source checkout. Paths below are local evidence for the deployment owner; hashed filenames are installation-specific.

## What is already supported

Host root: /usr/local/node24/lib/node_modules/openclaw

- docs/cli/agent.md:375–380 documents canonical --agent/--channel/--to routing, explicit --session-key, queued-input withdrawal and ambiguous transport failures. Gateway owns queueing; an idle-state or admitted:true preflight is unnecessary. Those requirements were removed from this implementation.
- dist/agent-turn-service-DndzLNDt.mjs:1600–1627 resolves explicit recipients only when no explicit key/ID is supplied; an explicit session key wins. This is ordinary supported dispatch, not fabricated inbound traffic.
- dist/agent-delivery-Ctb4bVDa.mjs:109–162 delegates canonical recipient resolution to resolveOutboundSessionRoute. It does not resolve inbound Discord runtime bindings.

## Why canonical outbound routing does not exclude bound threads

Plugin root: /Users/openclaw/.openclaw/extensions/discord

- dist/.setup/outbound-session-route-CM6i691P.mjs:703–735 builds the outbound session from the numeric peer and configured agent with buildOutboundBaseSessionKey, useSuffix:false. No runtime binding lookup occurs here.
- dist/.setup/message-handler.preflight-Bv2tfpIw.mjs:254–302 uses resolveDiscordConversationBindingRoute, including runtime and configured bindings, and extracts boundSessionKey.
- dist/.setup/message-handler.process-CoJWDkRn.mjs:411 chooses boundSessionKey before the ordinary thread session key.
- dist/.setup/conversation-binding-route-Dhxicw2Z.mjs:5–47 resolves runtime bindings and then configured bindings with parent fallback. This is the existing implementation a read-only extension should reuse.

A concrete counterexample is a thread bound to agent:main:subagent:<id>. Outbound canonical recipient routing for --agent main and that numeric thread still selects agent:main:discord:channel:<thread>. Human ingress selects the bound subagent key. Choosing a canonical-looking key does not preserve the same conversation or satisfy the requirement to reject bound threads.

## Why the public inspection candidates are insufficient

- Host dist/agents.commands.bind-CoDzUvJJ.mjs:35–48 implements agents bindings --json using listRouteBindings(cfg). It lists configured routing rules, not live thread binding records.
- Host dist/conversations-nTlNfEqO.mjs:155–175 filters conversations by current route ownership, then returns conversationRef/channel/accountId/kind/target/threadId/labels/timestamps. It exposes neither effective session key nor binding classification.
- Plugin dist/.setup/channel-DoctSTbZ.mjs:203–255 implements inspectDiscordConversationRouteOwner. It does consult live bindings, but returns only kind:agent plus the bound agent ID. A subagent bound to the same main agent remains eligible.
- Host dist/conversation-route-ownership-BjL0XQGT.mjs:144–153 accepts eligibility based on that owning agent, not an ordinary-session requirement.
- sessions.list returns stored session rows. A stale ordinary row may coexist with a newer bound session; absence of a listed subagent is not a binding proof. sessions.resolve resolves a key/ID selector, not a Discord inbound route.
- Plugin dist/.setup/thread-bindings-Blhv7XV8.mjs:33–34 exposes an internal JavaScript runtime helper; dist/.setup/thread-bindings.manager-Cqml5pUh.mjs:736–737 retrieves a manager from a process-local map. Importing it into the MCP process would not inspect the running Gateway. No public Gateway method for this helper was found in the installed plugin registration. Reading SQLite directly was not attempted.

## Narrow extension required

Expose a read-only, authenticated Gateway method for the Discord account and verified parent/thread that reuses resolveDiscordConversationBindingRoute with touchBinding:false. Return the effective agent/session key and whether a runtime/configured/plugin-owned binding exists, with explicit unavailable/ambiguous failure. The MCP service can reject any binding/nonordinary key, retain the acknowledged ordinary routing configuration, then use existing Gateway-backed agent --session-key dispatch and Gateway queueing.

This extension is not implemented here because the assignment restricts changes to the MCP repository and forbids modifying the deployed Gateway/plugin. No live sends or private database reads were performed.
