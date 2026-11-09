# Threat model

## Shared trust

Every authenticated MCP client may select every configured instance and agent. Agent IDs select routing; they provide no per-user ACL or tenant isolation. Configure a separate MCP deployment and narrower Gateway credentials when callers must have different access. stdio trusts the local process owner. HTTP authentication remains controlled by the existing OAuth configuration.

The operator-configured forwarding requester name attributes new Discord requests to the single service owner. It is independent of the selected agent and is not an authenticated caller identity. MCP client names and generated session labels are display metadata.

## Capabilities and effects

Generic chat sends messages to the selected Gateway. Its agents may run tools and change external state according to Gateway policy. Async chat queues the same work in process memory. Gateway health reports reachability, including some HTTP authentication failures; it does not verify agent readiness or authorization.

Optional Discord tools read allowed destinations, create threads, publish requests and replies, and invoke agents. Separately configured creation policies permit channel creation and persistent admission after explicit request flags. The service invokes a fixed CLI command set and fixed Gateway message actions, and writes operation/admission records to a private state directory. It requires the operator's acknowledgement of local CLI identity and ordinary inbound routing. Durable records and fingerprints support recovery without blindly repeating writes.

Optional local agent discovery invokes fixed read-only roster and binding export commands at startup. It accepts an operator-selected executable and projects the output to agent IDs and supported static binding matches. Discovery responses exclude filesystem paths and credentials. Remote catalogs are explicit operator configuration; discovery performs no remote administrative export.

## Ownership and continuity

Async task ownership retains the existing transport behavior: modern HTTP uses a token-derived owner, while legacy and stdio sessions use server-local ownership. Token refresh changes the modern task owner. Tasks and their selected agents remain process-local and disappear on restart.

Discord operation ownership is service-lifecycle ownership, not per-client authorization. All clients share the configured Discord capabilities. Operation IDs are unguessable recovery identifiers and must be kept with their original arguments. Status checks retain current target/policy authorization and never retarget an operation.

Caller-supplied Gateway session keys retain existing access semantics. The bridge rejects a supplied agent-qualified key when it conflicts with an explicit agent selector, but it does not introduce session ownership. Legacy transport sessions are not newly bound to authenticated principals by this feature. Do not treat possession of a task ID, operation ID or session key as a general authorization mechanism.

## Routing and Discord permissions

The registry resolves instance and explicit agent together without changing a shared client. Unknown explicit agents fail before submission. Generic agents need no Discord mapping.

Imported Discord bindings can restrict or reassign routing only inside explicit MCP scopes. Channel blacklist/whitelist checks, verified thread ancestry, creation-policy admission, and normal-routing acknowledgement still apply. Adding an agent or binding does not admit a guild or enable creation. The CLI-backed Discord adapters remain associated with one configured instance and existing bot-account configuration.

Catalogs and bindings are startup snapshots. Runtime thread rebindings and session overrides are unsupported. The CLI binding export omits session overrides; the operator must verify ordinary routing before acknowledging it. A snapshot cannot prove that Gateway configuration has remained unchanged. Reload the service through the operator's deployment process after changing routing, and inspect uncertain operations before issuing more writes.

## Network and input boundaries

Gateway destinations and discovery executables come from operator configuration, not tool arguments. The registry accepts HTTP/HTTPS URLs; it does not block all private addresses. Local Gateways are supported. Discord adapters apply their existing HTTPS/loopback restrictions. Restrict service network access at deployment level where required.

Tool argument validation, response limits, request timeouts, task limits, private Discord state, and durable operation fingerprints reduce accidental misuse. They do not constrain the intent or permissions of a Gateway agent. Debug logging may include message content; control log access accordingly.

For remotely reachable HTTP deployments, enable authentication, terminate HTTPS at the trusted proxy, restrict origins, and disable development-only dynamic client registration. Review the permissions of every selectable agent and the configured Discord account before admitting callers into this shared trust domain.
