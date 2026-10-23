# Code Review — CONSIDER (importance-sorted working list)

> Branch `ui/web` vs `main`, scope `git diff main...HEAD` (188 files). Review status: saturation reached — the review is closed. **148 entries** (132 in-scope + 16 out-of-scope annex; entries 10, 14, 56 are folded facets of entries 9, 13, 55). Numbering is local to this list: 1–148, importance-descending.

**Cross-references.** Bare `#n` refers to entry n in this list. `SF #n` = entry n in the SHOULD FIX list; `CS #n` = entry n in the CONSIDER list.

**Sort scheme (descending importance).** Key: (1) impact class — `S` security posture/exposure → `B` guaranteed breakage or data/config loss → `R` races, resource and reliability hardening → `F` functional degradation / recoverable UX → `D` documentation, spec or comment contradictions → `T` test/CI-only defects → `H` code hygiene; (2) evidence strength — `E1` an independent pass rated the issue MUST (kept SHOULD) or proposed a SHOULD re-rate (kept CONSIDER), both declined after conductor re-verification per the review's calibration → `E2` corroborated by a later blind pass → `E3` single-pass finding; (3) branch-new before pre-existing on `main`. Impact dominates: a single-pass security gap ranks above a thrice-MUST-rated UX papercut.

**Folded companion entries.** Entries 10, 14, 56 (CONSIDER) are folded facets of 9, 13, 55 respectively — same mechanism / same sites; each sits directly after its parent entry. The CONSIDER facets of two SHOULD-graded mechanisms live in the should-fix list instead: SF #26 (folded into SF #25) and SF #24 (folded into SF #23).

---

### 1. CONSIDER — Login burns a rate-limit attempt before the body is parsed

*(Origin: pass 8 · Impact class: S — security posture / exposure · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [internal/webaccess/auth.go:157](internal/webaccess/auth.go#L157)

**Category:** `handleLogin` consumes a limiter attempt before reading/parsing the body, so any script or hostile page can drain the shared per-IP window (a single bucket on the loopback bind) with malformed requests and lock a legitimate user out of login for up to the window length.

**Fix:** a) count the attempt only after a parseable body carrying a token arrives; b) keep pre-parse consumption but exempt clearly-malformed requests from the count.

---

### 2. CONSIDER — `getWebAccessInfo` logs the raw payload (including the access token) to the console on a shape mismatch

*(Origin: pass 1 · Impact class: S — security posture / exposure · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/api/webAccess.ts:117](frontend/src/api/webAccess.ts#L117)
**Category:** security / logging hygiene. `logger.error('...unexpected response shape', raw)` serializes the whole payload — whose `token` field is the sidecar login credential — into the console whenever the parser rejects (e.g. future DTO drift). Bounded: console is local and unpersisted, and the same user can read the token in Settings.
**Fix:** a) Log a redacted summary (keys + `typeof`). b) Drop the payload entirely from the log call.

---

### 3. CONSIDER — `mlxChildEnv`'s scrub misses `DYLD_*`/`LD_*` steering variables

*(Origin: pass 3 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: S — security posture / exposure · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/server_mlx.go:241-244](core/embeddedllm/server_mlx.go#L241-L244)
**Category:** hardening nuance (the operator's own env is the threat, same trust level as llama's full inheritance). `DYLD_INSERT_LIBRARIES`/`DYLD_LIBRARY_PATH` (darwin — the engine's only host) and `LD_*` pass into the pinned interpreter, so the documented "operator environment cannot steer them" invariant (ADR-090 D1) is narrower than implemented.
**Fix:** a) Scrub `DYLD_*`/`LD_*` in the same switch. b) Set `DYLD_*` to the pinned lib dirs and document the residual.

---

### 4. CONSIDER — `webAccessCertCoversHost` ignores wildcard DNS SANs

*(Origin: pass 4 · Impact class: S — security posture / exposure · Evidence: E3 — single-pass finding)*

**File:** [desktop/app.go:1517](desktop/app.go#L1517)
**Category:** fail-noisy misclassification (safe direction). DNS coverage is exact `EqualFold` only; a wildcard SAN (`*.example.com`) covering the bind's host is reported as `cert_status: "mismatch"` with "regenerate" guidance for a pair browsers would accept.
**Fix:** a) Implement the RFC 6125 wildcard suffix rule for DNS SANs. b) State the exact-match-only scope in `CertDetail` so the operator isn't told to regenerate a valid pair.

---

### 5. CONSIDER — Static handler serves directory listings for subdirectories without an `index.html`

*(Origin: pass 7 · Impact class: S — security posture / exposure · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/webaccess.go:317](internal/webaccess/webaccess.go#L317)

**Category:** `http.FileServerFS` renders directory indexes for paths like `/assets/`, exposing the unauthenticated SPA file manifest behind the (token-gated) sidecar. Informational only — the content ships to every logged-in client anyway — but unnecessary surface.

**Fix:** a) wrap the static `fs.FS` to reject directory requests; b) custom handler that resolves only file entries.

---

### 6. CONSIDER — `sameOrigin` trusts the client-sent `Host` header; an Origin==Host DNS-rebinding setup passes the check

*(Origin: pass 7 · Impact class: S — security posture / exposure · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/ws.go:198](internal/webaccess/ws.go#L198)

**Category:** defense-in-depth residual only — the host-scoped `SameSite=Strict` cookie still gates access, so a rebinding attacker without the cookie is rejected; noted so the reliance on cookie scoping is explicit.

**Fix:** a) additionally compare `r.Host` against the configured bind/loopback set; b) document the residual reliance on cookie scoping in the sameOrigin comment.

---

### 7. CONSIDER — `writeFileAtomic` never fsyncs the parent directory after the rename

*(Origin: pass 4 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [internal/webaccess/certgen.go:184-205](internal/webaccess/certgen.go#L184-L205)
**Category:** durability hardening of a security artifact. Staged files are fsync'd, but the directory entry is not synced after `os.Rename`, so a power loss can revert the rename or land the mixed state (new key + old cert). The mixed state is already handled fail-closed (mount refuses; regeneration documented) — no correctness hole.
**Fix:** a) After both renames, open the directory and `f.Sync()` once. b) Document the residual window next to the existing crash-between-renames paragraph.

---

### 8. CONSIDER — `attachFileContent` passes a base64 string where the generated binding declares `Array<number>`

*(Origin: pass 7 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/api/attachments.ts:99](frontend/src/api/attachments.ts#L99) vs [frontend/wailsjs/go/desktop/App.d.ts:30](frontend/wailsjs/go/desktop/App.d.ts#L30)

**Category:** the Go parameter is `[]byte` and the generated binding declares `Array<number>`, but the wrapper sends a base64 STRING; it works because `encoding/json` accepts base64 strings for `[]byte` on both bridges — a silent divergence from the generated contract that breaks the first caller going through the typed signature.

**Fix:** a) document the divergence at the `types/api.ts` boundary; b) send `Array<number>` to match the generated signature.

---

### 9. CONSIDER — No server-side bound on concurrent connections or slow-body reads; only header-read is timed

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [internal/webaccess/webaccess.go:109-110](internal/webaccess/webaccess.go#L109-L110), [374-447](internal/webaccess/webaccess.go#L374-L447)
**Category:** performance/security (resource exhaustion). `ReadHeaderTimeout` + `IdleTimeout` set, but no `ReadTimeout`/`WriteTimeout` and no connection cap: a client can trickle a body indefinitely, pinning goroutines (~8 KB each); hijacked WS conns have no idle reap (documented stage-2 gap). Materializes only on a deliberately chosen non-loopback bind; omitting `ReadTimeout` is defensible to protect the 48 MiB upload path.
**Fix:** a) Generous `ReadTimeout` (10-15 min) or a per-request `SetReadDeadline` after headers sized from the upload cap. b) Counting-semaphore connection cap in `recoverWrap`. c) Accept for stage 1, recorded beside the stage-2 keepalive note.

---

**Folded companion entry #10 (pass 2, CONSIDER) — same missing server-side body-read bound on the same server paths — pass 6/7 dedupe already carried these as one pair (#9+#10):**

### 10. CONSIDER — Request bodies are read with no time bound (slow-POST on the unauthenticated login route)

**File:** [internal/webaccess/webaccess.go:386](internal/webaccess/webaccess.go#L386)
**Category:** resource exhaustion (server-side sibling of #17). `readAllLimited` caps bytes, not rate; a client can drip ≤1 MiB login bodies indefinitely, pinning a goroutine per connection on a non-loopback bind.
**Fix:** a) Arm a per-request read deadline before body reads (cleared after the WS hijack). b) Document beside the existing slowloris note.

---

### 11. CONSIDER — `useShallowResync` writes the session list outside `useSessionLoader`'s fetch ordering

*(Origin: pass 2 · Impact class: R — races, resource and reliability hardening · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [frontend/src/hooks/useShallowResync.ts:76](frontend/src/hooks/useShallowResync.ts#L76)
**Category:** race (transient, self-healing). The resync's own `listSessions()` bypasses the loader's `fetchSeq`, so an older response can overwrite a fresher post-mutation list until the next `sessions:changed`/focus trigger (≥5 s).
**Fix:** a) Share one fetch-generation token between loader and resync. b) Document the bounded staleness.

---

### 12. CONSIDER — The task-started test's quiesce loop has no overall deadline

*(Origin: pass 4 · Impact class: R — races, resource and reliability hardening · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [backend/session/manager_task_started_test.go:66-76](backend/session/manager_task_started_test.go#L66-L76)
**Category:** test robustness. The "no further lifecycle events" join loop exits only on a 200 ms quiet window with no cap on total duration — a stream firing more often than every 200 ms spins forever (hang, not clean failure), while a duplicate landing >200 ms after the last event slips past (false pass).
**Fix:** a) Bound the quiesce phase with an outer `time.After(2 * time.Second)` case that `t.Fatalf`s, keeping the 200 ms window as the success exit. b) Wait deterministically for the epilogue-tail event the comment names (`agent_metrics`), then assert no lifecycle event behind it.

---

### 13. CONSIDER — `markHistoryLoaded` can resurrect a just-deleted session's marker

*(Origin: pass 4 · Impact class: R — races, resource and reliability hardening · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [frontend/src/lib/sessionHistoryReload.ts:58-64](frontend/src/lib/sessionHistoryReload.ts#L58-L64)
**Category:** narrow cleanup race. `isCancelled()` detects only a session SWITCH, not deletion: a history load for session X in flight when X is deleted passes `dropSessions`' synchronous `historyLoaded` cleanup, and if the RPC settles after the sweep but before the effect cleanup/active-session check flips, the finally re-adds an orphan marker — defeating the cleanup's purpose (a recreated session with a reused id would read "already loaded" and skip its history load).
**Fix:** a) In the finally, mark only if the session still exists in the session catalog. b) Make `markHistoryLoaded` a no-op for ids unknown to the catalog.

---

**Folded companion entry #14 (pass 7, CONSIDER) — same historyLoaded marker-cleanup integrity defect — #13 is the in-flight race, #14 the systematic single-delete leak; each cites the other:**

### 14. CONSIDER — `historyLoaded` markers are not cleared on the single-session delete path, contradicting the store's own doc comment

**File:** [frontend/src/stores/chatStore.ts:707](frontend/src/stores/chatStore.ts#L707) (doc claim at [:132](frontend/src/stores/chatStore.ts#L132))

**Category:** cleanup asymmetry. The chatStore doc says the marker is "Cleared per session by dropSessions (session deletion)", but the only production `dropSessions` caller for chatStore is the project-delete cascade ([ProjectSelector.tsx:94](frontend/src/components/layout/ProjectSelector.tsx#L94)) — the common single delete ([useSessionActions.ts:191-207](frontend/src/hooks/useSessionActions.ts#L191-L207)) calls the sibling stores' `dropSessions` but not chatStore's, so the marker leaks per deleted session for the app lifetime. No functional consequence today (UUID ids are never reused and dead sessions are never active — cf. #13's recreated-id scenario, which this leak would feed if ids were ever reused); pass 7's delegate rated it SHOULD, the conductor downgraded to CONSIDER under the report's calibration (#13, with the actual skip-load consequence, is itself CONSIDER).

**Fix:** a) add `useChatStore.getState().dropSessions([id])` to `handleDelete` (covers stepContextFill + tokens + historyLoaded in one update); b) replace the `clearStepContextFill`+`clearScrollPosition` pair with a single `dropSessions` call; c) fix the doc comment to match reality.

---

### 15. CONSIDER — `ForkSession` store round-trips use `context.Background()`, bypassing the file's own `storeOpCtx` bound (pre-existing)

*(Origin: pass 5 · Impact class: R — races, resource and reliability hardening · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification · pre-existing on main)*

**File:** [backend/frontend_api_session.go:102](backend/frontend_api_session.go#L102)
**Category:** unbounded pool wait (pre-existing code, flagged by the saturation pass because the diff touches this function). The file header mandates every direct `f.store` call on an RPC path go through `storeOpCtx()` (15 s pool-wait bound + shutdown cancellation); `ForkSession` passes `context.Background()` to the guard reads and the transactional fork. All stores share the app's single pool, so a contended pool parks the RPC and shutdown cannot cancel it. Trigger: contended pool + user clicks Fork.
**Fix:** a) Derive the two guard reads from `storeOpCtx()` and give the transactional fork its own explicit `context.WithTimeout`. b) Wrap only the guard reads and file the unbounded fork as reviewed timing debt. c) Document the exception in the `storeOpCtx` contract comment.

---

### 16. CONSIDER — `hitl_resolved` can broadcast a decision that was dropped, violating the "effective decision" contract

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [desktop/event_handlers.go:197-222](desktop/event_handlers.go#L197-L222) (same pattern at [395-419](desktop/event_handlers.go#L395-L419), [632-649](desktop/event_handlers.go#L632-L649))
**Category:** bug (corner case) / behavior. The buffered-channel send is best-effort: on `default` (channel full) the response is logged as dropped, but the pending entry is still deleted, the persisted message resolved with the dropped `decision`, and `emitHitlResolved` still broadcasts it — the event's contract (and test) say the payload carries the EFFECTIVE first-responder decision. Sub-second races only; cosmetic convergence lie, never agent-side.
**Fix:** a) In the dropped branch emit an empty `decision` (payload already treats "" as "no effective answer"). b) Move `emitHitlResolved` into the successful-send path only.

---

