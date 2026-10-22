# Code Review — branch `ui/web` vs `main`

> Aggregated review report. Scope: `git diff main...HEAD` — 188 files at pass 4 (Go: `internal/webaccess` (new), `desktop/`, `backend/`; React/TS `frontend/src`; specs/config/CI). Originally reviewed at 305 files; between passes 3 and 4 the branch merged `origin/main` (a5afc14a), absorbing the `core/embeddedllm` and part of the session/frontend work into `main` — the affected findings (20 issues) moved to the [out-of-scope annex](#out-of-scope-annex--issues-whose-files-were-absorbed-into-main-mid-review) with numbers preserved.
>
> Method: the `code-review` skill. Pass 1: twelve parallel area reviews (6 Go + 6 frontend) each read the full changed files plus binding policy (`SECURITY.md`, `AGENTS.md`, relevant `specs/`), followed by an independent conductor verification pass: **every SHOULD FIX below was re-verified line-by-line against the working tree before inclusion**; CONSIDER items are included from the area reviews with file:line anchors. Passes 2–6: blind, independent full re-reviews (12–13 parallel area subagents each) with conductor dedupe + verification of every candidate. Specs were additionally checked mechanically (INDEX completeness, no dangling ADR references after the 091/093/094/095 → 090/092 consolidation, no broken relative links).
>
> Status: **iteration 10 aggregated — SATURATION REACHED.** Pass 10 — the final blind, independent re-review over the current 188-file diff (12 area subagents, same scope split; conductor dedupe + working-tree verification of every candidate; 187/188 files reviewed, the binary favicon excluded) — produced **zero new MUST FIX and zero new SHOULD FIX findings**. Its MUST/SHOULD candidates were all re-ratings of issues already in this report (#7 and #40 and #123 rated MUST again, all kept per the report's established calibration; #58, #76/#95 and #139 re-rated SHOULD, kept CONSIDER after re-verification), its duplicates re-confirmed eight known issues (#8, #15, #41, #44, #45, #49, #81, #104, #105, #111, #134), and its only net-new findings are **3 new CONSIDER** (#185–#187). The stop condition — a final full re-review pass producing no new MUST FIX / SHOULD FIX beyond this report — is **met**; the review is closed (see the tracker at the bottom).

## Summary

| Severity | In-scope body | Out-of-scope annex | Total |
| --- | --- | --- | --- |
| MUST FIX | 0 | 0 | 0 |
| SHOULD FIX | 33 | 4 | 37 |
| CONSIDER | 134 | 16 | 150 |
| **issues** | **167** | **20** | **187** |

The branch is in strong shape: no MUST FIX findings survived verification across six passes (pass 3's single MUST candidate was rejected after conductor verification against the Go 1.27.3 standard-library sources — see #66; passes 4, 5, 6 and 7 re-rated existing SHOULDs #7/#40 as MUST and each rating was declined after conductor verification against the report's established calibration). The web-access sidecar's security core (fail-closed TLS, token lifecycle, cookie flags, WS origin checks, dispatch denylist, control-RPC isolation, compound experimental gate) was verified line-by-line and held — pass 4's one gate finding (#80) is a hardening gap on a public binding, not an exposed hole; pass 5's `go test -race` run over `internal/webaccess` came back clean and its deep re-verification of the token/cookie/origin/denylist posture corroborated pass 1–4's "verified clean" trail; path containment is centralized throughout (zero inline `HasPrefix`-style containment introduced); DTO/arity roundtrips between Go and the frontend match, including the dual desktop/web transports. Pass 5's new SHOULDs are transport-parity and doc-accuracy gaps on the branch's net-new surfaces, not regressions of existing behavior. Pass 6's single new SHOULD is a test-only OS-portability defect that deterministically fails the Windows CI leg; the branch's code surfaces themselves re-verified clean, with the web-access security core re-audited line-by-line for the sixth consecutive pass. Pass 7's single new SHOULD (#129) is a resource-hardening gap on the judge evaluation path (unbounded parallel LLM evaluations per inbound frame) — the security core held for the seventh consecutive pass. Pass 8's single new SHOULD (#141) is a false doc claim in the branch-new `sessions:changed` comment (phantom managed-worktree creation emitters); the security core held for the eighth consecutive pass, and pass 8's remaining new findings are all CONSIDER-grade. Pass 9's single new SHOULD (#153) is the frontend README's "exclusively via Wails IPC" claim and Wails-only architecture diagram — true on `main`, made false by this branch's dual-transport web-access feature and left unamended in a file the branch touched; the security core held for the ninth consecutive pass, and pass 9's 31 remaining new findings are all CONSIDER-grade (seven conductor-verified as pre-existing on `main` and marked). Pass 10 — the final saturation pass — produced **zero new MUST FIX / SHOULD FIX**: every delegate MUST/SHOULD candidate mapped onto an issue already in this report (#7/#40/#123 rated MUST again and kept SHOULD; #58/#76+#95/#139 re-rated SHOULD and kept CONSIDER after conductor re-verification), and only 3 new CONSIDERs (#185–#187) were added; the web-access security core held for the tenth consecutive pass. Saturation reached — review closed.

---

## SHOULD FIX

### 1. SHOULD FIX — Inbound web bridge logs payload-shape drops at Warn, contradicting its own stated Debug-only invariant

**File:** [desktop/webaccess_inbound.go:27](desktop/webaccess_inbound.go#L27), [desktop/webaccess_inbound.go:55-L100](desktop/webaccess_inbound.go#L55-L100) via [desktop/event_handlers.go:17-30](desktop/event_handlers.go#L17-L30)
**Category:** security/behavior (log-noise vector; invariant violation)

The file's security rationale (line 27) states: "Every dropped frame is logged at Debug only: network input must not be able to write unbounded Warn/Error lines into the log." That holds for malformed JSON, unnamed, and non-whitelisted frames — but a frame carrying a *whitelisted* name with a missing or wrong-shaped payload is routed into the shared `extractPayload`, which logs **Warn** ("missing payload" / "unexpected payload type") and drops. The tests ([desktop/webaccess_inbound_test.go:297-312](desktop/webaccess_inbound_test.go#L297-L312)) pin the Warn behavior. Verified: `extractPayload` unconditionally `log.Warn`s both failure shapes.

**Why it is a problem:** any authenticated WS principal (a compromised/buggy tab, or any token holder on a non-loopback bind) can emit whitelisted names with empty args at frame rate and write an unbounded stream of Warn lines into the durable rotating log — exactly the outcome the comment says the design prevents; the noise evicts real signal (crash-capture mirror, 4 MiB rotation).

**Suggested fix:**
a) In `dispatchWebInboundFrame`, do the shape check inline before the shared handler path and drop at Debug (`len(env.Args) != 1` / non-map `env.Args[0]` → `log.Debug(...)`, return), then call the HITL handlers directly with the payload map.
b) Hand the HITL handlers a demoting logger on the web path (a slog wrapper mapping Warn→Debug for these two messages), keeping the desktop Wails path's Warns.
c) Weakest: keep the behavior and rewrite the line-27 invariant to carve out the exception (not recommended — the rationale is the security argument).

### 2. SHOULD FIX — Data race: `GetWebAccessInfo` reads `cfg.WebAccess` fields the control RPCs write under `webAccessMu`

**File:** [desktop/app.go:1023-1051](desktop/app.go#L1023-L1051) (reader) vs [desktop/app.go:1092-1096](desktop/app.go#L1092-L1096), [desktop/app.go:1303](desktop/app.go#L1303), [desktop/app.go:1372](desktop/app.go#L1372) (writers)
**Category:** bug (data race)

`GetWebAccessInfo` reads `cfg.WebAccess.Enabled/.Bind/.Port/.Token/.TLS.*` (and passes the section to `classifyWebAccessCert`) holding only `stateMu.RLock` for the config pointer. Every desktop writer of those fields (`setWebAccessEnabledLocked`, `setWebAccessConnectionLocked`, `SetWebAccessToken`, `RegenerateWebAccessToken`, `setWebAccessTLSLocked`) mutates them under `webAccessMu` only — a lock this reader does not take. The documented "one-word window" rationale covers a concurrent *backend save*, but `GetWebAccessInfo` is itself a renderer-callable App method on a Wails binding goroutine: overlapping RPC calls (Settings refreshing info around a toggle) are a real, renderer-triggerable race; `Token` is a two-word string header, so a torn read is UB-class under the Go memory model. `go test -race` CI legs would flag it as flaky red.

**Suggested fix:**
a) Snapshot the section under `webAccessMu` in `GetWebAccessInfo` (struct copy `sec := cfg.WebAccess`), then run cert classification and URL rendering outside the lock (keeps `classifyWebAccessCert`'s file I/O off the transition lock).
b) Take `webAccessMu` for the whole `GetWebAccessInfo` body (simplest; blocks a concurrent hot-restart for up to ~3 s).
c) Publish an immutable `WebAccessConfig` snapshot via `atomic.Pointer[config.WebAccessConfig]` beside the live-config pointer and read only that.

**Pass 5 extension:** a fresh blind pass widened the same seam in both directions. (i) The race is not desktop-reader-vs-desktop-writer only: desktop control RPCs persist through the package-level `config.Save` (which `yaml.Marshal`s the ENTIRE live config with no internal lock) while the backend mutates other sections under `configMu` — so a desktop marshal can read a backend mid-mutation, and a backend persist can read the `WebAccess` section mid-mutation: bidirectional, whole-struct. (ii) Two near-simultaneous persists (desktop `Save` vs backend `persistConfig`) interleave at whole-file granularity — last writer wins, so a web-access toggle can be silently dropped by an unrelated settings save landing in the same few-millisecond window (or vice versa). The "one-word window" comments at [desktop/app.go:165](desktop/app.go#L165), [desktop/app.go:1088](desktop/app.go#L1088) match neither the multi-word writes nor the whole-file write granularity. Fix option d) narrows option (a) to the seam: add an exported backend method (e.g. `UpdateWebAccessSection(mutate func(*config.WebAccessConfig) error)`) that mutates + persists under `configMu` and route the five control RPCs plus the token mint through it, deleting the zero-backend-edit exception; option e) is the minimum: correct the comments to state the real exposure (whole-struct writes; whole-file, bidirectional, lost-update-prone) so the accepted risk is honest.

### 3. SHOULD FIX — Fail-soft bind/port reset silently wipes a hand-authored TLS subsection while the sibling reset deliberately preserves it

**File:** [backend/config/web_access.go:393-401](backend/config/web_access.go#L393-L401) (`normalizeWebAccess`)
**Category:** behavior / config data loss / internal inconsistency

The bind/port fail-soft branch replaces the **whole section** with `defaultWebAccessState()` (line 399), zeroing `tls.cert`/`tls.key`. Twelve lines later the TLS-unusable branch does the opposite: only `cfg.WebAccess.Enabled = false`, with the explicit comment that "the operator's paths survive the reset". The bind/port warning text does not mention the wipe.

**Why it is a problem:** `config.example.yaml` documents hand-editing `tls.cert`/`tls.key` as the way to use an operator-owned certificate. Realistic trigger: an operator writes a malformed `bind` (e.g. port typed into the bind field) alongside their own PEM pair → load warns and resets the section in memory → the **next `Save` for any unrelated settings change persists `enabled: false` with empty cert/key paths**, silently destroying the authored pair; the warning only names bind/port, so nothing hints the paths were erased. The ADR-092 fix-and-re-enable flow presumes the subsection survives a reset.

**Suggested fix:**
a) Mirror the sibling branch: reset only `Enabled`/`Bind`/`Port`/`Token` and preserve `cfg.WebAccess.TLS` as authored (a disabled section is inert; the persisted shape stays valid, and the TLS check below is skipped for the disabled section either way).
b) Keep the wipe but say so in the warning ("…and clears the tls.cert/tls.key paths") and pin the wipe with a test so it is at least observable.

**Pass 5 extension:** the wipe also destroys a hand-authored **static token** (the reset assigns `defaultWebAccessState()`, zeroing `Token` too), while the warning's "fix bind/port and re-enable" implies a one-field repair — the actual repair is three fields (bind/port, token, TLS pair), and the token loss silently re-authenticates every existing browser setup on the next start. The sibling TLS-unusable path deliberately preserves bind/port/token for its fix-and-re-enable flow ([backend/config/web_access.go:410-415](backend/config/web_access.go#L410-L415)), which is what makes the asymmetry misleading.

### 5. SHOULD FIX — Failed post-toggle re-read flips an APPLIED web-access enable back to "Off" (security-relevant status lie)

**File:** [frontend/src/components/settings/WebAccessSettings.tsx:152-155](frontend/src/components/settings/WebAccessSettings.tsx#L152-L155)
**Category:** bug / stale security status after failed action

`handleToggle` awaits `setWebAccessEnabled(next)` (persist + live apply succeed together), then `const fresh = await getWebAccessInfo(); setInfo(fresh ?? previous)`. `getWebAccessInfo` never throws — on any read failure it resolves `null`, and the UI reverts to `previous`: the toggle renders **Off** and the status line claims "the app is reachable from the desktop window only" **while the sidecar is actually serving and a browser tab may be connected**. The in-code justification ("the backend still holds the previous value") is false on this path: the write succeeded, only the read failed. The sibling TLS block handles the identical case the opposite (correct) way — it keeps the optimistic state when the re-read returns null (pinned by its own test).

**Why it is a problem:** this section exists to tell the operator honestly whether the app is network-exposed; a transient read failure after a successful enable produces the dangerous lie "not exposed".

**Suggested fix:**
a) `setInfo(fresh ?? { ...previous, enabled: next })` — on re-read failure keep the applied switch value instead of the pre-toggle snapshot.
b) Keep the optimistic object and patch only the fields the fresh read actually supplies, so a null re-read is a no-op.
c) Extract the TLS block's re-read-on-failure semantics into a shared helper used by both blocks so they cannot diverge again.

### 6. SHOULD FIX — With TLS enabled, editing BOTH cert and key paths can never be committed (draft deadlock)

**File:** [frontend/src/components/settings/WebAccessTLSSettings.tsx:93-95](frontend/src/components/settings/WebAccessTLSSettings.tsx#L93-L95)
**Category:** bug / partial-save flow

`commitPath(field)` pairs the edited field's draft with the sibling's **persisted** value: `const cert = field === 'cert' ? certDraft.trim() : info.tlsCert ?? ''` (and symmetrically for key). The backend verifies the pair as a unit (`tls.LoadX509KeyPair` before persist). When the operator must replace both halves of a pair while `tlsEnabled` is true (rotating to a new external pair), each self-committing blur sends a mismatched pair — both commits are refused, `info` never updates (re-read runs only on success), so the next commit pairs new-draft-with-old-sibling again: the fields deadlock with no way to land `(certB, keyB)`.

**Why it is a problem:** a core save flow of the new TLS section cannot complete for a legitimate input; the operator sees repeated refusals no amount of retyping fixes.

**Suggested fix:**
a) Thread the sibling **draft** (trimmed, empty-falls-back-to-persisted) instead of the persisted value, so the first blur after editing both fields commits the complete new pair — matches the "backend loads the pair as a unit" design.
b) Commit as a unit: fire the RPC only when `(cert, key) !== persisted pair`, always sending both drafts.
c) Give the two path fields one shared commit (debounced pair-commit or an explicit Apply button for the pair).

### 7. SHOULD FIX — Web-transport Create Project dialog is a dead end: the hint says "Type the workspace directory path" but no path input exists

**File:** [frontend/src/components/project/CreateProjectDialog.tsx:88-102](frontend/src/components/project/CreateProjectDialog.tsx#L88-L102) (guard at [CreateProjectDialog.tsx:37-39](frontend/src/components/project/CreateProjectDialog.tsx#L37-L39))
**Category:** bug / behavior (web transport)

This change hides the native picker button in the web transport and shows: "Type the workspace directory path — the native folder browser is only available in the desktop app." But the dialog contains no text input for the path — `externalPath` is set only by `pickDirectory()` (the hidden native picker), and `handleSubmit` requires `externalPath`, so **Create is permanently disabled**. The dialog is reachable from a browser tab via the sidebar CODE toggle and `ProjectSelector` (no transport gate on entry). The new test pins the hint copy but not the capability; its comment claims "The manual path entry stays usable" — an invariant the component does not implement.

**Why it is a problem:** the shipped UI instructs an impossible action and the dialog's primary action can never be enabled in that transport; the test enshrines the false invariant.

**Suggested fix:**
a) In the web transport render a real path `Input` bound to `externalPath` (the backend's `createProject` already validates the path) — the hint then becomes true.
b) If web creation is not intended yet, change the hint to say creation requires the desktop app and disable/omit the Create button; fix the test's "manual path entry stays usable" comment/expectations.
c) Least-effort honesty fix: hide the entire Directory block on web and gate the dialog entry points (SidebarHeader/ProjectSelector) on `!isWebTransport()`.

### 8. SHOULD FIX — Same-named files in one web drop: `byName` map stages the wrong file's content

**File:** [frontend/src/hooks/useStageAttachments.ts:173-190](frontend/src/hooks/useStageAttachments.ts#L173-L190)
**Category:** bug / content integrity

`stageAttachmentFiles` builds `const byName = new Map(files.map((f) => [f.name, f]))` and resolves each staged entry back to its `File` via `byName.get(e.fileName)`. A name-keyed map cannot represent two files with identical names: the last one wins. In the web transport a user can multi-select/drag two files with the same basename from different folders — both entries look up the *same* `File` object, so one attachment is silently staged with the other file's **bytes** under its name. Nothing fails, no error is shown; the wrong content travels into the agent context.

**Suggested fix:**
a) Zip by index instead of by name: build entries and `File` list in parallel and pass the `File` alongside each entry in the closure, making the name display-only metadata.
b) Key the map by a per-file unique handle (the `File` object or index); keep a name→count multimap only for the legacy name-only path.
c) Minimal hardening: detect duplicate names up front and stage duplicates one-by-one in separate `stageEntries` calls.

---

## CONSIDER

### 9. CONSIDER — `hitl_resolved` can broadcast a decision that was dropped, violating the "effective decision" contract

**File:** [desktop/event_handlers.go:197-222](desktop/event_handlers.go#L197-L222) (same pattern at [395-419](desktop/event_handlers.go#L395-L419), [632-649](desktop/event_handlers.go#L632-L649))
**Category:** bug (corner case) / behavior. The buffered-channel send is best-effort: on `default` (channel full) the response is logged as dropped, but the pending entry is still deleted, the persisted message resolved with the dropped `decision`, and `emitHitlResolved` still broadcasts it — the event's contract (and test) say the payload carries the EFFECTIVE first-responder decision. Sub-second races only; cosmetic convergence lie, never agent-side.
**Fix:** a) In the dropped branch emit an empty `decision` (payload already treats "" as "no effective answer"). b) Move `emitHitlResolved` into the successful-send path only.

### 10. CONSIDER — `GenerateWebAccessCertificate` skips the warning-channel refresh although regeneration can move the section's load-warning contribution

**File:** [desktop/app.go:1434-1470](desktop/app.go#L1434-L1470) (refresh rule at [1040-1046](desktop/app.go#L1040-L1046))
**Category:** behavior (stale UI state). The docstring's "cannot move the warning state" holds for the token RPCs but not the certificate RPCs: an unusable TLS pair turns the section off with a load warning; generating a fresh valid pair heals the pair, yet the banner keeps claiming it is broken until restart.
**Fix:** a) Call `a.refreshWebAccessLoadWarnings()` after the unlock (idempotent, cheap). b) Narrow the docstring justification to the token RPCs and document the stale-banner-after-generate consequence.

### 11. CONSIDER — `Server` lifecycle is single-use; double `Start` or `Start`-after-`Stop` leaks a listener while the type doc claims blanket concurrency safety

**File:** [internal/webaccess/webaccess.go:374-447](internal/webaccess/webaccess.go#L374-L447)
**Category:** bug (latent, API contract). Unreachable today (every desktop path builds a fresh `Server` per mount and serializes through `webAccessMu`; idempotence pinned by tests) — a latent hazard for the next caller.
**Fix:** a) Guard `Start` with a `started atomic.Bool` (error on double-start / start-after-stop). b) Document the single-use contract and drop the blanket sentence.

### 12. CONSIDER — Unauthenticated client-triggered diagnostics land at Warn via `http.Server.ErrorLog` — a per-line log-noise vector on a non-loopback bind

**File:** [internal/webaccess/webaccess.go:393](internal/webaccess/webaccess.go#L393)
**Category:** security (minor, DoS-adjacent). Unlike finding 1 this needs no credential: any TCP peer can send garbage and produce Warn lines at line rate. Deliberate and documented, tests rely on it; volume case unbounded; the loopback default makes it near-moot.
**Fix:** a) Route the stdlib logger at Debug, keep an explicit server-side Warn only for serve-loop termination. b) Sample handshake errors. c) Accept and document at the non-loopback warning site.

### 13. CONSIDER — No server-side bound on concurrent connections or slow-body reads; only header-read is timed

**File:** [internal/webaccess/webaccess.go:109-110](internal/webaccess/webaccess.go#L109-L110), [374-447](internal/webaccess/webaccess.go#L374-L447)
**Category:** performance/security (resource exhaustion). `ReadHeaderTimeout` + `IdleTimeout` set, but no `ReadTimeout`/`WriteTimeout` and no connection cap: a client can trickle a body indefinitely, pinning goroutines (~8 KB each); hijacked WS conns have no idle reap (documented stage-2 gap). Materializes only on a deliberately chosen non-loopback bind; omitting `ReadTimeout` is defensible to protect the 48 MiB upload path.
**Fix:** a) Generous `ReadTimeout` (10-15 min) or a per-request `SetReadDeadline` after headers sized from the upload cap. b) Counting-semaphore connection cap in `recoverWrap`. c) Accept for stage 1, recorded beside the stage-2 keepalive note.

### 14. CONSIDER — Exposure warnings build messages with `fmt.Sprintf` inside `log.Warn` instead of structured attrs

**File:** [internal/webaccess/webaccess.go:262-264](internal/webaccess/webaccess.go#L262-L264)
**Category:** structure (convention). Every other diagnostic in the package uses slog structured attributes.
**Fix:** a) Convert to `log.Warn("...", "bind", ..., "transport", ...)` and tweak the two substring assertions. b) Leave as-is (stylistic).

### 15. CONSIDER — `ValidateWebAccessToken` doc claims "after trimming" but neither the function nor its test trims

**File:** [backend/config/web_access.go:289-296](backend/config/web_access.go#L289-296) (test pins the opposite at [web_access_test.go:588-591](backend/config/web_access_test.go#L588-L591))
**Category:** doc/implementation mismatch (security-adjacent input rule). A future caller trusting the doc may accept a whitespace-padded below-floor token as meeting the guessability floor. Bounded: interactive input of the operator's own credential.
**Fix:** a) Fix the doc to "raw length, no trimming (callers trim before calling)". b) Or actually trim and update the test (verify the desktop caller doesn't double-trim against the stored value).

### 16. CONSIDER — New `defaults.go` comment calls the web_access token "ephemeral per-launch", contradicting the mint-once-and-persist semantics

**File:** [backend/config/defaults.go:737](backend/config/defaults.go#L737)
**Category:** doc drift (introduced by this diff). `web_access.go`'s field doc and `config.example.yaml` specify empty = minted at first start, persisted, stable across restarts. The wrong comment invites a regression to per-launch credentials (breaking browser logins across restarts).
**Fix:** a) Reword to "(minted once at the first start, then persisted)".

### 17. CONSIDER — Behavior change: `goal_loop.suggest.min_complexity` default silently moves 2 → 3

**Files:** [backend/config/defaults.go:471-478](backend/config/defaults.go#L471-L478), [backend/config/config.go:2501](backend/config/config.go#L2501), `config.example.yaml`
**Category:** behavior change (confirmation flag). Coherent and deliberate (code comment, example file, spec, tests updated in lockstep); users relying on the default observably stop getting goal proposals for complexity-2 messages with no config diff to explain it.
**Fix:** a) Call it out in CHANGELOG/release notes (and the goal-mode spec if numeric there). b) Optionally key the floor off an absence sentinel (likely over-engineering).

