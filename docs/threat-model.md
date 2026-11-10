# Threat model

## Shared trust

Every authenticated MCP client may select every configured agent on the connected Gateway. Agent IDs select routing; they provide no per-user ACL or tenant isolation. Configure a separate MCP deployment and narrower Gateway credentials when callers must have different access. stdio trusts the local process owner. HTTP authentication remains controlled by the existing OAuth configuration.

The operator-configured forwarding requester name attributes new Discord requests to the single service owner. It is independent of the selected agent and is not an authenticated caller identity. MCP client names and generated session labels are display metadata.

## Capabilities and effects

Generic chat sends messages to the configured Gateway. Its agents may run tools and change external state according to Gateway policy. Async chat queues the same work in process memory. Gateway health reports reachability, including some HTTP authentication failures; it does not verify agent readiness or authorization.

Optional Discord tools read allowed destinations, create threads, publish requests and replies, and invoke agents. Separately configured creation policies permit channel creation and persistent admission after explicit request flags. The service uses fixed Gateway SDK agent/wait/abort requests, Gateway HTTP message actions and Discord REST adapters, and writes operation/admission records to a private state directory. It requires a configured Gateway connection, SDK service identity and operator acknowledgement of ordinary inbound routing. It does not launch the OpenClaw CLI. Durable records and fingerprints support recovery without blindly repeating writes.

Optional Gateway agent discovery calls agents.list through the SDK once at startup for the configured Gateway, requesting operator.read with a separate persistent device identity. It retains agent IDs only and never imports configuration or bindings. Alternatively, catalogs and supported binding matches are explicit operator configuration. No executable or CLI discovery mode is accepted.

## Ownership and continuity

Async task ownership retains the existing transport behavior: modern HTTP uses a token-derived owner, while legacy and stdio sessions use server-local ownership. Token refresh changes the modern task owner. Tasks and their selected agents remain process-local and disappear on restart.

Discord operation ownership is service-lifecycle ownership, not per-client authorization. All clients share the configured Discord capabilities. Operation IDs are unguessable recovery identifiers and must be kept with their original arguments. Status checks retain current target/policy authorization and never retarget an operation.

Caller-supplied Gateway session keys retain existing access semantics. The bridge rejects a supplied agent-qualified key when it conflicts with an explicit agent selector, but it does not introduce session ownership. Legacy transport sessions are not newly bound to authenticated principals by this feature. Do not treat possession of a task ID, operation ID or session key as a general authorization mechanism.

## Routing and Discord permissions

Agent selection resolves against the configured Gateway catalog without changing a shared client. Unknown explicit agents fail before submission. Generic agents need no Discord mapping.

Imported Discord bindings can restrict or reassign routing only inside explicit MCP scopes. Channel blacklist/whitelist checks, verified thread ancestry, creation-policy admission, and normal-routing acknowledgement still apply. Adding an agent or binding does not admit a guild or enable creation. All Discord SDK/HTTP adapters use the same Gateway connection as direct chat and the existing bot-account configuration.

Catalogs and bindings are startup snapshots. Runtime thread rebindings and session overrides are unsupported. A catalog or binding snapshot does not prove runtime session routing; the operator must verify ordinary routing before acknowledging it. A snapshot cannot prove that Gateway configuration has remained unchanged. Reload the service through the operator's deployment process after changing routing, and inspect uncertain operations before issuing more writes.

## Network and input boundaries

Gateway destinations and service authentication come from operator configuration, not tool arguments. The connection configuration accepts HTTP/HTTPS URLs; it does not block all private addresses. Local Gateways are supported. Discord adapters apply their existing HTTPS/loopback restrictions. Restrict service network access at deployment level where required.

Tool argument validation, response limits, request timeouts, task limits, private Discord state, and durable operation fingerprints reduce accidental misuse. They do not constrain the intent or permissions of a Gateway agent. Debug logging may include message content; control log access accordingly.

For remotely reachable HTTP deployments, enable authentication, terminate HTTPS at the trusted proxy, restrict origins, and disable development-only dynamic client registration. Review the permissions of every selectable agent and the configured Discord account before admitting callers into this shared trust domain.