### 17. CONSIDER — `webAccessLogin` / `webRpc` fetches carry no timeout

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/api/webAccess.ts:352-357](frontend/src/api/webAccess.ts#L352-L357); [frontend/src/api/runtime.ts:301-312](frontend/src/api/runtime.ts#L301-L312)
**Category:** robustness. A sidecar that accepts TCP but stalls leaves the login gate (first screen a fresh tab shows) or the RPC pending until the browser stack's own long timeout. Desktop-transport Wails RPCs are equally unbounded — behavior parity rather than a regression.
**Fix:** a) `signal: AbortSignal.timeout(15_000)` in both fetches, mapping `TimeoutError` to the existing operator-actionable errors. b) At minimum timeout `webAccessLogin` only.

---

### 18. CONSIDER — `browserFilePicker` leaks its hidden `<input>` on engines that never deliver `cancel`

*(Origin: pass 2 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/lib/browserFilePicker.ts:36-43](frontend/src/lib/browserFilePicker.ts#L36-L43)
**Category:** resource hygiene (cosmetic/memory-level). `input.remove()` runs only from `change`/`cancel`; on engines without cancel support each dismissed picker leaves one dead hidden input on `<body>`.
**Fix:** a) Also finish via a one-shot guarded `window` `focus` listener after `input.click()`. b) Accept and document next to the existing cancel caveat.

---

### 19. CONSIDER — WS control frames over 125 bytes are accepted and their payloads echoed as pongs

*(Origin: pass 2 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [internal/webaccess/ws.go:465](internal/webaccess/ws.go#L465) (echo at [:363](internal/webaccess/ws.go#L363), [:393](internal/webaccess/ws.go#L393))
**Category:** protocol conformance/hardening. RFC6455 §5.5 forbids control frames >125 B (and fragmenting them, which the lenient path also tolerates). Impact immaterial: bounded memory, authenticated peer, browsers ignore pong payloads.
**Fix:** a) Reject `length > 125` for control opcodes with `errWSProtocol`. b) Cap the echoed pong payload.

---

### 20. CONSIDER — `sanitizeAttachmentName` lets Windows reserved device names through to `os.WriteFile`

*(Origin: pass 3 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [backend/frontend_api_attachment.go:41](backend/frontend_api_attachment.go#L41)
**Category:** robustness (Windows-only). A browser-supplied `nul.png` survives the separator/dot strip; on Windows the write targets a device (bytes discarded or error) and the attachment stages from a bogus path. Trigger: web-surface upload with a reserved basename (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
**Fix:** a) Reject reserved basenames after the separator strip. b) Underscore-escape them (`nul_.png`).

---

### 21. CONSIDER — `task_cancelled`'s payload is typed required but never boundary-validated

*(Origin: pass 4 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/types/events.ts:676](frontend/src/types/events.ts#L676) with [:239-241](frontend/src/types/events.ts#L239-L241)
**Category:** boundary-guard gap (latent). The same diff added `isHitlResolvedData`/`isMessageReceivedData` and updated `isErrorData`/`isTaskCompleteData`, but no `isTaskCancelledData` exists; the transport even permits payload-less delivery (batch filter drops null payloads; `runtime.test.ts:97-100` pins callbacks firing with `undefined`). No consumer reads the payload today, so nothing breaks — but the type asserts a wire guarantee nothing validates.
**Fix:** a) Add `isTaskCancelledData` (string `session_id` required) and validate at consumers. b) Type it `session_id?: string` to match the unchecked reality. c) Keep the event payloadless until a consumer needs the field.

### Pass 4 dedupe and corroboration

The 13 blind passes re-found 13 known issues (closed as duplicates, no changes): SF #21 CreateProjectDialog dead end (this pass rated it MUST; the conductor keeps SHOULD — the desktop path still works and nothing is lost or exposed, but three independent passes have now flagged it), SF #5 byName dup files, SF #4 TLS pair draft family, #131 WebAccessSettings size, #95 sessionHistoryReload header, #17 web fetches without timeout (extended below), SF #29 triple ADR-090, SF #30 ADR-090 D6 gorilla claim, #122 uploadBodyMethods pin claim, #60 `message.md` naming, #20 Windows reserved names (this pass adds the staging-hang aggravation on Windows hosts), SF #16 Warn-on-shape-drop (extended below), SF #17 section race family (extended below). Four merges into existing entries:

- **SF #16 (Warn-on-shape-drop):** pass 4 adds that `extractPayload` echoes attacker-controlled payload contents into the Warn line, and the WS path has no rate limit — an authenticated tab can flood the log with controlled bytes at wire rate, strengthening the case for the Debug-only fix.
- **SF #17 (section race family):** pass 4 found two more unlocked readers/writers in the same family: `RefreshWebAccessLoadWarnings` reads the desktop-owned section outside `webAccessMu` ([backend/frontend_api.go:803-833](backend/frontend_api.go#L803-L833)), and `persistConfig`'s whole-config save under `configMu` races the desktop writers (the branch documents this as the accepted "one-word window" at [desktop/app.go:164](desktop/app.go#L164); a string header is two words, and acceptance does not remove the UB). The fix this issue already suggests (one owning lock/seam for the section) covers all pairs.
- **SF #4 (TLS pair draft family):** pass 4 adds the sibling-wipe manifestation — the reseed effect deps `[info.tlsCert, info.tlsKey]` rewrite BOTH drafts when one field's commit lands, so input typed into the sibling field mid-commit silently vanishes (the parent's address draft has the same exposure one step removed).
- **#17 (web fetches without timeout):** pass 4 extends the site list with the boot-gating transport probe — `webAuthRequired()` awaits `fetch('/api/transport')` with no signal before the UI mounts, so a wedged sidecar leaves the tab on the splash forever ([frontend/src/api/runtime.ts:83](frontend/src/api/runtime.ts#L83)).

### Pass 4 additionally verified clean (selected)

`internal/webaccess` security core re-confirmed (auth constant-time compare, rate-limited login, WS admission ordering, denylist-before-reflection, bounded outbox/stop, certgen profile); desktop event-tap publish/teardown, batcher dual-transport delivery, configMu→webAccessMu ordering, persist→rollback control RPCs; `task_started` single-emission lifecycle and echo semantics across all three `message_received` sites; `sessions:changed` fan-out arity and emission points; attachment staging caps consistent across transports (48 MiB wire vs 32 MiB content); `UpdateExperimentalFeatures` rollback discipline; Web Access/TLS draft state machines and ADR-092 `onConfigChanged` wiring; ChatArea history-load refactor vs the loading-states spec; ToolConfirmation stale-click guard; `hitl_resolved` decision vocabulary completeness; `useSessionLoader` fetchSeq discipline; message echo dedup; `WebAccessGate` mount gating; Zoom-safety and selector-stability sweeps; `SendMessage` 13-arg wire parity incl. `clientSendID`; notification permission gesture gating and Firefox SecurityError handling; `compaction_availability` omitempty parity; boot loader + CSP directives; all ADR cross-links resolve.

---

### 22. CONSIDER — `Server` lifecycle is single-use; double `Start` or `Start`-after-`Stop` leaks a listener while the type doc claims blanket concurrency safety

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/webaccess.go:374-447](internal/webaccess/webaccess.go#L374-L447)
**Category:** bug (latent, API contract). Unreachable today (every desktop path builds a fresh `Server` per mount and serializes through `webAccessMu`; idempotence pinned by tests) — a latent hazard for the next caller.
**Fix:** a) Guard `Start` with a `started atomic.Bool` (error on double-start / start-after-stop). b) Document the single-use contract and drop the blanket sentence.

---

### 23. CONSIDER — Unauthenticated client-triggered diagnostics land at Warn via `http.Server.ErrorLog` — a per-line log-noise vector on a non-loopback bind

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/webaccess.go:393](internal/webaccess/webaccess.go#L393)
**Category:** security (minor, DoS-adjacent). Unlike finding 1 this needs no credential: any TCP peer can send garbage and produce Warn lines at line rate. Deliberate and documented, tests rely on it; volume case unbounded; the loopback default makes it near-moot.
**Fix:** a) Route the stdlib logger at Debug, keep an explicit server-side Warn only for serve-loop termination. b) Sample handshake errors. c) Accept and document at the non-loopback warning site.

---

### 24. CONSIDER — `UpdateExperimentalFeatures` holds `configMu` across the synchronous desktop sidecar transition

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_config.go:759-801](backend/frontend_api_config.go#L759-L801) with the hook at [desktop/app.go:1167-1203](desktop/app.go#L1167-L1203)
**Category:** performance / lock hygiene (documented trade-off). Verified no deadlock (one-directional `configMu → webAccessMu` order), but toggling the gate OFF while the sidecar's graceful stop is slow convoys every `configMu` contender (settings setters, `embeddedConfig()` readers on the LLM request path) for up to the stop budget.
**Fix:** a) Accept as a recorded decision (bounded budget + documented rationale). b) Split into sync gate-flip + async mount/stop with completion via state event (contract change; needs the ADR wording updated).

---

### 25. CONSIDER — `hitl_resolved` decision strings: unknown values silently render as "denied" (tool_confirm) or are cast unchecked (step_limit)

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/events/hitlHandlers.ts:255](frontend/src/hooks/events/hitlHandlers.ts#L255), [290-301](frontend/src/hooks/events/hitlHandlers.ts#L290-L301); guard at [frontend/src/types/events.ts:1124-1131](frontend/src/types/events.ts#L1124-L1131)
**Category:** type safety at boundary / defensive hardening. `decision` is validated only as *some* string; any non-empty unrecognized wire value becomes a visible "denied" card. Today's vocabulary matches, so nothing misbehaves — flagged as the asymmetry, not a live bug.
**Fix:** a) Extend the guard (or handler) with per-kind decision sets; unrecognized non-empty decisions settle neutrally. b) Centralize the wire→UI mapping in one exported pure helper with a unit test.

---

### 26. CONSIDER — `useSessionLoader`: a failed `sessions:changed` re-read still poisons the in-flight initial fetch's result

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/useSessionLoader.ts:157-165](frontend/src/hooks/useSessionLoader.ts#L157-L165)
**Category:** race / error-path interaction. `fetchSeq` is bumped when a re-read is *issued*; if it fails, the succeeded initial fetch is dropped (`initialFetchId !== fetchSeq`) and `listApplied` is false — the activation ends with no list and no restore. Narrow and self-healing.
**Fix:** a) Mark ownership only on success (roll the token back in the re-read's `.catch`, or compare against `lastSuccessfulFetchId`). b) Track the superseding fetch's outcome in the drop branch.

---

### 27. CONSIDER — `Installer.Install` silently routes any non-`mtplx` engine value (including garbage) down the llama path

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install.go:883-885](core/embeddedllm/install.go#L883-L885)
**Category:** latent API contract. Validation lives one layer up in `ResolveEngine`; a future caller passing a raw config string gets a llama install where the config asked for something else — the silent substitution the engine vocabulary elsewhere refuses. Today's only production caller resolves first.
**Fix:** a) Validate `opts.Engine` (`""`, `EngineLlama`, `EngineMTPLX`) at the top of `Install`. b) Document that invalid values mean llama.

---

### 28. CONSIDER — A pending-attachment removal can lose the race against the bind eviction and be silently resurrected with a dangling path

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/session/manager_attachment.go:740](backend/session/manager_attachment.go#L740) vs [backend/session/manager_promote.go:81-93](backend/session/manager_promote.go#L81-L93)
**Category:** corner-case race (two surfaces, one session). A removal landing inside the capture→restore window deletes the image file, then `RestorePendingAttachments` re-stages the captured item unconditionally — the removal is undone, the image sends from memory, and the persisted `path` dangles (unreconstructable after restart).
**Fix:** a) Stat the image path in `RestorePendingAttachments` and emit staged-attachments-lost instead. b) Fail removes with "workspace switch in progress" mid-eviction.

---

### 29. CONSIDER — `BindSessionWorkspace`'s atomic UPDATE does not pin `project_id`

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/session/persistence_binding.go:115-148](backend/session/persistence_binding.go#L115-L148)
**Category:** store-level hardening. No in-repo caller can trigger it (all pass the session's own project), but the one API that mutates binding identity would let a mismatched project argument persist a cross-project binding.
**Fix:** a) Add `AND project_id = ?` to the WHERE. b) Assert `project_id` in the post-UPDATE verification.

---

### 30. CONSIDER — A crash between the two mtplx pack-swap renames costs a full ~8.9 GiB re-download

*(Origin: pass 3 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install_mlx.go:253-257](core/embeddedllm/install_mlx.go#L253-L257)
**Category:** install robustness. Crash after `packDir→packOld` but before `packStaging→packDir` leaves no live pack, and the next attempt's staging wipe destroys the fetched revision because pack files go straight to staging (unlike llama weights, which use the persistent DownloadsDir).
**Fix:** a) Fetch pack files into DownloadsDir so the swap replays from cache. b) Keep staging on failure when it holds a fully verified revision.

---

### 31. CONSIDER — `ErrorData.session_id` is typed required but its guard tolerates absence

*(Origin: pass 3 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/types/events.ts:35](frontend/src/types/events.ts#L35)
**Category:** type-safety nit. `isErrorData` accepts payloads without `session_id` (documented Wails-serialization tolerance) while the interface declares it non-optional — a future consumer gets `undefined` typed as `string`. `TaskCompleteData` keeps it optional; the two terminal-event contracts disagree (no current consumer reads it).
**Fix:** a) Declare `session_id?: string`. b) Enforce presence in the guard.

---

### 32. CONSIDER — The desktop event tap is invoked without panic isolation

*(Origin: pass 3 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/app.go:735](desktop/app.go#L735)
**Category:** robustness. The tap contract ("must never block, alter, or fail the emit") is enforced only by convention in the out-of-scope webaccess implementation; a panicking tap propagates into whichever goroutine called `emit` (session producers, Wails dispatch) and kills the dispatch — e.g. a tap bug during sidecar hot-restart teardown while a `hitl_resolved` broadcast fires.
**Fix:** a) Wrap the call in a `recover()` that logs and continues. b) State the recover requirement explicitly in the `setEventTap` contract with a webaccess-side test.

---

### 33. CONSIDER — `CreateSession` emits `sessions:changed` before the session row is persisted