### 22. CONSIDER — `UpdateExperimentalFeatures` holds `configMu` across the synchronous desktop sidecar transition

**File:** [backend/frontend_api_config.go:759-801](backend/frontend_api_config.go#L759-L801) with the hook at [desktop/app.go:1167-1203](desktop/app.go#L1167-L1203)
**Category:** performance / lock hygiene (documented trade-off). Verified no deadlock (one-directional `configMu → webAccessMu` order), but toggling the gate OFF while the sidecar's graceful stop is slow convoys every `configMu` contender (settings setters, `embeddedConfig()` readers on the LLM request path) for up to the stop budget.
**Fix:** a) Accept as a recorded decision (bounded budget + documented rationale). b) Split into sync gate-flip + async mount/stop with completion via state event (contract change; needs the ADR wording updated).

### 24. CONSIDER — The bind's unfinished-task / active-task refusal gates have no pinned tests

**File:** [backend/frontend_api_worktrees.go:319-332](backend/frontend_api_worktrees.go#L319-L332) vs [backend/frontend_api_worktrees_bind_test.go](backend/frontend_api_worktrees_bind_test.go)
**Category:** test coverage. The store's atomic fresh-window guard is the authoritative race-closer and is tested; these two pre-checks are defense-in-depth without a regression pin — a refactor could silently drop them.
**Fix:** a) Add a bind test seeding an unfinished task row asserting `errors.Is(err, session.ErrSessionNotFresh)` and `noManagedTrees`. b) At minimum pin the `HasUnfinishedTask` gate and reference the store guard for the status gate.

### 26. CONSIDER — A failed history (re)load appends the "Failed to load session history" card even when the transcript is already populated

**File:** [frontend/src/components/chat/ChatArea.tsx:98-120](frontend/src/components/chat/ChatArea.tsx#L98-L120) and [frontend/src/lib/sessionHistoryReload.ts:86-104](frontend/src/lib/sessionHistoryReload.ts#L86-L104)
**Category:** behavior change / minor UX bug. New for the resync path: a focus/visibility/WS-reconnect re-run failing appends a false "history failed" card beneath a fully rendered transcript (web transport, brief desktop unreachability). Self-healing on the next successful load.
**Fix:** a) Append the card only when the session's transcript is empty; log otherwise. b) Render `historyLoadFailed` as a non-transcript banner. c) Reap stale failure cards at the start of every load.

### 28. CONSIDER — WebAccessSettings.tsx is 463 lines, well over the ≤200-line component target

**File:** [frontend/src/components/settings/WebAccessSettings.tsx](frontend/src/components/settings/WebAccessSettings.tsx)
**Category:** structure. The TLS block was extracted explicitly to keep the parent under target, yet the parent still carries the address block, token block, and three warning banners.
**Fix:** a) Extract the token block into `WebAccessTokenSettings.tsx`. b) Extract the warning banners into a small component. c) Record the deviation in a comment if deferred.

### 30. CONSIDER — SessionSelector.tsx (339 lines) renders the Archived section twice; over the 200-line target

**File:** [frontend/src/components/layout/SessionSelector.tsx:250-321](frontend/src/components/layout/SessionSelector.tsx#L250-L321)
**Category:** structure. The flat-mode archived branch duplicates the grouped archived JSX tree; the two can drift and `archivedCount` must stay in lockstep by convention.
**Fix:** a) Extract an `ArchivedSection` component rendering both modes. b) Derive flat archived rows from the same grouping model.

### 32. CONSIDER — `hitl_resolved` decision strings: unknown values silently render as "denied" (tool_confirm) or are cast unchecked (step_limit)

**File:** [frontend/src/hooks/events/hitlHandlers.ts:255](frontend/src/hooks/events/hitlHandlers.ts#L255), [290-301](frontend/src/hooks/events/hitlHandlers.ts#L290-L301); guard at [frontend/src/types/events.ts:1124-1131](frontend/src/types/events.ts#L1124-L1131)
**Category:** type safety at boundary / defensive hardening. `decision` is validated only as *some* string; any non-empty unrecognized wire value becomes a visible "denied" card. Today's vocabulary matches, so nothing misbehaves — flagged as the asymmetry, not a live bug.
**Fix:** a) Extend the guard (or handler) with per-kind decision sets; unrecognized non-empty decisions settle neutrally. b) Centralize the wire→UI mapping in one exported pure helper with a unit test.

### 33. CONSIDER — `useSessionLoader`: a failed `sessions:changed` re-read still poisons the in-flight initial fetch's result

**File:** [frontend/src/hooks/useSessionLoader.ts:157-165](frontend/src/hooks/useSessionLoader.ts#L157-L165)
**Category:** race / error-path interaction. `fetchSeq` is bumped when a re-read is *issued*; if it fails, the succeeded initial fetch is dropped (`initialFetchId !== fetchSeq`) and `listApplied` is false — the activation ends with no list and no restore. Narrow and self-healing.
**Fix:** a) Mark ownership only on success (roll the token back in the re-read's `.catch`, or compare against `lastSuccessfulFetchId`). b) Track the superseding fetch's outcome in the drop branch.

### 34. CONSIDER — sessionHistoryReload module header contradicts the implemented (and test-pinned) failure contract

**File:** [frontend/src/lib/sessionHistoryReload.ts:12](frontend/src/lib/sessionHistoryReload.ts#L12) (implementation at [85-97](frontend/src/lib/sessionHistoryReload.ts#L85-L97), pinned by [sessionHistoryReload.test.ts:143-145](frontend/src/lib/sessionHistoryReload.test.ts#L143-L145))
**Category:** documentation correctness. The header claims the history-RPC rejection propagates to the caller; the implementation swallows it, injects the error card itself, and resolves. A maintainer coding against the header will double-handle the failure (duplicate error card, or a rejection-path test that can never fire).
**Fix:** a) Correct the header to the actual contract (loader renders the failure card and resolves; only post-merge steps can reject, and their wrappers resolve null in practice).

### 35. CONSIDER — wailsAccessInvariant guard does not catch destructuring window access

**File:** [frontend/src/test/wailsAccessInvariant.test.ts:90-92](frontend/src/test/wailsAccessInvariant.test.ts#L90-L92)
**Category:** structure (guard coverage). `const { runtime } = window` compiles, touches the raw Wails surface outside the shim, and passes the scan — silently breaking the web transport, the exact failure class the invariant prevents.
**Fix:** a) Add a destructuring pattern to `VIOLATION_PATTERNS`. b) Document the gap (dot + bracket-string only) in the file header.

### 36. CONSIDER — `getWebAccessInfo` logs the raw payload (including the access token) to the console on a shape mismatch

**File:** [frontend/src/api/webAccess.ts:117](frontend/src/api/webAccess.ts#L117)
**Category:** security / logging hygiene. `logger.error('...unexpected response shape', raw)` serializes the whole payload — whose `token` field is the sidecar login credential — into the console whenever the parser rejects (e.g. future DTO drift). Bounded: console is local and unpersisted, and the same user can read the token in Settings.
**Fix:** a) Log a redacted summary (keys + `typeof`). b) Drop the payload entirely from the log call.

### 37. CONSIDER — `webAccessLogin` / `webRpc` fetches carry no timeout

**File:** [frontend/src/api/webAccess.ts:352-357](frontend/src/api/webAccess.ts#L352-L357); [frontend/src/api/runtime.ts:301-312](frontend/src/api/runtime.ts#L301-L312)
**Category:** robustness. A sidecar that accepts TCP but stalls leaves the login gate (first screen a fresh tab shows) or the RPC pending until the browser stack's own long timeout. Desktop-transport Wails RPCs are equally unbounded — behavior parity rather than a regression.
**Fix:** a) `signal: AbortSignal.timeout(15_000)` in both fetches, mapping `TimeoutError` to the existing operator-actionable errors. b) At minimum timeout `webAccessLogin` only.

### 38. CONSIDER — Behavior change (raised for confirmation): flat display mode's Archived section loses the bulk group actions

**File:** [frontend/src/components/layout/SessionSelector.tsx](frontend/src/components/layout/SessionSelector.tsx) (flat-mode branch)
**Category:** behavior change. Bulk Pin group / Unarchive all / Delete all of archived branch sessions is now grouped-mode-only; per-session unarchive/delete remains. Tests assert the absence, so it appears deliberate — but it is a real UX capability change worth a second look (and a CHANGELOG line if intended).
**Fix:** a) Confirm intended and note it in release notes. b) Or surface the group actions in flat mode too (single ArchivedSection per finding 30).

---

## Pass 2 — independent full re-review (iteration 2)

Method: 13 blind area subagents (same 6 Go + 6 frontend area split as pass 1, plus specs/docs; the `fe_stores_lib` result was lost from the batch and re-run) re-reviewed the entire diff **without access to this report**. The conductor deduplicated their output against the findings above and independently re-verified every candidate-new SHOULD FIX against the code before inclusion (all six below verified; **zero new MUST FIX**). Pass-2 flags that re-matched existing findings (deduplicated, no change): Warn-vs-Debug inbound logging → #1; enable-toggle failed re-read → #5; downloads sweep → #4; CreateProjectDialog dead end → #7; byName attachment staging → #8; token in shape-violation log → #36; missing-space run-on → #27 (re-rated to SHOULD FIX, see above).

### 40. SHOULD FIX — Three accepted ADRs share the number 090

**Files:** [specs/decisions/090-browser-web-access.md](specs/decisions/090-browser-web-access.md), [specs/decisions/090-embedded-llm-mlx-mtplx.md](specs/decisions/090-embedded-llm-mlx-mtplx.md), [specs/decisions/090-openvino-device-resolution.md](specs/decisions/090-openvino-device-resolution.md) (all new in this diff)
**Category:** docs/structure (spec corpus integrity; META.md's `NNN-slug.md` convention implies unique numbers, and 001–089 are unique).
Bare textual references are now ambiguous across the corpus: SECURITY.md uses "ADR-090" for two different decisions (the web-server attack-surface bullet means the browser ADR; the embedded-LLM bullet means the mtplx ADR), AGENTS.md's bare "ADR-090" mentions mean mtplx, while `specs/domains/web-access.md` and ADR-092's "ADR-090 decision 3/4/12/13" mean the browser ADR, and `specs/domains/workspace.md`'s "ADR-090" means the OpenVINO ADR. An implementer following "ADR-090 decision 4" lands on the wrong document.
**Suggested fix:**
a) Renumber two of the three (e.g. 093/094) and update inbound links/text.
b) Minimum: make every prose mention carry the disambiguating slug alongside the number (all links already do — prose mentions don't).

### 41. SHOULD FIX — ADR-090 (browser) decision 6 contradicts the shipped implementation and was left unamended

**File:** [specs/decisions/090-browser-web-access.md:30](specs/decisions/090-browser-web-access.md#L30) (Status at line 5)
**Category:** docs/spec-vs-code contradiction.
D6 states "WebSocket transport is `gorilla/websocket v1.5.3` … adopting it promotes an existing pinned version", but the implementation is a hand-rolled stdlib RFC6455 codec ([internal/webaccess/ws.go:4-5](internal/webaccess/ws.go#L4-L5): "no websocket library"; `go.mod:70` still marks gorilla `// indirect`; the package hygiene test bans non-stdlib imports). The domain spec carries only a parenthetical correction, and the ADR's Status — edited by this branch for the consolidation — was not extended, unlike the amendment pattern used in ADR-092/080/082. An implementer reading the accepted ADR would adopt gorilla/websocket and break the dependency contract the spec and its hygiene test enforce.
**Suggested fix:**
a) Append a Status amendment ("D6 superseded: hand-rolled stdlib RFC6455 codec; the library never left indirect").
b) Annotate D6 in place as amended with the narrowing.

### 42. SHOULD FIX — AGENTS.md still pins Go 1.27.0 while this branch bumps go.mod and CI to 1.27.3

**File:** [AGENTS.md:33](AGENTS.md#L33) vs [go.mod:3](go.mod#L3)
**Category:** docs drift (violates the doc's own lockstep rule).
The branch's toolchain bump touched `go.mod` (`go 1.27.3`) and every `go-version`/`GO_VERSION` pin in the workflows, but not the Project-shape sentence that mandates lockstep ("CI builds with exactly this toolchain … bump both together whenever Go ships a security patch"). A contributor following AGENTS.md's stated version is two security patches behind and trips the `make vulncheck` gate the same sentence describes.
**Suggested fix:**
a) Update the line to 1.27.3.
b) Drop the patch version from the prose ("current Go toolchain, see go.mod") so the line cannot drift again.

### 43. SHOULD FIX — The event catalog's new `sessions:changed` row names a producer this same branch deleted

**File:** [specs/contracts/event-catalog.md:21](specs/contracts/event-catalog.md#L21)
**Category:** docs/spec-vs-code contradiction.
The row's emitter enumeration reads "…create, fork (plain + managed), **managed-draft commit**, delete, archive, pin…", but the draft-commit path (`CreateManagedSession` / `lib/sessionDraft.createSessionFromDraft`) was removed by ADR-091 — no such call site exists (verified: the only `frontend_api_worktrees.go` emit is the managed fork). The row is new in this branch and its list is presented as exhaustive; a reader tracing the event greps for a path that no longer exists, while the actual new producer (the send-time workspace bind, covered transitively by the task-lifecycle mirror) is unnamed.
**Suggested fix:**
a) Drop "managed-draft commit" from the enumeration.
b) Replace it with "send-time workspace bind (via the task-lifecycle mirror)".

### 44. SHOULD FIX — A failed pending-actions poll clears a genuinely-blocked session's radar indicator, and it may not heal for a long time

**File:** [frontend/src/stores/activeSessionsStore.ts:239-241](frontend/src/stores/activeSessionsStore.ts#L239-L241) (via [frontend/src/api/chat.ts:466-469](frontend/src/api/chat.ts#L466-L469) and [activeSessionsStore.ts:162-163](frontend/src/stores/activeSessionsStore.ts#L162-L163))
**Category:** bug (introduced by the override re-poll in this diff).
The reworked `sweepPendingActions` correctly makes override-only `pending` rows poll targets — but on ANY RPC failure `getPendingActions` resolves `null`, the sweep feeds it straight into `applyPendingActions(id, null)` → `setPendingOverride(id, hasPendingActions(null) === false)` → the true bit is deleted. Before this change a pending row was never a poll target, so a failed poll could never clear a pending row's bit; now it can.
**Why it is a problem:** a background session blocked on a HITL prompt flips yellow→green while the prompt is still pending; sweeps run only on first snapshot load per mount and on dropdown open, so the attention signal can stay gone until the next dropdown open or app reload — precisely the signal the radar exists to give. The accompanying test mocks `mockResolvedValue(null)` under a name claiming the empty-answer path — it pins the FAILURE shape, and the genuine all-empty heal case (a real empty `PendingActionsResponse`) is untested.
**Suggested fix:**
a) In the sweep, apply only definitive answers: `const resp = await getPendingActions(row.session.id); if (resp !== null) store.applyPendingActions(row.session.id, resp)`.
b) Give the store ignore-null `applyPendingActions` semantics and update the doc comment; re-point the test at a real empty response and add an explicit failure-preserves-bit case.

### 45. CONSIDER — `AttachFileContent`'s 32 MiB cap diverges from the desktop path for large documents; the doc comment overstates parity

**File:** [backend/frontend_api_attachment.go:14](backend/frontend_api_attachment.go#L14)
**Category:** docs/behavior (fail-closed, transport-motivated). Only images are size-capped in the session pipeline; a 50 MiB PDF attaches on desktop but hard-fails on the web path while the comment claims identical behavior.
**Fix:** a) Reword the comment to state the cap is transport-motivated. b) Size the cap from the web body limit and let oversize surface as the pipeline's per-file failure.

### 46. CONSIDER — Draft re-seed effects can silently discard a typed-but-uncommitted draft when a sibling control re-reads `info`

**File:** [frontend/src/components/settings/WebAccessSettings.tsx:110-122](frontend/src/components/settings/WebAccessSettings.tsx#L110-L122), [WebAccessTLSSettings.tsx:49-52](frontend/src/components/settings/WebAccessTLSSettings.tsx#L49-L52)
**Category:** UX nuance. Type a new address, then flip the HTTPS toggle: the dep change re-seeds the address field from the persisted pin and the typed draft vanishes. The display always ends truthful; commit-on-blur semantics preserved.
**Fix:** a) Skip re-seeding while the field is focused or differs from the last seeded value. b) Accept and document (the seeds also canonicalize after this field's own commits — desirable).

### 48. CONSIDER — The new web attachment-staging path has no unit tests

**File:** [frontend/src/hooks/useStageAttachments.test.tsx](frontend/src/hooks/useStageAttachments.test.tsx) (also the `isWebTransport()` branches of `useFileDrop`/`useAttachmentsInput`)
**Category:** test coverage. Only the api-level `attachFileContent` is covered; the per-file loop (mid-loop failure, claim draining) is unpinned — the region where finding #8 sits.
**Fix:** a) Add a multi-file web-loop test including a mid-loop failure. b) Flip `isWebTransport` in a useFileDrop test and assert HTML5-drop staging.

**Pass 5 extension:** [frontend/src/lib/browserFilePicker.ts](frontend/src/lib/browserFilePicker.ts) — the only net-new lib file without a unit test — belongs to the same gap: its settle-once contract (first of `change`/`cancel` wins; second finish is a no-op) and the pick→`stageAttachmentFiles` glue are exercised by no test (the hook harnesses pin `isWebTransport: () => false`), so the documented no-cancel-engine input leak (#51) and the duplicate-basename path (#8) are both unpinned.

### 49. CONSIDER — Degraded `task_complete` card no longer reports how many steps failed

**File:** [frontend/src/hooks/events/useChatEvents.ts:286](frontend/src/hooks/events/useChatEvents.ts#L286)
**Category:** behavior change (raised for confirmation). The `failed_steps` interpolation and field were removed together — deliberate-looking, but a partially completed task loses a concrete transcript signal.
**Fix:** a) Confirm the backend no longer sends a reliable count and keep as is. b) Otherwise keep reporting the count when present.

### 50. CONSIDER — `useShallowResync` writes the session list outside `useSessionLoader`'s fetch ordering

**File:** [frontend/src/hooks/useShallowResync.ts:76](frontend/src/hooks/useShallowResync.ts#L76)
**Category:** race (transient, self-healing). The resync's own `listSessions()` bypasses the loader's `fetchSeq`, so an older response can overwrite a fresher post-mutation list until the next `sessions:changed`/focus trigger (≥5 s).
**Fix:** a) Share one fetch-generation token between loader and resync. b) Document the bounded staleness.

### 51. CONSIDER — `browserFilePicker` leaks its hidden `<input>` on engines that never deliver `cancel`

**File:** [frontend/src/lib/browserFilePicker.ts:36-43](frontend/src/lib/browserFilePicker.ts#L36-L43)
**Category:** resource hygiene (cosmetic/memory-level). `input.remove()` runs only from `change`/`cancel`; on engines without cancel support each dismissed picker leaves one dead hidden input on `<body>`.
**Fix:** a) Also finish via a one-shot guarded `window` `focus` listener after `input.click()`. b) Accept and document next to the existing cancel caveat.

### 52. SHOULD FIX — Two web-transport paths read `Notification.permission` directly, bypassing the module's own throw-safe reader (re-rated in pass 3)

**File:** [frontend/src/api/notifications.ts:132](frontend/src/api/notifications.ts#L132), [:58](frontend/src/api/notifications.ts#L58), [frontend/src/App.tsx:78](frontend/src/App.tsx#L78)
**Category:** robustness (re-rated CONSIDER → SHOULD FIX by pass 3). Firefox throws SecurityError from the getter on insecure origins (the reason `readNotificationPermission()` exists and is tested); the raw reads turn background notification sends into rejections plus per-event warns instead of the designed silent drop. Pass 3 additionally verified the boot path: `initSystemNotifications` (line 58) reads the raw getter inside the async function, and `App.tsx:78` discards it with `void initSystemNotifications()` under a comment claiming both inits "never throw" — on a non-loopback HTTP bind (an explicitly supported shape) with Firefox, every page load produces an unhandled promise rejection, violating the project's clean-run rule for expected diagnostics.
**Fix:** a) Use `readNotificationPermission()` in both paths (treat `null` as denied/skip) and correct the App.tsx comment. b) Minimal: safe reader at line 132 only, drop the getter from the line-58 log.

### 53. CONSIDER — `TestStopWebAccess_BoundedEvenWithExpiredDeadline` holds `webAccessMu` across a fatal assertion, deadlocking its own cleanup

**File:** [desktop/webaccess_test.go:354-367](desktop/webaccess_test.go#L354-L367)
**Category:** tests. `t.Fatal` inside the critical section skips the manual `Unlock`; the cleanup's `stopWebAccess` then blocks until the go-test timeout — noisy CI diagnostics exactly when the guarded regression occurs. Violates the project's "register idempotent release cleanup before any fatal assertion" convention.
**Fix:** a) `defer a.webAccessMu.Unlock()` immediately after the Lock. b) Wait on `done` before locking.

### 56. CONSIDER — WS control frames over 125 bytes are accepted and their payloads echoed as pongs

**File:** [internal/webaccess/ws.go:465](internal/webaccess/ws.go#L465) (echo at [:363](internal/webaccess/ws.go#L363), [:393](internal/webaccess/ws.go#L393))
**Category:** protocol conformance/hardening. RFC6455 §5.5 forbids control frames >125 B (and fragmenting them, which the lenient path also tolerates). Impact immaterial: bounded memory, authenticated peer, browsers ignore pong payloads.
**Fix:** a) Reject `length > 125` for control opcodes with `errWSProtocol`. b) Cap the echoed pong payload.

### 57. CONSIDER — `dispatch.go` claims a contract-test pin for `uploadBodyMethods` that no test provides

**File:** [internal/webaccess/dispatch.go:85-93](internal/webaccess/dispatch.go#L85-L93)
**Category:** doc/test mismatch. If `FrontendAPI.AttachFileContent` is renamed, the map key silently goes dead — web uploads over 1 MiB start failing 413 with the suite green.
**Fix:** a) Add a subtest asserting every key resolves to an exported method (`srv.Dispatchable(key)`). b) Soften the comment to "manual".

### 58. CONSIDER — Request bodies are read with no time bound (slow-POST on the unauthenticated login route)

**File:** [internal/webaccess/webaccess.go:386](internal/webaccess/webaccess.go#L386)
**Category:** resource exhaustion (server-side sibling of #37). `readAllLimited` caps bytes, not rate; a client can drip ≤1 MiB login bodies indefinitely, pinning a goroutine per connection on a non-loopback bind.
**Fix:** a) Arm a per-request read deadline before body reads (cleared after the WS hijack). b) Document beside the existing slowloris note.

### 62. CONSIDER — Web-transport message download always names the file `message.md`

**File:** [frontend/src/components/chat/CopyButton.tsx:88](frontend/src/components/chat/CopyButton.tsx#L88)
**Category:** UX. Repeated Shift+click saves collide on `message.md` (the browser suffixes (1), (2)…), so saved artifacts are indistinguishable on disk.
**Fix:** a) Derive the name from content (first heading/line, slugified). b) Embed a short timestamp.

### 63. CONSIDER — Boot-loader removal can precede React's first commit, briefly blanking `#root`

**File:** [frontend/src/main.tsx:113-115](frontend/src/main.tsx#L113-L115)
**Category:** startup cosmetics (narrow frame-timing window). The module-scope rAF is decoupled from React's commit; on a loaded machine it can remove the spinner before the splash commits — the opposite of the promised handoff.
**Fix:** a) Remove the node in a post-commit hook, keeping the rAF as a guarded fallback. b) Only remove when React has actually mounted (`childElementCount > 1`).

### 64. CONSIDER — The `SendMessage` contract row omits the `clientSendID` parameter

