# ADR-084: Per-capability chat/code activation modes

## Status

Accepted

## Context

[ADR-077](./077-explicit-mcp-server-mentions.md) gave MCP servers a single
per-server activation mode — `auto` | `manual` | `disabled` — stored as
`mcp.servers.<name>.mode`, with a task-scoped `/`-mention gate. Three gaps
remained:

- **One mode per server, globally.** A CHAT (No Project) session and a CODE
  (real project) session have different needs: a filesystem or git server is
  noise in chat but essential in code, while a research server may be the
  reverse. A single slot forces the operator to choose one behavior for both
  contexts (or to flip it back and forth).
- **Only MCP had modes.** Subagent profiles and Skills — the other two
  `/`-mentionable capability kinds of [ADR-076](./076-unified-slash-mentions.md)
  — could be configured (present or not) but never kept present-yet-quiet:
  there was no way to keep a skill installed while out of the router catalog,
  or an agent profile registered while out of the implicit roster.
- **Mode was entangled with the MCP server wire format.** `mode` rode the
  `MCPServerConfig` struct through every server CRUD surface
  (`UpdateMCPServers`), coupling a capability policy to transport editing and
  blocking the same vocabulary for the other kinds.

## Decision

**A top-level `capabilities:` config section giving every capability kind an
independent `chat_mode`/`code_mode` pair, a session-kind context resolved once
per task entry, and a dedicated whole-section RPC — superseding ADR-077's
single per-server mode while keeping its mention grammar, task-scoped mention
durability, and gated-complement mechanics unchanged.**

1. **Per-capability, per-context modes** — `capabilities.{skills, agents,
   mcp}.<name>` each carry `CapabilityModes{chat_mode, code_mode}`, a closed
   `auto` | `manual` | `disabled` enum per slot; empty = `auto`, and an absent
   entry = `auto` in both contexts (existing configs are behaviorally
   unchanged, zero regression). The legacy `mcp.servers.<name>.mode` key
   migrates at load — folded into **both** slots of `capabilities.mcp.<name>`
   unless that entry already carries an explicit value (all-or-nothing) — and
   is always erased, disappearing from the YAML on the next save.
   `MCPServerConfig` keeps the field only as the legacy YAML key; it is
   invisible on the JSON wire, and `UpdateMCPServers` rejects/ignores it.

