# Threat model

## Shared trust

Every authenticated MCP client may select every configured agent on the connected Gateway. Agent IDs select routing; they provide no per-user ACL or tenant isolation. Configure a separate MCP deployment and narrower Gateway credentials when callers must have different access. stdio trusts the local process owner. HTTP authentication remains controlled by the existing OAuth configuration.

The operator-configured forwarding requester name attributes new Discord requests to the single service owner. It is independent of the selected agent and is not an authenticated caller identity. MCP client names and generated session labels are display metadata. The optional caller-supplied `source` string is also display metadata, not proof of identity or authority. Any client or domain is accepted; the server neither fetches it nor verifies its provenance. HTML tags are stripped with quoted attribute delimiters respected; entity references are rejected rather than decoded. Markdown syntax is escaped, user/role/everyone mentions are neutralized, and valid Discord channel tags and raw URLs remain visible. Controls, format characters (including bidi), line separators, malformed Unicode, empty rendered text and excessive input/output length are rejected before effects. The original string, not its sanitized display, participates in the durable operation fingerprint. It grants no access to the source or destination and is never appended to agent input.

## Capabilities and effects

Generic chat sends messages to the configured Gateway. Its agents may run tools and change external state according to Gateway policy. Async chat queues the same work in process memory. Gateway health reports reachability, including some HTTP authentication failures; it does not verify agent readiness or authorization.

Optional Discord tools read allowed destinations, create threads, publish requests and replies, and invoke agents. Separately configured creation policies permit channel creation and persistent admission after explicit request flags. The service uses fixed Gateway SDK agent/wait/abort requests, Gateway HTTP message actions and Discord REST adapters, and writes operation/admission records to a private state directory. It requires a configured Gateway connection, SDK service identity and operator acknowledgement of ordinary inbound routing. It does not launch the OpenClaw CLI. Durable records and fingerprints support recovery without blindly repeating writes.


## Ownership and continuity

Async task ownership retains the existing transport behavior: modern HTTP uses a token-derived owner, while legacy and stdio sessions use server-local ownership. Token refresh changes the modern task owner. Tasks and their selected agents remain process-local and disappear on restart.

Discord operation ownership is service-lifecycle ownership, not per-client authorization. All clients share the configured Discord capabilities. Operation IDs are unguessable recovery identifiers and must be kept with their original arguments. Status checks validate the selected agent against the stored operation without authorizing new writes.

Caller-supplied Gateway session keys retain existing access semantics. The bridge rejects a supplied agent-qualified key when it conflicts with an explicit agent selector, but it does not introduce session ownership. Legacy transport sessions are not newly bound to authenticated principals by this feature. Do not treat possession of a task ID, operation ID or session key as a general authorization mechanism.

## Routing and Discord permissions

Agent selection resolves against the current Gateway roster without changing a shared client. Unknown explicit agents fail before submission. Generic agents need no Discord mapping.



## Network and input boundaries

Gateway destinations and service authentication come from operator configuration, not tool arguments. The connection configuration accepts HTTP/HTTPS URLs; it does not block all private addresses. Local Gateways are supported. Discord adapters apply their existing HTTPS/loopback restrictions. Restrict service network access at deployment level where required.

Tool argument validation, response limits, request timeouts, task limits, private Discord state, and durable operation fingerprints reduce accidental misuse. They do not constrain the intent or permissions of a Gateway agent. Debug logging may include message content; control log access accordingly.

For remotely reachable HTTP deployments, enable authentication, terminate HTTPS at the trusted proxy, restrict origins, and disable development-only dynamic client registration. Review the permissions of every selectable agent and the configured Discord account before admitting callers into this shared trust domain.

## Live binding access

Every authenticated client can select all current Gateway agents. Discord access unions only the selected agent’s supported server/channel bindings; other agents never subtract it. Thread access comes from verified parent metadata. Unsupported conditions grant nothing. Creation needs a server binding and verified guild bot permissions.

agents.list and config.get are read live. Config snapshots must be valid with equal applied/revision hashes. There is a non-atomic interval between checks and effects; no revision precondition is available. Runtime ownership, roles, broadcast and ACP are outside this access model. Inbound responses may route differently.