*(Origin: pass 4 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_session.go:79](backend/frontend_api_session.go#L79) (persist follows at 81-89)
**Category:** emission-order inconsistency; every other emission site persists first. If `SaveSession` is slow (pool contention) or fails (log-only), the debounced re-read at +250 ms misses the row and the new session is absent from sidebar/radar until the safety poll — in practice self-healing.
**Fix:** a) Move `emitSessionsChanged()` below the `SaveSession` block, matching `ForkSession`/`Delete`/`Archive`/`Pin`/promote. b) Overlay unsaved in-memory sessions in `ListSessions*` (heavier).

---

### 34. CONSIDER — The full file is materialized before the 32 MiB upload cap applies

*(Origin: pass 4 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/useStageAttachments.ts:191](frontend/src/hooks/useStageAttachments.ts#L191); cap checked only in [frontend/src/api/attachments.ts:107](frontend/src/api/attachments.ts#L107)
**Category:** client-side resource use. `MAX_ATTACHMENT_UPLOAD_BYTES` runs after the hook has already read the whole file into a `Uint8Array`, so a multi-GB drop costs a gigabyte-scale tab allocation (possible OOM) before the clean "too large" rejection. Browser bounds on `File.arrayBuffer()` uncertain, hence CONSIDER.
**Fix:** a) Check `file.size > MAX_ATTACHMENT_UPLOAD_BYTES` in `stageAttachmentFiles` before `arrayBuffer()`. b) Let `attachFileContent` accept the `File` and size-check before reading bytes.

---

### 35. CONSIDER — WebAccessSettings and WebAccessTLSSettings writer locks don't compose across the two blocks

*(Origin: pass 5 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/WebAccessSettings.tsx](frontend/src/components/settings/WebAccessSettings.tsx) + [WebAccessTLSSettings.tsx](frontend/src/components/settings/WebAccessTLSSettings.tsx)
**Category:** composed-busy gap. The TLS block disables its controls while its own `writeBusy` flags are set and the parent's toggle disables while `saving` — neither flag covers the other block, so a TLS write and an enable toggle can be in flight together (a sidecar start makes the enable window seconds-wide). The backend serializes under `webAccessMu`, so data stays consistent, but the failure-path rollbacks restore whole stale `info` snapshots, which can repaint a stale `enabled` until the next successful re-read.
**Fix:** a) Lift a single busy flag into the parent and thread it down, disabling both toggles and all Web Access fields during any in-flight write. b) On failure paths, restore via a fresh `getWebAccessInfo()` instead of the captured `previous`. c) Narrow the child's "a commit never races a toggle" comment to its own block.

---

### 36. CONSIDER — The warning-refresh keep-filter is text-coupled to the "web_access" prefix

*(Origin: pass 6 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api.go:822](backend/frontend_api.go#L822)

**Category:** robustness nit — verified exact today (every matching shape originates in `config/web_access.go`), but a future foreign warning that happens to begin with the prefix would be silently dropped by the refresh instead of kept.

**Fix:** a) document the prefix invariant as deliberate at the filter; b) match the exact current warning shapes instead of the prefix.

---

### 37. CONSIDER — `TaskFailedResumableData`'s new optional `task_id`/`reason` bypass shape validation, unlike the file's own additive-field convention

*(Origin: pass 6 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/types/events.ts:1354](frontend/src/types/events.ts#L1354)

**Category:** the guard validates only `message` and documents its tolerance for `auto_retry_at`; the two newly added optional fields are neither pinned-when-present (cf. `isSessionTokensData` in the same file) nor covered by a documented tolerate-but-degrade note, and a malformed `task_id` would silently degrade the resume banner's match field.

**Fix:** a) validate-when-present like the sibling guards; b) extend the guard's tolerance comment to name the two fields and the degrade path.

### Pass 6 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** SF #16, SF #17, SF #22, SF #4, SF #21, SF #5, #9+#10, #93, #131, #95, #2, SF #29, SF #30, #59, #19, SF #25, #20, SF #2, SF #8, #62, #63, #64. **Extensions merged:** SF #5 (the `byName` collapse also covers browser multi-select, not only cross-directory drops), #9+#10 (the HTTP server's missing body-read bound/concurrency cap, with the per-request 48 MiB buffering spelled out), #131 (the TLS extraction header's "keeps the parent under the 200-line target" claim is false against the 463-line parent), #19 (the fragment cap is checked after append, so a fragmented message transiently reaches ~2× the cap), #62 (the persist-failure rollback re-raised as a behavior-change confirmation), #63 (`getRuntime()` throws before the api-level logging on three context-menu sites), #64 (generalized: the web transport drops all UI→backend frames during an outage, warn-once, until reconnect resync restores pending cards). **Severity disagreement (kept at report severity):** pass 6 rated SF #21 MUST — the third independent MUST rating (after passes 4 and 5, against three SHOULD ratings); the split is now 3–3 and the issue stays SHOULD with nothing re-litigated.

**Pass 6 additionally verified clean (selected):** the full webaccess security core re-audited (constant-time digest compare, per-IP limiter with virtual-time window tests, cookie flags with Secure riding TLS only, denylist precedence over both surfaces + fail-closed nil dispatch validation, panic recovery across handlers/pumps/tap, bounded stop with expired-deadline force close, TLS 1.2 floor + fail-closed pair classes + atomic 0600/0644 publish, WS admission strictness, outbox backpressure, import-hygiene guards); `go build ./backend/... ./desktop/...` and targeted `-run` tests green; config load-order and fail-soft/fail-closed semantics re-verified through the real `LoadWithResult` pipeline and `config.example.yaml` claims re-checked against code; the task_started single-activation contract re-confirmed across fresh/goal/E2S/continue paths; SendMessage 13-arg threading re-verified end-to-end (generated binding, wrappers, echo dedup) with vitest 337/337 green and zero unexpected diagnostics; hitl_resolved id-prefix map covers all six card formats; useSessionLoader/useShallowResync race guards re-confirmed; zoom-safety, selector-stability and no-module-side-effect sweeps clean in every frontend area; the specs/docs pass re-verified the gate conjunction and live-follow, denylist, inbound whitelist, cookie/token vocabulary, cert_status classes, CSP, INDEX completeness and all relative links.

---

### 38. CONSIDER — `stopWebAccessLocked` clears the handle and event tap before `srv.Stop`; a total Stop failure leaves a live listener that every reader reports as not-running

*(Origin: pass 7 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/app.go:1641](desktop/app.go#L1641)

**Category:** if both the graceful and force stop phases fail, the OS listener survives while `GetWebAccessInfo` and every reader report not-running, and a later start fails on the held port until the rollback path restores the previous state. Narrow (Stop failure is already an error path), but the observable state can contradict reality.

**Fix:** a) on a Stop error, re-store the handle so state matches reality; b) keep the clear but surface liveness via the stored `Server` and report running in `GetWebAccessInfo`.

---

### 39. CONSIDER — `runExperimentalChangedHook` executes while `configMu` is held, stalling unrelated config RPCs for the sidecar-mount duration

*(Origin: pass 7 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_config.go:800](backend/frontend_api_config.go#L800)

**Category:** the changed-hook (sidecar mount/stop: TLS load, bind, probe) runs under the deferred `configMu` unlock, so a slow mount delays `GetConfig` and every other config RPC for its duration. Deliberate per the ADR-090 synchronous-apply contract, but the cost is borne by unrelated readers; a comment naming the accepted stall window exists only on the desktop side.

**Fix:** a) snapshot state, unlock, then run the hook (revisit the documented lock-order rationale first); b) accept and document the stall window at this call site too.

---

### 40. CONSIDER — `emitSessionsChanged` inherits `seedAcquire`'s early-startup park for an emit-only call

*(Origin: pass 7 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_session.go:52-54](backend/frontend_api_session.go#L52-L54)

**Category:** the helper calls `seedAcquire()` though it reads no seed-guarded state — it is a pure `emitEvent` passthrough (sibling `EventProjectCreated` calls `emitEvent` directly), so on the pre-seed startup path it can park in the seed wait loop before emitting a UI list-refresh event that nothing it emits depends on.

**Fix:** a) drop the `seedAcquire` call; b) keep it with a comment naming the invariant it protects.

---

### 41. CONSIDER — `AttachFileContent` runs on `context.Background()`: the RPC is uncancellable

*(Origin: pass 8 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_attachment.go:169](backend/frontend_api_attachment.go#L169)

**Category:** a long markitdown conversion during staging cannot be cancelled by app shutdown (the unchanged sibling `AttachFiles` shares the pattern).

**Fix:** a) derive the context from `f.ctx()` so shutdown cancels staging.

---

### 42. CONSIDER — A throwing `attach()` callback in `armWhenRuntimeReady` becomes an unhandled rejection

*(Origin: pass 8 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/lib/armWhenRuntimeReady.ts:56](frontend/src/lib/armWhenRuntimeReady.ts#L56)

**Category:** on the async probe path a throwing callback rejects an unobserved promise (the sync wails path propagates to the caller instead — asymmetric failure handling).

**Fix:** a) append `.catch` with a warn-level log to the arming chain.

---

### 43. CONSIDER — Goal-proposal decision string is forwarded to the core gate unvalidated

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/event_handlers.go:478](desktop/event_handlers.go#L478)
The plan-approval path validates its decision via `parsePlanApprovalDecision`; `handleGoalProposalResponse` forwards any non-empty string — reachable from both Wails events and the browser WS. **Fix:** a) validate against the accepted enum like the plan path.

---

### 44. CONSIDER — Tool-confirm Load-then-Delete window lets two simultaneous responses both broadcast `hitl_resolved`

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/event_handlers.go:169](desktop/event_handlers.go#L169)
Two concurrent responses both pass the `Load` check before either deletes, so two `hitl_resolved` events with different decisions broadcast — contradicting the first-responder-wins comment (cosmetic dup on a multi-surface race). **Fix:** a) `sync.Map.LoadAndDelete` to make removal atomic with lookup.

---

### 45. CONSIDER — Batcher coalescing merge keeps the old sizeHint, under-counting pendingBytes past the envelope cap

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/event_batcher.go:167](desktop/event_batcher.go#L167)
When a queued frame is replaced by a larger payload, the stale sizeHint can let pending bytes exceed the 256KB envelope cap before the overflow flush. **Fix:** a) add the size delta on merge.

---

### 46. CONSIDER — Session-logger close failure is logged through the logger that was just closed

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/startup_phases.go:74](desktop/startup_phases.go#L74)
`maybeReinitLogger` reports the close failure via `current` — the logger wrapping the sink just closed — so the diagnostic is silently lost. **Fix:** a) log through the new logger or `slog.Default()`.

---

### 47. CONSIDER — TLS pair probe runs `tls.LoadX509KeyPair` synchronously on every config load, unbudgeted

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/config/web_access.go:260](backend/config/web_access.go#L260)
A cert/key path on a hanging mount or FIFO blocks app startup unboundedly (deliberate fail-closed per ADR-092, but unbudgeted). **Fix:** a) bound the read/open with a non-blocking guard.

---

### 48. CONSIDER — `SetLogLevel` guards `f.app` but dereferences `Manager()` unguarded

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_config.go:1912](backend/frontend_api_config.go#L1912)
Sibling call sites check `Manager() == nil` before use. **Fix:** a) `if m := f.app.Manager(); m != nil { m.SetLogLevel(level) }`.

---

### 49. CONSIDER — `isWorkUnitSettledData` never validates the declared optional `reason`

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/types/events.ts:1317](frontend/src/types/events.ts#L1317)
Every neighboring new guard pins its optional strings. **Fix:** a) add `d.reason === undefined || typeof d.reason === 'string'`.

---

### 50. CONSIDER — `isHitlResolvedData` validates a phantom `total_count` field `HitlResolvedData` doesn't declare

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/types/events.ts:1124](frontend/src/types/events.ts#L1124)
Copy-paste from `isPlanStepCompleteData`; dead validation that misleads readers. **Fix:** a) drop the `total_count` clause.

---

### 51. CONSIDER — `isSessionRuntimeStatus` validates `active`/`has_unfinished_task` but not the declared-required `paused`

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/api/chat.ts:292](frontend/src/api/chat.ts#L292)
The reconcile overlay reads `paused`; an undefined would collapse paused detection. **Fix:** a) add `typeof d.paused === 'boolean'`.

---

### 52. CONSIDER — 30s judge timeout has no unmount cleanup in `ToolConfirmation`

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/ToolConfirmation.tsx:80](frontend/src/components/chat/ToolConfirmation.tsx#L80)
Resolving/dismissing mid-evaluation leaves the timer to setState into an unmounted component. **Fix:** a) clear `judgeTimeoutRef` in a `useEffect` cleanup.

---