**File:** [specs/contracts/desktop-frontend.md:71](specs/contracts/desktop-frontend.md#L71)
**Category:** docs/wire arity. The rewritten row lists 12 parameters; the real signature and the regenerated binding carry 13 (`clientSendID` between `reviewMode` and `workspace`). The omission predates the branch, but the row was rewritten here.
**Fix:** a) Add `clientSendID` to the row. b) Note it as a binding artifact if deliberately not frontend-facing.

### 65. CONSIDER — Embedded-LLM gate wording in AGENTS.md/SECURITY.md is llama-shaped for both engines

**File:** [AGENTS.md](AGENTS.md) (Embedded LLM bullet), [SECURITY.md](SECURITY.md) (ASI04 bullet)
**Category:** docs precision. "A combined memory gate over BOTH pools" reads as the single description for both families, but mtplx's gate is ONE unified-pool comparison; the pack size is quoted "~8.9 GiB" where the ADR pins decimal "8.85 GB".
**Fix:** a) Scope the both-pools phrase to llama, one-line the mtplx gate. b) Normalize size citations to the pinned bytes.

## Pass 3 — independent full re-review (iteration 3)

Method: 13 blind area subagents (same area split as pass 2) re-reviewed the entire diff **without access to this report**. The conductor deduplicated against all findings above and independently re-verified every candidate-new MUST/SHOULD against the source before inclusion. Verdict: **1 candidate MUST (rejected after Go-stdlib verification — downgraded to #66), 6 new SHOULD FIX (#66–#71 + the #52 re-rate), 8 new CONSIDER (#72–#79)** — so the stop condition is still not met and a pass 4 is required.

Duplicates closed against existing findings (no change): CreateProjectDialog dead end → #7; inbound Warn payload dumps → #1; toggle re-read "Off" lie → #5; TLS commit-path deadlock → #6; `byName` duplicate basenames → #8; downloads sweep → #4; `ValidateWebAccessToken` trim doc → #15; token in shape-violation log → #36; `webRpc` no timeout → #37; ADR-090 triple collision → #40; gorilla/websocket D6 → #41; draft re-seed discard → #46; unchecked step_limit cast → #32.

Out of scope (rejected — the flagged files are **not modified by this diff**; pre-existing on `main`, recorded for a separate follow-up): `ProbeEmbeddedLLMDevices` resolves the llama runtime tree for any engine, failing misleadingly on mtplx installs ([backend/frontend_api_embedded_tuning.go:488](backend/frontend_api_embedded_tuning.go#L488), SHOULD-grade); engine-refusal wrapper misattributes unknown `engine` spellings to the machine ([backend/frontend_api_embedded.go:1235](backend/frontend_api_embedded.go#L1235)); `FitWarning` `omitempty` contradicts the DTO's no-omitempty invariant ([backend/frontend_api_embedded_dto.go:181](backend/frontend_api_embedded_dto.go#L181)); racing first `embeddedBuild` mute window can swallow the winner's state event ([backend/frontend_api_embedded.go:518](backend/frontend_api_embedded.go#L518)).

### 66. SHOULD FIX — The TLS server's WebSocket compatibility rides a Go-internal default that Go itself calls temporary: nothing pins h1 or asserts ALPN (pass 3 rated MUST; downgraded after verification)

**File:** [internal/webaccess/webaccess.go:384](internal/webaccess/webaccess.go#L384), [:407](internal/webaccess/webaccess.go#L407) (handshake contract at [internal/webaccess/ws.go:100-119](internal/webaccess/ws.go#L100-L119))
**Category:** hardening/fragility on the remote attack surface.
The pass-3 delegate rated this MUST FIX with the claim that Go's h2 server advertises `SETTINGS_ENABLE_CONNECT_PROTOCOL`, making browsers send `wss://` as an RFC 8441 extended CONNECT (no `Upgrade`/`Sec-WebSocket-Key`, no `Hijacker`) and killing `/ws` under TLS for every mainstream browser. **Conductor verification against the go1.27.3 sources rejects the premise**: `net/http/internal/http2/http2.go:38-61` sets `disableExtendedConnectProtocol = true` by default — the advertisement at `server.go:776-778` is sent only when `GODEBUG=http2xconnect=1` is set, and `server.go:2128` rejects `:protocol` requests at the frame level. The Go comment cites exactly this breakage class ("browsers … attempt to use WebSockets-over-HTTP/2 … problems when the server's websocket package doesn't support extended CONNECT", issue #71128) as the reason. This repo sets no such GODEBUG (only `http2client=0` in CI), so `wss://` negotiates http/1.1 and works today.
**Why it is still a problem:** the server's correctness depends on that explicitly temporary default. The comment says "Disable extended CONNECT by default **for now**" — when a future Go flips it, every browser's `/ws` (the event stream and all seven inbound HITL responses) dies silently under TLS, and no test would notice (tests speak h1; nothing asserts the negotiated ALPN or the absence of the setting).
**Suggested fix:**
a) Pin the server to h1-only (`Server.TLSNextProto` set to a non-nil empty map, or `Protocols` with HTTP2 off) next to the existing timeout config, and add a regression test asserting the TLS listener never offers/advertises h2 extended CONNECT.
b) Minimum: a comment at the `ServeTLS` call documenting the dependency plus a test asserting the served settings omit `ENABLE_CONNECT_PROTOCOL` so a Go upgrade that flips the default fails CI instead of production.

### 67. SHOULD FIX — `POST /api/rpc` authenticates by cookie only; the same-origin gate that `/ws` enforces against exactly this threat is missing

**File:** [internal/webaccess/webaccess.go:316](internal/webaccess/webaccess.go#L316) (the gate exists at [internal/webaccess/ws.go:96](internal/webaccess/ws.go#L96), [:198-206](internal/webaccess/ws.go#L198-L206))
**Category:** security (authz hardening, CSRF-adjacent; verified against the route table).
`requireAuth` checks only the `SameSite=Strict` cookie. SameSite separates *sites*, not *origins*: a page served from any other port on the same host string (e.g. `http://127.0.0.1:3000` while the sidecar is on its port) can fire a preflight-free `Content-Type: text/plain` no-cors `POST /api/rpc/<method>` with `credentials: 'include'`; the cookie rides along and `handleRPC` parses the body regardless of content type — every RPC (control RPCs are already server-side isolated) executes fire-and-forget. `/ws` enforces exact `Origin` equality against precisely this class; the state-changing route (and `/api/login`) does not.
**Why it is a problem:** the report's own web-access threat model treats same-site cross-origin as adversarial for `/ws`; the inconsistency leaves a same-power bypass on the RPC route reachable from any co-located page.
**Suggested fix:**
a) Reject requests whose `Origin` is present and not exactly `scheme://r.Host` on `/api/rpc` (and `/api/login`), reusing `sameOrigin`.
b) Additionally/alternatively require `Content-Type: application/json` on RPC (no-cors requests cannot send it).

### 69. SHOULD FIX — A stale initial `useSessionLoader` fetch can silently drop the saved-session restore

**File:** [frontend/src/hooks/useSessionLoader.ts:157-166](frontend/src/hooks/useSessionLoader.ts#L157-L166) (the re-read's contract at [:104](frontend/src/hooks/useSessionLoader.ts#L104))
**Category:** bug (race window in the multi-surface scenario this branch targets).
When a foreign `sessions:changed` re-read (250 ms debounce) is issued while the initial load is in flight and the initial `.then` resolves first, the stale branch sees `listApplied === false` and returns without restoring; the re-read applies its list by design **never** calling `restoreIfIdle` (its own comment: "restoreIfIdle is NEVER called: a foreign mutation must not …"). The activation then ends with `savedSessionId` resolved but never consumed — no session auto-selected. Trigger: another surface forks/deletes a session during a project switch whose initial `listSessions` is slower than the debounce plus the second RPC (web + desktop on one workspace, the branch's headline scenario).
**Suggested fix:**
a) Carry a pending-restore flag consumed by whichever application wins (the re-read's apply calls `restoreIfIdle` once when the flag is set).
b) In the stale branch, restore against the dropped same-project list before discarding it (guard remains idle-only).

### 70. SHOULD FIX — Repeated history-load failures stack duplicate error cards (one per focus/visibility/reconnect trigger)

**File:** [frontend/src/lib/sessionHistoryReload.ts:85-100](frontend/src/lib/sessionHistoryReload.ts#L85-L100)
**Category:** bug (UX degradation with a reproducible unbounded growth path).
Every failed `getSessionHistory` unconditionally `addMessage()`s an error card keyed by a fresh `generateMessageId()`; the new App-root shallow resync re-runs the loader on focus/visibility/WS-reconnect triggers — so with the history RPC down, each trigger (≥5 s apart) appends another identical "Failed to load session history" card. A later success reaps stale cards, but while the failure persists they accumulate without bound. Distinct from #26 (one card vs an already-populated transcript) and #34 (module-header contract wording): this is the repeated-failure accumulation path.
**Suggested fix:**
a) Upsert with a deterministic per-session semantic id (the HITL-card pattern, e.g. `history-load-failed:<sessionId>`).
b) Skip the add when a `historyLoadFailed` card for the session already exists.

### 71. SHOULD FIX — `connectWS` has no liveness probe: a half-open socket leaves the web tab silently deaf

**File:** [frontend/src/api/runtime.ts:427-437](frontend/src/api/runtime.ts#L427-L437) (server side defers keepalive: [internal/webaccess/ws.go:15-17](internal/webaccess/ws.go#L15-L17), "no keepalive timer yet (stage 2)")
**Category:** bug (transport reliability on the web transport's lifeline).
Neither side keeps the events socket alive. After laptop sleep or NAT rebinding the TCP socket can stay half-open: no `onclose` fires, so no reconnect, no `onWSReconnected` resync, and every `webEmit` is dropped warn-once until the user manually reloads. The reconnected-resync machinery already exists — only the dead-socket detection is missing.
**Suggested fix:**
a) Client-side staleness watchdog: track last inbound frame; after N idle minutes force `close()` + reconnect (the existing retry/backoff path then resyncs).
b) Implement the stage-2 server ping interval and have the client treat missing pongs as dead (closes both failure modes at once).

### 72. CONSIDER — The `config.example.yaml` exposure warning is a paraphrase, not the literal message an operator would grep for

**File:** [config.example.yaml:2128](config.example.yaml#L2128) vs [backend/config/web_access.go:315](backend/config/web_access.go#L315)
**Category:** docs precision. The comment quotes "not loopback — network-accessible, traffic unencrypted"; the actual load warning reads "bind %q is not loopback — the listener is network-accessible, traffic is plain HTTP without TLS".
**Fix:** a) Quote the literal message. b) Drop the quotation marks.

### 73. CONSIDER — `sanitizeAttachmentName` lets Windows reserved device names through to `os.WriteFile`

**File:** [backend/frontend_api_attachment.go:41](backend/frontend_api_attachment.go#L41)
**Category:** robustness (Windows-only). A browser-supplied `nul.png` survives the separator/dot strip; on Windows the write targets a device (bytes discarded or error) and the attachment stages from a bogus path. Trigger: web-surface upload with a reserved basename (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
**Fix:** a) Reject reserved basenames after the separator strip. b) Underscore-escape them (`nul_.png`).

### 76. CONSIDER — A failed initial session load renders an endless skeleton with no error surface

**File:** [frontend/src/components/layout/SessionList.tsx:155](frontend/src/components/layout/SessionList.tsx#L155), same pattern [SessionSelector.tsx:211](frontend/src/components/layout/SessionSelector.tsx#L211)
**Category:** UX regression window. The null-sentinel render replaced the old (wrong but terminal) "No sessions yet" text with a pulsing skeleton; a transient cold-start RPC failure now shows an unbounded fake-loading state in both components (only `sessions:changed` or a project switch re-reads).
**Fix:** a) Track a load-failed state and fall back to an error/empty state. b) Bound the skeleton with a retry.

### 77. CONSIDER — `hitl_resolved` converge path clears the activity label even when converging to `confirmed`

**File:** [frontend/src/hooks/events/hitlHandlers.ts:267](frontend/src/hooks/events/hitlHandlers.ts#L267)
**Category:** minor state inconsistency. The fresh-resolution path sets "Running tool: X…" for confirmed; the already-resolved converge branch unconditionally nulls the activity status, so a surface that converges onto `confirmed` loses the label until the next tool event.
**Fix:** a) Mirror the fresh path: set the label when `decision === 'confirmed' && tool`.

### 78. CONSIDER — `ErrorData.session_id` is typed required but its guard tolerates absence

**File:** [frontend/src/types/events.ts:35](frontend/src/types/events.ts#L35)
**Category:** type-safety nit. `isErrorData` accepts payloads without `session_id` (documented Wails-serialization tolerance) while the interface declares it non-optional — a future consumer gets `undefined` typed as `string`. `TaskCompleteData` keeps it optional; the two terminal-event contracts disagree (no current consumer reads it).
**Fix:** a) Declare `session_id?: string`. b) Enforce presence in the guard.

### 79. CONSIDER — The desktop event tap is invoked without panic isolation

**File:** [desktop/app.go:735](desktop/app.go#L735)
**Category:** robustness. The tap contract ("must never block, alter, or fail the emit") is enforced only by convention in the out-of-scope webaccess implementation; a panicking tap propagates into whichever goroutine called `emit` (session producers, Wails dispatch) and kills the dispatch — e.g. a tap bug during sidecar hot-restart teardown while a `hitl_resolved` broadcast fires.
**Fix:** a) Wrap the call in a `recover()` that logs and continues. b) State the recover requirement explicitly in the `setEventTap` contract with a webaccess-side test.

## Pass 4 — independent full re-review (iteration 4, current 188-file diff)

> Method: 13 blind, independent area subagents over the full current `git diff main...HEAD` (188 files; see the annex note for the mid-review merge that shrank the diff from the originally reviewed 305), each reading full files plus binding policy (`SECURITY.md`, `AGENTS.md`, `specs/`), followed by conductor dedupe and line-by-line working-tree verification of every new SHOULD FIX. Pass 4 yielded **4 new SHOULD FIX** (#80–#83) and **21 new CONSIDER** (#84–#104): saturation not reached — pass 5 required.

### 80. SHOULD FIX — `SetWebAccessEnabled(true)` mounts the sidecar even though the master experimental gate is closed

**File:** [desktop/app.go:1099-1131](desktop/app.go#L1099-L1131) (`setWebAccessEnabledLocked` → `startWebAccessLocked`; neither checks `cfg.Experimental.Enabled`) vs [desktop/app.go:1170](desktop/app.go#L1170) (`applyExperimentalWebAccess`, which mounts only on the `enabled && cfg.WebAccess.Enabled` conjunction)
**Category:** gate bypass on a public binding. ADR-090 decision 13 defines availability as the conjunction "enforced externally to the section, at the only two points where the app decides to mount"; the toggle is a third mount decision that skips the conjunction. Settings hides the block while the gate is closed, but `SetWebAccessEnabled` is a public Wails binding — a programmatic caller, config-restore path, or webview-console invocation can mount a full-remote-control listener with the master switch off. Tests hardwire the gate open (`writeWebAccessConfig` sets `experimental.enabled: true`), so nothing pins the closed-gate behavior.
**Fix:** a) Start the sidecar in the toggle only when `cfg.Experimental.Enabled`, via one shared conjunction helper used by `initWebAccess`/`applyExperimentalWebAccess`/the toggle; add a closed-gate toggle test. b) Refuse enabling outright while the gate is closed with an error naming the master switch.

### 81. SHOULD FIX — Desktop toggle-on resets a real "denied" notification authorization to neutral

**File:** [frontend/src/components/settings/SystemNotificationSettings.tsx:146](frontend/src/components/settings/SystemNotificationSettings.tsx#L146) with [frontend/src/api/notifications.ts:201-203](frontend/src/api/notifications.ts#L201-L203)
**Category:** logic error introduced by the diff (the toggle path never touched permission state before). On the desktop transport `ensureNotificationPermission()` is a no-op that resolves `'granted'`, so the unconditional `setPermission(outcome === 'denied' ? 'denied' : 'neutral')` wipes the `'denied'` state the mount probe set from the real OS read (line 120).
**Why it is a problem:** on macOS with notifications denied in System Settings, the muted hint shows; toggling the master switch off→on hides the hint and reveals the Test button although the OS authorization is still denied — a misleading dead-end UI.
**Fix:** a) Derive permission from the outcome only on the web transport (`if (isWebTransport()) setPermission(...)`). b) Make `ensureNotificationPermission` return the real desktop authorization instead of a constant.

### 82. SHOULD FIX — "An https:// scheme typed there is refused" is stale: the parser accepts and strips it

**File:** [config.example.yaml:2163](config.example.yaml#L2163) and [specs/decisions/092-web-access-tls.md](specs/decisions/092-web-access-tls.md) (decision 1) vs [frontend/src/api/webAccess.ts:255-270](frontend/src/api/webAccess.ts#L255-L270) (`parseWebAccessAddress` accepts and strips both schemes; test-pinned)
**Category:** doc/implementation contradiction sitting on the feature's own security switch. An operator who types `https://host:port` (as the example invites) gets silent stripping; with `tls.enabled: false` the sidecar serves plain HTTP while the operator can reasonably believe HTTPS is active.
**Fix:** a) Reword the example parenthetical: the scheme is display-only, both schemes accepted and stripped, anything else refused — the transport is `tls.enabled` alone. b) Amend ADR-092 decision 1 in the same sweep (it is the source of the stale refusal claim).

### 83. SHOULD FIX — The event catalog states the inbound whitelist's direction backwards

**File:** [specs/contracts/event-catalog.md:16](specs/contracts/event-catalog.md#L16) (`runtime_error` row, new sentence)
**Category:** materially wrong spec text, self-contradicting within one sentence: "the inbound whitelist is backend→frontend-only and would drop the name". The inbound bridge resolves exactly the seven frontend→backend HITL events; `runtime_error` is backend→frontend — which is precisely why it would be dropped, and why the row's `emitLocalEvent` claim is correct. The Web Transport section of the same doc states the direction correctly.
**Fix:** a) Change to "the inbound whitelist is frontend→backend-only (the seven HITL events) and would drop the name". b) Drop the parenthetical and keep only the local-dispatch statement.

### 84. CONSIDER — `config:updated` is announced for an experimental toggle that was rolled back

**File:** [backend/frontend_api_config.go:772-779](backend/frontend_api_config.go#L772-L779) with `persistConfig` at [:2448](backend/frontend_api_config.go#L2448)
**Category:** cosmetic event fidelity. `persistConfig` emits `config:updated` even when the disk write failed, but this caller rolls the in-memory flip back on that exact path and the emit rides a `go` statement that can deliver before or after the rollback; consumers refetch and briefly see the rolled-forward gate. No correctness divergence (`GetConfig` serves the rolled-back value).
**Fix:** a) Move the emit to successful callers (larger refactor). b) Note the false announcement in the `persistConfig` comment for the rollback path.

### 85. CONSIDER — `CreateSession` emits `sessions:changed` before the session row is persisted

**File:** [backend/frontend_api_session.go:79](backend/frontend_api_session.go#L79) (persist follows at 81-89)
**Category:** emission-order inconsistency; every other emission site persists first. If `SaveSession` is slow (pool contention) or fails (log-only), the debounced re-read at +250 ms misses the row and the new session is absent from sidebar/radar until the safety poll — in practice self-healing.
**Fix:** a) Move `emitSessionsChanged()` below the `SaveSession` block, matching `ForkSession`/`Delete`/`Archive`/`Pin`/promote. b) Overlay unsaved in-memory sessions in `ListSessions*` (heavier).

### 86. CONSIDER — The `sessions:changed` push set omits renames and live-interjection activity bumps

**File:** [backend/frontend_api_session.go:272](backend/frontend_api_session.go#L272) (`RenameSession` — no emission)
**Category:** push-contract coverage gap. The diff makes `sessions:changed` the mechanism that keeps every surface's list fresh, but the emitted set covers only create/fork/delete/archive/pin/promotion/project-delete; a rename changes list content and a live interjection bumps `last_active_at` without any task transition event, so remote surfaces show stale name/order until the safety poll. Possibly deliberate scope (the contract comment enumerates list-shape mutations).
**Fix:** a) Add `emitSessionsChanged()` to `RenameSession` (debounced consumers coalesce it). b) Document the exclusion in the `EventSessionsChanged` contract comment.

### 87. CONSIDER — The example's "empty while enabled" fail-soft claim misdescribes file-load behavior

**File:** [config.example.yaml:2130](config.example.yaml#L2130) vs [backend/config/web_access.go:83-84](backend/config/web_access.go#L83-L84) and [backend/config/defaults.go:733-741](backend/config/defaults.go#L733-L741)
**Category:** doc/behavior mismatch. `ApplyDefaults` seeds an empty bind with `127.0.0.1` before normalization, so `enabled: true` with no bind key loads ENABLED warning-free (the intentional shortcut, test-pinned); the fail-soft empty-bind reset exists only for in-memory mutation and the save gate. An operator deleting the bind line while enabled expects "warning + sidecar off" and instead gets a running listener with no warning (benign — loopback default).
**Fix:** a) Reword: unparseable binds fail soft at load; a missing bind key loads the loopback default; an empty bind is refused at save/runtime. b) Document the no-bind shortcut explicitly, matching the test commentary.

### 88. CONSIDER — `writeFileAtomic` never fsyncs the parent directory after the rename

**File:** [internal/webaccess/certgen.go:184-205](internal/webaccess/certgen.go#L184-L205)
**Category:** durability hardening of a security artifact. Staged files are fsync'd, but the directory entry is not synced after `os.Rename`, so a power loss can revert the rename or land the mixed state (new key + old cert). The mixed state is already handled fail-closed (mount refuses; regeneration documented) — no correctness hole.
**Fix:** a) After both renames, open the directory and `f.Sync()` once. b) Document the residual window next to the existing crash-between-renames paragraph.

### 89. CONSIDER — `webAccessCertCoversHost` ignores wildcard DNS SANs

**File:** [desktop/app.go:1517](desktop/app.go#L1517)
**Category:** fail-noisy misclassification (safe direction). DNS coverage is exact `EqualFold` only; a wildcard SAN (`*.example.com`) covering the bind's host is reported as `cert_status: "mismatch"` with "regenerate" guidance for a pair browsers would accept.
**Fix:** a) Implement the RFC 6125 wildcard suffix rule for DNS SANs. b) State the exact-match-only scope in `CertDetail` so the operator isn't told to regenerate a valid pair.

### 90. SHOULD FIX — Web-transport download revokes the blob URL synchronously after click (re-rated from CONSIDER in pass 5)

> Re-rated in pass 5: a fresh blind pass confirmed the WebKit mechanism is not merely cosmetic — same-tick revocation can cancel the in-flight download handoff entirely, so a Safari user clicks Save, the button flashes "Download started", and no file arrives: silent feature loss with positive feedback on a first-class web-transport client (the original pass-4 rating weighed only the "sometimes flaky" reading).

**File:** [frontend/src/components/chat/CopyButton.tsx:85-88](frontend/src/components/chat/CopyButton.tsx#L85-L88)
**Category:** browser-compat hardening. `anchor.click()` is immediately followed by `URL.revokeObjectURL(url)`; safe in Chromium/Firefox, but WebKit/Safari have historically raced same-tick revocation against the in-flight download (the reason FileSaver.js defers revocation). The web transport targets "a normal browser page", which includes Safari; the test stubs `click`, so it cannot catch this.
**Fix:** a) Defer: `setTimeout(() => URL.revokeObjectURL(url), 10_000)`. b) Revoke on the next `flashFeedback` timer expiry (2 s) instead of inline. c) Attach the anchor to the document before clicking (`appendChild`/`click`/`remove`) — covers the old-Gecko detached-anchor quirk alongside the revoke race.

### 91. CONSIDER — History-loading spinner's `aria-label` sits on a bare SVG with no role

