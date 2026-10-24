# ADR-096: Custom Commands — the fourth `/` category (opencode-style prompt templates)

## Status

Accepted

## Context

The unified `/` trigger (ADR-076) currently dispatches to three mention
catalogs — Subagent Profiles, MCP servers, and Skills — all of which are
**capability mentions**: they annotate a message with "also activate/request
this" and ride along with whatever prose the user typed. There is no way to
say "run this prepared prompt": recurring workflows (run the test suite, write
a commit message from a template, scaffold a component) must be re-typed or
kept in ad-hoc notes.

opencode (https://opencode.ai/docs/commands/) solves exactly this with
file-backed custom commands: markdown files whose frontmatter binds
`description`/`agent`/`model`/`subtask` and whose body is a prompt template
supporting `$ARGUMENTS`/`$N` placeholders, shell injection (`` !`cmd` ``) and
`@file` references.

c0wrk needs the same affordance as a FOURTH `/` category, discovered on the
same three levels as skills and agents (project-local → c0wrk global → user).
Two decisions from the exploration round constrain the design:

- The shell-injection feature (`` !`cmd` `` executes at send time, before any
  agent-side security pipeline) is DEFERRED — a hardened backend execution
  path (an `ExecuteUnattended`-shaped gate per the verify-on-edit precedent)
  and a security review would be its own change.
- The name-collision rule must be the ADR-076 rule: a plain `/name` present
  in more than one catalog is a visible no-op with a hint; a
  collision-qualified spelling disambiguates. Silent preference is rejected.

## Decision

**Commands are file-backed prompt templates invoked by a leading token, and
they are not mentions.**

1. **Format.** A command is `<name>.md` in a command discovery directory:
   YAML frontmatter with `description`, `agent` (optional), `model`
   (optional; unknown keys ignored, every field optional), and a template
   body. The file name sans extension is the command name; only names in the
   mention character class (`[\w-]+`, matching `isMentionNameByte`) are
   discoverable — anything else cannot be typed as a ref and is skipped.
2. **Discovery.** Three levels, highest first: the project-local
   `<workspace>/.agents/commands/` (always scanned automatically), then the
   `commands.dirs` config list (defaults `~/.c0wrk/.agents/commands`,
   `~/.agents/commands`; nil → defaults, empty list → opt-out — the
   skills/agents semantics). The first file claiming a name wins. Like the
   sibling catalogs, the resolved dir list is fixed at startup; the global
   dirs are watched (`commands:changed`), workspace-local changes surface via
   `workspace:tree_changed`.
3. **Invocation.** Only a LEADING token (after whitespace) invokes: plain
   `/name args…` or the collision-qualified `/command: name args…` (both
   colon spellings; the spaced form is the canonical dropdown emission; ANY
   run of spaces/tabs after the colon is accepted — a deliberate divergence
   from the ADR-076 mention grammar, whose single optional space is unchanged
   for `/agent:`/`/skill:`/`/mcp:`).
   Commands are an invocation, not a mention: the token is replaced by the
   expanded template BEFORE the mention pipeline runs, so
   `PreprocessMessageText`, the `SendMessage` positional contract, and
   `HandleOptions` are untouched. A mid-message `/name` never invokes.
4. **Substitution.** One left-to-right pass over the template: `$ARGUMENTS` →
   the raw remainder after the token; `$N` → the Nth positional argument
   (whitespace-split, a double-quoted run groups as one argument, backslash
   escapes work inside quotes). Substituted values are literal — no
   re-expansion. Missing positionals and `$0` expand to the empty string. No
   escape syntax in v1: a literal `$1` in a template is indistinguishable
   from the placeholder.
5. **Bindings.** Frontmatter `agent` is merged into the send's requested
   subagents (`activeAgents` → the `## Requested Subagents` directive);
   frontmatter `model` is a FALLBACK model override — the user's explicit
   toolbar selection always wins. `subtask` is not carried: delegation in
   c0wrk belongs to the Conductor, and a "force delegation" directive would
   be an unenforceable preference.
6. **Precedence (ADR-076 generalized).** A leading plain `/name` resolves
   against FOUR catalogs: in ≥2 → the ambiguous no-op (text preserved, hint
   names `/command:` as the fourth spelling); exactly the command catalog →
   expand; exactly one mention catalog → that mention; none → the historical
   permissive skill passthrough. The qualified `/command:` form is always
   valid input. A command named `goal` shadows the built-in `/goal` — the
   same accepted shadowing class as a skill named `goal` (ADR-076
   Consequences).
7. **Where expansion lives.** The FRONTEND chat-input send path expands the
   command (pure logic in `lib/commandsExpand.ts`); the backend owns
   discovery and serves full descriptors (`ListCommands`, template included —
   command files are small, no separate GetCommand RPC). Core never consumes
   commands: no builder wiring, no path constant beyond the single literal in
   `backend/config/paths.go`.
8. **Completion.** A `Commands` section at rank 0 (the "run this" affordance
   answers `/` first, like opencode's command palette); the mention sections
   shift down one rank (Subagents 1, MCP Servers 2, Skills 3). Commands are
   not session-kind filtered (they have no capability modes; project-local
   commands simply do not exist in a No-Project session).
9. **Empty expansion guard.** A command whose expansion is whitespace is a
   no-op with a hint naming the empty template.

## Consequences

**Positive:**

- Recurring prompts become versionable project files, shareable on the same
  three levels (and packable like skills) without touching the orchestrator —
  the entire feature is frontend send-path logic plus a backend listing RPC.
- The mention pipeline (catalog-gated fail-closed stripping, the Go scanner,
  chips) is unchanged; commands cannot be hallucinated or activated by the
  model, only typed or picked by the user.
- Templates compose with existing machinery: a template may itself carry
  `/skill`/`/agent` mentions (partitioned normally after expansion) and
  `@file` references (resolved by the existing fileref pipeline).

**Negative / trade-offs:**

- No shell injection (`!`cmd``) and no escape syntax in v1 — templates
  containing shell positional-parameter examples will substitute `$1`
  unintentionally; both are documented limitations with a follow-up path.
- A command shadowing `/goal` silently changes a load-bearing builtin's
  meaning for the plain spelling — accepted by precedent (ADR-076), still
  user-caused and reversible by renaming the file.
- The backend catalog is fixed at startup (new global dirs appear on
  restart) — the same accepted trade-off as the skill/agent watchers.
- A template's text is sent verbatim as the user message: the transcript
  shows the expanded prompt (transparent, matches what the model sees) at the
  cost of a longer persisted user turn.

## Alternatives Considered

- **v1 with shell injection.** Rejected for now: send-time shell execution
  bypasses the agent-side security pipeline and needs its own hardened gate +
  security review (SECURITY.md ASI); deferring keeps this change
  frontend-most.
- **Commands win at the start of a message (opencode semantics).** Rejected:
  silently reroutes a colliding name's established mention behavior —
  exactly the "silent misactivation" ADR-076 rejects.
- **Backend-side expansion** (thread `activeCommands` + args through
  `SendMessage`). Rejected: a 13th positional argument on an already-12-arg
  contract, `HandleOptions` growth, and a persisted-message question the
  frontend answer answers for free (the expanded text IS the message).
- **Carry `subtask`.** Rejected: c0wrk delegation is Conductor-owned; a
  MUST-delegate directive would be advisory in practice.
- **Flat reserved-name list protecting `/goal`.** Rejected: breaks the
  "catalog names shadow builtins" symmetry ADR-076 already accepted for
  skills; the collision is deliberate user action and visible in the
  completion list.

## Related

- [ADR-076](./076-unified-slash-mentions.md) — the unified `/` grammar this
  ADR extends with a fourth namespace.
- [ADR-084](./084-per-capability-chat-code-activation-modes.md) — per-context
  activation modes; deliberately NOT extended to commands in v1.
- [domains/commands.md](../domains/commands.md) — the behavioral spec.
- `docs/commands.md` — the user-facing reference.