### 53. CONSIDER — Pre-existing: `sendMessage`'s activation hold re-checks only `compacting`, so two concurrent fresh sends both activate

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [backend/session/manager_execution.go:888](backend/session/manager_execution.go#L888)
Verified verbatim on `main` (the branch changed only the emitted payloads nearby): after the unlocked DB reads, the second hold re-checks just `compacting` — not `active`/`deleting`. Two concurrent fresh sends (double-send, desktop app + web tab) both pass, the second overwriting `session.cancel`/`session.done`: run #1 becomes uncancellable and two `HandleMessage` goroutines run concurrently on one orchestrator. `ResumeTask` re-checks all three flags in its single activation hold ([manager_execution.go:1594-1622](backend/session/manager_execution.go#L1594-L1622)) — `sendMessage` does not mirror it. **Fix:** a) add `session.active`/`session.deleting` rejections inside the same hold, mirroring `ResumeTask`.

---

### 54. CONSIDER — Pre-existing: `DeleteProject` takes no `switchMu`, so a delete landing mid-`SwitchProject` can be activated

*(Origin: pass 9 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [backend/frontend_api_project.go:38](backend/frontend_api_project.go#L38)
Verified pre-existing on `main`: `SwitchProject` serializes via `acquireSwitchLock`, `DeleteProject` does not — a delete between `GetProjectCtx` and the activation commit lets the switch activate the deleted project (stale watcher/workspace, bogus `project:switched`). The branch's hunk in this function (vector release) neither introduces nor worsens the window. **Fix:** a) acquire `switchMu` (bounded, like `acquireSwitchLock`) in `DeleteProject`; b) re-validate the project still exists just before activation.

---

### 55. CONSIDER — A failed initial session load renders an endless skeleton with no error surface

*(Origin: pass 3 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [frontend/src/components/layout/SessionList.tsx:155](frontend/src/components/layout/SessionList.tsx#L155), same pattern [SessionSelector.tsx:211](frontend/src/components/layout/SessionSelector.tsx#L211)
**Category:** UX regression window. The null-sentinel render replaced the old (wrong but terminal) "No sessions yet" text with a pulsing skeleton; a transient cold-start RPC failure now shows an unbounded fake-loading state in both components (only `sessions:changed` or a project switch re-reads).
**Fix:** a) Track a load-failed state and fall back to an error/empty state. b) Bound the skeleton with a retry.

---

**Folded companion entry #56 (pass 4, CONSIDER) — same endless-skeleton mechanism at the same two sites (SessionList.tsx:155, SessionSelector.tsx:211) — #56 adds the catch(() => null) mechanism:**

### 56. CONSIDER — "Loading sessions…" can persist after a failed initial load with no error or retry affordance

**File:** [frontend/src/components/layout/SessionSelector.tsx:211-221](frontend/src/components/layout/SessionSelector.tsx#L211-L221) and [SessionList.tsx:155-164](frontend/src/components/layout/SessionList.tsx#L155-L164)
**Category:** misleading empty state. The initial fetch swallows failures into `null` (`listSessions().catch(() => null)`), leaving the sentinel set; the new UI shows an active-sounding "Loading sessions…" indefinitely unless a heal fires (push, `sessions:changed`, focus resync). Previous behavior was a silent empty body.
**Fix:** a) Trigger a `listSessions` retry in the dropdown's `onOpenChange` when `sessions === null`. b) Render a distinct "Couldn't load sessions" row when a load failure is tracked.

---

### 57. CONSIDER — Unrelated settings writers blanket-nil `configLoadErrors`, silently dropping a live web_access exposure banner

*(Origin: pass 6 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [backend/frontend_api_config.go:461](backend/frontend_api_config.go#L461), also [:1548](backend/frontend_api_config.go#L1548) and [:2432](backend/frontend_api_config.go#L2432)

**Category:** the branch adds the web_access warning channel to the shared `configLoadErrors` slice, but the pre-existing writers clear it wholesale once their own section validates ("Clear any config load errors since settings are now valid"), and `RefreshWebAccessLoadWarnings` re-appends only web-access-shaped warnings — so an exposure banner a user is being shown vanishes after any unrelated settings save and does not return until the next web-access mutation or an app restart.

**Fix:** a) route those writers through the same surgical replace `RefreshWebAccessLoadWarnings` uses; b) re-append `config.WebAccessLoadWarnings` after each blanket nil.

---

### 58. CONSIDER — Draft re-seed effects can silently discard a typed-but-uncommitted draft when a sibling control re-reads `info`

*(Origin: pass 2 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/settings/WebAccessSettings.tsx:110-122](frontend/src/components/settings/WebAccessSettings.tsx#L110-L122), [WebAccessTLSSettings.tsx:49-52](frontend/src/components/settings/WebAccessTLSSettings.tsx#L49-L52)
**Category:** UX nuance. Type a new address, then flip the HTTPS toggle: the dep change re-seeds the address field from the persisted pin and the typed draft vanishes. The display always ends truthful; commit-on-blur semantics preserved.
**Fix:** a) Skip re-seeding while the field is focused or differs from the last seeded value. b) Accept and document (the seeds also canonicalize after this field's own commits — desirable).

---

### 59. CONSIDER — Degraded `task_complete` card no longer reports how many steps failed

*(Origin: pass 2 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/hooks/events/useChatEvents.ts:286](frontend/src/hooks/events/useChatEvents.ts#L286)
**Category:** behavior change (raised for confirmation). The `failed_steps` interpolation and field were removed together — deliberate-looking, but a partially completed task loses a concrete transcript signal.
**Fix:** a) Confirm the backend no longer sends a reliable count and keep as is. b) Otherwise keep reporting the count when present.

---

### 60. CONSIDER — Web-transport message download always names the file `message.md`

*(Origin: pass 2 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/chat/CopyButton.tsx:88](frontend/src/components/chat/CopyButton.tsx#L88)
**Category:** UX. Repeated Shift+click saves collide on `message.md` (the browser suffixes (1), (2)…), so saved artifacts are indistinguishable on disk.
**Fix:** a) Derive the name from content (first heading/line, slugified). b) Embed a short timestamp.

---

### 61. CONSIDER — `hitl_resolved` converge path clears the activity label even when converging to `confirmed`

*(Origin: pass 3 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/hooks/events/hitlHandlers.ts:267](frontend/src/hooks/events/hitlHandlers.ts#L267)
**Category:** minor state inconsistency. The fresh-resolution path sets "Running tool: X…" for confirmed; the already-resolved converge branch unconditionally nulls the activity status, so a surface that converges onto `confirmed` loses the label until the next tool event.
**Fix:** a) Mirror the fresh path: set the label when `decision === 'confirmed' && tool`.

---

### 62. CONSIDER — `config:updated` is announced for an experimental toggle that was rolled back

*(Origin: pass 4 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [backend/frontend_api_config.go:772-779](backend/frontend_api_config.go#L772-L779) with `persistConfig` at [:2448](backend/frontend_api_config.go#L2448)
**Category:** cosmetic event fidelity. `persistConfig` emits `config:updated` even when the disk write failed, but this caller rolls the in-memory flip back on that exact path and the emit rides a `go` statement that can deliver before or after the rollback; consumers refetch and briefly see the rolled-forward gate. No correctness divergence (`GetConfig` serves the rolled-back value).
**Fix:** a) Move the emit to successful callers (larger refactor). b) Note the false announcement in the `persistConfig` comment for the rollback path.

---

### 63. CONSIDER — Clipboard failure handlers fold the rejection's error detail away

*(Origin: pass 4 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/GitPanel/GitHistoryContextMenu.tsx:243-245](frontend/src/components/GitPanel/GitHistoryContextMenu.tsx#L243-L245); same pattern at :398-400, [FileViewerTabContextMenu.tsx:74-77](frontend/src/components/fileViewer/FileViewerTabContextMenu.tsx#L74-L77), :89-92, [FileTreeContextMenu.tsx:159-162](frontend/src/components/layout/FileTreeContextMenu.tsx#L159-L162), :173-176
**Category:** log fidelity regression. `.catch(() => false)` folds a rejection into the boolean verdict, so the new `logger.error('Failed to copy …')` no longer carries the cause; a native-path rejection (`rt.ClipboardSetText` via `getRuntime()`, which throws when the runtime is gone) propagates unlogged where the old code logged the error object.
**Fix:** a) Log the folded rejection: `.catch((err) => { logger.error('clipboard write rejected', err); return false })`. b) Centralize the six sites in one helper that logs `ok === false` plus the rejection.

---

### 64. CONSIDER — HITL responses are silently dropped during a WS outage after the card already closed optimistically

*(Origin: pass 4 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/api/runtime.ts:478-490](frontend/src/api/runtime.ts#L478-L490) (drop path) with [ToolConfirmation.tsx:94-101](frontend/src/components/chat/ToolConfirmation.tsx#L94-L101)
**Category:** documented-tradeoff sharp edge. On the web transport `emit()` drops UI→backend frames (warn-once) while the socket reconnects; `ToolConfirmation.handleResponse` marks the card resolved immediately, so a click landing in an outage window closes the card while the backend never learns — the task stays blocked until the next `GetPendingActions` reconcile. The no-queue tradeoff is documented and the window is sub-second after a typical restart; `tool_judge_request` degrades more gracefully (30 s timeout reports failure).
**Fix:** a) Short-TTL queue for the seven whitelisted names, flushed on reconnect (first-responder-wins idempotency makes late delivery safe). b) Fire a local `runtime_error`/feedback when a HITL-named frame is dropped so the card stays open for retry.

---

### 65. CONSIDER — The plain-HTTP exposure warning fires for a non-loopback section even while the compound experimental gate guarantees the sidecar cannot mount

*(Origin: pass 7 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [backend/config/web_access.go:337](backend/config/web_access.go#L337)

**Category:** `WebAccessLoadWarnings` emits the present-tense "listener is network-accessible, traffic is plain HTTP" warning for an enabled non-loopback plain-HTTP section even when `experimental.enabled` is false and the compound gate ([desktop/app.go:1099](desktop/app.go#L1099) vs `applyExperimentalWebAccess`) guarantees no listener exists. The warning overstates the actual exposure on the load path (the runtime recompute after a live gate flip is the case it is written for).

**Fix:** a) soften/suppress the warning at the load call site when the master gate is closed (`normalizeWebAccess` has the whole cfg); b) reword to conditional ("will be network-accessible … once Experimental Features is enabled").

---

### 66. CONSIDER — Nudge-resume/live-echo renders the user message before the dispatch outcome is known (pre-existing ordering; the diff only adds fields)

*(Origin: pass 6 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass · pre-existing on main)*

**File:** [backend/session/manager_execution.go:868](backend/session/manager_execution.go#L868), also [backend/frontend_api_session.go:527](backend/frontend_api_session.go#L527)

**Category:** if the subsequent resume fails, the caller skips `SaveMessage`, so cards other surfaces rendered from the echo vanish on reload. The ordering predates the branch — the changed hunks add `ClientSendID`/`IsNudge` fields to these emissions, which is why they are in scope.

**Fix:** a) emit the echo only after the resume/persist commits; b) persist the row before dispatch.

---

### 67. CONSIDER — `GenerateWebAccessCertificate` skips the warning-channel refresh although regeneration can move the section's load-warning contribution

*(Origin: pass 1 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [desktop/app.go:1434-1470](desktop/app.go#L1434-L1470) (refresh rule at [1040-1046](desktop/app.go#L1040-L1046))
**Category:** behavior (stale UI state). The docstring's "cannot move the warning state" holds for the token RPCs but not the certificate RPCs: an unusable TLS pair turns the section off with a load warning; generating a fresh valid pair heals the pair, yet the banner keeps claiming it is broken until restart.
**Fix:** a) Call `a.refreshWebAccessLoadWarnings()` after the unlock (idempotent, cheap). b) Narrow the docstring justification to the token RPCs and document the stale-banner-after-generate consequence.

---

### 68. CONSIDER — Behavior change: `goal_loop.suggest.min_complexity` default silently moves 2 → 3

*(Origin: pass 1 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**Files:** [backend/config/defaults.go:471-478](backend/config/defaults.go#L471-L478), [backend/config/config.go:2501](backend/config/config.go#L2501), `config.example.yaml`
**Category:** behavior change (confirmation flag). Coherent and deliberate (code comment, example file, spec, tests updated in lockstep); users relying on the default observably stop getting goal proposals for complexity-2 messages with no config diff to explain it.
**Fix:** a) Call it out in CHANGELOG/release notes (and the goal-mode spec if numeric there). b) Optionally key the floor off an absence sentinel (likely over-engineering).

---

### 69. CONSIDER — No progress events across the offline pip install + smoke test (up to ~12 min silent)

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install_mlx.go:354](core/embeddedllm/install_mlx.go#L354) (10-min budget), [398](core/embeddedllm/install_mlx.go#L398) (2-min budget)
**Category:** UX / progress fidelity. The llama flow emits `StageExtracting` through its comparable gap; the mtplx install is the only one that can sit silent long enough to read as wedged, inviting interruptions mid-promote-critical work.
**Fix:** a) Emit a synthetic stage around `mlxPipInstall`/`mlxSmoke`. b) At minimum document the silent window in the flow comment.

---

### 70. CONSIDER — `opts.Backend` override silently ignored on the mtplx install path

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install_mlx.go:78-97](core/embeddedllm/install_mlx.go#L78-L97)
**Category:** silent no-op of an explicit operator input. The llama path threads (and degrades) `InstallOptions.Backend`; `installMLX` hardcodes `BackendMetal` without consulting or acknowledging the override. Manifest records truthfully; reachable only with an explicit non-Metal override while `engine: mtplx`.
**Fix:** a) Warn when `opts.Backend != "" && opts.Backend != BackendMetal`. b) Refuse with a typed error naming the engine (mirroring `mlxForbiddenOverrides`' spirit).

---

### 71. CONSIDER — Behavior change (raised for confirmation): flat display mode's Archived section loses the bulk group actions

*(Origin: pass 1 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/layout/SessionSelector.tsx](frontend/src/components/layout/SessionSelector.tsx) (flat-mode branch)
**Category:** behavior change. Bulk Pin group / Unarchive all / Delete all of archived branch sessions is now grouped-mode-only; per-session unarchive/delete remains. Tests assert the absence, so it appears deliberate — but it is a real UX capability change worth a second look (and a CHANGELOG line if intended).
**Fix:** a) Confirm intended and note it in release notes. b) Or surface the group actions in flat mode too (single ArchivedSection per finding 30).

---

### 72. CONSIDER — mtplx spawn failures are reported as failures of "llama-server"

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/server.go:2235](core/embeddedllm/server.go#L2235) (constant at [core/embeddedllm/layout.go:38](core/embeddedllm/layout.go#L38))
**Category:** diagnostics. The fixed `ServerBinaryName` label now wraps both engines' exec errors, pointing mtplx diagnosis at the wrong binary family.
**Fix:** a) Label from `filepath.Base(spec.ServerBinary)`. b) Select the name by `spec.Engine`.

---

### 73. CONSIDER — Boot-loader removal can precede React's first commit, briefly blanking `#root`

*(Origin: pass 2 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/main.tsx:113-115](frontend/src/main.tsx#L113-L115)
**Category:** startup cosmetics (narrow frame-timing window). The module-scope rAF is decoupled from React's commit; on a loaded machine it can remove the spinner before the splash commits — the opposite of the promised handoff.
**Fix:** a) Remove the node in a post-commit hook, keeping the rAF as a guarded fallback. b) Only remove when React has actually mounted (`childElementCount > 1`).

---

### 74. CONSIDER — The `sessions:changed` push set omits renames and live-interjection activity bumps

*(Origin: pass 4 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_session.go:272](backend/frontend_api_session.go#L272) (`RenameSession` — no emission)
**Category:** push-contract coverage gap. The diff makes `sessions:changed` the mechanism that keeps every surface's list fresh, but the emitted set covers only create/fork/delete/archive/pin/promotion/project-delete; a rename changes list content and a live interjection bumps `last_active_at` without any task transition event, so remote surfaces show stale name/order until the safety poll. Possibly deliberate scope (the contract comment enumerates list-shape mutations).
**Fix:** a) Add `emitSessionsChanged()` to `RenameSession` (debounced consumers coalesce it). b) Document the exclusion in the `EventSessionsChanged` contract comment.

---

### 75. CONSIDER — History-loading spinner's `aria-label` sits on a bare SVG with no role

