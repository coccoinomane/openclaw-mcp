# Implementation report

Prepared on 2026-11-01 in feature/discord-skills-mcp, based on fork/main at 04bad9b. Production checkout, gateway configuration and services were not changed. No live Discord actions, credential reads, deploys or pushes were performed.

## Delivered

- Opt-in service-owned CLI adapter with explicit target/account/agent allowlists, guild and thread-parent readback, strict input checks, shell:false argument arrays and unchanged invocation provenance.
- Channel discovery, active/public-archived thread discovery, fresh ordinary thread/session creation, existing channel/thread continuation and durable operation lookup.
- Private prompt files, cleanup, recorded partial creation, uncertain run status, explicit unverified delivery, exclusive operation claims, file/directory sync, restart and duplicate suppression. No blind retry.
- Official 2.4.0 Skills catalog/attachment on 2026-07-28 HTTP through createMcpHandler and 2.1.2 Node adapter, alongside existing stateful HTTP/SSE/stdio and resource fallback.
- Packaged English SKILL.md and recovery reference; SDK manifests include both files and SHA-256 digests. Description is below 500 UTF-8 bytes.
- Existing direct HTTP chat, multi-instance registry, continuity contract and legacy connection ownership retained. Modern async ownership is tied to validated access tokens; anonymous modern async calls fail closed.
- Explicit Origin checks ahead of auth/transport; existing Host protection retained.
- Docker copy/include rules for packaged skills.

## Validation

Lint, typecheck, full Vitest suite and build pass. Added tests cover mocked CLI execution/provenance, validation, allowlists, wrong guild/parent, partial results, timeout ambiguity, duplicate and concurrent calls, restart records, private state permissions, prompt cleanup, pagination and unsupported channel creation. Official SkillsClient verifies list/get/read and support-file digests. Real local transport tests cover modern and legacy clients on the actual server entry point, PKCE OAuth discovery gating, token ownership isolation, continuity metadata, Host and Origin rejection. Existing auth, SSE, stdio and multi-instance tests remain green.

The compiled stdio bundle was launched from /tmp and successfully read its packaged skill. npm pack --dry-run includes SKILL.md and its support file. Docker was inspected but not built or deployed.

Compatible transitive dependencies were refreshed after an audit: body-parser 2.4.0, fast-uri 3.1.9, zod 4.6.7. Production dependency audit reports no vulnerabilities. All SDK direct versions remain pinned.

## Remaining gates and limits

1. Channel creation is blocked in the CLI adapter. The tool honestly reports unsupported. The installed OpenClaw 2026.10.9 channel command has only info/list. The documented tools/invoke HTTP route and plugin channel-create action were verified in docs/source but not called. Adding that full-operator API requires a separately reviewed authorization/provenance design and dedicated creation policy/recovery tests; it is not an automatic fallback.
2. Official Skills extension methods and 2026 negotiation are served on HTTP. Legacy stdio/SSE provide the resources fallback, not a falsely advertised modern protocol.
3. Deployment must supply allowlisted settings through its launcher, private persistent state, CLI credentials/configuration and appropriate bot permissions. No live canary was authorized here.
4. Idempotency requires retained local state. A crash between an external effect and its record remains uncertain and needs operator inspection; there is no cross-system exactly-once claim.
5. The service allowlist is shared by trusted callers, not a per-user Discord authorization system. Modern task access changes when its access token rotates. Gateway CLI success does not independently prove Discord delivery.

See discord-skills.md for configuration and the packaged recovery reference for caller behavior.