**File:** [frontend/src/components/chat/ChatArea.tsx:181](frontend/src/components/chat/ChatArea.tsx#L181)
**Category:** accessibility. An `aria-label` on a generic `<svg>` without `role="img"` (or a `role="status"` wrapper) is not reliably exposed to assistive tech, and the placeholder→spinner→content transition is never announced.
**Fix:** a) Wrap in `<div role="status" aria-label="Loading session history">` and drop the label from the svg. b) Add `role="img"` to the `Loader2` element.

### 92. CONSIDER — History-loading spinner has no bound if the RPC hangs

**File:** [frontend/src/components/chat/ChatArea.tsx:107-108](frontend/src/components/chat/ChatArea.tsx#L107-L108) and [:177-183](frontend/src/components/chat/ChatArea.tsx#L177-L183)
**Category:** feedback honesty. `getSessionHistory` has no timeout; a permanently hung RPC renders an infinite spinner where main rendered the static placeholder. Recovery exists (window-focus resync re-runs the load, whose finally settles the marker), so it degrades rather than wedges — and the RPC would have hung on main too, just less visibly.
**Fix:** a) Bound the in-flight UI: after N seconds without settle, fall back to the placeholder icon (marker logic untouched). b) Accept and note the focus-resync recovery path in the branch comment.

### 93. CONSIDER — The full file is materialized before the 32 MiB upload cap applies

**File:** [frontend/src/hooks/useStageAttachments.ts:191](frontend/src/hooks/useStageAttachments.ts#L191); cap checked only in [frontend/src/api/attachments.ts:107](frontend/src/api/attachments.ts#L107)
**Category:** client-side resource use. `MAX_ATTACHMENT_UPLOAD_BYTES` runs after the hook has already read the whole file into a `Uint8Array`, so a multi-GB drop costs a gigabyte-scale tab allocation (possible OOM) before the clean "too large" rejection. Browser bounds on `File.arrayBuffer()` uncertain, hence CONSIDER.
**Fix:** a) Check `file.size > MAX_ATTACHMENT_UPLOAD_BYTES` in `stageAttachmentFiles` before `arrayBuffer()`. b) Let `attachFileContent` accept the `File` and size-check before reading bytes.

### 94. CONSIDER — Clipboard failure handlers fold the rejection's error detail away

**File:** [frontend/src/components/GitPanel/GitHistoryContextMenu.tsx:243-245](frontend/src/components/GitPanel/GitHistoryContextMenu.tsx#L243-L245); same pattern at :398-400, [FileViewerTabContextMenu.tsx:74-77](frontend/src/components/fileViewer/FileViewerTabContextMenu.tsx#L74-L77), :89-92, [FileTreeContextMenu.tsx:159-162](frontend/src/components/layout/FileTreeContextMenu.tsx#L159-L162), :173-176
**Category:** log fidelity regression. `.catch(() => false)` folds a rejection into the boolean verdict, so the new `logger.error('Failed to copy …')` no longer carries the cause; a native-path rejection (`rt.ClipboardSetText` via `getRuntime()`, which throws when the runtime is gone) propagates unlogged where the old code logged the error object.
**Fix:** a) Log the folded rejection: `.catch((err) => { logger.error('clipboard write rejected', err); return false })`. b) Centralize the six sites in one helper that logs `ok === false` plus the rejection.

### 95. CONSIDER — "Loading sessions…" can persist after a failed initial load with no error or retry affordance

**File:** [frontend/src/components/layout/SessionSelector.tsx:211-221](frontend/src/components/layout/SessionSelector.tsx#L211-L221) and [SessionList.tsx:155-164](frontend/src/components/layout/SessionList.tsx#L155-L164)
**Category:** misleading empty state. The initial fetch swallows failures into `null` (`listSessions().catch(() => null)`), leaving the sentinel set; the new UI shows an active-sounding "Loading sessions…" indefinitely unless a heal fires (push, `sessions:changed`, focus resync). Previous behavior was a silent empty body.
**Fix:** a) Trigger a `listSessions` retry in the dropdown's `onOpenChange` when `sessions === null`. b) Render a distinct "Couldn't load sessions" row when a load failure is tracked.

### 96. CONSIDER — Contradictory dedup comments in `useReviewActions`

**File:** [frontend/src/components/review/useReviewActions.ts:92-99](frontend/src/components/review/useReviewActions.ts#L92-L99) vs [:150-152](frontend/src/components/review/useReviewActions.ts#L150-L152)
**Category:** comment drift introduced by the same diff. The block comment says the echo is deduped by "tail user-message content + time window", while the `sendMessage` comment says the optimistic id dedups "by identity" — only the second is what now happens on this surface; content+window is the no-id fallback.
**Fix:** a) Reword the block comment to lead with identity dedup via `clientSendId`, naming content+window as the fallback. b) Reference `shouldAddReceivedUserMessage` instead of restating the mechanism.

### 97. CONSIDER — HITL responses are silently dropped during a WS outage after the card already closed optimistically

**File:** [frontend/src/api/runtime.ts:478-490](frontend/src/api/runtime.ts#L478-L490) (drop path) with [ToolConfirmation.tsx:94-101](frontend/src/components/chat/ToolConfirmation.tsx#L94-L101)
**Category:** documented-tradeoff sharp edge. On the web transport `emit()` drops UI→backend frames (warn-once) while the socket reconnects; `ToolConfirmation.handleResponse` marks the card resolved immediately, so a click landing in an outage window closes the card while the backend never learns — the task stays blocked until the next `GetPendingActions` reconcile. The no-queue tradeoff is documented and the window is sub-second after a typical restart; `tool_judge_request` degrades more gracefully (30 s timeout reports failure).
**Fix:** a) Short-TTL queue for the seven whitelisted names, flushed on reconnect (first-responder-wins idempotency makes late delivery safe). b) Fire a local `runtime_error`/feedback when a HITL-named frame is dropped so the card stays open for retry.

### 98. CONSIDER — `isPendingAskUser`'s comment claims a ≥1-option invariant the code does not enforce

**File:** [frontend/src/api/chat.ts:419-427](frontend/src/api/chat.ts#L419-L427)
**Category:** guard/comment mismatch. The comment says the guard requires "≥1 well-formed option" (relying on the Go producer rejecting zero-option questions), but `Array.isArray(q.options) && q.options.every(...)` passes an empty array vacuously — a backend regression would reach the UI as an unanswerable form instead of being dropped at the boundary.
**Fix:** a) Add `q.options.length > 0` to match the documented invariant. b) Correct the comment to state the guard only validates element shapes.

### 99. CONSIDER — SECURITY.md's web-server bullet omits the experimental master switch

**File:** [SECURITY.md](SECURITY.md) (new "Built-in web server" attack-surface bullet)
**Category:** understated gating in the operator's first-read security doc. The bullet says the Web Access toggle "makes the running app serve its own frontend", but the sidecar mounts only while `experimental.enabled && web_access.enabled` (ADR-090 decision 13; AGENTS.md and web-access.md, updated in this same diff, say so). Fail-safe direction, but incomplete.
**Fix:** a) Add "(and only while the experimental master switch is also on — ADR-090 decision 13)" after the toggle sentence. b) Cross-reference decision 13 explicitly if the bullet is deliberately scoped to "once it runs".

### 100. CONSIDER — Raw path used as link label in the Boundary Rule

**File:** [specs/contracts/desktop-frontend.md](specs/contracts/desktop-frontend.md) (Boundary Rule, new transport list)
**Category:** doc polish. `[../domains/web-access.md](../domains/web-access.md)` renders as a literal file path; the sibling link in the same sentence uses a proper label ("ADR-090").
**Fix:** a) Label it "[the web-access domain spec](../domains/web-access.md)". b) Match the surrounding docs' link-label style throughout the new transport section.

### 101. CONSIDER — "The five HITL responses" counts a request as a response

**File:** [specs/contracts/event-catalog.md](specs/contracts/event-catalog.md) (Web Transport section); [specs/decisions/090-browser-web-access.md](specs/decisions/090-browser-web-access.md) (decision 8, "seven frontend→backend HITL response events")
**Category:** imprecise noun. The seven whitelisted events include `tool_judge_request`, which is a request, not a response; only four are responses. The count (seven) and the actual set are correct everywhere — SECURITY.md and web-access.md already say "HITL events".
**Fix:** a) "the seven frontend→backend HITL events (four responses, the judge request, and the two goal decisions)". b) Or simply "the seven HITL events", matching SECURITY.md/web-access.md.

### 102. CONSIDER — The task-started test's quiesce loop has no overall deadline

**File:** [backend/session/manager_task_started_test.go:66-76](backend/session/manager_task_started_test.go#L66-L76)
**Category:** test robustness. The "no further lifecycle events" join loop exits only on a 200 ms quiet window with no cap on total duration — a stream firing more often than every 200 ms spins forever (hang, not clean failure), while a duplicate landing >200 ms after the last event slips past (false pass).
**Fix:** a) Bound the quiesce phase with an outer `time.After(2 * time.Second)` case that `t.Fatalf`s, keeping the 200 ms window as the success exit. b) Wait deterministically for the epilogue-tail event the comment names (`agent_metrics`), then assert no lifecycle event behind it.

### 103. CONSIDER — `markHistoryLoaded` can resurrect a just-deleted session's marker

**File:** [frontend/src/lib/sessionHistoryReload.ts:58-64](frontend/src/lib/sessionHistoryReload.ts#L58-L64)
**Category:** narrow cleanup race. `isCancelled()` detects only a session SWITCH, not deletion: a history load for session X in flight when X is deleted passes `dropSessions`' synchronous `historyLoaded` cleanup, and if the RPC settles after the sweep but before the effect cleanup/active-session check flips, the finally re-adds an orphan marker — defeating the cleanup's purpose (a recreated session with a reused id would read "already loaded" and skip its history load).
**Fix:** a) In the finally, mark only if the session still exists in the session catalog. b) Make `markHistoryLoaded` a no-op for ids unknown to the catalog.

### 104. CONSIDER — `task_cancelled`'s payload is typed required but never boundary-validated

**File:** [frontend/src/types/events.ts:676](frontend/src/types/events.ts#L676) with [:239-241](frontend/src/types/events.ts#L239-L241)
**Category:** boundary-guard gap (latent). The same diff added `isHitlResolvedData`/`isMessageReceivedData` and updated `isErrorData`/`isTaskCompleteData`, but no `isTaskCancelledData` exists; the transport even permits payload-less delivery (batch filter drops null payloads; `runtime.test.ts:97-100` pins callbacks firing with `undefined`). No consumer reads the payload today, so nothing breaks — but the type asserts a wire guarantee nothing validates.
**Fix:** a) Add `isTaskCancelledData` (string `session_id` required) and validate at consumers. b) Type it `session_id?: string` to match the unchecked reality. c) Keep the event payloadless until a consumer needs the field.

### Pass 4 dedupe and corroboration

The 13 blind passes re-found 13 known issues (closed as duplicates, no changes): #7 CreateProjectDialog dead end (this pass rated it MUST; the conductor keeps SHOULD — the desktop path still works and nothing is lost or exposed, but three independent passes have now flagged it), #8 byName dup files, #6 TLS pair draft family, #28 WebAccessSettings size, #34 sessionHistoryReload header, #37 web fetches without timeout (extended below), #40 triple ADR-090, #41 ADR-090 D6 gorilla claim, #57 uploadBodyMethods pin claim, #62 `message.md` naming, #73 Windows reserved names (this pass adds the staging-hang aggravation on Windows hosts), #1 Warn-on-shape-drop (extended below), #2 section race family (extended below). Four merges into existing entries:

- **#1 (Warn-on-shape-drop):** pass 4 adds that `extractPayload` echoes attacker-controlled payload contents into the Warn line, and the WS path has no rate limit — an authenticated tab can flood the log with controlled bytes at wire rate, strengthening the case for the Debug-only fix.
- **#2 (section race family):** pass 4 found two more unlocked readers/writers in the same family: `RefreshWebAccessLoadWarnings` reads the desktop-owned section outside `webAccessMu` ([backend/frontend_api.go:803-833](backend/frontend_api.go#L803-L833)), and `persistConfig`'s whole-config save under `configMu` races the desktop writers (the branch documents this as the accepted "one-word window" at [desktop/app.go:164](desktop/app.go#L164); a string header is two words, and acceptance does not remove the UB). The fix this issue already suggests (one owning lock/seam for the section) covers all pairs.
- **#6 (TLS pair draft family):** pass 4 adds the sibling-wipe manifestation — the reseed effect deps `[info.tlsCert, info.tlsKey]` rewrite BOTH drafts when one field's commit lands, so input typed into the sibling field mid-commit silently vanishes (the parent's address draft has the same exposure one step removed).
- **#37 (web fetches without timeout):** pass 4 extends the site list with the boot-gating transport probe — `webAuthRequired()` awaits `fetch('/api/transport')` with no signal before the UI mounts, so a wedged sidecar leaves the tab on the splash forever ([frontend/src/api/runtime.ts:83](frontend/src/api/runtime.ts#L83)).

### Pass 4 additionally verified clean (selected)

`internal/webaccess` security core re-confirmed (auth constant-time compare, rate-limited login, WS admission ordering, denylist-before-reflection, bounded outbox/stop, certgen profile); desktop event-tap publish/teardown, batcher dual-transport delivery, configMu→webAccessMu ordering, persist→rollback control RPCs; `task_started` single-emission lifecycle and echo semantics across all three `message_received` sites; `sessions:changed` fan-out arity and emission points; attachment staging caps consistent across transports (48 MiB wire vs 32 MiB content); `UpdateExperimentalFeatures` rollback discipline; Web Access/TLS draft state machines and ADR-092 `onConfigChanged` wiring; ChatArea history-load refactor vs the loading-states spec; ToolConfirmation stale-click guard; `hitl_resolved` decision vocabulary completeness; `useSessionLoader` fetchSeq discipline; message echo dedup; `WebAccessGate` mount gating; Zoom-safety and selector-stability sweeps; `SendMessage` 13-arg wire parity incl. `clientSendID`; notification permission gesture gating and Firefox SecurityError handling; `compaction_availability` omitempty parity; boot loader + CSP directives; all ADR cross-links resolve.

## Out-of-scope annex — issues whose files were absorbed into `main` mid-review

> Re-scoped at pass 4. Between pass 3 and pass 4 the branch merged `origin/main` (commit a5afc14a,
> "draft-free workspaces + Bonsai2 mtplx engine"), which absorbed this branch's own changes to
> `core/embeddedllm/**`, parts of `backend/session/**`, and several frontend files into `main`.
> Those files are no longer part of `git diff main...HEAD` (188 files, merge-base = `main` tip).
> Following the pass-3 precedent for findings on files the diff no longer touches, the issues below
> move out of the scope body: they were verified against the working tree and remain real, but the
> code they describe is now mainline code — they are follow-ups for `main`, not blockers for this branch.
> Numbers are preserved for cross-reference from the pass sections.

### 4. SHOULD FIX — `mlxSweepDownloads` evicts the llama family's cached downloads from the shared cache

**File:** [core/embeddedllm/install_mlx.go:423-445](core/embeddedllm/install_mlx.go#L423-L445) (call site [core/embeddedllm/install_mlx.go:146](core/embeddedllm/install_mlx.go#L146)); affected layout: [core/embeddedllm/layout.go:249-260](core/embeddedllm/layout.go#L249-L260)
**Category:** behavior change / unintended cross-engine side effect

The downloads area is a persistent cache shared by BOTH engines — `Layout.Destination` routes `ComponentRuntime`/`ComponentCudart` (llama runtime/cudart archives) into the same `DownloadsDir` the mtplx wheel set uses. The sweep's pinned-name map contains only `pythonArchiveAsset` + the 46 wheels, so every other entry is deleted as "a download the current pin table does not carry". Realistic trigger: a darwin/arm64 user with a working llama install (cached `llama-<tag>-metal.tar.gz`, hundreds of MB) flips `embedded_llm.engine` to `mtplx` and clicks Install — the llama archive is silently deleted; switching back costs a full re-download. This contradicts the sweep's own doc comment (its purpose is `--find-links` pip hygiene; `--require-hashes` is already the enforcement) and the layout comment ("a persistent cache shared across installs and pin bumps"), and is untested for the llama case.

**Suggested fix:**
a) Restrict the sweep to entries that could participate in the offline pip step: delete only `*.whl` files plus the pinned python-archive name when the current table does not carry them; leave everything else (llama archives) alone.
b) Key the sweep on `ComponentEngineWheels`/`ComponentPython` identity (URL-tail names) instead of "anything not in the mtplx tables".
c) If the eviction is deliberate, document it at the sweep and add a test asserting the llama archive's fate on an mtplx install.

### 18. CONSIDER — `StageDone` emitted twice for every engine wheel

**File:** [core/embeddedllm/install_mlx.go:202-205](core/embeddedllm/install_mlx.go#L202-L205) vs `fetchComponents` in `core/embeddedllm/install.go`
**Category:** progress-event fidelity. Wheels are fetched with `staging == ""` (StageDone at fetch), and the post-promote loop (which exists to close the python component's deferred stream) re-emits StageDone for all engineAssets — 46 duplicate terminal events per install and two sources of truth for who emits a component's terminal stage. Consumers keying on component+stage are idempotent.
**Fix:** a) Loop over only the staged-extracted component (`engineAssets[:1]`). b) Have `splitMLXAssets` return the python asset separately so the terminal emit is explicit.

### 19. CONSIDER — No progress events across the offline pip install + smoke test (up to ~12 min silent)

**File:** [core/embeddedllm/install_mlx.go:354](core/embeddedllm/install_mlx.go#L354) (10-min budget), [398](core/embeddedllm/install_mlx.go#L398) (2-min budget)
**Category:** UX / progress fidelity. The llama flow emits `StageExtracting` through its comparable gap; the mtplx install is the only one that can sit silent long enough to read as wedged, inviting interruptions mid-promote-critical work.
**Fix:** a) Emit a synthetic stage around `mlxPipInstall`/`mlxSmoke`. b) At minimum document the silent window in the flow comment.

### 20. CONSIDER — `opts.Backend` override silently ignored on the mtplx install path

**File:** [core/embeddedllm/install_mlx.go:78-97](core/embeddedllm/install_mlx.go#L78-L97)
**Category:** silent no-op of an explicit operator input. The llama path threads (and degrades) `InstallOptions.Backend`; `installMLX` hardcodes `BackendMetal` without consulting or acknowledging the override. Manifest records truthfully; reachable only with an explicit non-Metal override while `engine: mtplx`.
**Fix:** a) Warn when `opts.Backend != "" && opts.Backend != BackendMetal`. b) Refuse with a typed error naming the engine (mirroring `mlxForbiddenOverrides`' spirit).

### 21. CONSIDER — mtplx tuning-refusal message is duplicated between the RPC and the load validator

**File:** [backend/frontend_api_embedded_tuning.go:405-413](backend/frontend_api_embedded_tuning.go#L405-L413) (duplicate at [backend/config/config.go:1561-1569](backend/config/config.go#L1561-L1569))
**Category:** structure/maintainability. The "one voice" invariant is enforced by a test comparing suffixes rather than by construction; a wording edit touching one site fails CI in an unrelated-looking test file — or, if updated mechanically, the surfaces silently diverge and a tuning write becomes the config.yaml-poisoning bug the check exists to prevent.
**Fix:** a) Hoist the sentence into a single source (e.g. an `embeddedllm.ForbiddenLlamaTuningError(...)` helper) called by both. b) Share one exported `const` literal in `backend/config`.

### 23. CONSIDER — Duplicated `seedPublished.Store` in the `restart()` test helper

**File:** [backend/frontend_api_worktrees_test.go:229-230](backend/frontend_api_worktrees_test.go#L229-L230)
**Category:** tests/style. Back-to-back identical atomic stores; reads like a merge artifact.
**Fix:** a) Delete one line. b) Comment it if deliberate.

### 25. CONSIDER — SessionWorkspaceSelector.tsx grew past the 200-line target (305 lines)

**File:** [frontend/src/components/chat/SessionWorkspaceSelector.tsx:54](frontend/src/components/chat/SessionWorkspaceSelector.tsx#L54)
**Category:** structure. One component carries three render modes plus two subtle inline predicates (`isFresh`, `windowClosed`) that deserve isolated pure-helper tests.
**Fix:** a) Extract the pinned chip and preparing hint into sibling components. b) Move the predicates into a small pure helper (e.g. `lib/sessionFreshness.ts`) with unit tests. c) Split the doc comment between the two predicates.

### 27. SHOULD FIX — Projection removal item renders the refusal with no separating space

> Re-rated from CONSIDER in pass 2: under the mtplx engine the projector is never removable, so the garbled suffix renders on **every** open of the Remove dropdown for every mtplx user — a visible defect on the normal path of the new engine support, not an edge case. Verified: the refusal string at [EmbeddedLLMSettings.tsx:107](frontend/src/components/settings/EmbeddedLLMSettings.tsx#L107) carries no leading space, while the llama fallback literal does.

**File:** [frontend/src/components/settings/embedded/EmbeddedLLMActions.tsx:130-135](frontend/src/components/settings/embedded/EmbeddedLLMActions.tsx#L130-L135)
**Category:** cosmetic. JSX strips the whitespace between the text child and the expression: "Remove vision projector only**not removable under the MTPLX engine**".
**Fix:** a) Leading space in the refusal string at source. b) Separate `<span>` with a dash. c) Prefix at the call site.

### 29. CONSIDER — Redundant double close (and a divergent no-op edge) in the worktree pick handler

**File:** [frontend/src/components/GitPanel/BranchPicker.tsx:508-514](frontend/src/components/GitPanel/BranchPicker.tsx#L508-L514) (vs `recordChoice` at 279)
**Category:** structure/consistency. `recordChoice` already closes; the trailing `closeBranchPicker()` is a no-op today but diverges on the degenerate null-activeSessionId edge (picker row click leaves it open; worktree row click closes without recording).
**Fix:** a) Drop the trailing close and let `recordChoice` be the single closer for pick mode. b) Make `recordChoice` always close (before the null guard).

### 31. CONSIDER — BranchPicker.tsx (570 lines): draft/pick-mode logic is an extractable unit

**File:** [frontend/src/components/GitPanel/BranchPicker.tsx:236-352](frontend/src/components/GitPanel/BranchPicker.tsx#L236-L352)
**Category:** structure. ~120 lines of self-contained pick-mode logic (pending read, `recordChoice`, three draft callbacks, two marker derivations) inside an already-large component.
**Fix:** a) Extract a `useWorkspacePick(...)` hook. b) Move `draftSelectedRemote`'s shape check into a pure lib helper with a unit test.

### 39. SHOULD FIX — The mtplx server spawn passes a directory where `mlxChildEnv` requires the interpreter path, corrupting the child's PATH and engine-state paths

**File:** [core/embeddedllm/server.go:2222](core/embeddedllm/server.go#L2222) (contract at [core/embeddedllm/server_mlx.go:227-233](core/embeddedllm/server_mlx.go#L227-L233); correct call sites at [core/embeddedllm/install_mlx.go:375](core/embeddedllm/install_mlx.go#L375), [core/embeddedllm/install_mlx.go:401](core/embeddedllm/install_mlx.go#L401))
**Category:** bug (env correctness on every mtplx launch).
`mlxChildEnv(parent, goos, pythonBinPath)` documents `pythonBinPath` as the interpreter (`<tree>/python/bin/python3.12`): `Dir` of it must be the pinned `bin` dir that leads PATH, and triple-`Dir` the tree root. The two install-time call sites pass the interpreter; the production spawn site passes `binaryDir := filepath.Dir(spec.ServerBinary)` — i.e. `<tree>/python/bin`. Every derivation shifts one level up: PATH leads with `<tree>/python` (the pinned `bin` dir is not on PATH at all, contradicting the spawn-site comment) and `MTPLX_CONFIG`/`MTPLX_MODEL_DIR` resolve to `<runtimesRoot>/config.toml` and `<runtimesRoot>` instead of the engine tree.
**Why it is a problem:** on every mtplx server launch (darwin/arm64 `engine: auto`) the long-running child gets wrong env: the engine's state file lands in the shared `~/.c0wrk/runtimes/` root — a directory no removal scope deletes (`removeRuntimeTrees` matches only `llama-*`/`mtplx-*` prefixes) and `DetectLeftovers` never reports — so stale engine state survives Remove and is shared across pin bumps; child subprocesses resolving pinned-`bin` console scripts fall through to the inherited system PATH. `TestMLXChildEnv` feeds the interpreter path directly, so the mismatch is invisible to the suite.
**Suggested fix:**
a) Pass `spec.ServerBinary` instead of `binaryDir` at the spawn site (keep `Dir: binaryDir` for the child CWD), matching the contract and the pip/smoke call sites.
b) Alternatively have `mlxChildEnv` take the bin dir (renamed parameter) and update the two install call sites, so no caller can pass the wrong shape.