*(Origin: pass 4 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/ChatArea.tsx:181](frontend/src/components/chat/ChatArea.tsx#L181)
**Category:** accessibility. An `aria-label` on a generic `<svg>` without `role="img"` (or a `role="status"` wrapper) is not reliably exposed to assistive tech, and the placeholder→spinner→content transition is never announced.
**Fix:** a) Wrap in `<div role="status" aria-label="Loading session history">` and drop the label from the svg. b) Add `role="img"` to the `Loader2` element.

---

### 76. CONSIDER — History-loading spinner has no bound if the RPC hangs

*(Origin: pass 4 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/ChatArea.tsx:107-108](frontend/src/components/chat/ChatArea.tsx#L107-L108) and [:177-183](frontend/src/components/chat/ChatArea.tsx#L177-L183)
**Category:** feedback honesty. `getSessionHistory` has no timeout; a permanently hung RPC renders an infinite spinner where main rendered the static placeholder. Recovery exists (window-focus resync re-runs the load, whose finally settles the marker), so it degrades rather than wedges — and the RPC would have hung on main too, just less visibly.
**Fix:** a) Bound the in-flight UI: after N seconds without settle, fall back to the placeholder icon (marker logic untouched). b) Accept and note the focus-resync recovery path in the branch comment.

---

### 77. CONSIDER — A failed enable leaves an enabled-but-down sidecar whose in-session recovery is an off→on double toggle

*(Origin: pass 5 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [desktop/app.go:1104](desktop/app.go#L1104)
**Category:** minor UX dead-end, not correctness. On a start failure after persist, the switch stays ON (documented "the next launch retries"), but a repeated `SetWebAccessEnabled(true)` hits the `enabled == on` no-op and returns nil — the retry the error message invites does nothing. `GetWebAccessInfo` does surface `Running=false`, so the state is visible and honest; recovery is toggle-off/on or restart.
**Fix:** a) When `on` is requested, the section is already enabled, and no live handle exists, fall through to `startWebAccessLocked` (its live-handle idempotence prevents double binds). b) Return a distinct "enabled but not running" sentinel the frontend renders as a Restart action. c) Document the off→on recovery in the error string.

---

### 78. CONSIDER — `DeleteSession` can return early after the managed pre-flight already removed the store row, skipping `sessions:changed`

*(Origin: pass 6 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_session.go:200](backend/frontend_api_session.go#L200)

**Category:** when the manager delete fails, the early return skips the emission although the visible list already mutated (the pre-flight removed the row itself), leaving other surfaces stale until the periodic poll or the next unrelated event.

**Fix:** a) emit `sessions:changed` on that error path too (the list genuinely changed); b) document the poll fallback as the accepted recovery.

---

### 79. CONSIDER — Map-form `task_complete` without an `output` key returns without persisting the terminal row

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [backend/session/event_persister.go:118](backend/session/event_persister.go#L118)
The typed form persists a `"[Task completed]"` continuation row for empty outputs; the map form lacking `output` silently drops the terminal row, defeating that continuation-context guard. **Fix:** a) fall through to `role="assistant"`, `content="[Task completed]"` instead of returning.

---

### 80. CONSIDER — `UpdateSearchSettings` swallows a `persistConfig` failure (warn-only, returns nil)

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_config.go:559](backend/frontend_api_config.go#L559)
The UI reports saved though the disk write failed; the value silently reverts on restart. Sibling `UpdateVectorIndexSettings` returns the error. **Fix:** a) return `fmt.Errorf("failed to persist search settings: %w", err)` like the vector path.

---

### 81. CONSIDER — `cancelAttachmentUpload`'s claim sweep discards the returned `retired` ids

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/lib/attachmentUploads.ts:292](frontend/src/lib/attachmentUploads.ts#L292)
Sibling non-cancelled uploads that claim during the sweep never get `endUploads`, so their spinner chip keeps spinning until the whole staging batch settles. **Fix:** a) `endUploads(sessionId, claimLandedAttachments(sessionId, staged))` after the sweep.

---

### 82. CONSIDER — The no-session branch renders `<ChatInput/>` without the ErrorBoundary wrapper

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/ChatArea.tsx:119-131](frontend/src/components/chat/ChatArea.tsx#L119-L131)
Both other branches wrap the input shell in an ErrorBoundary with `resetKeys`; a crash in the bare branch escalates higher instead of showing the "Input error" fallback. **Fix:** a) reuse the same boundary wrapper in all three branches.

---

### 83. CONSIDER — `handleRegenerate` keeps the OLD token displayed after a successful rotation when the re-read fails

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/WebAccessSettings.tsx:259](frontend/src/components/settings/WebAccessSettings.tsx#L259)
`if (fresh) setInfo(fresh)` on a null re-read leaves the pre-rotation token in the Copy/masked field — a dead credential handed out with no staleness hint. **Fix:** a) on null, clear `tokenDraft`/reveal and show a "token changed but state unverified" slot; b) retry the read once first.

---

### 84. CONSIDER — Notification preview suppression reads the stale render-scope `permission` closure

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/SystemNotificationSettings.tsx:147](frontend/src/components/settings/SystemNotificationSettings.tsx#L147)
The first re-enable after a since-fixed denial resolves `'granted'` yet sends no confirmation banner because the closure `permission` is still `'denied'`. **Fix:** a) derive suppression from the outcome (or functional state) instead of the closure.

---

### 85. CONSIDER — Git history submenus open only on hover; keyboard cannot reach Create/Reset/Tag

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/GitPanel/GitHistoryContextMenu.tsx:96](frontend/src/components/GitPanel/GitHistoryContextMenu.tsx#L96)
Items are `role=menuitem` buttons but no focus/keyboard path opens the submenus. **Fix:** a) also open on `onFocus`/ArrowRight of the trigger.

---

### 86. CONSIDER — Optimistic comment rollback can clobber a newer draft

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/review/FileReviewBlock.tsx:27](frontend/src/components/review/FileReviewBlock.tsx#L27) (same pattern [HunkReviewBlock.tsx:57](frontend/src/components/review/HunkReviewBlock.tsx#L57), [ReviewHeader.tsx:120](frontend/src/components/review/ReviewHeader.tsx#L120))
If the save RPC fails after the user saved a newer draft elsewhere, `setFileComment(previous)` restores the pre-first-edit value over the newer one. **Fix:** a) restore only if the store value still equals the optimistic value.

---

### 87. CONSIDER — Web-transport explanation lives in `title` on a `disabled` button, so web users see an unexplained dead control

*(Origin: pass 10 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/WorkDirsModal.tsx:341](frontend/src/components/chat/WorkDirsModal.tsx#L341)

**Category:** unreachable hint. The "Add directory" button carries the web-transport reason ("needs the desktop app (native folder dialog)") in its `title` attribute and is `disabled={isWebTransport()}` — browsers suppress tooltips on disabled controls (no pointer events), so a web user sees an unexplained dead button and never the explanation.

**Suggested fix:**
a) Render the reason as visible hint text when `isWebTransport()`.
b) Use an `aria-disabled` pattern that keeps the element hoverable/focusable.

---

### 88. CONSIDER — "Open In Terminal" sets the cwd to the file itself on Windows (pre-existing)