2. **The two slots are independent; the dial decision is not** — for an MCP
   server, `disabled` in one context gates that context only (mentions
   discarded, advertised catalogs filtered, dispatch rejected); the gateway
   still dials the server for the other context. The server is omitted from
   `mcp.GatewayConfig` — never spawned, never connected — only when **both**
   slots are `disabled`. `manual` stays dialed in either context (warm on
   mention, exactly ADR-077's trade-off).

3. **Session-kind context selected once per task entry** — CHAT for a No
   Project session, CODE for a real project (`Orchestrator.isNoProject`).
   `prepareTaskMCP` and `attachCapabilitySnapshots` resolve the context on
   `HandleMessage` and `Resume` alike, project the two-slot maps onto the flat
   name→mode map of that context (both-empty entries dropped; a wholly empty
   section yields no map — every absent name is auto), and derive the entry's
   whole gate/snapshot set from that projection. In-flight executions keep
   their entry projection; a chat→code promotion applies at the next entry.
   The builder keeps publishing immutable snapshots on accepted
   reconfiguration before fallible gateway work; capabilities changes apply at
   the next entry without rebuilding orchestrators.

4. **The same three modes for Subagents and Skills, mirroring the MCP gate** —
   `auto` is fully discoverable (implicit roster `## Available Subagents`,
   router skill catalog); `manual` is hidden from implicit discovery but
   **resolvable and activatable by mention** (a `/agent:`-mentioned manual
   agent delegates; an explicitly mentioned manual skill activates even though
   the router catalog does not list it — a hallucinated router match of it is
   dropped); `disabled` is removed from discovery, its mentions are discarded,
   and delegation to it is refused fail-closed (`buildSubAgentTask` names
   `capabilities.agents`), mirroring the MCP registry gate. Restored routing
   respects the same filter: a disabled skill named by a persisted routing
   decision does not reactivate on resume.

5. **A dedicated wire surface** — `GetCapabilityModes()` returns all three
   sections normalized (canonical enum values, non-nil maps, `capabilities.mcp`
   names always resolvable against `mcp.servers`);
   `UpdateCapabilityModes(kind ∈ {skills, agents, mcp}, modes)` **replaces the
   whole section** (never merges) with strict save-path validation
   (`ValidateCapabilities` rejects unknown values up front), load-mirroring
   structural cleanup (stale `mcp` names trimmed, both-empty entries dropped),
   and the common atomic config-persist pipeline. It deliberately performs no
   gateway reconfigure: the server set is unchanged, advertising re-derives
   per task entry from the builder snapshot, and a both-disabled dial flip
   catches up at the next `UpdateMCPServers`-triggered reconfigure or
   restart. `GetMCPStatus` / `GetMCPMentionableServers` carry
   `chat_mode`/`code_mode` per server instead of a single `mode`.

6. **Frontend follows the session** — the Settings tab becomes **Capabilities**
   (sections ordered Subagents → MCP Servers → Skills, mirroring the
   completion list); every capability renders two chat/code selectors. MCP
   cards keep add/edit/delete/reload on `UpdateMCPServers` (mode keys removed
   from that wire format); Subagents and Skills are view-only (their catalog
   changes live in `.agents/` and the skills directories, not in
   `config.yaml`). A both-disabled server renders neutrally; a
   partially-disabled one keeps its live status. `/`-completion and the send
   path read the **active session's context column** only: a capability is
   mentionable unless `disabled` there, the "mention to enable" hint keys on
   manual in that context, and the catalog filters re-derive when the active
   session changes without a refetch.

7. **Unchanged ADR-077 mechanics** — mention syntax (plain partitioned,
   `/mcp:`-qualified always valid), monotonic durable `task_mcp_mentions`,
   `prepareTaskMCP`'s load-union-reload with `ErrMCPAuthorizationState`
   fail-closed persistence, the gated-complement transport, the four gate
   layers (descriptor filter, delegation raw-registry strip, registry
   dispatch gate, in-flight inheritance), the soft `## Requested MCP Servers`
   directive, and "a mention never overrides the mode" (now: the mode **in
   the session's context**) all carry over verbatim. Capability-group policy
   ([ADR-024](./024-group-policies.md)) still applies on top, untouched.

## Consequences

**Positive:**

- Chat and code sessions get independent capability policies without config
  churn — a server, agent, or skill can be essential in one context and gone
  in the other.
- Subagents and Skills gain the keep-configured-but-quiet affordance MCP had:
  smaller router catalogs and rosters, less prompt noise, fewer irrelevant
  confirmations, while a mention still pulls the capability in task-wide.
- The mode vocabulary is uniform across all three mentionable kinds, one
  settings surface, one RPC pair, one frontend filter library.
- Existing configs are byte-compatible and behavior-identical: the legacy key
  migrates once, then vanishes; absent entries are auto everywhere.
- Empty sections reproduce the pre-capabilities behavior exactly — every
  gate, catalog filter, and mention filter is a no-op.

**Negative / trade-offs:**

- Two slots per capability double the config surface and the states the UI
  must render (neutral both-disabled vs partially-disabled-with-live-status).
- A both-disabled flip via `UpdateCapabilityModes` does not stop the server's
  process until the next gateway reconfigure or restart — advertising is
  immediate at the next task entry, dialing is not (deliberate: mode edits
  are policy, not topology; `UpdateMCPServers` remains the topology RPC).
- Frontend session-kind resolution adds a dependency on `project_id` reads at
  completion/send time (fall-open on unknown: an unresolved session shows the
  active project's context).
- Legacy state has one migration window: a load that folds `mode` into both
  slots cannot preserve "this server was meant for code only" — the original
  key never carried that information.

## Alternatives Considered

- **Separate chat/code sections** (`capabilities.chat.*` /
  `capabilities.code.*`). Rejected: duplicates the kind axis into two trees,
  invites drift between them, and makes "what is this capability's policy"
  a two-file lookup; the per-capability pair keeps one entry per capability.
- **A per-session override instead of per-context config.** Rejected: the
  session kind is a durable property of the workspace a session runs in, not
  a per-task choice; per-session overrides would reintroduce the state
  ADR-077's task-scoped mentions already model, one level down.
- **Keep `mode` on `MCPServerConfig` and add a second key** (`chat_mode`/
  `code_mode` alongside it). Rejected: three spellings of one policy, and the
  wire format would keep carrying a field only the legacy path understands.
- **Lazy dial for single-context-disabled servers** (spawn on demand when the
  enabling context appears). Rejected: the enabled context would pay a cold
  process spawn + handshake per session switch; staying dialed keeps ADR-077's
  warm-mention property, and the gate already hides the tools in the disabled
  context.
- **Hide a server everywhere when disabled anywhere.** Rejected: it would
  silently cut off the context where the server is wanted — the whole point
  of the pair is per-context independence.
- **Per-tool granularity inside a server.** Rejected again, as in ADR-077:
  name-keyed policy is ruled out by ADR-024, and tool lists churn with every
  server refresh.
- **Making Subagents/Skills config-writable** (add/edit/delete in
  `capabilities:`). Rejected: their catalogs are already owned by
  `.agents/` profiles and the skills directories with their own lifecycle;
  duplicating CRUD in config.yaml would create a second source of truth for
  existence. The section only tunes activation of what exists.

## Related

- [ADR-077](./077-explicit-mcp-server-mentions.md) — the superseded
  single-mode decision; mention grammar, task-scoped durability, and the
  gated complement carry over unchanged.
- [ADR-076](./076-unified-slash-mentions.md) — the unified `/`-mention
  grammar whose three namespaces all gain per-context modes.
- [ADR-024](./024-group-policies.md) — capability-group policy, still applied
  on top of the mode gate.
- [../domains/capabilities.md](../domains/capabilities.md) — the cross-kind
  capability semantics.
- [../domains/tool-system/mcp-gateway.md](../domains/tool-system/mcp-gateway.md)
  — MCP-specific wiring: dial/reconfigure lifecycle, status reporting,
  mention gating.
- [../../docs/custom-skills-and-subagents.md](../../docs/custom-skills-and-subagents.md)
  — the user-facing capability/mention documentation.