### 47. CONSIDER — The embedded-LLM section intro still describes the llama engine only, contradicting the new engine-aware install record

**File:** [frontend/src/components/settings/EmbeddedLLMSettings.tsx:155-158](frontend/src/components/settings/EmbeddedLLMSettings.tsx#L155-L158)
**Category:** copy drift. An mtplx install renders "Engine MLX (MTPLX)" directly above prose claiming llama-server supervision and "about 8 GiB".
**Fix:** a) Make the sentence engine-conditional like `formatPlan`. b) Reword engine-neutrally ("the pinned local inference server").

### 54. CONSIDER — `Installer.Install` silently routes any non-`mtplx` engine value (including garbage) down the llama path

**File:** [core/embeddedllm/install.go:883-885](core/embeddedllm/install.go#L883-L885)
**Category:** latent API contract. Validation lives one layer up in `ResolveEngine`; a future caller passing a raw config string gets a llama install where the config asked for something else — the silent substitution the engine vocabulary elsewhere refuses. Today's only production caller resolves first.
**Fix:** a) Validate `opts.Engine` (`""`, `EngineLlama`, `EngineMTPLX`) at the top of `Install`. b) Document that invalid values mean llama.

### 55. CONSIDER — mtplx spawn failures are reported as failures of "llama-server"

**File:** [core/embeddedllm/server.go:2235](core/embeddedllm/server.go#L2235) (constant at [core/embeddedllm/layout.go:38](core/embeddedllm/layout.go#L38))
**Category:** diagnostics. The fixed `ServerBinaryName` label now wraps both engines' exec errors, pointing mtplx diagnosis at the wrong binary family.
**Fix:** a) Label from `filepath.Base(spec.ServerBinary)`. b) Select the name by `spec.Engine`.

### 59. CONSIDER — A pending-attachment removal can lose the race against the bind eviction and be silently resurrected with a dangling path

**File:** [backend/session/manager_attachment.go:740](backend/session/manager_attachment.go#L740) vs [backend/session/manager_promote.go:81-93](backend/session/manager_promote.go#L81-L93)
**Category:** corner-case race (two surfaces, one session). A removal landing inside the capture→restore window deletes the image file, then `RestorePendingAttachments` re-stages the captured item unconditionally — the removal is undone, the image sends from memory, and the persisted `path` dangles (unreconstructable after restart).
**Fix:** a) Stat the image path in `RestorePendingAttachments` and emit staged-attachments-lost instead. b) Fail removes with "workspace switch in progress" mid-eviction.

### 60. CONSIDER — `BindSessionWorkspace`'s atomic UPDATE does not pin `project_id`

**File:** [backend/session/persistence_binding.go:115-148](backend/session/persistence_binding.go#L115-L148)
**Category:** store-level hardening. No in-repo caller can trigger it (all pass the session's own project), but the one API that mutates binding identity would let a mismatched project argument persist a cross-project binding.
**Fix:** a) Add `AND project_id = ?` to the WHERE. b) Assert `project_id` in the post-UPDATE verification.

### 61. CONSIDER — `EvictSession`'s doc comment is duplicated, reading as two conflicting intros

**File:** [backend/session/manager_promote.go:16-33](backend/session/manager_promote.go#L16-L33)
**Category:** docs. The new forwarding comment was prepended without splitting the original long block, so godoc announces the subject twice.
**Fix:** a) Keep the narrative on `EvictSessionCarryingAttachments`, two-line intro on the wrapper. b) Append a "see" line after a blank-line split.

### 68. SHOULD FIX — The mtplx engine-tree promotion deletes the old tree before the rename, with no rollback: a failed rename leaves no working engine

**File:** [core/embeddedllm/install_mlx.go:192-198](core/embeddedllm/install_mlx.go#L192-L198) (the correct pattern at [core/embeddedllm/install.go:1610-1643](core/embeddedllm/install.go#L1610-L1643))
**Category:** bug (install robustness / data loss of the previous engine tree).
Step 6 runs `removeOwned(runtimeDir)` then `os.Rename(workDir, runtimeDir)`. If the rename fails (EACCES/EBUSY on a locked or open file in the old tree — realistic on macOS while the engine is mid-upgrade), the previous working tree is already destroyed while the manifest still records it installed; the next launch fails with "the provisioned Python is missing" and recovery is a full ~8.9 GiB reinstall. The llama path's `promoteRuntime` deliberately uses retire→rename→rollback for exactly this failure and says so in its doc comment; the pack swap at `install_mlx.go:253` follows the same retire shape — this is the only promotion that does not. The step-6 comment ("it survives every failure above") covers failures *before* the rename but the code reads as if the swap itself were safe.
**Suggested fix:**
a) Mirror `promoteRuntime`: rename `runtimeDir` to a retired sibling, rename `workDir` in, roll back from the retired dir on rename failure, delete the retired dir last.
b) Minimum: reorder to `rename(workDir→runtimeDir)` only after moving the old tree aside, keeping the delete after the swap succeeds.

### 74. CONSIDER — A crash between the two mtplx pack-swap renames costs a full ~8.9 GiB re-download

**File:** [core/embeddedllm/install_mlx.go:253-257](core/embeddedllm/install_mlx.go#L253-L257)
**Category:** install robustness. Crash after `packDir→packOld` but before `packStaging→packDir` leaves no live pack, and the next attempt's staging wipe destroys the fetched revision because pack files go straight to staging (unlike llama weights, which use the persistent DownloadsDir).
**Fix:** a) Fetch pack files into DownloadsDir so the swap replays from cache. b) Keep staging on failure when it holds a fully verified revision.

### 75. CONSIDER — `mlxChildEnv`'s scrub misses `DYLD_*`/`LD_*` steering variables

**File:** [core/embeddedllm/server_mlx.go:241-244](core/embeddedllm/server_mlx.go#L241-L244)
**Category:** hardening nuance (the operator's own env is the threat, same trust level as llama's full inheritance). `DYLD_INSERT_LIBRARIES`/`DYLD_LIBRARY_PATH` (darwin — the engine's only host) and `LD_*` pass into the pinned interpreter, so the documented "operator environment cannot steer them" invariant (ADR-090 D1) is narrower than implemented.
**Fix:** a) Scrub `DYLD_*`/`LD_*` in the same switch. b) Set `DYLD_*` to the pinned lib dirs and document the residual.

## Pass 5 — independent full re-review (iteration 5, current 188-file diff)

### 105. SHOULD FIX — `config.example.yaml` claims every non-loopback bind loads with a warning; the warning is scoped to plain HTTP and a TLS-encrypted LAN bind loads warning-free

**File:** [config.example.yaml:2123-2127](config.example.yaml#L2123-L2127) vs [backend/config/web_access.go:341-344](backend/config/web_access.go#L341-L344)
**Category:** doc claims contradicted by code on the security-exposure surface. The bind paragraph states unconditionally: "A non-loopback bind is a LAN-exposed listener: it loads with a warning (…) and is saved as-is." The code returns no load warning when `section.TLS.Enabled` (`if IsLoopbackBind(section.Bind) || section.TLS.Enabled { return nil }`), and the warning text itself names the transport ("traffic is plain HTTP without TLS"). Both halves are test-pinned: `TestWebAccessTLS_NonLoopbackBindLoadsWarningFree` ([backend/config/web_access_test.go:209-233](backend/config/web_access_test.go#L209-L233)) asserts a TLS-encrypted LAN bind loads warning-free, and the warning-text assertions require the plain-HTTP phrasing.

**Why it is problem:** an operator reading the authoritative example believes any LAN listener announces itself in the config-errors banner at every load; a TLS-encrypted one will not (by design it is surfaced only via the Settings banner and the start log). This is exactly the drift class the example file is the reference for.

**Suggested fix:**
a) Scope the sentence: "over plain HTTP it loads with a warning (…); with the tls subsection enabled it loads warning-free (the exposure is surfaced by the Settings banner and the start log instead)".
b) Minimal: delete the quoted paraphrase and state "loads with a warning when TLS is off" (also resolves the paraphrase half of #72).
c) Move the warning sentence next to the tls paragraph so the TLS exemption reads as part of one contract.

### 106. SHOULD FIX — `new Notification()` is unguarded: on Android browsers every banner throws a raw TypeError while Settings reports "granted"

**File:** [frontend/src/api/notifications.ts:139](frontend/src/api/notifications.ts#L139) (guards at [:128-134](frontend/src/api/notifications.ts#L128-L134))
**Category:** browser-compat bug. `sendWebNotification` checks `'Notification' in window` and `permission === 'granted'`, then constructs the banner directly. On Chrome and Firefox for Android the `Notification` constructor throws `TypeError: Illegal constructor` even when the API exists and permission is granted — banner display there requires `ServiceWorkerRegistration.showNotification`. The caller-side wrapper degrades to a per-event warn, and the Settings Test button surfaces the raw TypeError instead of the typed `NotificationPermissionError` UX built for every other failure shape (denied / default / insecure-context, see #52). The suite's FakeNotification constructor never throws, so the case is untested.

**Why it is a problem:** the sidecar explicitly supports non-loopback binds (a deliberate, warned network listener) and a phone browser is the flagship client for that surface. Realistic trigger: grant permission from an Android browser, then every completion/attention banner silently never appears while the Settings toggle reports granted/authorized — the same "honest status" class as #5, in the notification transport.

**Suggested fix:**
a) Wrap the constructor in try/catch and map failure to the same clean degradation as the missing-API case, so Android degrades honestly and the Test button shows an actionable message.
b) Feature-detect the constructor inside `webNotificationsAvailable()` (`try { new Notification('') } catch { return false }`) so "no API" and "API exists but constructor throws" collapse into one honest path.
c) Where a service-worker registration exists, prefer `registration.showNotification(title, options)` — the only path that actually displays banners on Android.

### 107. SHOULD FIX — Web-transport file/image paste is a guaranteed failure: the paste path calls the denylisted `PasteFromClipboard` RPC with no web branch

**File:** [frontend/src/hooks/usePasteHandler.ts:113](frontend/src/hooks/usePasteHandler.ts#L113) (denylist entry at [internal/webaccess/dispatch.go:42](internal/webaccess/dispatch.go#L42))
**Category:** transport-parity gap on a net-new surface. The paste handler stages optimistic spinner chips (`beginAttachmentUploadsFresh`) and then unconditionally awaits `pasteFromClipboard(sessionId, supportsVision)`. On the web transport that method is server-denylisted ("host clipboard content is not exposed to the browser" → 403), so any paste carrying file/image items fails: the chips flash and drain, and a "Failed to paste from clipboard" `runtime_error` toast fires — every time. The sibling attachment entry points both gained web branches this branch (`browserFilePicker` for 📎, `stageAttachmentFiles` for drag-drop); paste did not. There is no `isWebTransport` check anywhere in the handler, and no test exercises web paste.

**Why it is a problem:** pasting a screenshot into the chat is a core interaction; in any browser tab it now always fails with a generic error. The denylist comment says stage-1 mirrors should "paste via the browser's own clipboard access instead" — the `DataTransfer` the editor already holds — but no code implements that path (verified: `stageAttachmentFiles` has exactly two callers, the picker and `useFileDrop`).

**Suggested fix:**
a) Add a web branch at the top of `onPaste`: when `isWebTransport()`, stage the `DataTransfer`'s files/images client-side through `stageAttachmentFiles` (text still inserts via the editor's fast path) and return before the RPC.
b) Gate in `useChatEditor`'s paste handler: on web, preventDefault only for file items and hand them to a browser-native stager, letting text/html fall through to CodeMirror natively.
c) Minimal stopgap if the full path is deferred: on web skip the optimistic chips and surface one clear "pasting files is unavailable in the browser" banner instead of the generic failure toast.

### 108. SHOULD FIX — In non-chat input modes the web transport registers no drop suppression: a dropped file navigates the tab away from the app

**File:** [frontend/src/hooks/useFileDrop.ts:73-77](frontend/src/hooks/useFileDrop.ts#L73-L77) (suppression exists only inside the chat-mode branch at [:99-104](frontend/src/hooks/useFileDrop.ts#L99-L104))
**Category:** transport-specific data-loss hazard. The effect returns early when `mode !== 'chat'`, before registering any document listeners — including the `dragover`/`drop` preventDefault handlers whose sole purpose is suppressing the browser's default "open/navigate to the dropped file" behavior. On the desktop that was safe because Wails' OS-level `OnFileDrop` intercepts drops globally. In a browser tab there is no OS intercept: with the terminal panel open (or any non-chat mode), a file dragged over the window — accidentally or intentionally — makes the browser navigate the tab to the dropped file's content, discarding the whole SPA state.

**Why it is a problem:** realistic trigger: a web tab with the terminal open and an accidental file drop anywhere over the window loses the entire session view. The same early return was harmless pre-branch because the web transport did not exist; navigation suppression is not staging-specific and should not be mode-gated.

**Suggested fix:**
a) Always register the navigation-suppressing listeners (`dragenter`/`dragover`/`drop` preventDefault) regardless of mode, and gate only the staging call on `mode === 'chat'`.
b) In the web branch specifically, keep a `drop` handler active in non-chat modes that preventDefaults and no-ops.
c) Weakest: document the terminal-mode drop hazard as accepted for web.

### 109. SHOULD FIX — Failed Submit/Approve in the review surface is completely silent: log-only catches around a send this branch modified

**File:** [frontend/src/components/review/useReviewActions.ts:218-220](frontend/src/components/review/useReviewActions.ts#L218-L220) (Submit outer catch), [:32-35](frontend/src/components/review/useReviewActions.ts#L32-L35) (Approve catch)
**Category:** silent-failure inconsistency on a user-facing action. `handleSubmit`'s send call is modified by this branch (it gained the `clientSendId` argument, [#64](specs/contracts/desktop-frontend.md) threading), and its failure path — after a correct optimistic rollback — rethrows into `catch (err) { logger.error('Submit flow failed:', err) }`: no toast, no inline error. `handleApprove`'s `stageAll()`/`clearReview()` failures are likewise caught and only logged. Everywhere else in the review surface failures toast (`runtime_error` in ReviewHeader, FileReviewBlock, HunkReviewBlock).

**Why it is a problem:** a transient failure (SQLite busy, backend restart) at submit time leaves the user having clicked Submit with the button un-spinning and nothing happening — the review buffer survives for retry, but nothing says the submit failed or that retry is expected. Same for Approve, the terminal action of the review loop.

**Suggested fix:**
a) In the outer Submit catch and the Approve catch, `emit('runtime_error', { id: generateUUID(), message: 'Failed to submit review — your comments are kept' })` / `'Failed to approve review'`.
b) Return an error state from the hook and render inline error text in ReviewHeader.
c) Minimum: make Approve consistent with the comment-save paths that already toast.

### 110. SHOULD FIX — ADR-092 D4 and the domain spec claim the TLS commit check classifies "the way `cert_status` classifies it" — for a key/cert mismatch the two classify oppositely

**File:** [specs/decisions/092-web-access-tls.md:23](specs/decisions/092-web-access-tls.md#L23) (decision 4), [specs/domains/web-access.md:13](specs/domains/web-access.md#L13), mirrored comment at [desktop/app.go:1392-1394](desktop/app.go#L1392-L1394)
**Category:** doc/code contradiction on a security-relevant operator surface. `classifyWebAccessCert` ([desktop/app.go:1482-1495](desktop/app.go#L1482-L1495)) loads the pair first; a `tls.LoadX509KeyPair` failure — which is exactly what a key/cert mismatch is — lands in **unreadable**; its `mismatch` is reserved for SAN non-coverage of the pinned bind. The commit-time preflight in `setWebAccessTLSLocked` inspects the same error and refuses with the **mismatch-flavored** message ("TLS private key … does not match the certificate …"). Both docs assert the commit check is "classified the way `cert_status` classifies it: a key that does not match its certificate is a mismatch, every other load failure is unreadable" — the opposite of what `cert_status` reports for that very case.

**Why it is a problem:** an operator who hand-edits a mismatched pair sees the commit refuse with "does not match", then finds `cert_status: "unreadable"` in GetWebAccessInfo — and a reader of ADR-092 D4/web-access.md expects the docs' stated vocabulary, not two different buckets for the same defect. The docs normalize the divergent behavior instead of describing it.

**Suggested fix:**
a) Reword both docs (and the app.go comment) to state the actual split: "the commit check uses its own two-bucket error split (a key that does not match its certificate is refused as a mismatch, every other load failure as unreadable); `cert_status` reserves `mismatch` for SAN non-coverage and reports a key-mismatch pair as `unreadable`".
b) Align the code instead: have the commit message mirror cert_status (call every load failure unreadable) — weaker UX, loses the actionable "does not match" hint.
c) Note the divergence in ADR-092's amendment block without rewording the decision text.

### 111. CONSIDER — A peer-initiated close is answered with two close frames

**File:** [internal/webaccess/ws.go:370](internal/webaccess/ws.go#L370) (echo) and [:287](internal/webaccess/ws.go#L287) (deferred `Close()`)
**Category:** RFC 6125/§7.1.1 closing-handshake cleanliness. `wsReadPump` always exits through `defer c.Close()`, whose best-effort close frame has no "close already sent" memory; when the client initiated the closing handshake, the echo at the `opClose` case has already gone out, so the server emits a second close (code 1000). Every real browser ignores it and the socket is torn down immediately — no hang, leak, or interop failure observed; flagged because the package otherwise tracks the RFC's MUSTs precisely.
**Fix:** a) Add a `sentClose` flag (under `writeMu`) that `Close()` checks. b) Move the close echo solely into `Close()`, having `readMessage` only signal the received code. c) Accept and note it in the stage-2 keepalive comment.

### 112. CONSIDER — A failed enable leaves an enabled-but-down sidecar whose in-session recovery is an off→on double toggle

**File:** [desktop/app.go:1104](desktop/app.go#L1104)
**Category:** minor UX dead-end, not correctness. On a start failure after persist, the switch stays ON (documented "the next launch retries"), but a repeated `SetWebAccessEnabled(true)` hits the `enabled == on` no-op and returns nil — the retry the error message invites does nothing. `GetWebAccessInfo` does surface `Running=false`, so the state is visible and honest; recovery is toggle-off/on or restart.
**Fix:** a) When `on` is requested, the section is already enabled, and no live handle exists, fall through to `startWebAccessLocked` (its live-handle idempotence prevents double binds). b) Return a distinct "enabled but not running" sentinel the frontend renders as a Restart action. c) Document the off→on recovery in the error string.

### 113. CONSIDER — `ForkSession` store round-trips use `context.Background()`, bypassing the file's own `storeOpCtx` bound (pre-existing)

**File:** [backend/frontend_api_session.go:102](backend/frontend_api_session.go#L102)
**Category:** unbounded pool wait (pre-existing code, flagged by the saturation pass because the diff touches this function). The file header mandates every direct `f.store` call on an RPC path go through `storeOpCtx()` (15 s pool-wait bound + shutdown cancellation); `ForkSession` passes `context.Background()` to the guard reads and the transactional fork. All stores share the app's single pool, so a contended pool parks the RPC and shutdown cannot cancel it. Trigger: contended pool + user clicks Fork.
**Fix:** a) Derive the two guard reads from `storeOpCtx()` and give the transactional fork its own explicit `context.WithTimeout`. b) Wrap only the guard reads and file the unbounded fork as reviewed timing debt. c) Document the exception in the `storeOpCtx` contract comment.

### 114. CONSIDER — `emitSessionsChanged`'s doc comment omits the project-switch fallback creation among the mutations it lists

**File:** [backend/frontend_api_session.go:59](backend/frontend_api_session.go#L59)
**Category:** comment/contract drift. The enumeration "(create, fork, delete, archive, pin, promotion, project deletion)" misses `createSessionForProject` ([backend/frontend_api_project.go:1247](backend/frontend_api_project.go#L1247), the SwitchProject fallback creation), which the event-catalog row does list. A future editor pruning "unlisted" call sites could remove a required emission.
**Fix:** a) Add "project-switch fallback creation" to the enumeration. b) Replace the enumeration with a pointer to the catalog row (single source of truth).

### 115. CONSIDER — `useBackgroundSessionWatcher.test.ts` mock factories omit exports the source imports: latent access-time crash

**File:** [frontend/src/hooks/events/… /useBackgroundSessionWatcher.test.ts:86-99](frontend/src/hooks/events/useBackgroundSessionWatcher.test.ts#L86-L99)
**Category:** latent test debt. The `hitlHandlers` factory provides only 4 of the 5 imported handlers (`handleHitlResolvedEvent` missing) and `goalHandlers` omits `handleGoalSuggestionEvent`; vitest factory mocks throw only when the binding is dereferenced, and no current test fires `hitl_resolved`/`goal_suggestion` — so the suite passes today, but the first test for those subscriptions (already wired in the source and counted in the hard-coded 15/30 subscription totals) fails confusingly.
**Fix:** a) Add the two missing mock exports (plus one test each firing the events). b) Derive the per-session subscription count from a shared constant so the 15/30 assertions track the source.

### 116. CONSIDER — "Open In Terminal" sets the cwd to the file itself on Windows (pre-existing)

**File:** [frontend/src/components/fileViewer/FileViewerTabContextMenu.tsx:122-125](frontend/src/components/fileViewer/FileViewerTabContextMenu.tsx#L122-L125)
**Category:** pre-existing defect in an in-diff file, reported for triage. `path.lastIndexOf('/')` — file-viewer tab paths are backslash-joined on Windows (the codebase's own `pathSep()` helper in [FileTreeContextMenu.tsx:44-48](frontend/src/components/layout/FileTreeContextMenu.tsx#L44-L48) exists for this), so the cut fails and `dir` becomes the full file path; `startTerminalInDir` then fails to spawn the PTY. Deterministic for effectively every file on Windows; the diff did not touch this handler.
**Fix:** a) Derive the separator via `pathSep()` and fall back to the drive/root when there is no separator. b) Extract a shared `parentDir(path)` lib helper so the tree/tab/git menus cannot drift.

### 117. CONSIDER — Git history context menu's nested submenus don't flip/clamp: clipped off-window near the right edge (pre-existing)

**File:** [frontend/src/components/GitPanel/GitHistoryContextMenu.tsx:80-107](frontend/src/components/GitPanel/GitHistoryContextMenu.tsx#L80-L107)
**Category:** pre-existing UX defect in an in-diff file. The `Submenu` helper renders at `absolute left-full top-0` with no viewport check, while the top-level menu IS clamped by `useCursorMenuPosition` — so any right-click within ~200 px of the right window edge (the common case for the right-docked Git history panel) pins the menu at the viewport gutter and the "Create"/"Reset …"/"Tag" submenus open entirely off-screen. The destructive-reset flow becomes unreachable without moving the window.
**Fix:** a) Expose the placement's `horizontal` from `useCursorMenuPosition` and render submenus at `right-full` when the menu resolved leftward. b) Measure each submenu and flip on overflow (reuse `computeCursorMenuPlacement`). c) Cheap mitigation: `max-w-[50vw] overflow-y-auto` on the submenu.

### 118. CONSIDER — WebAccessSettings and WebAccessTLSSettings writer locks don't compose across the two blocks