*(Origin: pass 5 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [frontend/src/components/fileViewer/FileViewerTabContextMenu.tsx:122-125](frontend/src/components/fileViewer/FileViewerTabContextMenu.tsx#L122-L125)
**Category:** pre-existing defect in an in-diff file, reported for triage. `path.lastIndexOf('/')` — file-viewer tab paths are backslash-joined on Windows (the codebase's own `pathSep()` helper in [FileTreeContextMenu.tsx:44-48](frontend/src/components/layout/FileTreeContextMenu.tsx#L44-L48) exists for this), so the cut fails and `dir` becomes the full file path; `startTerminalInDir` then fails to spawn the PTY. Deterministic for effectively every file on Windows; the diff did not touch this handler.
**Fix:** a) Derive the separator via `pathSep()` and fall back to the drive/root when there is no separator. b) Extract a shared `parentDir(path)` lib helper so the tree/tab/git menus cannot drift.

---

### 89. CONSIDER — Git history context menu's nested submenus don't flip/clamp: clipped off-window near the right edge (pre-existing)

*(Origin: pass 5 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [frontend/src/components/GitPanel/GitHistoryContextMenu.tsx:80-107](frontend/src/components/GitPanel/GitHistoryContextMenu.tsx#L80-L107)
**Category:** pre-existing UX defect in an in-diff file. The `Submenu` helper renders at `absolute left-full top-0` with no viewport check, while the top-level menu IS clamped by `useCursorMenuPosition` — so any right-click within ~200 px of the right window edge (the common case for the right-docked Git history panel) pins the menu at the viewport gutter and the "Create"/"Reset …"/"Tag" submenus open entirely off-screen. The destructive-reset flow becomes unreachable without moving the window.
**Fix:** a) Expose the placement's `horizontal` from `useCursorMenuPosition` and render submenus at `right-full` when the menu resolved leftward. b) Measure each submenu and flip on overflow (reuse `computeCursorMenuPlacement`). c) Cheap mitigation: `max-w-[50vw] overflow-y-auto` on the submenu.

---

### 90. CONSIDER — Pre-existing: `!toolsOK` startup exit publishes the seed but emits no `EventStartupError`, and its comment misstates the condition

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [desktop/startup.go:286](desktop/startup.go#L286)
Verified pre-existing: the block is unchanged on `main`. A config-resolution panic (the only `toolsOK=false` producer per [startup_phases.go:112](desktop/startup_phases.go#L112)) leaves the webview on the splash forever — unlike the `buildApplication` failure path, which emits `startup_error` — and the comment still blames "a failed first-run tool download". **Fix:** a) emit `EventStartupError` with the cause before returning and correct the comment; b) at minimum fix the comment.

---

### 91. CONSIDER — Pre-existing: `WorkDirsModal` commit/remove rejections are unhandled and invisible

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [frontend/src/components/chat/WorkDirsModal.tsx:92-99](frontend/src/components/chat/WorkDirsModal.tsx#L92-L99)
Verified verbatim on `main`: `commit` awaits `onUpdate` in try/finally with no catch and `handleRemove` has neither — a failed RPC is an unhandled rejection with no user-visible error (unlike the add flow's `addError`). **Fix:** a) catch, log, and surface via the modal's error state.

---

### 92. CONSIDER — Pre-existing: `sensitivePathReason` is POSIX-only, so every advisory warning is dead on Windows

*(Origin: pass 9 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [frontend/src/components/chat/WorkDirsModal.tsx:30-45](frontend/src/components/chat/WorkDirsModal.tsx#L30-L45)
Verified verbatim on `main`: root block `=== '/'`, sensitive dirs `endsWith('/'+suffix)`, containment `startsWith(ws+'/')` — while picked paths are OS-native, so on Windows no advisory warning ever fires and `C:\` passes the root block (the backend's independent validation remains the backstop). **Fix:** a) normalize separators on `[\\/]` like `CreateProjectDialog.pathBasename`.

---

### 93. CONSIDER — `ValidateWebAccessToken` doc claims "after trimming" but neither the function nor its test trims

*(Origin: pass 1 · Impact class: D — documentation, spec or comment contradiction · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [backend/config/web_access.go:289-296](backend/config/web_access.go#L289-296) (test pins the opposite at [web_access_test.go:588-591](backend/config/web_access_test.go#L588-L591))
**Category:** doc/implementation mismatch (security-adjacent input rule). A future caller trusting the doc may accept a whitespace-padded below-floor token as meeting the guessability floor. Bounded: interactive input of the operator's own credential.
**Fix:** a) Fix the doc to "raw length, no trimming (callers trim before calling)". b) Or actually trim and update the test (verify the desktop caller doesn't double-trim against the stored value).

---

### 94. CONSIDER — New `defaults.go` comment calls the web_access token "ephemeral per-launch", contradicting the mint-once-and-persist semantics

*(Origin: pass 1 · Impact class: D — documentation, spec or comment contradiction · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [backend/config/defaults.go:737](backend/config/defaults.go#L737)
**Category:** doc drift (introduced by this diff). `web_access.go`'s field doc and `config.example.yaml` specify empty = minted at first start, persisted, stable across restarts. The wrong comment invites a regression to per-launch credentials (breaking browser logins across restarts).
**Fix:** a) Reword to "(minted once at the first start, then persisted)".

---

### 95. CONSIDER — sessionHistoryReload module header contradicts the implemented (and test-pinned) failure contract

*(Origin: pass 1 · Impact class: D — documentation, spec or comment contradiction · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [frontend/src/lib/sessionHistoryReload.ts:12](frontend/src/lib/sessionHistoryReload.ts#L12) (implementation at [85-97](frontend/src/lib/sessionHistoryReload.ts#L85-L97), pinned by [sessionHistoryReload.test.ts:143-145](frontend/src/lib/sessionHistoryReload.test.ts#L143-L145))
**Category:** documentation correctness. The header claims the history-RPC rejection propagates to the caller; the implementation swallows it, injects the error card itself, and resolves. A maintainer coding against the header will double-handle the failure (duplicate error card, or a rejection-path test that can never fire).
**Fix:** a) Correct the header to the actual contract (loader renders the failure card and resolves; only post-merge steps can reject, and their wrappers resolve null in practice).

---

### 96. CONSIDER — `AttachFileContent`'s 32 MiB cap diverges from the desktop path for large documents; the doc comment overstates parity

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [backend/frontend_api_attachment.go:14](backend/frontend_api_attachment.go#L14)
**Category:** docs/behavior (fail-closed, transport-motivated). Only images are size-capped in the session pipeline; a 50 MiB PDF attaches on desktop but hard-fails on the web path while the comment claims identical behavior.
**Fix:** a) Reword the comment to state the cap is transport-motivated. b) Size the cap from the web body limit and let oversize surface as the pipeline's per-file failure.

---

### 97. CONSIDER — The event catalog's Web-transport intro states availability as `web_access.enabled` alone, without the experimental master gate

*(Origin: pass 5 · Impact class: D — documentation, spec or comment contradiction · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [specs/contracts/event-catalog.md:7](specs/contracts/event-catalog.md#L7) (also the transport list in [specs/contracts/desktop-frontend.md](specs/contracts/desktop-frontend.md))
**Category:** spec completeness. ADR-090 D13 (and the implementation, `initWebAccess`) make availability the compound gate `experimental.enabled && web_access.enabled`; the rest of the doc set states the conjunction everywhere. A reader of the contracts' transport intro alone could conclude the section switch alone mounts the sidecar.
**Fix:** a) One clause: "opt-in (`web_access.enabled` behind the master `experimental.enabled` gate, ADR-090 D13)". b) Link the web-access domain spec's availability section next to the phrase.

---

### 98. CONSIDER — mtplx tuning-refusal message is duplicated between the RPC and the load validator

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_embedded_tuning.go:405-413](backend/frontend_api_embedded_tuning.go#L405-L413) (duplicate at [backend/config/config.go:1561-1569](backend/config/config.go#L1561-L1569))
**Category:** structure/maintainability. The "one voice" invariant is enforced by a test comparing suffixes rather than by construction; a wording edit touching one site fails CI in an unrelated-looking test file — or, if updated mechanically, the surfaces silently diverge and a tuning write becomes the config.yaml-poisoning bug the check exists to prevent.
**Fix:** a) Hoist the sentence into a single source (e.g. an `embeddedllm.ForbiddenLlamaTuningError(...)` helper) called by both. b) Share one exported `const` literal in `backend/config`.

---

### 99. CONSIDER — The embedded-LLM section intro still describes the llama engine only, contradicting the new engine-aware install record

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/EmbeddedLLMSettings.tsx:155-158](frontend/src/components/settings/EmbeddedLLMSettings.tsx#L155-L158)
**Category:** copy drift. An mtplx install renders "Engine MLX (MTPLX)" directly above prose claiming llama-server supervision and "about 8 GiB".
**Fix:** a) Make the sentence engine-conditional like `formatPlan`. b) Reword engine-neutrally ("the pinned local inference server").

---

### 100. CONSIDER — `EvictSession`'s doc comment is duplicated, reading as two conflicting intros

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [backend/session/manager_promote.go:16-33](backend/session/manager_promote.go#L16-L33)
**Category:** docs. The new forwarding comment was prepended without splitting the original long block, so godoc announces the subject twice.
**Fix:** a) Keep the narrative on `EvictSessionCarryingAttachments`, two-line intro on the wrapper. b) Append a "see" line after a blank-line split.

---

### 101. CONSIDER — The `SendMessage` contract row omits the `clientSendID` parameter

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/contracts/desktop-frontend.md:71](specs/contracts/desktop-frontend.md#L71)
**Category:** docs/wire arity. The rewritten row lists 12 parameters; the real signature and the regenerated binding carry 13 (`clientSendID` between `reviewMode` and `workspace`). The omission predates the branch, but the row was rewritten here.
**Fix:** a) Add `clientSendID` to the row. b) Note it as a binding artifact if deliberately not frontend-facing.

---

### 102. CONSIDER — Embedded-LLM gate wording in AGENTS.md/SECURITY.md is llama-shaped for both engines

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [AGENTS.md](AGENTS.md) (Embedded LLM bullet), [SECURITY.md](SECURITY.md) (ASI04 bullet)
**Category:** docs precision. "A combined memory gate over BOTH pools" reads as the single description for both families, but mtplx's gate is ONE unified-pool comparison; the pack size is quoted "~8.9 GiB" where the ADR pins decimal "8.85 GB".
**Fix:** a) Scope the both-pools phrase to llama, one-line the mtplx gate. b) Normalize size citations to the pinned bytes.

---

### 103. CONSIDER — The `config.example.yaml` exposure warning is a paraphrase, not the literal message an operator would grep for

*(Origin: pass 3 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [config.example.yaml:2128](config.example.yaml#L2128) vs [backend/config/web_access.go:315](backend/config/web_access.go#L315)
**Category:** docs precision. The comment quotes "not loopback — network-accessible, traffic unencrypted"; the actual load warning reads "bind %q is not loopback — the listener is network-accessible, traffic is plain HTTP without TLS".
**Fix:** a) Quote the literal message. b) Drop the quotation marks.

---

### 104. CONSIDER — The example's "empty while enabled" fail-soft claim misdescribes file-load behavior

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [config.example.yaml:2130](config.example.yaml#L2130) vs [backend/config/web_access.go:83-84](backend/config/web_access.go#L83-L84) and [backend/config/defaults.go:733-741](backend/config/defaults.go#L733-L741)
**Category:** doc/behavior mismatch. `ApplyDefaults` seeds an empty bind with `127.0.0.1` before normalization, so `enabled: true` with no bind key loads ENABLED warning-free (the intentional shortcut, test-pinned); the fail-soft empty-bind reset exists only for in-memory mutation and the save gate. An operator deleting the bind line while enabled expects "warning + sidecar off" and instead gets a running listener with no warning (benign — loopback default).
**Fix:** a) Reword: unparseable binds fail soft at load; a missing bind key loads the loopback default; an empty bind is refused at save/runtime. b) Document the no-bind shortcut explicitly, matching the test commentary.

---

### 105. CONSIDER — Contradictory dedup comments in `useReviewActions`

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/review/useReviewActions.ts:92-99](frontend/src/components/review/useReviewActions.ts#L92-L99) vs [:150-152](frontend/src/components/review/useReviewActions.ts#L150-L152)
**Category:** comment drift introduced by the same diff. The block comment says the echo is deduped by "tail user-message content + time window", while the `sendMessage` comment says the optimistic id dedups "by identity" — only the second is what now happens on this surface; content+window is the no-id fallback.
**Fix:** a) Reword the block comment to lead with identity dedup via `clientSendId`, naming content+window as the fallback. b) Reference `shouldAddReceivedUserMessage` instead of restating the mechanism.

---

### 106. CONSIDER — `isPendingAskUser`'s comment claims a ≥1-option invariant the code does not enforce

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/api/chat.ts:419-427](frontend/src/api/chat.ts#L419-L427)
**Category:** guard/comment mismatch. The comment says the guard requires "≥1 well-formed option" (relying on the Go producer rejecting zero-option questions), but `Array.isArray(q.options) && q.options.every(...)` passes an empty array vacuously — a backend regression would reach the UI as an unanswerable form instead of being dropped at the boundary.
**Fix:** a) Add `q.options.length > 0` to match the documented invariant. b) Correct the comment to state the guard only validates element shapes.

---

### 107. CONSIDER — SECURITY.md's web-server bullet omits the experimental master switch

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [SECURITY.md](SECURITY.md) (new "Built-in web server" attack-surface bullet)
**Category:** understated gating in the operator's first-read security doc. The bullet says the Web Access toggle "makes the running app serve its own frontend", but the sidecar mounts only while `experimental.enabled && web_access.enabled` (ADR-090 decision 13; AGENTS.md and web-access.md, updated in this same diff, say so). Fail-safe direction, but incomplete.
**Fix:** a) Add "(and only while the experimental master switch is also on — ADR-090 decision 13)" after the toggle sentence. b) Cross-reference decision 13 explicitly if the bullet is deliberately scoped to "once it runs".

---

### 108. CONSIDER — "The five HITL responses" counts a request as a response

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/contracts/event-catalog.md](specs/contracts/event-catalog.md) (Web Transport section); [specs/decisions/090-browser-web-access.md](specs/decisions/090-browser-web-access.md) (decision 8, "seven frontend→backend HITL response events")
**Category:** imprecise noun. The seven whitelisted events include `tool_judge_request`, which is a request, not a response; only four are responses. The count (seven) and the actual set are correct everywhere — SECURITY.md and web-access.md already say "HITL events".
**Fix:** a) "the seven frontend→backend HITL events (four responses, the judge request, and the two goal decisions)". b) Or simply "the seven HITL events", matching SECURITY.md/web-access.md.

---

### 109. CONSIDER — `emitSessionsChanged`'s doc comment omits the project-switch fallback creation among the mutations it lists

*(Origin: pass 5 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_session.go:59](backend/frontend_api_session.go#L59)
**Category:** comment/contract drift. The enumeration "(create, fork, delete, archive, pin, promotion, project deletion)" misses `createSessionForProject` ([backend/frontend_api_project.go:1247](backend/frontend_api_project.go#L1247), the SwitchProject fallback creation), which the event-catalog row does list. A future editor pruning "unlisted" call sites could remove a required emission.
**Fix:** a) Add "project-switch fallback creation" to the enumeration. b) Replace the enumeration with a pointer to the catalog row (single source of truth).

---

### 110. CONSIDER — INDEX's ADR-090 bullet says "stdlib only" while the same file's web-access.md bullet says "stdlib + `backend/config` only"

*(Origin: pass 5 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/INDEX.md](specs/INDEX.md) (090-browser-web-access bullet)
**Category:** internal inconsistency in the same document. The package's actual dependency contract is stdlib + `backend/config` (Options carries `config.WebAccessConfig`); the ADR bullet understates it relative to its sibling bullet.
**Fix:** a) Align the bullet to "stdlib + backend/config only". b) Clarify "stdlib-only codec" if the intent was the WebSocket layer.

---

### 111. CONSIDER — ADR-090's status note "consolidates the branch-local former ADR-091" is ambiguous against main's 091

*(Origin: pass 5 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/decisions/090-browser-web-access.md:3](specs/decisions/090-browser-web-access.md#L3)
**Category:** historical-note clarity. main's 091 is `091-eager-session-creation.md` — a different, existing decision; the note refers to a never-merged branch-local file, and a reader diffing against main can misread the consolidation as consuming main's 091. (The parallel "former ADR-093/094/095" note in ADR-092 names files that exist nowhere, so it is less ambiguous.)
**Fix:** a) "consolidates the branch-local former ADR-091 (web-access availability; unrelated to main's 091-eager-session-creation)". b) Leave as is — lowest priority.

### Pass 5 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** SF #16, SF #22, SF #4, SF #21, SF #5, #16, #93, SF #26+SF #25 (failure-card stacking/populated-transcript), #95, #2, #17, SF #29, SF #30, SF #31, SF #23, #58, #118 (extended), #18 (extended via #118), #19, #122, #20, #55/#56 (with the loader-side mechanism added), #31, SF #9 (re-rated), #75, #21. **Severity disagreements (kept at report severity):** pass 5 rated SF #21 and SF #29 MUST — both are severity disagreements with already-aggregated SHOULDs (a permanently-disabled web-transport dialog with an honest escape hatch via desktop, and a specs-numbering ambiguity whose INDEX links all resolve); SF #9's SHOULD rating was accepted (see the re-rate note there). **Extensions merged:** SF #17 (bidirectional whole-file marshal race + lost-update), SF #3 (token also wiped), #118 (browserFilePicker untested). **Process disclosure:** one frontend reviewer reported briefly opening a prior pass's blackboard output mid-session before catching itself; all of its findings and verification trails were formed before that point and were re-anchored to the working tree by the conductor, so no finding in this section derives from prior-round content. Blind constraint was otherwise honored by all 12 reviewers.

**Pass 5 additionally verified clean (selected):** `internal/webaccess` full suite passes under `go test -race -count=1`; token entropy/digest-only logging, cookie matrix, origin-vs-Host interlock with the host-scoped cookie (DNS-rebinding dies at cookie auth), denylist proven against targets that DO define the denied methods, RFC6455 client-frame strictness (mask/RSV/caps), shutdown idempotence, certgen SAN classes; `go build ./...`, `go vet`, `gofmt` clean across backend/desktop; the full `backend` and `backend/session` packages pass uncached including the nine-site `sessions:changed` emission audit against the catalog and the task_started single-activation-point contract; lock-order check found no ABBA cycle between `configMu` → `webAccessMu`; generated wailsjs drift-free (14-field WebAccessInfo, 13-arg SendMessage position-pinned, `[]byte`↔base64 mapping asserted); event fan-out exactly-once (batch-class names never emitted individually); WS reconnect backoff virtual-time tested; `webEmit` drop-on-disconnect routes only `runtime_error` locally; zoom-safety and Zustand-selector sweeps clean across all frontend areas; no `crypto.randomUUID` remains in scope; `ToolConfirmation` stale-click guard sound; experimental-toggle persist-failure rollback is intentional, documented, and test-pinned.

---

### 112. CONSIDER — Token length counts bytes while the example documents "characters"

*(Origin: pass 8 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [backend/config/web_access.go:295](backend/config/web_access.go#L295)

**Category:** `len` counts bytes; `config.example.yaml` documents an "8–256 characters" range, so a multibyte token passes validation at half the documented length (and vice versa for the minimum).

**Fix:** a) use `utf8.RuneCountInString`; b) document the limit as bytes.

---

### 113. CONSIDER — `useShallowResync`'s schedule comment claims the last-scheduled trigger fires; the first one does

*(Origin: pass 8 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/useShallowResync.ts:43](frontend/src/hooks/useShallowResync.ts#L43)

**Category:** `schedule()` keeps the first timer and later triggers return early, so the comment describes debounce semantics the code does not implement.

**Fix:** a) fix the comment; b) restart the timer on later triggers if last-trigger semantics were intended.

---

### 114. CONSIDER — `Init` doc claims "16 seed fields"; the critical section writes 19

*(Origin: pass 9 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api.go:586](backend/frontend_api.go#L586)
**Fix:** a) correct the count or say "all seed fields".

---

### 115. CONSIDER — Web-RPC rejection envelope is an `Error` object; the module's own comment documents a bare-string rejection

*(Origin: pass 10 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/api/runtime.ts:305](frontend/src/api/runtime.ts#L305)

**Category:** contract drift on a branch-new path. The web-RPC wrapper's doc block ([runtime.ts:249](frontend/src/api/runtime.ts#L249)) says the browser shim "rejects its Promise with the `error` string", but `webRpc` throws `new Error(msg)` — desktop Wails rejections are string-shaped, so `err instanceof Error` branches and `String(err)` rendering ("Error: " prefix) diverge per transport. Cosmetic; no functional caller inspects the envelope shape today.

**Suggested fix:**
a) Reject with the plain string to match the comment.
b) Reword the comment to document the Error envelope.

---

### 116. CONSIDER — `specs/domains/web-access.md` repeats identical ADR citations twice in the Configuration paragraph

*(Origin: pass 10 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/domains/web-access.md:174](specs/domains/web-access.md#L174)

**Category:** copy-paste residue in a branch-new spec. Two adjacent duplicated citation pairs — "([ADR-092](…), [ADR-092](…))" after the LIVE-warning sentence and again at "The `tls:` subsection ([ADR-092](…), [ADR-092](…))".

**Suggested fix:** drop the duplicates.

### Pass 10 dedupe and corroboration

- **Rating disagreements on existing issues (all declined after conductor re-verification, per the report's established calibration):** SF #21 (CreateProjectDialog web dead end) rated MUST for a 7th time and SF #29 (duplicate ADR-090) for a 3rd time and SF #39 (Windows-CI error-substring pins) for a 3rd time — all stay SHOULD (nothing lost or exposed; the rationale recorded at their entries stands). #10 (slow-POST, no body-read deadline) re-rated SHOULD for a 2nd time — stays CONSIDER (materializes only on a deliberately chosen non-loopback bind; the defensible-omission note recorded at #93/#10 stands). #55/#56 (endless sessions skeleton) and #14 (historyLoaded not cleared on single-session delete) re-rated SHOULD — stay CONSIDER (UX-only, self-healing triggers recorded; #14's fix option already names the `dropSessions` consolidation). SF #23 was this time rated CONSIDER by its delegate — the report keeps its SHOULD (the long non-heal window rationale stands).
- **Known issues re-confirmed:** SF #5 (byName staging collision), #93 ("after trimming" doc), SF #30 (ADR-090 D6 gorilla claim), #96 (extended: the delegate added that documents have no input bound at all — markitdown caps conversion OUTPUT only — sharpening the parity claim), #59 (failed_steps dropped), SF #8 (macOS denial→neutral wipe), #21 (task_cancelled unvalidated), SF #33 (TLS LAN bind warning-free, exact restatement), #132 (double close frame), #133 (spurious sessions:changed on unknown ids), and the stale `ChatAPI`/`AttachmentAPI` interfaces recorded under the pass-9 api.ts entry.
- **Pass 10 additionally verified clean (selected):** desktop web-access section re-traced clean for the tenth pass (single-writer cfg seam without lock cycles, stop/restart rollback ordering, mint-before-start persistence, experimental-gate live-follow idempotency, cert-status classification order, RFC 6125 SAN separation, 7-event inbound whitelist with control RPCs unreachable, plan-approval strict-validation hardening verified as deliberate and frontend-union-exact); `UpdateExperimentalFeatures` persist-failure rollback tested; lock-order audit found no ABBA (configMu→webAccessMu one-way); the `web_access` warning-prefix filter proven collision-free; attachment staging parity (0o600 temp, sanitize, oversize); sessions:changed emit sites and task_started exactly-once re-confirmed; echo-text/ClientSendID wiring end-to-end; load-pipeline order (ApplyDefaults→normalizeWebAccess→validate) and Save fail-closed gate re-verified; webaccess auth core re-verified for the tenth pass (cookie-gate first makes the sameOrigin Host-echo unreachable to cross-origin attackers, SameSite=Strict CSRF posture, limiter + constant-time compares, fail-closed TLS, denylist-before-reflection, fan-out backpressure); FE api SendMessage 13-arg parity, notification click payload guard; hooks hitl_resolved decision mapping against the Go emitter, fetchSeq/debounce race guards; stores sweep filter semantics, copy-on-write marker updates, generateUUID v4 fallback bits; specs producers/payloads confirmed in code (event whitelist, caps, limiter, outbox, certgen, CSP, gate conjunction).

---

### 117. CONSIDER — Pre-existing: stores.md "loaded flag" bullet contradicts the actual (and branch-documented) null-sentinel model

*(Origin: pass 9 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding · pre-existing on main)*

**File:** [specs/domains/frontend/stores.md:198](specs/domains/frontend/stores.md#L198)
Verified pre-existing on `main` (the bullet and `sessionStore.ts:75`'s `sessions: SessionInfo[] | null` are both unchanged): "stores that depend on backend data (sessionList, projectList) use a `loaded` flag" was already false. The branch's new [loading-states.md](specs/domains/frontend/loading-states.md) now documents the `sessions === null` sentinel in the same domain, making the stale sibling bullet visibly contradictory. **Fix:** a) reword the bullet to the null sentinel.

### Pass 9 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** SF #16, SF #22, SF #4, SF #21 (rated MUST for a 6th time — kept SHOULD), SF #5, #94 (re-rate SHOULD declined — comment-only drift), #95 (re-rate SHOULD declined — comment-only drift), SF #6, SF #30, SF #18, SF #32, #62, #12, SF #27, #15 (re-rate SHOULD declined — pre-existing bare `context.Background()`, calibration unchanged), #97, SF #39 (rated MUST for a 2nd time — kept SHOULD), #57 (re-rate SHOULD declined), #1, plus the pass-2 control-frame-size CONSIDER and the pass-3 hitl-converge-label CONSIDER. **Extensions merged:** SF #22 (pass 9 adds: the rollback comment is factually wrong — post-write the backend holds the NEW state — and the rollback contradicts the TLS block's keep-optimistic-on-null policy), SF #4 (Enter in one path field during the sibling's in-flight blur-commit hits `writeBusy` and is silently dropped), #118 (`stageAttachmentFiles`' web loop and `useFileDrop`'s web branch are untested — the harness mocks pin `isWebTransport: false`), SF #10 (pass-9 re-report confirms the Android gap; notes the surrounding catch limits it to a silent no-banner rather than a crash), #1 (no-cors cross-origin POST spam from any web page burns the shared loopback bucket → sustained 429 lockout of the real user's login; the SHOULD re-rate was declined — same site and mechanism as filed).

**Conductor-verified pre-existing findings (filed as marked CONSIDERs, calibration per #15/#66):** #53 `sendMessage` activation re-check gap (verbatim on `main`; `ResumeTask` contrasts), #54 `DeleteProject` vs `switchMu` (verbatim on `main`), #90 `startup.go` `!toolsOK` silence + stale comment (block unchanged on `main`), #91 `WorkDirsModal` unhandled rejections and #92 POSIX-only advisory checks (verbatim on `main`), the `useReviewActions` empty-diff prune conflation (`validFiles` guards pre-date the branch — folded into the SF #27-adjacent pre-existing class, not numbered separately), the `isPlanStepPausedData` duration-type-guard gap (verbatim on `main`, including the sibling comment naming it as symmetric — folded into the same pre-existing class), #117 stores.md `loaded flag` (verbatim on `main`).

**Pass 9 additionally verified clean (selected):** `EventTaskStarted`'s doc matches the code (the lifecycle-mirror list is exact; the resume path emits `task_resumed`+`session_resumed`, never `task_started`) and `emitSessionsChanged` covers every list mutation its doc names, pinned by `frontend_api_sessions_changed_test.go` — corroborating that pass 8's SF #37 fix class is otherwise clean; the webaccess security core re-confirmed for the ninth pass (auth gating, denylist-before-reflection, fail-closed TLS/nil-dispatch, body caps applied before allocation, client-mask enforcement, atomic cert publication, Secure-cookie TLS coupling, panic isolation); `config.example.yaml` web-access block defaults consistent with code; SendMessage 13-arg wire parity and the base64 `[]byte` mapping re-confirmed; `wailsAccessInvariant` uses a real TS parser with comment masking; transport detection never rejects (so `armWhenRuntimeReady`'s fire-and-forget cannot go unhandled); `useSessionLoader` fetchSeq supersession and `useShallowResync` debounce/race guards race-safe; chatStore selectors referentially stable; zoom-safety and selector sweeps clean across all frontend areas; specs INDEX lists all new specs, all relative links resolve, SECURITY.md's web-access threat-model entry present and consistent.

---

### 118. CONSIDER — The new web attachment-staging path has no unit tests

*(Origin: pass 2 · Impact class: T — test / CI-only defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/hooks/useStageAttachments.test.tsx](frontend/src/hooks/useStageAttachments.test.tsx) (also the `isWebTransport()` branches of `useFileDrop`/`useAttachmentsInput`)
**Category:** test coverage. Only the api-level `attachFileContent` is covered; the per-file loop (mid-loop failure, claim draining) is unpinned — the region where finding SF #5 sits.
**Fix:** a) Add a multi-file web-loop test including a mid-loop failure. b) Flip `isWebTransport` in a useFileDrop test and assert HTML5-drop staging.

**Pass 5 extension:** [frontend/src/lib/browserFilePicker.ts](frontend/src/lib/browserFilePicker.ts) — the only net-new lib file without a unit test — belongs to the same gap: its settle-once contract (first of `change`/`cancel` wins; second finish is a no-op) and the pick→`stageAttachmentFiles` glue are exercised by no test (the hook harnesses pin `isWebTransport: () => false`), so the documented no-cancel-engine input leak (#18) and the duplicate-basename path (SF #5) are both unpinned.

---

### 119. CONSIDER — `TestStopWebAccess_BoundedEvenWithExpiredDeadline` holds `webAccessMu` across a fatal assertion, deadlocking its own cleanup

*(Origin: pass 2 · Impact class: T — test / CI-only defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [desktop/webaccess_test.go:354-367](desktop/webaccess_test.go#L354-L367)
**Category:** tests. `t.Fatal` inside the critical section skips the manual `Unlock`; the cleanup's `stopWebAccess` then blocks until the go-test timeout — noisy CI diagnostics exactly when the guarded regression occurs. Violates the project's "register idempotent release cleanup before any fatal assertion" convention.
**Fix:** a) `defer a.webAccessMu.Unlock()` immediately after the Lock. b) Wait on `done` before locking.

---

### 120. CONSIDER — Duplicated `seedPublished.Store` in the `restart()` test helper

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_worktrees_test.go:229-230](backend/frontend_api_worktrees_test.go#L229-L230)
**Category:** tests/style. Back-to-back identical atomic stores; reads like a merge artifact.
**Fix:** a) Delete one line. b) Comment it if deliberate.

---

### 121. CONSIDER — The bind's unfinished-task / active-task refusal gates have no pinned tests

*(Origin: pass 1 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_worktrees.go:319-332](backend/frontend_api_worktrees.go#L319-L332) vs [backend/frontend_api_worktrees_bind_test.go](backend/frontend_api_worktrees_bind_test.go)
**Category:** test coverage. The store's atomic fresh-window guard is the authoritative race-closer and is tested; these two pre-checks are defense-in-depth without a regression pin — a refactor could silently drop them.
**Fix:** a) Add a bind test seeding an unfinished task row asserting `errors.Is(err, session.ErrSessionNotFresh)` and `noManagedTrees`. b) At minimum pin the `HasUnfinishedTask` gate and reference the store guard for the status gate.

---

### 122. CONSIDER — `dispatch.go` claims a contract-test pin for `uploadBodyMethods` that no test provides

*(Origin: pass 2 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/dispatch.go:85-93](internal/webaccess/dispatch.go#L85-L93)
**Category:** doc/test mismatch. If `FrontendAPI.AttachFileContent` is renamed, the map key silently goes dead — web uploads over 1 MiB start failing 413 with the suite green.
**Fix:** a) Add a subtest asserting every key resolves to an exported method (`srv.Dispatchable(key)`). b) Soften the comment to "manual".

---

### 123. CONSIDER — `useBackgroundSessionWatcher.test.ts` mock factories omit exports the source imports: latent access-time crash

*(Origin: pass 5 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/events/… /useBackgroundSessionWatcher.test.ts:86-99](frontend/src/hooks/events/useBackgroundSessionWatcher.test.ts#L86-L99)
**Category:** latent test debt. The `hitlHandlers` factory provides only 4 of the 5 imported handlers (`handleHitlResolvedEvent` missing) and `goalHandlers` omits `handleGoalSuggestionEvent`; vitest factory mocks throw only when the binding is dereferenced, and no current test fires `hitl_resolved`/`goal_suggestion` — so the suite passes today, but the first test for those subscriptions (already wired in the source and counted in the hard-coded 15/30 subscription totals) fails confusingly.
**Fix:** a) Add the two missing mock exports (plus one test each firing the events). b) Derive the per-session subscription count from a shared constant so the 15/30 assertions track the source.

---

### 124. CONSIDER — New `ThemeSelector` dropdown test parks Radix's open with a real 10 ms delay promise

*(Origin: pass 7 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/ThemeSelector.test.tsx:118](frontend/src/components/settings/ThemeSelector.test.tsx#L118)

**Category:** test timing. The open-wait uses `setTimeout(10)` real time; the project's sanctioned pattern for Radix open waits is the fake-timer helper in `frontend/src/test/virtualTime.ts` (timing rules discourage new real-delay debt).

**Fix:** a) port `openDropdown` to the virtualTime helper; b) keep as-is citing the existing harness precedent (tuningTestHarness).

---

### 125. CONSIDER — The echo `IsNudge` flag and the persisted `is_nudge` stamp are set at two sites; only half the must-agree invariant is pinned

*(Origin: pass 8 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [backend/session/events.go:107](backend/session/events.go#L107)

**Category:** the manager sets the echo flag while `FrontendAPI` stamps the DB row from the returned classification — two sites that must agree, with the test pinning the agreement per-branch on the echo only.

**Fix:** a) add one test asserting the persisted stamp matches the echo classification for live/nudge/fresh sends.

---

### 126. CONSIDER — WebAccessSettings test fixtures omit the required `tokenPinned` field

*(Origin: pass 8 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/WebAccessSettings.test.tsx:44](frontend/src/components/settings/WebAccessSettings.test.tsx#L44)

**Category:** the `runningInfo`/`offInfo` fixtures bypass the `WebAccessInfo` contract they model, so a new required field cannot break their compilation the way the source's contract drift would.

**Fix:** a) type the fixtures as `WebAccessInfo` so drift fails compilation.

---

### 127. CONSIDER — Startup test polls an async emit with a 5ms sleep loop

*(Origin: pass 9 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [desktop/startup_phases_test.go:296](desktop/startup_phases_test.go#L296)
`TestBuildConfirmCallback_HappyPath` sleeps to await the emit — the project's timing rules bar sleep-to-sync in new tests. **Fix:** a) signal arrival via a channel from the `uiEmit` stub.

---

### 128. CONSIDER — Sleep-based negative assertions probe save-serialization overlap

*(Origin: pass 9 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [backend/frontend_api_config_test.go:4258](backend/frontend_api_config_test.go#L4258), [:5312](backend/frontend_api_config_test.go#L5312)
50ms/200ms sleeps probe overlap that `saveMu` plus the existing counter/order snapshots already make deterministic — new sleep debt per the timing rules. **Fix:** a) assert via the counter/order snapshots with enter-hook signals and explicit release barriers.

---

### 129. CONSIDER — `goal_suggestion` attention classification is never asserted

*(Origin: pass 9 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/lib/systemNotifications.test.ts:184](frontend/src/lib/systemNotifications.test.ts#L184)
The distinct-title test lists 6 of the 7 attention cases; `goal_suggestion` (kind/title/body) is unasserted anywhere. **Fix:** a) add it to `attentionEvents` and expect 7 distinct titles.

---

### 130. CONSIDER — `HTMLAnchorElement.prototype.click` spy is never restored in CopyButton tests

*(Origin: pass 9 · Impact class: T — test / CI-only defect · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/CopyButton.test.tsx:238](frontend/src/components/chat/CopyButton.test.tsx#L238)
`clearAllMocks` does not restore spies, so the no-op anchor click leaks to later tests in the file. **Fix:** a) `mockRestore()` in the web describe's `afterEach`.

---

### 131. CONSIDER — WebAccessSettings.tsx is 463 lines, well over the ≤200-line component target

*(Origin: pass 1 · Impact class: H — code hygiene · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/settings/WebAccessSettings.tsx](frontend/src/components/settings/WebAccessSettings.tsx)
**Category:** structure. The TLS block was extracted explicitly to keep the parent under target, yet the parent still carries the address block, token block, and three warning banners.
**Fix:** a) Extract the token block into `WebAccessTokenSettings.tsx`. b) Extract the warning banners into a small component. c) Record the deviation in a comment if deferred.

---

### 132. CONSIDER — A peer-initiated close is answered with two close frames

*(Origin: pass 5 · Impact class: H — code hygiene · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [internal/webaccess/ws.go:370](internal/webaccess/ws.go#L370) (echo) and [:287](internal/webaccess/ws.go#L287) (deferred `Close()`)
**Category:** RFC 6125/§7.1.1 closing-handshake cleanliness. `wsReadPump` always exits through `defer c.Close()`, whose best-effort close frame has no "close already sent" memory; when the client initiated the closing handshake, the echo at the `opClose` case has already gone out, so the server emits a second close (code 1000). Every real browser ignores it and the socket is torn down immediately — no hang, leak, or interop failure observed; flagged because the package otherwise tracks the RFC's MUSTs precisely.
**Fix:** a) Add a `sentClose` flag (under `writeMu`) that `Close()` checks. b) Move the close echo solely into `Close()`, having `readMessage` only signal the received code. c) Accept and note it in the stage-2 keepalive comment.

---

### 133. CONSIDER — `DeleteSessionWithOptions`/`ArchiveSession`/`PinSession` emit `sessions:changed` even when the id is unknown and nothing mutated

*(Origin: pass 7 · Impact class: H — code hygiene · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [backend/frontend_api_session.go:240](backend/frontend_api_session.go#L240), also [:334](backend/frontend_api_session.go#L334) and [:362](backend/frontend_api_session.go#L362)

**Category:** `HasSession` false paths still emit, so each stray call triggers a spurious global list re-read on every surface. Cheap, but the emission contract elsewhere is "emit at success points".

**Fix:** a) emit only when a row was found/mutated; b) accept and document as an idempotent refresh.

---

### 134. CONSIDER — Exposure warnings build messages with `fmt.Sprintf` inside `log.Warn` instead of structured attrs

*(Origin: pass 1 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/webaccess.go:262-264](internal/webaccess/webaccess.go#L262-L264)
**Category:** structure (convention). Every other diagnostic in the package uses slog structured attributes.
**Fix:** a) Convert to `log.Warn("...", "bind", ..., "transport", ...)` and tweak the two substring assertions. b) Leave as-is (stylistic).

---

### 135. CONSIDER — `StageDone` emitted twice for every engine wheel

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install_mlx.go:202-205](core/embeddedllm/install_mlx.go#L202-L205) vs `fetchComponents` in `core/embeddedllm/install.go`
**Category:** progress-event fidelity. Wheels are fetched with `staging == ""` (StageDone at fetch), and the post-promote loop (which exists to close the python component's deferred stream) re-emits StageDone for all engineAssets — 46 duplicate terminal events per install and two sources of truth for who emits a component's terminal stage. Consumers keying on component+stage are idempotent.
**Fix:** a) Loop over only the staged-extracted component (`engineAssets[:1]`). b) Have `splitMLXAssets` return the python asset separately so the terminal emit is explicit.

---

### 136. CONSIDER — SessionWorkspaceSelector.tsx grew past the 200-line target (305 lines)

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/SessionWorkspaceSelector.tsx:54](frontend/src/components/chat/SessionWorkspaceSelector.tsx#L54)
**Category:** structure. One component carries three render modes plus two subtle inline predicates (`isFresh`, `windowClosed`) that deserve isolated pure-helper tests.
**Fix:** a) Extract the pinned chip and preparing hint into sibling components. b) Move the predicates into a small pure helper (e.g. `lib/sessionFreshness.ts`) with unit tests. c) Split the doc comment between the two predicates.

---

### 137. CONSIDER — Redundant double close (and a divergent no-op edge) in the worktree pick handler

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/GitPanel/BranchPicker.tsx:508-514](frontend/src/components/GitPanel/BranchPicker.tsx#L508-L514) (vs `recordChoice` at 279)
**Category:** structure/consistency. `recordChoice` already closes; the trailing `closeBranchPicker()` is a no-op today but diverges on the degenerate null-activeSessionId edge (picker row click leaves it open; worktree row click closes without recording).
**Fix:** a) Drop the trailing close and let `recordChoice` be the single closer for pick mode. b) Make `recordChoice` always close (before the null guard).

---

### 138. CONSIDER — SessionSelector.tsx (339 lines) renders the Archived section twice; over the 200-line target

*(Origin: pass 1 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/layout/SessionSelector.tsx:250-321](frontend/src/components/layout/SessionSelector.tsx#L250-L321)
**Category:** structure. The flat-mode archived branch duplicates the grouped archived JSX tree; the two can drift and `archivedCount` must stay in lockstep by convention.
**Fix:** a) Extract an `ArchivedSection` component rendering both modes. b) Derive flat archived rows from the same grouping model.

---

### 139. CONSIDER — BranchPicker.tsx (570 lines): draft/pick-mode logic is an extractable unit

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/GitPanel/BranchPicker.tsx:236-352](frontend/src/components/GitPanel/BranchPicker.tsx#L236-L352)
**Category:** structure. ~120 lines of self-contained pick-mode logic (pending read, `recordChoice`, three draft callbacks, two marker derivations) inside an already-large component.
**Fix:** a) Extract a `useWorkspacePick(...)` hook. b) Move `draftSelectedRemote`'s shape check into a pure lib helper with a unit test.

---

### 140. CONSIDER — wailsAccessInvariant guard does not catch destructuring window access

*(Origin: pass 1 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/test/wailsAccessInvariant.test.ts:90-92](frontend/src/test/wailsAccessInvariant.test.ts#L90-L92)
**Category:** structure (guard coverage). `const { runtime } = window` compiles, touches the raw Wails surface outside the shim, and passes the scan — silently breaking the web transport, the exact failure class the invariant prevents.
**Fix:** a) Add a destructuring pattern to `VIOLATION_PATTERNS`. b) Document the gap (dot + bracket-string only) in the file header.

---

### 141. CONSIDER — Raw path used as link label in the Boundary Rule

*(Origin: pass 4 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [specs/contracts/desktop-frontend.md](specs/contracts/desktop-frontend.md) (Boundary Rule, new transport list)
**Category:** doc polish. `[../domains/web-access.md](../domains/web-access.md)` renders as a literal file path; the sibling link in the same sentence uses a proper label ("ADR-090").
**Fix:** a) Label it "[the web-access domain spec](../domains/web-access.md)". b) Match the surrounding docs' link-label style throughout the new transport section.

---

### 142. CONSIDER — Stray indentation on a `removeAttribute` statement in ThemeSelector.test.tsx (merge artifact)

*(Origin: pass 5 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/settings/ThemeSelector.test.tsx:90-91](frontend/src/components/settings/ThemeSelector.test.tsx#L90-L91)
**Category:** cosmetic. One statement is mis-indented relative to its siblings; the formatter would normalize it.
**Fix:** a) Run the formatter over the file. b) Hand-fix the indent.

---

### 143. CONSIDER — The repeated-experimental-open "quiet" path still logs an Info line

*(Origin: pass 8 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [desktop/app.go:1189](desktop/app.go#L1189)

**Category:** the comment says a repeated experimental-gate open over an already-live sidecar is quiet, but `logWebAccessReady` then emits an Info "sidecar ready" line for the server that was already running.

**Fix:** a) skip the log when `startWebAccessLocked` returned the existing server; b) amend the comment to match behavior.

---

### 144. CONSIDER — `ChatArea.tsx` (235 lines) still exceeds the ≤200-line component target after the loader extraction

*(Origin: pass 8 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/components/chat/ChatArea.tsx](frontend/src/components/chat/ChatArea.tsx)

**Category:** project convention target; the extraction this branch performed reduced the file but left it over the line.

**Fix:** a) extract the empty/spinner render branch in a follow-up.

---

### 145. CONSIDER — `initRuntimeProbe()` is a module-level side effect, deviating from the project's no-module-side-effects principle

*(Origin: pass 8 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/main.tsx:23](frontend/src/main.tsx#L23)

**Category:** self-acknowledged in a comment; load-bearing for the web transport's pre-render "checking" hold, but the exception exists only as a comment.

**Fix:** a) codify the bootstrap-entry exception in the frontend spec; b) move the call behind an explicit `init()` invoked from the entry point.

---

### 146. CONSIDER — The added hitl_resolved rows drop the security-model diagram's two-space gutter

*(Origin: pass 8 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [specs/architecture/security-model.md:203](specs/architecture/security-model.md#L203)

**Category:** the new ASCII-flow rows are misaligned against the surrounding diagram.

**Fix:** a) realign the leading spaces.

### Pass 8 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** SF #16, SF #22, SF #4, SF #21 (rated MUST for a 5th time — kept SHOULD, 5 SHOULD ratings vs 5 MUST ratings across passes), SF #5, #93 (re-rate to SHOULD declined — doc-accuracy on a validated invariant stays CONSIDER per calibration), #94 (same decline), #131, #95 (re-rate declined — the implemented contract is deliberate and test-pinned), #17, SF #29, SF #30, #58, #11 (re-rate declined — a late resync overwrite is transient list staleness that self-heals on the next `sessions:changed`), SF #7 (the notifications.ts permission-read sites; fourth site :177 added below), #119, #19, #60, SF #1, #7, SF #9, #12, SF #11, SF #39 (both Windows-CI sites independently re-found — `web_access_test.go:759` and `frontend_api_config_test.go:4045`), #66 (the delegate's "pre-existing nudge ghost card" observation), #65, #14 (re-rate declined per the pass-7 calibration), the ADR-090 duplicate-number issue, the ADR-090 D6 gorilla→stdlib doc issue.

**Extensions merged:** SF #21 (the web-transport test asserts only the hint string, so the dead end ships green — same root cause, the fix necessarily rewrites the test), #131 (the extraction comment claiming the parent stays "under the 200-line target" while it is 463 lines), SF #7 (notifications.ts:177 added to the raw-read site list), #60 (stale Shift+click "native save-file dialog" docstring on the anchor-download path), SF #32 (ADR-090 decision 10 at [090-browser-web-access.md:39](specs/decisions/090-browser-web-access.md#L39) repeats the stale "refuses https://" claim — third doc site), SF #11 (the missing web branch also means a remote tab stages the *server's* clipboard content — stale/wrong attachment, not just a guaranteed failure), #65 (the exposure warning also misfires on an unvalidated non-IP bind — `WebAccessLoadWarnings` lacks a bind-validity gate, [web_access.go:332](backend/config/web_access.go#L332)).

**Pre-existing observations recorded, excluded from the numbered body (code unchanged by this diff, per the review scope):** a double-activation race in `sendMessage`'s second lock hold (`manager_execution.go:910` — the region sits in an untouched gap between the diff's hunks; two concurrent sends into one idle session can both activate, relevant only if the exactly-once contract is later extended to concurrent sends); impure `setSplashTools` updater in `App.tsx:239` (StrictMode double-invoke); sleep-poll in `startup_phases_test.go:321`; single-session-delete store-slice leak in `useSessionActions.ts:191` (the pre-existing base under #14); dead `.catch` in `ChatArea.tsx:109` (a consequence of #95's contract); `MCPServerForm` comma-arg splitting; `SystemNotificationSettings` mount-time probe; `persistConfig` announce-on-failure (the #62 family); main's own pre-existing duplicate ADR-090 pair.

**Pass 8 additionally verified clean (selected):** `RefreshWebAccessLoadWarnings`' "web_access" prefix-cut re-verified against every emitted warning shape (no other section shares the prefix) and the configMu→webAccessMu one-directional order held at every call site; `AttachFileContent` parity re-confirmed (32 MiB cap = `session.maxImageFileBytes`, mime map matches registered decoders, sanitization fails closed); webaccess auth core re-traced for the eighth pass (constant-time compare, per-launch cookie, rate limit, WS origin admission, control-frame handling, denylist order, atomic cert publication); SendMessage echo identity-threading verified on all three classifications (live/nudge set `IsNudge`, fresh/continuation unset) with the persisted-row stamp matching; `task_started` exactly-once at the single activation point with the persister transient-skip confirmed; `hitl_resolved` bypasses the persister as documented; `emitSessionsChanged` covers the full real mutation set; DTO/arity roundtrips re-confirmed (`clientSendId` at generated binding position 12, 13-arg tests); WS backoff exponential-capped and deterministic; 401 triggers the auth gate while rejecting the caller; base64 `[]byte` wire form deliberate and documented; new tests virtual-time/scoped-spy clean (no real delays, no missing mocks); specs links and INDEX consistent.

---

### 147. CONSIDER — `wsReadPump`'s `opPing`/`opPong`/`opClose` branches are unreachable dead code

*(Origin: pass 9 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [internal/webaccess/ws.go:363](internal/webaccess/ws.go#L363)
`readMessage` answers control frames internally and returns only text/binary ops, so the switch's other cases mislead readers. **Fix:** a) delete the dead branches.

---

### 148. CONSIDER — `ChatAPI.sendMessage` in types/api.ts is stale and dead

*(Origin: pass 9 · Impact class: H — code hygiene · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/types/api.ts:31](frontend/src/types/api.ts#L31)
Declares a removed `mode` param and omits `activeMCPServers`/`e2s`/`goalBudget`/`reviewMode`/`clientSendId`/`workspace`; the interface is imported nowhere. **Fix:** a) resync or delete `ChatAPI`/`AttachmentAPI`.

