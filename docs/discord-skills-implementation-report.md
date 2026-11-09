# Historical implementation report

This report preserves the original CLI-backed implementation and its test evidence. It is not current setup guidance: the CLI transport, CLI discovery and related configuration have since been removed. Use [Discord setup](discord-skills.md) and [SDK authentication/migration](discord-sdk.md) for the current release.

Prepared on 2026-11-01 in feature/discord-skills-mcp, based on fork/main at 04bad9b. Production checkout, gateway configuration and services were not changed. No live Discord actions, credential reads, deploys or pushes were performed.

## Delivered

- Opt-in service-owned CLI adapter with explicit target/account/agent allowlists, guild and thread-parent readback, strict input checks, shell:false argument arrays and unchanged invocation provenance.
- Channel discovery with topic/category metadata, active/public-archived thread discovery, durable operation lookup and guarded thread/session workflows. The narrowed MVP creates only fresh threads, requests the first response and returns a handoff link. Normal-routing acknowledgement and per-target normalRouting:true are required; existing-thread continuation is rejected.
- Explicit normal-text channel creation with persistent policy-bound admission, revoked by policy change/removal and denied after category moves. Agent-originated HTTP creation is rejected, never laundered into operator authority.
- Forum/media writes fail before effects; nonzero CLI exits preserve partial identity without claiming completion. Source NUL bytes were replaced with textual escapes.
- Private prompt files, cleanup, recorded partial creation, uncertain run status, explicit unverified delivery, exclusive operation claims, file/directory sync, restart and duplicate suppression. No blind retry.
- Official 2.4.0 Skills catalog/attachment on 2026-07-28 HTTP through createMcpHandler and 2.1.2 Node adapter, alongside existing stateful HTTP/SSE/stdio and resource fallback.
- Packaged English SKILL.md and recovery reference; SDK manifests include both files and SHA-256 digests. Description is below 500 UTF-8 bytes.
- Existing direct HTTP chat, multi-instance registry, continuity contract and legacy connection ownership retained. Modern async ownership is tied to validated access tokens; anonymous modern async calls fail closed.
- Explicit Origin checks ahead of auth/transport; existing Host protection retained.
- Docker copy/include rules for packaged skills.

## Validation

Lint, typecheck, the full 288-test Vitest suite and build pass. Added tests cover mocked CLI execution/provenance, validation, allowlists, wrong guild/parent, partial results, timeout ambiguity, duplicate and concurrent calls, restart records, private state permissions, prompt cleanup, pagination, explicit channel creation/admission, policy revocation, category moves, separate opt-in, HTTP auth failures, uncertain creation and provenance rejection. Official SkillsClient verifies list/get/read and support-file digests. Real local transport tests cover modern and legacy clients on the actual server entry point, PKCE OAuth discovery gating, token ownership isolation, continuity metadata, Host and Origin rejection. Existing auth, SSE, stdio and multi-instance tests remain green.

The compiled stdio bundle was launched from /tmp and successfully read its packaged skill. npm pack --dry-run includes SKILL.md and its support file. Docker was inspected but not built or deployed.

Compatible transitive dependencies were refreshed after an audit: body-parser 2.4.0, fast-uri 3.1.9, zod 4.6.7. Production dependency audit reports no vulnerabilities. All SDK direct versions remain pinned.

## Remaining gates and limits

The user narrowed scope after the continuity review: only service-created fresh threads are supported. Canonical ordinary session association uses explicitly acknowledged parent/account/agent routing. Arbitrary existing-thread continuation and runtime rebinding are out of scope. No Gateway plugin or exact-route API is required for this MVP. An optional resolver retains stricter mismatch checks.

Regression tests cover successful fresh-thread execution without a resolver, missing normal-routing acknowledgement, special-target exclusion, continue rejection before effects, optional resolver mismatch, duplicate recovery and independent generation/delivery states. The installed CLI's object-valued deliveryStatus is parsed; an available delivery messageId triggers one exact-ID read, never a guessed-text scan. The currently inspected CLI serializer exposes counts rather than message IDs, so independent delivery verification normally remains false.

A live first response and subsequent human Discord reply remain an explicit external-client integration gate. Operator acknowledgement is a prerequisite, not evidence that this test ran. No future topology or rebinding guarantee is made.

1. Channel creation is implemented as a separate, opt-in, constrained tools/invoke message/channel-create adapter. It requires guild/category/account policy, existing gateway credentials, CLI gateway identity and inbound-routing acknowledgement, and explicit user approval for persistent admission. Tests mock HTTP/CLI; no live action was executed. Production canary remains a separate authorized gate.
2. Official Skills extension methods and 2026 negotiation are served on HTTP. Legacy stdio/SSE provide the resources fallback, not a falsely advertised modern protocol.
3. Deployment must supply allowlisted settings through its launcher, private persistent state, CLI credentials/configuration and appropriate bot permissions. No live canary was authorized here.
4. Idempotency requires retained local state. A crash between an external effect and its record remains uncertain and needs operator inspection; there is no cross-system exactly-once claim.
5. The service allowlist is shared by trusted callers, not a per-user Discord authorization system. Modern task access changes when its access token rotates. Gateway CLI success does not independently prove Discord delivery.

See discord-skills.md for configuration and the packaged recovery reference for caller behavior.