**File:** [frontend/src/components/settings/WebAccessSettings.tsx](frontend/src/components/settings/WebAccessSettings.tsx) + [WebAccessTLSSettings.tsx](frontend/src/components/settings/WebAccessTLSSettings.tsx)
**Category:** composed-busy gap. The TLS block disables its controls while its own `writeBusy` flags are set and the parent's toggle disables while `saving` — neither flag covers the other block, so a TLS write and an enable toggle can be in flight together (a sidecar start makes the enable window seconds-wide). The backend serializes under `webAccessMu`, so data stays consistent, but the failure-path rollbacks restore whole stale `info` snapshots, which can repaint a stale `enabled` until the next successful re-read.
**Fix:** a) Lift a single busy flag into the parent and thread it down, disabling both toggles and all Web Access fields during any in-flight write. b) On failure paths, restore via a fresh `getWebAccessInfo()` instead of the captured `previous`. c) Narrow the child's "a commit never races a toggle" comment to its own block.

### 119. CONSIDER — Stray indentation on a `removeAttribute` statement in ThemeSelector.test.tsx (merge artifact)

**File:** [frontend/src/components/settings/ThemeSelector.test.tsx:90-91](frontend/src/components/settings/ThemeSelector.test.tsx#L90-L91)
**Category:** cosmetic. One statement is mis-indented relative to its siblings; the formatter would normalize it.
**Fix:** a) Run the formatter over the file. b) Hand-fix the indent.

### 120. CONSIDER — The event catalog's Web-transport intro states availability as `web_access.enabled` alone, without the experimental master gate

**File:** [specs/contracts/event-catalog.md:7](specs/contracts/event-catalog.md#L7) (also the transport list in [specs/contracts/desktop-frontend.md](specs/contracts/desktop-frontend.md))
**Category:** spec completeness. ADR-090 D13 (and the implementation, `initWebAccess`) make availability the compound gate `experimental.enabled && web_access.enabled`; the rest of the doc set states the conjunction everywhere. A reader of the contracts' transport intro alone could conclude the section switch alone mounts the sidecar.
**Fix:** a) One clause: "opt-in (`web_access.enabled` behind the master `experimental.enabled` gate, ADR-090 D13)". b) Link the web-access domain spec's availability section next to the phrase.

### 121. CONSIDER — INDEX's ADR-090 bullet says "stdlib only" while the same file's web-access.md bullet says "stdlib + `backend/config` only"

**File:** [specs/INDEX.md](specs/INDEX.md) (090-browser-web-access bullet)
**Category:** internal inconsistency in the same document. The package's actual dependency contract is stdlib + `backend/config` (Options carries `config.WebAccessConfig`); the ADR bullet understates it relative to its sibling bullet.
**Fix:** a) Align the bullet to "stdlib + backend/config only". b) Clarify "stdlib-only codec" if the intent was the WebSocket layer.

### 122. CONSIDER — ADR-090's status note "consolidates the branch-local former ADR-091" is ambiguous against main's 091

**File:** [specs/decisions/090-browser-web-access.md:3](specs/decisions/090-browser-web-access.md#L3)
**Category:** historical-note clarity. main's 091 is `091-eager-session-creation.md` — a different, existing decision; the note refers to a never-merged branch-local file, and a reader diffing against main can misread the consolidation as consuming main's 091. (The parallel "former ADR-093/094/095" note in ADR-092 names files that exist nowhere, so it is less ambiguous.)
**Fix:** a) "consolidates the branch-local former ADR-091 (web-access availability; unrelated to main's 091-eager-session-creation)". b) Leave as is — lowest priority.

### Pass 5 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** #1, #5, #6, #7, #8, #9, #15, #26+#70 (failure-card stacking/populated-transcript), #34, #36, #37, #40, #41, #42, #44, #46, #48 (extended), #51 (extended via #48), #56, #57, #73, #76/#95 (with the loader-side mechanism added), #78, #90 (re-rated), #91, #104. **Severity disagreements (kept at report severity):** pass 5 rated #7 and #40 MUST — both are severity disagreements with already-aggregated SHOULDs (a permanently-disabled web-transport dialog with an honest escape hatch via desktop, and a specs-numbering ambiguity whose INDEX links all resolve); #90's SHOULD rating was accepted (see the re-rate note there). **Extensions merged:** #2 (bidirectional whole-file marshal race + lost-update), #3 (token also wiped), #48 (browserFilePicker untested). **Process disclosure:** one frontend reviewer reported briefly opening a prior pass's blackboard output mid-session before catching itself; all of its findings and verification trails were formed before that point and were re-anchored to the working tree by the conductor, so no finding in this section derives from prior-round content. Blind constraint was otherwise honored by all 12 reviewers.

**Pass 5 additionally verified clean (selected):** `internal/webaccess` full suite passes under `go test -race -count=1`; token entropy/digest-only logging, cookie matrix, origin-vs-Host interlock with the host-scoped cookie (DNS-rebinding dies at cookie auth), denylist proven against targets that DO define the denied methods, RFC6455 client-frame strictness (mask/RSV/caps), shutdown idempotence, certgen SAN classes; `go build ./...`, `go vet`, `gofmt` clean across backend/desktop; the full `backend` and `backend/session` packages pass uncached including the nine-site `sessions:changed` emission audit against the catalog and the task_started single-activation-point contract; lock-order check found no ABBA cycle between `configMu` → `webAccessMu`; generated wailsjs drift-free (14-field WebAccessInfo, 13-arg SendMessage position-pinned, `[]byte`↔base64 mapping asserted); event fan-out exactly-once (batch-class names never emitted individually); WS reconnect backoff virtual-time tested; `webEmit` drop-on-disconnect routes only `runtime_error` locally; zoom-safety and Zustand-selector sweeps clean across all frontend areas; no `crypto.randomUUID` remains in scope; `ToolConfirmation` stale-click guard sound; experimental-toggle persist-failure rollback is intentional, documented, and test-pinned.



## Pass 6 — independent full re-review (iteration 6, current 188-file diff)

Method: 12 blind read-only area subagents (webaccess, desktop+main.go, backend API core, backend session, backend/config+example, frontend api/types/wailsjs, chat components, hooks, layout/git/review, settings, stores/lib, specs+AGENTS/SECURITY) over `git diff main...HEAD` at merge-base == main tip (114a5308); conductor dedupe of every candidate against the full issue index + line-by-line working-tree verification of every new finding. Coverage: 187/188 files reviewed; the only file outside every scope is the binary `frontend/public/favicon.png`. All 12 reviewers honored the blind constraint; every new candidate below was independently re-verified by the conductor before inclusion.

### 123. SHOULD FIX — Tests pin OS-specific error substrings: the broken-pair cases and the experimental-persist case fail the Windows CI leg deterministically

**Files:** [backend/config/web_access_test.go:759](backend/config/web_access_test.go#L759) (`wantReason` table in `TestWebAccessTLS_BrokenPairFilesDisableAtLoad`, both subtests); **pass-7 extension:** [backend/frontend_api_config_test.go:4044-4047](backend/frontend_api_config_test.go#L4044-L4047) (`TestUpdateExperimentalFeatures_PersistFailureSkipsHook` asserts the intercepted WARN contains `"no such file"`)

**Why it is a problem:** The load warning embeds the raw `tls.LoadX509KeyPair` error — [backend/config/web_access.go:411](backend/config/web_access.go#L411) appends `err.Error()` and `webAccessTLSPairError` wraps it as `certificate pair failed to load: %w` ([:261](backend/config/web_access.go#L261)). On Linux/macOS a missing file yields "open …: no such file or directory", so `strings.Contains(warning, "no such file")` passes; on Windows the ENOENT message is "The system cannot find the file specified.", which lacks the substring — both missing-file subtests fail deterministically on the `windows-latest` CI leg. Pass 7 found the identical defect class at a second site: the experimental-features persist-failure test ([backend/frontend_api_config_test.go:4024-4028](backend/frontend_api_config_test.go#L4024-L4028)) points `configPath` under a missing parent directory and then ([:4044-4047](backend/frontend_api_config_test.go#L4044-L4047)) requires the WARN record to contain `"no such file"` — on Windows the path-error message ("The system cannot find the path/file specified.") never contains that substring, so this test also fails the Windows CI leg deterministically. Verified in the working tree: both assertion sites and the missing-parent setup.

**Suggested fix:**
a) Classify in `webAccessTLSPairError` with `errors.Is(err, fs.ErrNotExist)` and emit platform-neutral wording, so the operator-facing warning text and the assertion stop depending on the OS strerror.
b) Assert only the stable wrapper text — "certificate pair failed to load" for the missing-file cases, "failed to persist experimental features toggle" for the persist case — dropping the raw OS-message matches at both sites.
c) For the persist test specifically, assert `errors.Is(err, fs.ErrNotExist)` on the returned error instead of matching the logged cause text.

### 124. CONSIDER — Unrelated settings writers blanket-nil `configLoadErrors`, silently dropping a live web_access exposure banner

**File:** [backend/frontend_api_config.go:461](backend/frontend_api_config.go#L461), also [:1548](backend/frontend_api_config.go#L1548) and [:2432](backend/frontend_api_config.go#L2432)

**Category:** the branch adds the web_access warning channel to the shared `configLoadErrors` slice, but the pre-existing writers clear it wholesale once their own section validates ("Clear any config load errors since settings are now valid"), and `RefreshWebAccessLoadWarnings` re-appends only web-access-shaped warnings — so an exposure banner a user is being shown vanishes after any unrelated settings save and does not return until the next web-access mutation or an app restart.

**Fix:** a) route those writers through the same surgical replace `RefreshWebAccessLoadWarnings` uses; b) re-append `config.WebAccessLoadWarnings` after each blanket nil.

### 125. CONSIDER — The warning-refresh keep-filter is text-coupled to the "web_access" prefix

**File:** [backend/frontend_api.go:822](backend/frontend_api.go#L822)

**Category:** robustness nit — verified exact today (every matching shape originates in `config/web_access.go`), but a future foreign warning that happens to begin with the prefix would be silently dropped by the refresh instead of kept.

**Fix:** a) document the prefix invariant as deliberate at the filter; b) match the exact current warning shapes instead of the prefix.

### 126. CONSIDER — `DeleteSession` can return early after the managed pre-flight already removed the store row, skipping `sessions:changed`

**File:** [backend/frontend_api_session.go:200](backend/frontend_api_session.go#L200)

**Category:** when the manager delete fails, the early return skips the emission although the visible list already mutated (the pre-flight removed the row itself), leaving other surfaces stale until the periodic poll or the next unrelated event.

**Fix:** a) emit `sessions:changed` on that error path too (the list genuinely changed); b) document the poll fallback as the accepted recovery.

### 127. CONSIDER — Nudge-resume/live-echo renders the user message before the dispatch outcome is known (pre-existing ordering; the diff only adds fields)

**File:** [backend/session/manager_execution.go:868](backend/session/manager_execution.go#L868), also [backend/frontend_api_session.go:527](backend/frontend_api_session.go#L527)

**Category:** if the subsequent resume fails, the caller skips `SaveMessage`, so cards other surfaces rendered from the echo vanish on reload. The ordering predates the branch — the changed hunks add `ClientSendID`/`IsNudge` fields to these emissions, which is why they are in scope.

**Fix:** a) emit the echo only after the resume/persist commits; b) persist the row before dispatch.

### 128. CONSIDER — `TaskFailedResumableData`'s new optional `task_id`/`reason` bypass shape validation, unlike the file's own additive-field convention

**File:** [frontend/src/types/events.ts:1354](frontend/src/types/events.ts#L1354)

**Category:** the guard validates only `message` and documents its tolerance for `auto_retry_at`; the two newly added optional fields are neither pinned-when-present (cf. `isSessionTokensData` in the same file) nor covered by a documented tolerate-but-degrade note, and a malformed `task_id` would silently degrade the resume banner's match field.

**Fix:** a) validate-when-present like the sibling guards; b) extend the guard's tolerance comment to name the two fields and the degrade path.

### Pass 6 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** #1, #2, #5, #6, #7, #8, #13+#58, #15, #28, #34, #36, #40, #41, #49, #56, #70, #73, #80, #81, #84, #94, #97. **Extensions merged:** #8 (the `byName` collapse also covers browser multi-select, not only cross-directory drops), #13+#58 (the HTTP server's missing body-read bound/concurrency cap, with the per-request 48 MiB buffering spelled out), #28 (the TLS extraction header's "keeps the parent under the 200-line target" claim is false against the 463-line parent), #56 (the fragment cap is checked after append, so a fragmented message transiently reaches ~2× the cap), #84 (the persist-failure rollback re-raised as a behavior-change confirmation), #94 (`getRuntime()` throws before the api-level logging on three context-menu sites), #97 (generalized: the web transport drops all UI→backend frames during an outage, warn-once, until reconnect resync restores pending cards). **Severity disagreement (kept at report severity):** pass 6 rated #7 MUST — the third independent MUST rating (after passes 4 and 5, against three SHOULD ratings); the split is now 3–3 and the issue stays SHOULD with nothing re-litigated.

**Pass 6 additionally verified clean (selected):** the full webaccess security core re-audited (constant-time digest compare, per-IP limiter with virtual-time window tests, cookie flags with Secure riding TLS only, denylist precedence over both surfaces + fail-closed nil dispatch validation, panic recovery across handlers/pumps/tap, bounded stop with expired-deadline force close, TLS 1.2 floor + fail-closed pair classes + atomic 0600/0644 publish, WS admission strictness, outbox backpressure, import-hygiene guards); `go build ./backend/... ./desktop/...` and targeted `-run` tests green; config load-order and fail-soft/fail-closed semantics re-verified through the real `LoadWithResult` pipeline and `config.example.yaml` claims re-checked against code; the task_started single-activation contract re-confirmed across fresh/goal/E2S/continue paths; SendMessage 13-arg threading re-verified end-to-end (generated binding, wrappers, echo dedup) with vitest 337/337 green and zero unexpected diagnostics; hitl_resolved id-prefix map covers all six card formats; useSessionLoader/useShallowResync race guards re-confirmed; zoom-safety, selector-stability and no-module-side-effect sweeps clean in every frontend area; the specs/docs pass re-verified the gate conjunction and live-follow, denylist, inbound whitelist, cookie/token vocabulary, cert_status classes, CSP, INDEX completeness and all relative links.

## Pass 7 — independent full re-review (iteration 7, current 188-file diff)

Method: 12 blind read-only area subagents (same scope split as pass 6: webaccess; desktop+main.go; backend API core; backend session; backend/config+example; frontend api/types/wailsjs; chat/webaccess/project/papers components; hooks+lib; layout/git/review; settings; stores; specs+AGENTS/SECURITY) over `git diff main...HEAD` at merge-base == main tip (114a5308); conductor dedupe of every candidate against the full issue index + line-by-line working-tree verification of every new finding. Coverage: 187/188 files reviewed; the only file outside every scope is the binary `frontend/public/favicon.png`. All 12 reviewers honored the blind constraint; every new candidate below was independently re-verified by the conductor before inclusion.

### 129. SHOULD FIX — `handleToolJudgeRequest` spawns an unbounded judge-evaluation goroutine per inbound frame; first-responder-wins protects the delivery, not the spawn

**File:** [desktop/event_handlers.go:231-248](desktop/event_handlers.go#L231-L248) (spawn), [desktop/event_handlers.go:250-257](desktop/event_handlers.go#L250-L257) (`runJudgeEvaluation`)

**Why it is a problem:** Every accepted `tool_judge_request` frame — one of the seven whitelisted inbound web-transport events — unconditionally does `a.judgeWG.Add(1); go runJudgeEvaluation(...)` with no in-flight marker and no dedup per `confirm_id`. The pending-entry lookup happens before the spawn, and `pendingData` is captured by reference, so a second frame for the same confirmation while the first evaluation is in flight (an LLM call budgeted up to ~120 s) starts a full second evaluation whose result can only lose the first-responder race. An authenticated browser tab that double-clicks the judge button (or a scripted client) fans out parallel 120 s LLM evaluations for one `confirm_id` — token burn / provider-load amplification on the web transport, where the frame source is network-reachable by design. Verified in the working tree: no in-flight set, no singleflight, `judgeWG` joins only at shutdown; the webdispatch surface has no per-frame rate limit beyond the login limiter.

**Suggested fix:**
a) Track an in-flight set (e.g. a small map guarded by `pendingConfirmations`' mutex or a `singleflight.Group` keyed by `confirm_id`): repeat frames while an evaluation runs are dropped (Debug-logged, matching the file's invariant).
b) Record a `judging` flag on `pendingConfirmData` and refuse re-entry until the evaluation resolves or the entry is deleted.
c) Weaker alternative: serialize judge evaluations behind a single-slot semaphore so at most one evaluation runs at a time app-wide.

### 130. CONSIDER — `stopWebAccessLocked` clears the handle and event tap before `srv.Stop`; a total Stop failure leaves a live listener that every reader reports as not-running

**File:** [desktop/app.go:1641](desktop/app.go#L1641)

**Category:** if both the graceful and force stop phases fail, the OS listener survives while `GetWebAccessInfo` and every reader report not-running, and a later start fails on the held port until the rollback path restores the previous state. Narrow (Stop failure is already an error path), but the observable state can contradict reality.

**Fix:** a) on a Stop error, re-store the handle so state matches reality; b) keep the clear but surface liveness via the stored `Server` and report running in `GetWebAccessInfo`.

### 131. CONSIDER — The plain-HTTP exposure warning fires for a non-loopback section even while the compound experimental gate guarantees the sidecar cannot mount

**File:** [backend/config/web_access.go:337](backend/config/web_access.go#L337)

**Category:** `WebAccessLoadWarnings` emits the present-tense "listener is network-accessible, traffic is plain HTTP" warning for an enabled non-loopback plain-HTTP section even when `experimental.enabled` is false and the compound gate ([desktop/app.go:1099](desktop/app.go#L1099) vs `applyExperimentalWebAccess`) guarantees no listener exists. The warning overstates the actual exposure on the load path (the runtime recompute after a live gate flip is the case it is written for).

**Fix:** a) soften/suppress the warning at the load call site when the master gate is closed (`normalizeWebAccess` has the whole cfg); b) reword to conditional ("will be network-accessible … once Experimental Features is enabled").

### 132. CONSIDER — `runExperimentalChangedHook` executes while `configMu` is held, stalling unrelated config RPCs for the sidecar-mount duration

**File:** [backend/frontend_api_config.go:800](backend/frontend_api_config.go#L800)

**Category:** the changed-hook (sidecar mount/stop: TLS load, bind, probe) runs under the deferred `configMu` unlock, so a slow mount delays `GetConfig` and every other config RPC for its duration. Deliberate per the ADR-090 synchronous-apply contract, but the cost is borne by unrelated readers; a comment naming the accepted stall window exists only on the desktop side.

**Fix:** a) snapshot state, unlock, then run the hook (revisit the documented lock-order rationale first); b) accept and document the stall window at this call site too.

### 133. CONSIDER — `emitSessionsChanged` inherits `seedAcquire`'s early-startup park for an emit-only call

**File:** [backend/frontend_api_session.go:52-54](backend/frontend_api_session.go#L52-L54)

**Category:** the helper calls `seedAcquire()` though it reads no seed-guarded state — it is a pure `emitEvent` passthrough (sibling `EventProjectCreated` calls `emitEvent` directly), so on the pre-seed startup path it can park in the seed wait loop before emitting a UI list-refresh event that nothing it emits depends on.

**Fix:** a) drop the `seedAcquire` call; b) keep it with a comment naming the invariant it protects.

### 134. CONSIDER — `DeleteSessionWithOptions`/`ArchiveSession`/`PinSession` emit `sessions:changed` even when the id is unknown and nothing mutated

**File:** [backend/frontend_api_session.go:240](backend/frontend_api_session.go#L240), also [:334](backend/frontend_api_session.go#L334) and [:362](backend/frontend_api_session.go#L362)

**Category:** `HasSession` false paths still emit, so each stray call triggers a spurious global list re-read on every surface. Cheap, but the emission contract elsewhere is "emit at success points".

**Fix:** a) emit only when a row was found/mutated; b) accept and document as an idempotent refresh.

### 135. CONSIDER — `attachFileContent` passes a base64 string where the generated binding declares `Array<number>`

**File:** [frontend/src/api/attachments.ts:99](frontend/src/api/attachments.ts#L99) vs [frontend/wailsjs/go/desktop/App.d.ts:30](frontend/wailsjs/go/desktop/App.d.ts#L30)

**Category:** the Go parameter is `[]byte` and the generated binding declares `Array<number>`, but the wrapper sends a base64 STRING; it works because `encoding/json` accepts base64 strings for `[]byte` on both bridges — a silent divergence from the generated contract that breaks the first caller going through the typed signature.

**Fix:** a) document the divergence at the `types/api.ts` boundary; b) send `Array<number>` to match the generated signature.

### 136. CONSIDER — Static handler serves directory listings for subdirectories without an `index.html`

**File:** [internal/webaccess/webaccess.go:317](internal/webaccess/webaccess.go#L317)

**Category:** `http.FileServerFS` renders directory indexes for paths like `/assets/`, exposing the unauthenticated SPA file manifest behind the (token-gated) sidecar. Informational only — the content ships to every logged-in client anyway — but unnecessary surface.

**Fix:** a) wrap the static `fs.FS` to reject directory requests; b) custom handler that resolves only file entries.

### 137. CONSIDER — `sameOrigin` trusts the client-sent `Host` header; an Origin==Host DNS-rebinding setup passes the check

**File:** [internal/webaccess/ws.go:198](internal/webaccess/ws.go#L198)

**Category:** defense-in-depth residual only — the host-scoped `SameSite=Strict` cookie still gates access, so a rebinding attacker without the cookie is rejected; noted so the reliance on cookie scoping is explicit.

**Fix:** a) additionally compare `r.Host` against the configured bind/loopback set; b) document the residual reliance on cookie scoping in the sameOrigin comment.

### 138. CONSIDER — New `ThemeSelector` dropdown test parks Radix's open with a real 10 ms delay promise

**File:** [frontend/src/components/settings/ThemeSelector.test.tsx:118](frontend/src/components/settings/ThemeSelector.test.tsx#L118)

**Category:** test timing. The open-wait uses `setTimeout(10)` real time; the project's sanctioned pattern for Radix open waits is the fake-timer helper in `frontend/src/test/virtualTime.ts` (timing rules discourage new real-delay debt).

**Fix:** a) port `openDropdown` to the virtualTime helper; b) keep as-is citing the existing harness precedent (tuningTestHarness).

### 139. CONSIDER — `historyLoaded` markers are not cleared on the single-session delete path, contradicting the store's own doc comment

**File:** [frontend/src/stores/chatStore.ts:707](frontend/src/stores/chatStore.ts#L707) (doc claim at [:132](frontend/src/stores/chatStore.ts#L132))

**Category:** cleanup asymmetry. The chatStore doc says the marker is "Cleared per session by dropSessions (session deletion)", but the only production `dropSessions` caller for chatStore is the project-delete cascade ([ProjectSelector.tsx:94](frontend/src/components/layout/ProjectSelector.tsx#L94)) — the common single delete ([useSessionActions.ts:191-207](frontend/src/hooks/useSessionActions.ts#L191-L207)) calls the sibling stores' `dropSessions` but not chatStore's, so the marker leaks per deleted session for the app lifetime. No functional consequence today (UUID ids are never reused and dead sessions are never active — cf. #103's recreated-id scenario, which this leak would feed if ids were ever reused); pass 7's delegate rated it SHOULD, the conductor downgraded to CONSIDER under the report's calibration (#103, with the actual skip-load consequence, is itself CONSIDER).

**Fix:** a) add `useChatStore.getState().dropSessions([id])` to `handleDelete` (covers stepContextFill + tokens + historyLoaded in one update); b) replace the `clearStepContextFill`+`clearScrollPosition` pair with a single `dropSessions` call; c) fix the doc comment to match reality.

### 140. CONSIDER — A failed `GetPendingActions` on an override-only pending row clears its bit, flickering the row until the next sweep re-flags it

**File:** [frontend/src/stores/activeSessionsStore.ts:223](frontend/src/stores/activeSessionsStore.ts#L223)

**Category:** documented deliberate tradeoff: the new re-poll filter re-asks override-only rows each sweep, and `applyPendingActions(id, null)` deletes the bit, so on an RPC failure the row loses its pending dot for one sweep interval and regains it on the next sweep. Worst case is a transient dot flicker on a failing backend; the doc comment names the tradeoff.

**Fix:** a) leave as-is (documented); b) on a null response skip the update instead of clearing the bit.

### Pass 7 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** #5, #6, #7 (rated MUST for a 4th time — kept SHOULD), #8, #57, #58, #80, #81, #82, #102 (re-rate to SHOULD declined — the quiesce `select` drains and asserts on events concurrently; it is a bounded-join watchdog, not an empty sleep, and #102's fix option (a) already covers the outer-deadline strengthening), the ADR-090 duplicate-number issue, the ADR-090 D6 gorilla→stdlib doc issue. **Extensions merged:** #66 (pass 7's "ServeTLS leaves h2 ALPN enabled → Hijack fails under TLS" is the same WS-under-TLS upgrade hazard with the same fix — the h2/ALPN trigger folded into #66's TLSNextProto/ALPN-regression-test remediation), #90 (CopyButton sync-revoke re-report), #97 (runtime.ts:504 emit-drop re-report), #111 (notifications.ts:58/:132/:171 direct `Notification.permission` reads bypassing `readNotificationPermission`), #2 (the `RefreshWebAccessLoadWarnings` configMu/webAccessMu reader-window re-report). **#123 extended** with the `frontend_api_config_test.go:4044` Windows-CI site (verified).

**Pass 7 additionally verified clean (selected):** webaccess auth core re-traced clean for the seventh pass (constant-time compares, per-launch cookie, rate limit, SameSite=Strict CSRF posture, denylist-before-reflection order, fan-out backpressure, stop/force-close bounds, panic isolation, atomic cert publication); inbound whitelist exactly mirrors the 7 wireWailsEventListeners subscriptions; hitl_resolved first-responder-wins preserved; control RPCs unreachable from the web dispatch surface; token mint/persist/rollback and TLS fail-closed paths as documented; SendMessage 13-arg order and 32 MiB cap parity re-confirmed; task_started exactly-once and transient whitelist entry re-confirmed; config load pipeline, normalizeWebAccess edge cases and every tested `config.example.yaml` claim re-verified against code; echo dedup identity-threading (optimisticId at both production send sites); clipboard false-verdict toasts; `generateUUID` insecure-context fix across 6 files; session list loading sentinels match the store; no viewport units / raw pointer anchors / selector allocations introduced; specs pass re-verified hitl_resolved/task_started/sessions:changed/message_received event rows, HITL whitelist, body caps, limiter, cookie flags, cert classes, CSP and all links.


## Pass 8 — independent full re-review (iteration 8, current 188-file diff)

Method: 12 blind read-only area subagents (same scope split as passes 5–7: internal/webaccess; desktop+main.go; backend api core; backend session; backend/config+config.example.yaml; fe api/wailsjs/types; fe chat/webaccess/project/papers; fe hooks; fe layout/git/review; fe settings; fe stores/lib/test; specs+AGENTS+SECURITY), explicit file lists embedded, blind constraint enforced (no access to this report or prior-pass artifacts), concise findings-only reports. Conductor dedupe against the full #1–#140 index + working-tree verification of every candidate. Diff scope re-confirmed unchanged: merge-base == main tip (114a5308), 188 files, 187/188 reviewed (binary favicon excluded).

### 141. SHOULD FIX — The new `sessions:changed` doc comment names creation emitters that do not exist

**File:** [backend/events.go:113](backend/events.go#L113)

**Category:** false documentation, added by this branch (the whole `EventSessionsChanged` doc block is new). The parenthetical claims the create sites are "the RPC, the SwitchProject fallback creation, and both managed-worktree creation paths". Verified against the working tree: exactly two production creation sites exist — the `CreateSession` RPC ([frontend_api_session.go:75](backend/frontend_api_session.go#L75)) and the SwitchProject fallback (`createSessionForProject`, [frontend_api_project.go:1230](backend/frontend_api_project.go#L1230)). `frontend_api_worktrees.go` contains no session-creation call — managed worktrees are created/bound around `ForkSession`, which the same sentence already lists separately as "fork (plain and managed)".

**Why it is a problem:** the comment is the event's contract. A developer implementing a new emitter or auditing emission coverage will hunt for two call sites that do not exist, and an auditor cross-checking the documented set against the real one concludes the doc cannot be trusted. Same defect class as #43 and #110 (doc claims contradicting the implementation), both rated SHOULD.

**Suggested fix:**
a) Drop "and both managed-worktree creation paths" from the parenthetical: "create (the RPC and the SwitchProject fallback creation)".
b) Alternatively reword to enumerate verified sites only and point fork-time tree creation at the fork clause.

### 142. CONSIDER — Login burns a rate-limit attempt before the body is parsed

**File:** [internal/webaccess/auth.go:157](internal/webaccess/auth.go#L157)

**Category:** `handleLogin` consumes a limiter attempt before reading/parsing the body, so any script or hostile page can drain the shared per-IP window (a single bucket on the loopback bind) with malformed requests and lock a legitimate user out of login for up to the window length.

**Fix:** a) count the attempt only after a parseable body carrying a token arrives; b) keep pre-parse consumption but exempt clearly-malformed requests from the count.

### 143. CONSIDER — The repeated-experimental-open "quiet" path still logs an Info line

**File:** [desktop/app.go:1189](desktop/app.go#L1189)

**Category:** the comment says a repeated experimental-gate open over an already-live sidecar is quiet, but `logWebAccessReady` then emits an Info "sidecar ready" line for the server that was already running.

**Fix:** a) skip the log when `startWebAccessLocked` returned the existing server; b) amend the comment to match behavior.

### 144. CONSIDER — The echo `IsNudge` flag and the persisted `is_nudge` stamp are set at two sites; only half the must-agree invariant is pinned

**File:** [backend/session/events.go:107](backend/session/events.go#L107)

**Category:** the manager sets the echo flag while `FrontendAPI` stamps the DB row from the returned classification — two sites that must agree, with the test pinning the agreement per-branch on the echo only.

**Fix:** a) add one test asserting the persisted stamp matches the echo classification for live/nudge/fresh sends.

### 145. CONSIDER — Token length counts bytes while the example documents "characters"

**File:** [backend/config/web_access.go:295](backend/config/web_access.go#L295)

**Category:** `len` counts bytes; `config.example.yaml` documents an "8–256 characters" range, so a multibyte token passes validation at half the documented length (and vice versa for the minimum).

**Fix:** a) use `utf8.RuneCountInString`; b) document the limit as bytes.

### 146. CONSIDER — `AttachFileContent` runs on `context.Background()`: the RPC is uncancellable

**File:** [backend/frontend_api_attachment.go:169](backend/frontend_api_attachment.go#L169)

**Category:** a long markitdown conversion during staging cannot be cancelled by app shutdown (the unchanged sibling `AttachFiles` shares the pattern).

**Fix:** a) derive the context from `f.ctx()` so shutdown cancels staging.

### 147. CONSIDER — `ChatArea.tsx` (235 lines) still exceeds the ≤200-line component target after the loader extraction

**File:** [frontend/src/components/chat/ChatArea.tsx](frontend/src/components/chat/ChatArea.tsx)

**Category:** project convention target; the extraction this branch performed reduced the file but left it over the line.

**Fix:** a) extract the empty/spinner render branch in a follow-up.

### 148. CONSIDER — `useShallowResync`'s schedule comment claims the last-scheduled trigger fires; the first one does

**File:** [frontend/src/hooks/useShallowResync.ts:43](frontend/src/hooks/useShallowResync.ts#L43)

**Category:** `schedule()` keeps the first timer and later triggers return early, so the comment describes debounce semantics the code does not implement.

**Fix:** a) fix the comment; b) restart the timer on later triggers if last-trigger semantics were intended.

### 149. CONSIDER — `initRuntimeProbe()` is a module-level side effect, deviating from the project's no-module-side-effects principle

**File:** [frontend/src/main.tsx:23](frontend/src/main.tsx#L23)

**Category:** self-acknowledged in a comment; load-bearing for the web transport's pre-render "checking" hold, but the exception exists only as a comment.

**Fix:** a) codify the bootstrap-entry exception in the frontend spec; b) move the call behind an explicit `init()` invoked from the entry point.

### 150. CONSIDER — WebAccessSettings test fixtures omit the required `tokenPinned` field

**File:** [frontend/src/components/settings/WebAccessSettings.test.tsx:44](frontend/src/components/settings/WebAccessSettings.test.tsx#L44)

**Category:** the `runningInfo`/`offInfo` fixtures bypass the `WebAccessInfo` contract they model, so a new required field cannot break their compilation the way the source's contract drift would.

**Fix:** a) type the fixtures as `WebAccessInfo` so drift fails compilation.

### 151. CONSIDER — A throwing `attach()` callback in `armWhenRuntimeReady` becomes an unhandled rejection

**File:** [frontend/src/lib/armWhenRuntimeReady.ts:56](frontend/src/lib/armWhenRuntimeReady.ts#L56)

**Category:** on the async probe path a throwing callback rejects an unobserved promise (the sync wails path propagates to the caller instead — asymmetric failure handling).

**Fix:** a) append `.catch` with a warn-level log to the arming chain.

### 152. CONSIDER — The added hitl_resolved rows drop the security-model diagram's two-space gutter

**File:** [specs/architecture/security-model.md:203](specs/architecture/security-model.md#L203)

**Category:** the new ASCII-flow rows are misaligned against the surrounding diagram.

**Fix:** a) realign the leading spaces.

### Pass 8 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** #1, #5, #6, #7 (rated MUST for a 5th time — kept SHOULD, 5 SHOULD ratings vs 5 MUST ratings across passes), #8, #15 (re-rate to SHOULD declined — doc-accuracy on a validated invariant stays CONSIDER per calibration), #16 (same decline), #28, #34 (re-rate declined — the implemented contract is deliberate and test-pinned), #37, #40, #41, #46, #50 (re-rate declined — a late resync overwrite is transient list staleness that self-heals on the next `sessions:changed`), #52 (the notifications.ts permission-read sites; fourth site :177 added below), #53, #56, #62, #67, #88, #90, #102, #107, #123 (both Windows-CI sites independently re-found — `web_access_test.go:759` and `frontend_api_config_test.go:4045`), #127 (the delegate's "pre-existing nudge ghost card" observation), #131, #139 (re-rate declined per the pass-7 calibration), the ADR-090 duplicate-number issue, the ADR-090 D6 gorilla→stdlib doc issue.

**Extensions merged:** #7 (the web-transport test asserts only the hint string, so the dead end ships green — same root cause, the fix necessarily rewrites the test), #28 (the extraction comment claiming the parent stays "under the 200-line target" while it is 463 lines), #52 (notifications.ts:177 added to the raw-read site list), #62 (stale Shift+click "native save-file dialog" docstring on the anchor-download path), #82 (ADR-090 decision 10 at [090-browser-web-access.md:39](specs/decisions/090-browser-web-access.md#L39) repeats the stale "refuses https://" claim — third doc site), #107 (the missing web branch also means a remote tab stages the *server's* clipboard content — stale/wrong attachment, not just a guaranteed failure), #131 (the exposure warning also misfires on an unvalidated non-IP bind — `WebAccessLoadWarnings` lacks a bind-validity gate, [web_access.go:332](backend/config/web_access.go#L332)).

**Pre-existing observations recorded, excluded from the numbered body (code unchanged by this diff, per the review scope):** a double-activation race in `sendMessage`'s second lock hold (`manager_execution.go:910` — the region sits in an untouched gap between the diff's hunks; two concurrent sends into one idle session can both activate, relevant only if the exactly-once contract is later extended to concurrent sends); impure `setSplashTools` updater in `App.tsx:239` (StrictMode double-invoke); sleep-poll in `startup_phases_test.go:321`; single-session-delete store-slice leak in `useSessionActions.ts:191` (the pre-existing base under #139); dead `.catch` in `ChatArea.tsx:109` (a consequence of #34's contract); `MCPServerForm` comma-arg splitting; `SystemNotificationSettings` mount-time probe; `persistConfig` announce-on-failure (the #84 family); main's own pre-existing duplicate ADR-090 pair.

**Pass 8 additionally verified clean (selected):** `RefreshWebAccessLoadWarnings`' "web_access" prefix-cut re-verified against every emitted warning shape (no other section shares the prefix) and the configMu→webAccessMu one-directional order held at every call site; `AttachFileContent` parity re-confirmed (32 MiB cap = `session.maxImageFileBytes`, mime map matches registered decoders, sanitization fails closed); webaccess auth core re-traced for the eighth pass (constant-time compare, per-launch cookie, rate limit, WS origin admission, control-frame handling, denylist order, atomic cert publication); SendMessage echo identity-threading verified on all three classifications (live/nudge set `IsNudge`, fresh/continuation unset) with the persisted-row stamp matching; `task_started` exactly-once at the single activation point with the persister transient-skip confirmed; `hitl_resolved` bypasses the persister as documented; `emitSessionsChanged` covers the full real mutation set; DTO/arity roundtrips re-confirmed (`clientSendId` at generated binding position 12, 13-arg tests); WS backoff exponential-capped and deterministic; 401 triggers the auth gate while rejecting the caller; base64 `[]byte` wire form deliberate and documented; new tests virtual-time/scoped-spy clean (no real delays, no missing mocks); specs links and INDEX consistent.


## Explicitly verified clean (selected, per area)

- **internal/webaccess + desktop glue:** fail-closed TLS chain (New refuses enabled-but-unloadable pair; hot-restart rollback; enable-flip preflight), ECDSA P-256 certgen (atomic publish, key-first, 0600/0644), token entropy/persistence/rotation (crypto/rand 32 B, digest-only logging, never in URLs), cookie matrix per transport (HttpOnly SameSite=Strict, Secure under TLS), constant-time login + rate limiting, WS cookie + exact same-origin admission (DNS-rebinding safe), frame codec enforcement, dispatch denylist + control-RPC isolation (pinned by tests), compound experimental gate at startup + live-follow, CSRF posture (SameSite=Strict + POST-only data routes), path traversal, header injection, races.
- **desktop (non-webaccess):** GPU watchdog lifecycle (ticker/defer, CAS idempotence, quitFn wired before start), startup phase ordering vs the embedded manifest contract, event batcher (no dropped/reordered events; double-delivery-safe dual registration), HITL resolver state machines.
- **backend/session + config:** no inline path containment anywhere in the diff (centralized `pathutil`/`config` helpers only), bind atomicity (single-statement guarded UPDATE), attachment-capture race protocol under both locks, config load/save fail-soft/fail-closed wiring, `config.example.yaml` ↔ struct parity, env `${VAR}` expansion not extended to new fields, embedded engine vocabulary fail-closed.
- **core/embeddedllm:** artifacts never under `tools/`; all mtplx URLs/digests compile-time pins verified fail-closed (verify-before-promote, staged swap); spawn hardening (list-form exec, env scrubbing, argv monopoly test, loopback-validated server); memory gate first-before-download; GiB math overflow-safe; effective-context clamp against the launched window; engine-aware stale-record detection; removal covers both engines' trees.
- **backend RPC surface:** DTO roundtrips complete (engine fields in status + generated models), tuning bounds delegated to the single authority (`ToTuning`/`limits.go`), busy gate HOLDER/READER semantics with correct release ordering, attachment sanitization + 32 MiB cap, generated `llm.openai_compatible.embedded` re-injection on load and save, crashlog redaction posture unchanged.
- **frontend:** zero `wailsjs` imports outside `src/api`; zoom-safety sweeps clean (no viewport units, no raw pointer anchors); Zustand selector discipline clean (no allocations in selectors, no dual bookkeeping, no module-level side effects); XSS surface unchanged (single sanitized `dangerouslySetInnerHTML`, pre-existing); no secrets in localStorage/persisted state; event-name registry matches backend; `generateUUID` correctly fixes the insecure-context `crypto.randomUUID` crash for the web transport; test suites intercept expected diagnostics at source (scoped spies, virtual time, no silencing).
- **specs:** all new ADRs indexed; consolidation annotated, zero dangling 091/093/094/095 web-access references; zero broken relative links across changed spec files; INDEX/AGENTS/SECURITY updates consistent with the implementation.
- **pass 2 (blind re-review) additionally verified clean:** `backend/frontend_api_embedded*` in depth (gate HOLDER/READER + cancel protocol, engine resolution fail-closed, tuning cross-check verbatim, config-sink field coverage, wire parity, conventions — no findings); worktree bind/unbind compensation protocol, `AttachFileContent` sanitization, `SendMessage` echo/arity, `sessions:changed` emission points; desktop locking (`webAccessMu` ordering, handle/tap publish order), control-RPC isolation triple-pin, GPU post-mortem ordering, HITL broadcast ordering, centralized path handling; `chatStore` history markers, `sessionWorkspaceStore` lifecycle, event-type/wire parity across `types/`, no secrets in persisted state; `wailsAccessInvariant` guard soundness; zoom/pointer-anchoring/stable-selector sweeps clean across all frontend areas; `config.example.yaml` ↔ struct parity for all new sections; security-review.md internally consistent with SECURITY.md.

## Pass 9 — independent full re-review (iteration 9, current 188-file diff)

Method: 12 blind read-only area subagents (same scope split as passes 5–8: internal/webaccess; desktop+main.go; backend api core; backend session; backend/config+config.example.yaml; fe api/wailsjs/types; fe chat/webaccess/project/papers; fe hooks; fe layout/git/review; fe settings; fe stores/lib/test; specs+AGENTS+SECURITY), explicit file lists embedded, blind constraint enforced (no access to this report or prior-pass artifacts), concise findings-only reports. Conductor dedupe against the full #1–#152 index + working-tree verification of every candidate. Diff scope re-confirmed unchanged: merge-base == main tip (114a5308), 188 files, 187/188 reviewed (binary favicon excluded).

### 153. SHOULD FIX — The frontend README's "exclusively via Wails IPC" claim and Wails-only architecture diagram are invalidated by this branch's dual-transport feature

**File:** [specs/domains/frontend/README.md:5](specs/domains/frontend/README.md#L5) and the Communication Pattern diagram at [~L203-215](specs/domains/frontend/README.md#L203-L215)

**Category:** false documentation — made false BY this branch. On `main` the Purpose sentence "Communicates with Go backend exclusively via Wails IPC" was true. The branch adds the browser transport (POST `/api/rpc` + WebSocket served by `internal/webaccess`), and the branch-new [loading-states.md](specs/domains/frontend/loading-states.md) itself states behavior is "identical in both transports (wails webview + web-access sidecar)" — while the domain README's Purpose paragraph still claims exclusivity and its architecture diagram shows only `window.go.desktop.App.*` / `window.runtime.EventsOn`, with no sidecar path. The branch also touched this very file (added the loading-states.md index line) without amending the claims its own feature invalidated.

**Why it is a problem:** same false-doc class as #43/#110/#141. A reader auditing transport exposure starting from the README — the domain's front door — is materially misled about the network-reachable surface: a security-relevant omission for the branch's flagship feature.

**Suggested fix:**
a) Reword the Purpose sentence around the `runtime.ts` transport seam: Wails IPC in the desktop webview; POST `/api/rpc` + WebSocket via the web-access sidecar in browser tabs (ADR-090).
b) Extend the Communication Pattern diagram with the transport seam (`src/api/*` wrappers above `runtime.ts`, which picks Wails vs sidecar per transport detection).

### 154. CONSIDER — Goal-proposal decision string is forwarded to the core gate unvalidated
**File:** [desktop/event_handlers.go:478](desktop/event_handlers.go#L478)
The plan-approval path validates its decision via `parsePlanApprovalDecision`; `handleGoalProposalResponse` forwards any non-empty string — reachable from both Wails events and the browser WS. **Fix:** a) validate against the accepted enum like the plan path.

### 155. CONSIDER — Tool-confirm Load-then-Delete window lets two simultaneous responses both broadcast `hitl_resolved`
**File:** [desktop/event_handlers.go:169](desktop/event_handlers.go#L169)
Two concurrent responses both pass the `Load` check before either deletes, so two `hitl_resolved` events with different decisions broadcast — contradicting the first-responder-wins comment (cosmetic dup on a multi-surface race). **Fix:** a) `sync.Map.LoadAndDelete` to make removal atomic with lookup.

### 156. CONSIDER — Batcher coalescing merge keeps the old sizeHint, under-counting pendingBytes past the envelope cap
**File:** [desktop/event_batcher.go:167](desktop/event_batcher.go#L167)
When a queued frame is replaced by a larger payload, the stale sizeHint can let pending bytes exceed the 256KB envelope cap before the overflow flush. **Fix:** a) add the size delta on merge.

### 157. CONSIDER — Session-logger close failure is logged through the logger that was just closed
**File:** [desktop/startup_phases.go:74](desktop/startup_phases.go#L74)
`maybeReinitLogger` reports the close failure via `current` — the logger wrapping the sink just closed — so the diagnostic is silently lost. **Fix:** a) log through the new logger or `slog.Default()`.

### 158. CONSIDER — Startup test polls an async emit with a 5ms sleep loop
**File:** [desktop/startup_phases_test.go:296](desktop/startup_phases_test.go#L296)
`TestBuildConfirmCallback_HappyPath` sleeps to await the emit — the project's timing rules bar sleep-to-sync in new tests. **Fix:** a) signal arrival via a channel from the `uiEmit` stub.

### 159. CONSIDER — Pre-existing: `!toolsOK` startup exit publishes the seed but emits no `EventStartupError`, and its comment misstates the condition
**File:** [desktop/startup.go:286](desktop/startup.go#L286)
Verified pre-existing: the block is unchanged on `main`. A config-resolution panic (the only `toolsOK=false` producer per [startup_phases.go:112](desktop/startup_phases.go#L112)) leaves the webview on the splash forever — unlike the `buildApplication` failure path, which emits `startup_error` — and the comment still blames "a failed first-run tool download". **Fix:** a) emit `EventStartupError` with the cause before returning and correct the comment; b) at minimum fix the comment.

### 160. CONSIDER — Map-form `task_complete` without an `output` key returns without persisting the terminal row
**File:** [backend/session/event_persister.go:118](backend/session/event_persister.go#L118)
The typed form persists a `"[Task completed]"` continuation row for empty outputs; the map form lacking `output` silently drops the terminal row, defeating that continuation-context guard. **Fix:** a) fall through to `role="assistant"`, `content="[Task completed]"` instead of returning.

### 161. CONSIDER — Pre-existing: `sendMessage`'s activation hold re-checks only `compacting`, so two concurrent fresh sends both activate
**File:** [backend/session/manager_execution.go:888](backend/session/manager_execution.go#L888)
Verified verbatim on `main` (the branch changed only the emitted payloads nearby): after the unlocked DB reads, the second hold re-checks just `compacting` — not `active`/`deleting`. Two concurrent fresh sends (double-send, desktop app + web tab) both pass, the second overwriting `session.cancel`/`session.done`: run #1 becomes uncancellable and two `HandleMessage` goroutines run concurrently on one orchestrator. `ResumeTask` re-checks all three flags in its single activation hold ([manager_execution.go:1594-1622](backend/session/manager_execution.go#L1594-L1622)) — `sendMessage` does not mirror it. **Fix:** a) add `session.active`/`session.deleting` rejections inside the same hold, mirroring `ResumeTask`.

### 162. CONSIDER — TLS pair probe runs `tls.LoadX509KeyPair` synchronously on every config load, unbudgeted
**File:** [backend/config/web_access.go:260](backend/config/web_access.go#L260)
A cert/key path on a hanging mount or FIFO blocks app startup unboundedly (deliberate fail-closed per ADR-092, but unbudgeted). **Fix:** a) bound the read/open with a non-blocking guard.

### 163. CONSIDER — Pre-existing: `DeleteProject` takes no `switchMu`, so a delete landing mid-`SwitchProject` can be activated
**File:** [backend/frontend_api_project.go:38](backend/frontend_api_project.go#L38)
Verified pre-existing on `main`: `SwitchProject` serializes via `acquireSwitchLock`, `DeleteProject` does not — a delete between `GetProjectCtx` and the activation commit lets the switch activate the deleted project (stale watcher/workspace, bogus `project:switched`). The branch's hunk in this function (vector release) neither introduces nor worsens the window. **Fix:** a) acquire `switchMu` (bounded, like `acquireSwitchLock`) in `DeleteProject`; b) re-validate the project still exists just before activation.

### 164. CONSIDER — `SetLogLevel` guards `f.app` but dereferences `Manager()` unguarded
**File:** [backend/frontend_api_config.go:1912](backend/frontend_api_config.go#L1912)
Sibling call sites check `Manager() == nil` before use. **Fix:** a) `if m := f.app.Manager(); m != nil { m.SetLogLevel(level) }`.

### 165. CONSIDER — `UpdateSearchSettings` swallows a `persistConfig` failure (warn-only, returns nil)
**File:** [backend/frontend_api_config.go:559](backend/frontend_api_config.go#L559)
The UI reports saved though the disk write failed; the value silently reverts on restart. Sibling `UpdateVectorIndexSettings` returns the error. **Fix:** a) return `fmt.Errorf("failed to persist search settings: %w", err)` like the vector path.

### 166. CONSIDER — Sleep-based negative assertions probe save-serialization overlap
**File:** [backend/frontend_api_config_test.go:4258](backend/frontend_api_config_test.go#L4258), [:5312](backend/frontend_api_config_test.go#L5312)
50ms/200ms sleeps probe overlap that `saveMu` plus the existing counter/order snapshots already make deterministic — new sleep debt per the timing rules. **Fix:** a) assert via the counter/order snapshots with enter-hook signals and explicit release barriers.

### 167. CONSIDER — `Init` doc claims "16 seed fields"; the critical section writes 19
**File:** [backend/frontend_api.go:586](backend/frontend_api.go#L586)
**Fix:** a) correct the count or say "all seed fields".

### 168. CONSIDER — `wsReadPump`'s `opPing`/`opPong`/`opClose` branches are unreachable dead code
**File:** [internal/webaccess/ws.go:363](internal/webaccess/ws.go#L363)
`readMessage` answers control frames internally and returns only text/binary ops, so the switch's other cases mislead readers. **Fix:** a) delete the dead branches.

### 169. CONSIDER — `isWorkUnitSettledData` never validates the declared optional `reason`
**File:** [frontend/src/types/events.ts:1317](frontend/src/types/events.ts#L1317)
Every neighboring new guard pins its optional strings. **Fix:** a) add `d.reason === undefined || typeof d.reason === 'string'`.

### 170. CONSIDER — `isHitlResolvedData` validates a phantom `total_count` field `HitlResolvedData` doesn't declare
**File:** [frontend/src/types/events.ts:1124](frontend/src/types/events.ts#L1124)
Copy-paste from `isPlanStepCompleteData`; dead validation that misleads readers. **Fix:** a) drop the `total_count` clause.

### 171. CONSIDER — `ChatAPI.sendMessage` in types/api.ts is stale and dead
**File:** [frontend/src/types/api.ts:31](frontend/src/types/api.ts#L31)
Declares a removed `mode` param and omits `activeMCPServers`/`e2s`/`goalBudget`/`reviewMode`/`clientSendId`/`workspace`; the interface is imported nowhere. **Fix:** a) resync or delete `ChatAPI`/`AttachmentAPI`.

### 172. CONSIDER — `isSessionRuntimeStatus` validates `active`/`has_unfinished_task` but not the declared-required `paused`
**File:** [frontend/src/api/chat.ts:292](frontend/src/api/chat.ts#L292)
The reconcile overlay reads `paused`; an undefined would collapse paused detection. **Fix:** a) add `typeof d.paused === 'boolean'`.

### 173. CONSIDER — `cancelAttachmentUpload`'s claim sweep discards the returned `retired` ids
**File:** [frontend/src/lib/attachmentUploads.ts:292](frontend/src/lib/attachmentUploads.ts#L292)
Sibling non-cancelled uploads that claim during the sweep never get `endUploads`, so their spinner chip keeps spinning until the whole staging batch settles. **Fix:** a) `endUploads(sessionId, claimLandedAttachments(sessionId, staged))` after the sweep.

### 174. CONSIDER — `goal_suggestion` attention classification is never asserted
**File:** [frontend/src/lib/systemNotifications.test.ts:184](frontend/src/lib/systemNotifications.test.ts#L184)
The distinct-title test lists 6 of the 7 attention cases; `goal_suggestion` (kind/title/body) is unasserted anywhere. **Fix:** a) add it to `attentionEvents` and expect 7 distinct titles.

### 175. CONSIDER — 30s judge timeout has no unmount cleanup in `ToolConfirmation`
**File:** [frontend/src/components/chat/ToolConfirmation.tsx:80](frontend/src/components/chat/ToolConfirmation.tsx#L80)
Resolving/dismissing mid-evaluation leaves the timer to setState into an unmounted component. **Fix:** a) clear `judgeTimeoutRef` in a `useEffect` cleanup.

### 176. CONSIDER — The no-session branch renders `<ChatInput/>` without the ErrorBoundary wrapper
**File:** [frontend/src/components/chat/ChatArea.tsx:119-131](frontend/src/components/chat/ChatArea.tsx#L119-L131)
Both other branches wrap the input shell in an ErrorBoundary with `resetKeys`; a crash in the bare branch escalates higher instead of showing the "Input error" fallback. **Fix:** a) reuse the same boundary wrapper in all three branches.

### 177. CONSIDER — `HTMLAnchorElement.prototype.click` spy is never restored in CopyButton tests
**File:** [frontend/src/components/chat/CopyButton.test.tsx:238](frontend/src/components/chat/CopyButton.test.tsx#L238)
`clearAllMocks` does not restore spies, so the no-op anchor click leaks to later tests in the file. **Fix:** a) `mockRestore()` in the web describe's `afterEach`.

### 178. CONSIDER — Pre-existing: `WorkDirsModal` commit/remove rejections are unhandled and invisible
**File:** [frontend/src/components/chat/WorkDirsModal.tsx:92-99](frontend/src/components/chat/WorkDirsModal.tsx#L92-L99)
Verified verbatim on `main`: `commit` awaits `onUpdate` in try/finally with no catch and `handleRemove` has neither — a failed RPC is an unhandled rejection with no user-visible error (unlike the add flow's `addError`). **Fix:** a) catch, log, and surface via the modal's error state.

### 179. CONSIDER — Pre-existing: `sensitivePathReason` is POSIX-only, so every advisory warning is dead on Windows
**File:** [frontend/src/components/chat/WorkDirsModal.tsx:30-45](frontend/src/components/chat/WorkDirsModal.tsx#L30-L45)
Verified verbatim on `main`: root block `=== '/'`, sensitive dirs `endsWith('/'+suffix)`, containment `startsWith(ws+'/')` — while picked paths are OS-native, so on Windows no advisory warning ever fires and `C:\` passes the root block (the backend's independent validation remains the backstop). **Fix:** a) normalize separators on `[\\/]` like `CreateProjectDialog.pathBasename`.

### 180. CONSIDER — `handleRegenerate` keeps the OLD token displayed after a successful rotation when the re-read fails
**File:** [frontend/src/components/settings/WebAccessSettings.tsx:259](frontend/src/components/settings/WebAccessSettings.tsx#L259)
`if (fresh) setInfo(fresh)` on a null re-read leaves the pre-rotation token in the Copy/masked field — a dead credential handed out with no staleness hint. **Fix:** a) on null, clear `tokenDraft`/reveal and show a "token changed but state unverified" slot; b) retry the read once first.

### 181. CONSIDER — Notification preview suppression reads the stale render-scope `permission` closure
**File:** [frontend/src/components/settings/SystemNotificationSettings.tsx:147](frontend/src/components/settings/SystemNotificationSettings.tsx#L147)
The first re-enable after a since-fixed denial resolves `'granted'` yet sends no confirmation banner because the closure `permission` is still `'denied'`. **Fix:** a) derive suppression from the outcome (or functional state) instead of the closure.

### 182. CONSIDER — Git history submenus open only on hover; keyboard cannot reach Create/Reset/Tag
**File:** [frontend/src/components/GitPanel/GitHistoryContextMenu.tsx:96](frontend/src/components/GitPanel/GitHistoryContextMenu.tsx#L96)
Items are `role=menuitem` buttons but no focus/keyboard path opens the submenus. **Fix:** a) also open on `onFocus`/ArrowRight of the trigger.

### 183. CONSIDER — Optimistic comment rollback can clobber a newer draft
**File:** [frontend/src/components/review/FileReviewBlock.tsx:27](frontend/src/components/review/FileReviewBlock.tsx#L27) (same pattern [HunkReviewBlock.tsx:57](frontend/src/components/review/HunkReviewBlock.tsx#L57), [ReviewHeader.tsx:120](frontend/src/components/review/ReviewHeader.tsx#L120))
If the save RPC fails after the user saved a newer draft elsewhere, `setFileComment(previous)` restores the pre-first-edit value over the newer one. **Fix:** a) restore only if the store value still equals the optimistic value.

### 184. CONSIDER — Pre-existing: stores.md "loaded flag" bullet contradicts the actual (and branch-documented) null-sentinel model
**File:** [specs/domains/frontend/stores.md:198](specs/domains/frontend/stores.md#L198)
Verified pre-existing on `main` (the bullet and `sessionStore.ts:75`'s `sessions: SessionInfo[] | null` are both unchanged): "stores that depend on backend data (sessionList, projectList) use a `loaded` flag" was already false. The branch's new [loading-states.md](specs/domains/frontend/loading-states.md) now documents the `sessions === null` sentinel in the same domain, making the stale sibling bullet visibly contradictory. **Fix:** a) reword the bullet to the null sentinel.

### Pass 9 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** #1, #5, #6, #7 (rated MUST for a 6th time — kept SHOULD), #8, #16 (re-rate SHOULD declined — comment-only drift), #34 (re-rate SHOULD declined — comment-only drift), #39, #41, #71, #82, #84, #102, #109, #113 (re-rate SHOULD declined — pre-existing bare `context.Background()`, calibration unchanged), #120, #123 (rated MUST for a 2nd time — kept SHOULD), #124 (re-rate SHOULD declined), #142, plus the pass-2 control-frame-size CONSIDER and the pass-3 hitl-converge-label CONSIDER. **Extensions merged:** #5 (pass 9 adds: the rollback comment is factually wrong — post-write the backend holds the NEW state — and the rollback contradicts the TLS block's keep-optimistic-on-null policy), #6 (Enter in one path field during the sibling's in-flight blur-commit hits `writeBusy` and is silently dropped), #48 (`stageAttachmentFiles`' web loop and `useFileDrop`'s web branch are untested — the harness mocks pin `isWebTransport: false`), #106 (pass-9 re-report confirms the Android gap; notes the surrounding catch limits it to a silent no-banner rather than a crash), #142 (no-cors cross-origin POST spam from any web page burns the shared loopback bucket → sustained 429 lockout of the real user's login; the SHOULD re-rate was declined — same site and mechanism as filed).

**Conductor-verified pre-existing findings (filed as marked CONSIDERs, calibration per #113/#127):** #161 `sendMessage` activation re-check gap (verbatim on `main`; `ResumeTask` contrasts), #163 `DeleteProject` vs `switchMu` (verbatim on `main`), #159 `startup.go` `!toolsOK` silence + stale comment (block unchanged on `main`), #178 `WorkDirsModal` unhandled rejections and #179 POSIX-only advisory checks (verbatim on `main`), the `useReviewActions` empty-diff prune conflation (`validFiles` guards pre-date the branch — folded into the #109-adjacent pre-existing class, not numbered separately), the `isPlanStepPausedData` duration-type-guard gap (verbatim on `main`, including the sibling comment naming it as symmetric — folded into the same pre-existing class), #184 stores.md `loaded flag` (verbatim on `main`).

**Pass 9 additionally verified clean (selected):** `EventTaskStarted`'s doc matches the code (the lifecycle-mirror list is exact; the resume path emits `task_resumed`+`session_resumed`, never `task_started`) and `emitSessionsChanged` covers every list mutation its doc names, pinned by `frontend_api_sessions_changed_test.go` — corroborating that pass 8's #141 fix class is otherwise clean; the webaccess security core re-confirmed for the ninth pass (auth gating, denylist-before-reflection, fail-closed TLS/nil-dispatch, body caps applied before allocation, client-mask enforcement, atomic cert publication, Secure-cookie TLS coupling, panic isolation); `config.example.yaml` web-access block defaults consistent with code; SendMessage 13-arg wire parity and the base64 `[]byte` mapping re-confirmed; `wailsAccessInvariant` uses a real TS parser with comment masking; transport detection never rejects (so `armWhenRuntimeReady`'s fire-and-forget cannot go unhandled); `useSessionLoader` fetchSeq supersession and `useShallowResync` debounce/race guards race-safe; chatStore selectors referentially stable; zoom-safety and selector sweeps clean across all frontend areas; specs INDEX lists all new specs, all relative links resolve, SECURITY.md's web-access threat-model entry present and consistent.



## Pass 10 — independent full re-review (iteration 10, final saturation pass)

Method: 12 blind read-only area subagents (same scope split as passes 5–9: internal/webaccess; desktop+main.go; backend api core; backend session; backend/config+config.example.yaml; fe api/wailsjs/types; fe chat/webaccess/project/papers; fe hooks; fe layout/git/review; fe settings; fe stores/lib/test; specs+AGENTS+SECURITY), explicit file lists embedded, blind constraint enforced (no access to this report or prior-pass artifacts), concise findings-only reports. Conductor dedupe against the full #1–#184 index + working-tree verification of every candidate. Diff scope re-confirmed unchanged: merge-base == main tip (114a5308), 188 files, 187/188 reviewed (binary favicon excluded).

**Result: zero new MUST FIX, zero new SHOULD FIX.** Coverage was complete: all 12 subagents reported FILES REVIEWED = full scope / FILES SKIPPED = none (14+16+10+11+7+19+19+24+22+12+18+15 = 187 files).

### Pass 10 new findings (all CONSIDER)

### 185. CONSIDER — Web-RPC rejection envelope is an `Error` object; the module's own comment documents a bare-string rejection

**File:** [frontend/src/api/runtime.ts:305](frontend/src/api/runtime.ts#L305)

**Category:** contract drift on a branch-new path. The web-RPC wrapper's doc block ([runtime.ts:249](frontend/src/api/runtime.ts#L249)) says the browser shim "rejects its Promise with the `error` string", but `webRpc` throws `new Error(msg)` — desktop Wails rejections are string-shaped, so `err instanceof Error` branches and `String(err)` rendering ("Error: " prefix) diverge per transport. Cosmetic; no functional caller inspects the envelope shape today.

**Suggested fix:**
a) Reject with the plain string to match the comment.
b) Reword the comment to document the Error envelope.

### 186. CONSIDER — Web-transport explanation lives in `title` on a `disabled` button, so web users see an unexplained dead control

**File:** [frontend/src/components/chat/WorkDirsModal.tsx:341](frontend/src/components/chat/WorkDirsModal.tsx#L341)

**Category:** unreachable hint. The "Add directory" button carries the web-transport reason ("needs the desktop app (native folder dialog)") in its `title` attribute and is `disabled={isWebTransport()}` — browsers suppress tooltips on disabled controls (no pointer events), so a web user sees an unexplained dead button and never the explanation.

**Suggested fix:**
a) Render the reason as visible hint text when `isWebTransport()`.
b) Use an `aria-disabled` pattern that keeps the element hoverable/focusable.

### 187. CONSIDER — `specs/domains/web-access.md` repeats identical ADR citations twice in the Configuration paragraph

**File:** [specs/domains/web-access.md:174](specs/domains/web-access.md#L174)

**Category:** copy-paste residue in a branch-new spec. Two adjacent duplicated citation pairs — "([ADR-092](…), [ADR-092](…))" after the LIVE-warning sentence and again at "The `tls:` subsection ([ADR-092](…), [ADR-092](…))".

**Suggested fix:** drop the duplicates.

### Pass 10 dedupe and corroboration

- **Rating disagreements on existing issues (all declined after conductor re-verification, per the report's established calibration):** #7 (CreateProjectDialog web dead end) rated MUST for a 7th time and #40 (duplicate ADR-090) for a 3rd time and #123 (Windows-CI error-substring pins) for a 3rd time — all stay SHOULD (nothing lost or exposed; the rationale recorded at their entries stands). #58 (slow-POST, no body-read deadline) re-rated SHOULD for a 2nd time — stays CONSIDER (materializes only on a deliberately chosen non-loopback bind; the defensible-omission note recorded at #15/#58 stands). #76/#95 (endless sessions skeleton) and #139 (historyLoaded not cleared on single-session delete) re-rated SHOULD — stay CONSIDER (UX-only, self-healing triggers recorded; #139's fix option already names the `dropSessions` consolidation). #44 was this time rated CONSIDER by its delegate — the report keeps its SHOULD (the long non-heal window rationale stands).
- **Known issues re-confirmed:** #8 (byName staging collision), #15 ("after trimming" doc), #41 (ADR-090 D6 gorilla claim), #45 (extended: the delegate added that documents have no input bound at all — markitdown caps conversion OUTPUT only — sharpening the parity claim), #49 (failed_steps dropped), #81 (macOS denial→neutral wipe), #104 (task_cancelled unvalidated), #105 (TLS LAN bind warning-free, exact restatement), #111 (double close frame), #134 (spurious sessions:changed on unknown ids), and the stale `ChatAPI`/`AttachmentAPI` interfaces recorded under the pass-9 api.ts entry.
- **Pass 10 additionally verified clean (selected):** desktop web-access section re-traced clean for the tenth pass (single-writer cfg seam without lock cycles, stop/restart rollback ordering, mint-before-start persistence, experimental-gate live-follow idempotency, cert-status classification order, RFC 6125 SAN separation, 7-event inbound whitelist with control RPCs unreachable, plan-approval strict-validation hardening verified as deliberate and frontend-union-exact); `UpdateExperimentalFeatures` persist-failure rollback tested; lock-order audit found no ABBA (configMu→webAccessMu one-way); the `web_access` warning-prefix filter proven collision-free; attachment staging parity (0o600 temp, sanitize, oversize); sessions:changed emit sites and task_started exactly-once re-confirmed; echo-text/ClientSendID wiring end-to-end; load-pipeline order (ApplyDefaults→normalizeWebAccess→validate) and Save fail-closed gate re-verified; webaccess auth core re-verified for the tenth pass (cookie-gate first makes the sameOrigin Host-echo unreachable to cross-origin attackers, SameSite=Strict CSRF posture, limiter + constant-time compares, fail-closed TLS, denylist-before-reflection, fan-out backpressure); FE api SendMessage 13-arg parity, notification click payload guard; hooks hitl_resolved decision mapping against the Go emitter, fetchSeq/debounce race guards; stores sweep filter semantics, copy-on-write marker updates, generateUUID v4 fallback bits; specs producers/payloads confirmed in code (event whitelist, caps, limiter, outbox, certgen, CSP, gate conjunction).



## Saturation tracker

| Pass | Scope | New MUST FIX | New SHOULD FIX | Status |
| --- | --- | --- | --- | --- |
| 1 (area reviews, 12× parallel + conductor verification) | full diff, all 305 files | 0 | 8 | aggregated (this report) |
| 2 (full re-review — 13 blind area subagents, one re-run; conductor dedupe + verification) | full diff, all 305 files | 0 | 6 new (#39–#44) + #27 re-rated SHOULD | aggregated (this report) |
| 3 (full re-review — 13 blind area subagents; conductor dedupe + verification incl. Go-stdlib source check) | full diff, all 305 files | 1 candidate → **rejected** (downgraded to SHOULD #66 after verification) | 6 new (#66–#71) + #52 re-rated SHOULD | aggregated (this report) |
| 4 (full re-review — 13 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification; 20 issues re-scoped to the annex after the mid-review merge) | full current diff, all 188 files | 1 rating disagreement on an existing issue (#7 rated MUST by one pass; kept SHOULD) | 4 new (#80–#83) + 4 extensions merged into #1/#2/#6/#37 | aggregated (this report) |
| 5 (full re-review — 12 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification of every new candidate) | full current diff, all 188 files | 0 candidates (2 rating disagreements on existing issues — #7 and #40 rated MUST; both kept SHOULD) | 6 new (#105–#110) + #90 re-rated SHOULD + 3 extensions merged into #2/#3/#48 | aggregated (this report) |
| 6 (full re-review — 12 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification of every new candidate; 187/188 files, binary favicon excluded) | full current diff, all 188 files | 0 candidates (1 rating disagreement on an existing issue — #7 rated MUST for a third time; kept SHOULD) | 1 new (#123) + 5 new CONSIDER (#124–#128) + 6 extensions merged into #8/#13+#58/#28/#56/#84/#94/#97 | aggregated (this report) |
| 7 (full re-review — 12 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification of every new candidate; 187/188 files, binary favicon excluded) | full current diff, all 188 files | 0 candidates (1 rating disagreement on an existing issue — #7 rated MUST for a 4th time; kept SHOULD; #102 SHOULD re-rate declined) | 1 new (#129) + 11 new CONSIDER (#130–#140) + 4 extensions merged into #66/#90/#97/#111/#2 + #123 extended with a second Windows-CI test site | aggregated (this report) |
| 8 (full re-review — 12 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification of every candidate; 187/188 files, binary favicon excluded) | full current diff, all 188 files | 0 candidates (5 rating disagreements on existing issues — #7 rated MUST for a 5th time; #15/#16/#34/#50/#139 re-rated SHOULD; all kept at current severity after re-verification) | 1 new (#141) + 11 new CONSIDER (#142–#152) + 7 extensions merged into #7/#28/#52/#62/#82/#107/#131 | aggregated (this report) |
| 9 (full re-review — 12 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification of every candidate; 187/188 files, binary favicon excluded) | full current diff, all 188 files | 0 candidates (2 rating disagreements on existing issues — #7 rated MUST for a 6th time and #123 for a 2nd; both kept SHOULD) | 1 new (#153) + 31 new CONSIDER (#154–#184, 7 conductor-verified pre-existing and marked) + 5 extensions merged into #5/#6/#48/#106/#142 | aggregated (this report) |
| 10 (final full re-review — 12 blind area subagents over the current 188-file diff; conductor dedupe + working-tree verification of every candidate; 187/188 files, binary favicon excluded) | full current diff, all 188 files | 0 candidates (3 rating disagreements on existing issues — #7/#40/#123 rated MUST again; all kept SHOULD) | **0 new** (3 new CONSIDER #185–#187; 3 SHOULD re-rates declined — #58/#76+#95/#139 stay CONSIDER; 11 known issues re-confirmed; #45 extended) | **aggregated (this report) — SATURATION REACHED** |

The stop condition — a final full re-review pass producing no new MUST FIX / SHOULD FIX beyond this report — has been **reached**: pass 10 (a blind, independent re-review of the entire 188-file diff by 12 area subagents under the same scope split and blind constraints as passes 5–9) produced zero new MUST FIX and zero new SHOULD FIX findings; every MUST/SHOULD candidate it raised mapped onto an issue already in this report, and its only net-new findings were three CONSIDERs (#185–#187). The review is closed at **187 issues: 0 MUST FIX, 37 SHOULD FIX (33 in-scope + 4 annex), 150 CONSIDER (134 in-scope + 16 annex)**.
