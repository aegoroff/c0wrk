# Code Review — SHOULD FIX (importance-sorted working list)

> Branch `ui/web` vs `main`, scope `git diff main...HEAD` (188 files). Review status: saturation reached — the review is closed. **39 entries** (35 in-scope + 4 out-of-scope annex; entries 24 and 26 are folded CONSIDER facets of entries 23 and 25). Numbering is local to this list: 1–39, importance-descending.

**Cross-references.** Bare `#n` refers to entry n in this list. `SF #n` = entry n in the SHOULD FIX list; `CS #n` = entry n in the CONSIDER list.

**Sort scheme (descending importance).** Key: (1) impact class — `S` security posture/exposure → `B` guaranteed breakage or data/config loss → `R` races, resource and reliability hardening → `F` functional degradation / recoverable UX → `D` documentation, spec or comment contradictions → `T` test/CI-only defects → `H` code hygiene; (2) evidence strength — `E1` an independent pass rated the issue MUST (kept SHOULD) or proposed a SHOULD re-rate (kept CONSIDER), both declined after conductor re-verification per the review's calibration → `E2` corroborated by a later blind pass → `E3` single-pass finding; (3) branch-new before pre-existing on `main`. Impact dominates: a single-pass security gap ranks above a thrice-MUST-rated UX papercut.

**Folded companion entries.** Entry 26 (CONSIDER) is a folded facet of entry 25 — the populated-transcript side of the same failed-history-card mechanism; entry 24 (CONSIDER) is a folded facet of entry 23 — the frontend override-bit side of the same pending-actions radar-indicator mechanism. Each sits directly after its parent entry.

---

### 1. SHOULD FIX — `POST /api/rpc` authenticates by cookie only; the same-origin gate that `/ws` enforces against exactly this threat is missing

*(Origin: pass 3 · Impact class: S — security posture / exposure · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [internal/webaccess/webaccess.go:316](internal/webaccess/webaccess.go#L316) (the gate exists at [internal/webaccess/ws.go:96](internal/webaccess/ws.go#L96), [:198-206](internal/webaccess/ws.go#L198-L206))
**Category:** security (authz hardening, CSRF-adjacent; verified against the route table).
`requireAuth` checks only the `SameSite=Strict` cookie. SameSite separates *sites*, not *origins*: a page served from any other port on the same host string (e.g. `http://127.0.0.1:3000` while the sidecar is on its port) can fire a preflight-free `Content-Type: text/plain` no-cors `POST /api/rpc/<method>` with `credentials: 'include'`; the cookie rides along and `handleRPC` parses the body regardless of content type — every RPC (control RPCs are already server-side isolated) executes fire-and-forget. `/ws` enforces exact `Origin` equality against precisely this class; the state-changing route (and `/api/login`) does not.
**Why it is a problem:** the report's own web-access threat model treats same-site cross-origin as adversarial for `/ws`; the inconsistency leaves a same-power bypass on the RPC route reachable from any co-located page.
**Suggested fix:**
a) Reject requests whose `Origin` is present and not exactly `scheme://r.Host` on `/api/rpc` (and `/api/login`), reusing `sameOrigin`.
b) Additionally/alternatively require `Content-Type: application/json` on RPC (no-cors requests cannot send it).

---

### 2. SHOULD FIX — `SetWebAccessEnabled(true)` mounts the sidecar even though the master experimental gate is closed

*(Origin: pass 4 · Impact class: S — security posture / exposure · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [desktop/app.go:1099-1131](desktop/app.go#L1099-L1131) (`setWebAccessEnabledLocked` → `startWebAccessLocked`; neither checks `cfg.Experimental.Enabled`) vs [desktop/app.go:1170](desktop/app.go#L1170) (`applyExperimentalWebAccess`, which mounts only on the `enabled && cfg.WebAccess.Enabled` conjunction)
**Category:** gate bypass on a public binding. ADR-090 decision 13 defines availability as the conjunction "enforced externally to the section, at the only two points where the app decides to mount"; the toggle is a third mount decision that skips the conjunction. Settings hides the block while the gate is closed, but `SetWebAccessEnabled` is a public Wails binding — a programmatic caller, config-restore path, or webview-console invocation can mount a full-remote-control listener with the master switch off. Tests hardwire the gate open (`writeWebAccessConfig` sets `experimental.enabled: true`), so nothing pins the closed-gate behavior.
**Fix:** a) Start the sidecar in the toggle only when `cfg.Experimental.Enabled`, via one shared conjunction helper used by `initWebAccess`/`applyExperimentalWebAccess`/the toggle; add a closed-gate toggle test. b) Refuse enabling outright while the gate is closed with an error naming the master switch.

---

### 3. SHOULD FIX — Fail-soft bind/port reset silently wipes a hand-authored TLS subsection while the sibling reset deliberately preserves it

*(Origin: pass 1 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [backend/config/web_access.go:393-401](backend/config/web_access.go#L393-L401) (`normalizeWebAccess`)
**Category:** behavior / config data loss / internal inconsistency

The bind/port fail-soft branch replaces the **whole section** with `defaultWebAccessState()` (line 399), zeroing `tls.cert`/`tls.key`. Twelve lines later the TLS-unusable branch does the opposite: only `cfg.WebAccess.Enabled = false`, with the explicit comment that "the operator's paths survive the reset". The bind/port warning text does not mention the wipe.

**Why it is a problem:** `config.example.yaml` documents hand-editing `tls.cert`/`tls.key` as the way to use an operator-owned certificate. Realistic trigger: an operator writes a malformed `bind` (e.g. port typed into the bind field) alongside their own PEM pair → load warns and resets the section in memory → the **next `Save` for any unrelated settings change persists `enabled: false` with empty cert/key paths**, silently destroying the authored pair; the warning only names bind/port, so nothing hints the paths were erased. The ADR-092 fix-and-re-enable flow presumes the subsection survives a reset.

**Suggested fix:**
a) Mirror the sibling branch: reset only `Enabled`/`Bind`/`Port`/`Token` and preserve `cfg.WebAccess.TLS` as authored (a disabled section is inert; the persisted shape stays valid, and the TLS check below is skipped for the disabled section either way).
b) Keep the wipe but say so in the warning ("…and clears the tls.cert/tls.key paths") and pin the wipe with a test so it is at least observable.

**Pass 5 extension:** the wipe also destroys a hand-authored **static token** (the reset assigns `defaultWebAccessState()`, zeroing `Token` too), while the warning's "fix bind/port and re-enable" implies a one-field repair — the actual repair is three fields (bind/port, token, TLS pair), and the token loss silently re-authenticates every existing browser setup on the next start. The sibling TLS-unusable path deliberately preserves bind/port/token for its fix-and-re-enable flow ([backend/config/web_access.go:410-415](backend/config/web_access.go#L410-L415)), which is what makes the asymmetry misleading.

---

### 4. SHOULD FIX — With TLS enabled, editing BOTH cert and key paths can never be committed (draft deadlock)

*(Origin: pass 1 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/settings/WebAccessTLSSettings.tsx:93-95](frontend/src/components/settings/WebAccessTLSSettings.tsx#L93-L95)
**Category:** bug / partial-save flow

`commitPath(field)` pairs the edited field's draft with the sibling's **persisted** value: `const cert = field === 'cert' ? certDraft.trim() : info.tlsCert ?? ''` (and symmetrically for key). The backend verifies the pair as a unit (`tls.LoadX509KeyPair` before persist). When the operator must replace both halves of a pair while `tlsEnabled` is true (rotating to a new external pair), each self-committing blur sends a mismatched pair — both commits are refused, `info` never updates (re-read runs only on success), so the next commit pairs new-draft-with-old-sibling again: the fields deadlock with no way to land `(certB, keyB)`.

**Why it is a problem:** a core save flow of the new TLS section cannot complete for a legitimate input; the operator sees repeated refusals no amount of retyping fixes.

**Suggested fix:**
a) Thread the sibling **draft** (trimmed, empty-falls-back-to-persisted) instead of the persisted value, so the first blur after editing both fields commits the complete new pair — matches the "backend loads the pair as a unit" design.
b) Commit as a unit: fire the RPC only when `(cert, key) !== persisted pair`, always sending both drafts.
c) Give the two path fields one shared commit (debounced pair-commit or an explicit Apply button for the pair).

---

### 5. SHOULD FIX — Same-named files in one web drop: `byName` map stages the wrong file's content

*(Origin: pass 1 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/hooks/useStageAttachments.ts:173-190](frontend/src/hooks/useStageAttachments.ts#L173-L190)
**Category:** bug / content integrity

`stageAttachmentFiles` builds `const byName = new Map(files.map((f) => [f.name, f]))` and resolves each staged entry back to its `File` via `byName.get(e.fileName)`. A name-keyed map cannot represent two files with identical names: the last one wins. In the web transport a user can multi-select/drag two files with the same basename from different folders — both entries look up the *same* `File` object, so one attachment is silently staged with the other file's **bytes** under its name. Nothing fails, no error is shown; the wrong content travels into the agent context.

**Suggested fix:**
a) Zip by index instead of by name: build entries and `File` list in parallel and pass the `File` alongside each entry in the closure, making the name display-only metadata.
b) Key the map by a per-file unique handle (the `File` object or index); keep a name→count multimap only for the legacy name-only path.
c) Minimal hardening: detect duplicate names up front and stage duplicates one-by-one in separate `stageEntries` calls.

---

### 6. SHOULD FIX — The mtplx server spawn passes a directory where `mlxChildEnv` requires the interpreter path, corrupting the child's PATH and engine-state paths

*(Origin: pass 2 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [core/embeddedllm/server.go:2222](core/embeddedllm/server.go#L2222) (contract at [core/embeddedllm/server_mlx.go:227-233](core/embeddedllm/server_mlx.go#L227-L233); correct call sites at [core/embeddedllm/install_mlx.go:375](core/embeddedllm/install_mlx.go#L375), [core/embeddedllm/install_mlx.go:401](core/embeddedllm/install_mlx.go#L401))
**Category:** bug (env correctness on every mtplx launch).
`mlxChildEnv(parent, goos, pythonBinPath)` documents `pythonBinPath` as the interpreter (`<tree>/python/bin/python3.12`): `Dir` of it must be the pinned `bin` dir that leads PATH, and triple-`Dir` the tree root. The two install-time call sites pass the interpreter; the production spawn site passes `binaryDir := filepath.Dir(spec.ServerBinary)` — i.e. `<tree>/python/bin`. Every derivation shifts one level up: PATH leads with `<tree>/python` (the pinned `bin` dir is not on PATH at all, contradicting the spawn-site comment) and `MTPLX_CONFIG`/`MTPLX_MODEL_DIR` resolve to `<runtimesRoot>/config.toml` and `<runtimesRoot>` instead of the engine tree.
**Why it is a problem:** on every mtplx server launch (darwin/arm64 `engine: auto`) the long-running child gets wrong env: the engine's state file lands in the shared `~/.c0wrk/runtimes/` root — a directory no removal scope deletes (`removeRuntimeTrees` matches only `llama-*`/`mtplx-*` prefixes) and `DetectLeftovers` never reports — so stale engine state survives Remove and is shared across pin bumps; child subprocesses resolving pinned-`bin` console scripts fall through to the inherited system PATH. `TestMLXChildEnv` feeds the interpreter path directly, so the mismatch is invisible to the suite.
**Suggested fix:**
a) Pass `spec.ServerBinary` instead of `binaryDir` at the spawn site (keep `Dir: binaryDir` for the child CWD), matching the contract and the pip/smoke call sites.
b) Alternatively have `mlxChildEnv` take the bin dir (renamed parameter) and update the two install call sites, so no caller can pass the wrong shape.

---

### 7. SHOULD FIX — Two web-transport paths read `Notification.permission` directly, bypassing the module's own throw-safe reader (re-rated in pass 3)

*(Origin: pass 2 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/api/notifications.ts:132](frontend/src/api/notifications.ts#L132), [:58](frontend/src/api/notifications.ts#L58), [frontend/src/App.tsx:78](frontend/src/App.tsx#L78)
**Category:** robustness (re-rated CONSIDER → SHOULD FIX by pass 3). Firefox throws SecurityError from the getter on insecure origins (the reason `readNotificationPermission()` exists and is tested); the raw reads turn background notification sends into rejections plus per-event warns instead of the designed silent drop. Pass 3 additionally verified the boot path: `initSystemNotifications` (line 58) reads the raw getter inside the async function, and `App.tsx:78` discards it with `void initSystemNotifications()` under a comment claiming both inits "never throw" — on a non-loopback HTTP bind (an explicitly supported shape) with Firefox, every page load produces an unhandled promise rejection, violating the project's clean-run rule for expected diagnostics.
**Fix:** a) Use `readNotificationPermission()` in both paths (treat `null` as denied/skip) and correct the App.tsx comment. b) Minimal: safe reader at line 132 only, drop the getter from the line-58 log.

---

### 8. SHOULD FIX — Desktop toggle-on resets a real "denied" notification authorization to neutral

*(Origin: pass 4 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/settings/SystemNotificationSettings.tsx:146](frontend/src/components/settings/SystemNotificationSettings.tsx#L146) with [frontend/src/api/notifications.ts:201-203](frontend/src/api/notifications.ts#L201-L203)
**Category:** logic error introduced by the diff (the toggle path never touched permission state before). On the desktop transport `ensureNotificationPermission()` is a no-op that resolves `'granted'`, so the unconditional `setPermission(outcome === 'denied' ? 'denied' : 'neutral')` wipes the `'denied'` state the mount probe set from the real OS read (line 120).
**Why it is a problem:** on macOS with notifications denied in System Settings, the muted hint shows; toggling the master switch off→on hides the hint and reveals the Test button although the OS authorization is still denied — a misleading dead-end UI.
**Fix:** a) Derive permission from the outcome only on the web transport (`if (isWebTransport()) setPermission(...)`). b) Make `ensureNotificationPermission` return the real desktop authorization instead of a constant.

---

### 9. SHOULD FIX — Web-transport download revokes the blob URL synchronously after click (re-rated from CONSIDER in pass 5)

*(Origin: pass 4 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

> Re-rated in pass 5: a fresh blind pass confirmed the WebKit mechanism is not merely cosmetic — same-tick revocation can cancel the in-flight download handoff entirely, so a Safari user clicks Save, the button flashes "Download started", and no file arrives: silent feature loss with positive feedback on a first-class web-transport client (the original pass-4 rating weighed only the "sometimes flaky" reading).

**File:** [frontend/src/components/chat/CopyButton.tsx:85-88](frontend/src/components/chat/CopyButton.tsx#L85-L88)
**Category:** browser-compat hardening. `anchor.click()` is immediately followed by `URL.revokeObjectURL(url)`; safe in Chromium/Firefox, but WebKit/Safari have historically raced same-tick revocation against the in-flight download (the reason FileSaver.js defers revocation). The web transport targets "a normal browser page", which includes Safari; the test stubs `click`, so it cannot catch this.
**Fix:** a) Defer: `setTimeout(() => URL.revokeObjectURL(url), 10_000)`. b) Revoke on the next `flashFeedback` timer expiry (2 s) instead of inline. c) Attach the anchor to the document before clicking (`appendChild`/`click`/`remove`) — covers the old-Gecko detached-anchor quirk alongside the revoke race.

---

### 10. SHOULD FIX — `new Notification()` is unguarded: on Android browsers every banner throws a raw TypeError while Settings reports "granted"

*(Origin: pass 5 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/api/notifications.ts:139](frontend/src/api/notifications.ts#L139) (guards at [:128-134](frontend/src/api/notifications.ts#L128-L134))
**Category:** browser-compat bug. `sendWebNotification` checks `'Notification' in window` and `permission === 'granted'`, then constructs the banner directly. On Chrome and Firefox for Android the `Notification` constructor throws `TypeError: Illegal constructor` even when the API exists and permission is granted — banner display there requires `ServiceWorkerRegistration.showNotification`. The caller-side wrapper degrades to a per-event warn, and the Settings Test button surfaces the raw TypeError instead of the typed `NotificationPermissionError` UX built for every other failure shape (denied / default / insecure-context, see #7). The suite's FakeNotification constructor never throws, so the case is untested.

**Why it is a problem:** the sidecar explicitly supports non-loopback binds (a deliberate, warned network listener) and a phone browser is the flagship client for that surface. Realistic trigger: grant permission from an Android browser, then every completion/attention banner silently never appears while the Settings toggle reports granted/authorized — the same "honest status" class as #22, in the notification transport.

**Suggested fix:**
a) Wrap the constructor in try/catch and map failure to the same clean degradation as the missing-API case, so Android degrades honestly and the Test button shows an actionable message.
b) Feature-detect the constructor inside `webNotificationsAvailable()` (`try { new Notification('') } catch { return false }`) so "no API" and "API exists but constructor throws" collapse into one honest path.
c) Where a service-worker registration exists, prefer `registration.showNotification(title, options)` — the only path that actually displays banners on Android.

---

### 11. SHOULD FIX — Web-transport file/image paste is a guaranteed failure: the paste path calls the denylisted `PasteFromClipboard` RPC with no web branch

*(Origin: pass 5 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/hooks/usePasteHandler.ts:113](frontend/src/hooks/usePasteHandler.ts#L113) (denylist entry at [internal/webaccess/dispatch.go:42](internal/webaccess/dispatch.go#L42))
**Category:** transport-parity gap on a net-new surface. The paste handler stages optimistic spinner chips (`beginAttachmentUploadsFresh`) and then unconditionally awaits `pasteFromClipboard(sessionId, supportsVision)`. On the web transport that method is server-denylisted ("host clipboard content is not exposed to the browser" → 403), so any paste carrying file/image items fails: the chips flash and drain, and a "Failed to paste from clipboard" `runtime_error` toast fires — every time. The sibling attachment entry points both gained web branches this branch (`browserFilePicker` for 📎, `stageAttachmentFiles` for drag-drop); paste did not. There is no `isWebTransport` check anywhere in the handler, and no test exercises web paste.

**Why it is a problem:** pasting a screenshot into the chat is a core interaction; in any browser tab it now always fails with a generic error. The denylist comment says stage-1 mirrors should "paste via the browser's own clipboard access instead" — the `DataTransfer` the editor already holds — but no code implements that path (verified: `stageAttachmentFiles` has exactly two callers, the picker and `useFileDrop`).

**Suggested fix:**
a) Add a web branch at the top of `onPaste`: when `isWebTransport()`, stage the `DataTransfer`'s files/images client-side through `stageAttachmentFiles` (text still inserts via the editor's fast path) and return before the RPC.
b) Gate in `useChatEditor`'s paste handler: on web, preventDefault only for file items and hand them to a browser-native stager, letting text/html fall through to CodeMirror natively.
c) Minimal stopgap if the full path is deferred: on web skip the optimistic chips and surface one clear "pasting files is unavailable in the browser" banner instead of the generic failure toast.

---

### 12. SHOULD FIX — The mtplx engine-tree promotion deletes the old tree before the rename, with no rollback: a failed rename leaves no working engine

*(Origin: pass 3 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: B — guaranteed breakage / data or config loss · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install_mlx.go:192-198](core/embeddedllm/install_mlx.go#L192-L198) (the correct pattern at [core/embeddedllm/install.go:1610-1643](core/embeddedllm/install.go#L1610-L1643))
**Category:** bug (install robustness / data loss of the previous engine tree).
Step 6 runs `removeOwned(runtimeDir)` then `os.Rename(workDir, runtimeDir)`. If the rename fails (EACCES/EBUSY on a locked or open file in the old tree — realistic on macOS while the engine is mid-upgrade), the previous working tree is already destroyed while the manifest still records it installed; the next launch fails with "the provisioned Python is missing" and recovery is a full ~8.9 GiB reinstall. The llama path's `promoteRuntime` deliberately uses retire→rename→rollback for exactly this failure and says so in its doc comment; the pack swap at `install_mlx.go:253` follows the same retire shape — this is the only promotion that does not. The step-6 comment ("it survives every failure above") covers failures *before* the rename but the code reads as if the swap itself were safe.
**Suggested fix:**
a) Mirror `promoteRuntime`: rename `runtimeDir` to a retired sibling, rename `workDir` in, roll back from the retired dir on rename failure, delete the retired dir last.
b) Minimum: reorder to `rename(workDir→runtimeDir)` only after moving the old tree aside, keeping the delete after the swap succeeds.

---

### 13. SHOULD FIX — A stale initial `useSessionLoader` fetch can silently drop the saved-session restore

*(Origin: pass 3 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/useSessionLoader.ts:157-166](frontend/src/hooks/useSessionLoader.ts#L157-L166) (the re-read's contract at [:104](frontend/src/hooks/useSessionLoader.ts#L104))
**Category:** bug (race window in the multi-surface scenario this branch targets).
When a foreign `sessions:changed` re-read (250 ms debounce) is issued while the initial load is in flight and the initial `.then` resolves first, the stale branch sees `listApplied === false` and returns without restoring; the re-read applies its list by design **never** calling `restoreIfIdle` (its own comment: "restoreIfIdle is NEVER called: a foreign mutation must not …"). The activation then ends with `savedSessionId` resolved but never consumed — no session auto-selected. Trigger: another surface forks/deletes a session during a project switch whose initial `listSessions` is slower than the debounce plus the second RPC (web + desktop on one workspace, the branch's headline scenario).
**Suggested fix:**
a) Carry a pending-restore flag consumed by whichever application wins (the re-read's apply calls `restoreIfIdle` once when the flag is set).
b) In the stale branch, restore against the dropped same-project list before discarding it (guard remains idle-only).

---

### 14. SHOULD FIX — In non-chat input modes the web transport registers no drop suppression: a dropped file navigates the tab away from the app

*(Origin: pass 5 · Impact class: B — guaranteed breakage / data or config loss · Evidence: E3 — single-pass finding)*

**File:** [frontend/src/hooks/useFileDrop.ts:73-77](frontend/src/hooks/useFileDrop.ts#L73-L77) (suppression exists only inside the chat-mode branch at [:99-104](frontend/src/hooks/useFileDrop.ts#L99-L104))
**Category:** transport-specific data-loss hazard. The effect returns early when `mode !== 'chat'`, before registering any document listeners — including the `dragover`/`drop` preventDefault handlers whose sole purpose is suppressing the browser's default "open/navigate to the dropped file" behavior. On the desktop that was safe because Wails' OS-level `OnFileDrop` intercepts drops globally. In a browser tab there is no OS intercept: with the terminal panel open (or any non-chat mode), a file dragged over the window — accidentally or intentionally — makes the browser navigate the tab to the dropped file's content, discarding the whole SPA state.

**Why it is a problem:** realistic trigger: a web tab with the terminal open and an accidental file drop anywhere over the window loses the entire session view. The same early return was harmless pre-branch because the web transport did not exist; navigation suppression is not staging-specific and should not be mode-gated.

**Suggested fix:**
a) Always register the navigation-suppressing listeners (`dragenter`/`dragover`/`drop` preventDefault) regardless of mode, and gate only the staging call on `mode === 'chat'`.
b) In the web branch specifically, keep a `drop` handler active in non-chat modes that preventDefaults and no-ops.
c) Weakest: document the terminal-mode drop hazard as accepted for web.

---

### 15. SHOULD FIX — The TLS server's WebSocket compatibility rides a Go-internal default that Go itself calls temporary: nothing pins h1 or asserts ALPN (pass 3 rated MUST; downgraded after verification)

*(Origin: pass 3 · Impact class: R — races, resource and reliability hardening · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [internal/webaccess/webaccess.go:384](internal/webaccess/webaccess.go#L384), [:407](internal/webaccess/webaccess.go#L407) (handshake contract at [internal/webaccess/ws.go:100-119](internal/webaccess/ws.go#L100-L119))
**Category:** hardening/fragility on the remote attack surface.
The pass-3 delegate rated this MUST FIX with the claim that Go's h2 server advertises `SETTINGS_ENABLE_CONNECT_PROTOCOL`, making browsers send `wss://` as an RFC 8441 extended CONNECT (no `Upgrade`/`Sec-WebSocket-Key`, no `Hijacker`) and killing `/ws` under TLS for every mainstream browser. **Conductor verification against the go1.27.3 sources rejects the premise**: `net/http/internal/http2/http2.go:38-61` sets `disableExtendedConnectProtocol = true` by default — the advertisement at `server.go:776-778` is sent only when `GODEBUG=http2xconnect=1` is set, and `server.go:2128` rejects `:protocol` requests at the frame level. The Go comment cites exactly this breakage class ("browsers … attempt to use WebSockets-over-HTTP/2 … problems when the server's websocket package doesn't support extended CONNECT", issue #71128) as the reason. This repo sets no such GODEBUG (only `http2client=0` in CI), so `wss://` negotiates http/1.1 and works today.
**Why it is still a problem:** the server's correctness depends on that explicitly temporary default. The comment says "Disable extended CONNECT by default **for now**" — when a future Go flips it, every browser's `/ws` (the event stream and all seven inbound HITL responses) dies silently under TLS, and no test would notice (tests speak h1; nothing asserts the negotiated ALPN or the absence of the setting).
**Suggested fix:**
a) Pin the server to h1-only (`Server.TLSNextProto` set to a non-nil empty map, or `Protocols` with HTTP2 off) next to the existing timeout config, and add a regression test asserting the TLS listener never offers/advertises h2 extended CONNECT.
b) Minimum: a comment at the `ServeTLS` call documenting the dependency plus a test asserting the served settings omit `ENABLE_CONNECT_PROTOCOL` so a Go upgrade that flips the default fails CI instead of production.

---

### 16. SHOULD FIX — Inbound web bridge logs payload-shape drops at Warn, contradicting its own stated Debug-only invariant

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [desktop/webaccess_inbound.go:27](desktop/webaccess_inbound.go#L27), [desktop/webaccess_inbound.go:55-L100](desktop/webaccess_inbound.go#L55-L100) via [desktop/event_handlers.go:17-30](desktop/event_handlers.go#L17-L30)
**Category:** security/behavior (log-noise vector; invariant violation)

The file's security rationale (line 27) states: "Every dropped frame is logged at Debug only: network input must not be able to write unbounded Warn/Error lines into the log." That holds for malformed JSON, unnamed, and non-whitelisted frames — but a frame carrying a *whitelisted* name with a missing or wrong-shaped payload is routed into the shared `extractPayload`, which logs **Warn** ("missing payload" / "unexpected payload type") and drops. The tests ([desktop/webaccess_inbound_test.go:297-312](desktop/webaccess_inbound_test.go#L297-L312)) pin the Warn behavior. Verified: `extractPayload` unconditionally `log.Warn`s both failure shapes.

**Why it is a problem:** any authenticated WS principal (a compromised/buggy tab, or any token holder on a non-loopback bind) can emit whitelisted names with empty args at frame rate and write an unbounded stream of Warn lines into the durable rotating log — exactly the outcome the comment says the design prevents; the noise evicts real signal (crash-capture mirror, 4 MiB rotation).

**Suggested fix:**
a) In `dispatchWebInboundFrame`, do the shape check inline before the shared handler path and drop at Debug (`len(env.Args) != 1` / non-map `env.Args[0]` → `log.Debug(...)`, return), then call the HITL handlers directly with the payload map.
b) Hand the HITL handlers a demoting logger on the web path (a slog wrapper mapping Warn→Debug for these two messages), keeping the desktop Wails path's Warns.
c) Weakest: keep the behavior and rewrite the line-27 invariant to carve out the exception (not recommended — the rationale is the security argument).

---

### 17. SHOULD FIX — Data race: `GetWebAccessInfo` reads `cfg.WebAccess` fields the control RPCs write under `webAccessMu`

*(Origin: pass 1 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [desktop/app.go:1023-1051](desktop/app.go#L1023-L1051) (reader) vs [desktop/app.go:1092-1096](desktop/app.go#L1092-L1096), [desktop/app.go:1303](desktop/app.go#L1303), [desktop/app.go:1372](desktop/app.go#L1372) (writers)
**Category:** bug (data race)

`GetWebAccessInfo` reads `cfg.WebAccess.Enabled/.Bind/.Port/.Token/.TLS.*` (and passes the section to `classifyWebAccessCert`) holding only `stateMu.RLock` for the config pointer. Every desktop writer of those fields (`setWebAccessEnabledLocked`, `setWebAccessConnectionLocked`, `SetWebAccessToken`, `RegenerateWebAccessToken`, `setWebAccessTLSLocked`) mutates them under `webAccessMu` only — a lock this reader does not take. The documented "one-word window" rationale covers a concurrent *backend save*, but `GetWebAccessInfo` is itself a renderer-callable App method on a Wails binding goroutine: overlapping RPC calls (Settings refreshing info around a toggle) are a real, renderer-triggerable race; `Token` is a two-word string header, so a torn read is UB-class under the Go memory model. `go test -race` CI legs would flag it as flaky red.

**Suggested fix:**
a) Snapshot the section under `webAccessMu` in `GetWebAccessInfo` (struct copy `sec := cfg.WebAccess`), then run cert classification and URL rendering outside the lock (keeps `classifyWebAccessCert`'s file I/O off the transition lock).
b) Take `webAccessMu` for the whole `GetWebAccessInfo` body (simplest; blocks a concurrent hot-restart for up to ~3 s).
c) Publish an immutable `WebAccessConfig` snapshot via `atomic.Pointer[config.WebAccessConfig]` beside the live-config pointer and read only that.

**Pass 5 extension:** a fresh blind pass widened the same seam in both directions. (i) The race is not desktop-reader-vs-desktop-writer only: desktop control RPCs persist through the package-level `config.Save` (which `yaml.Marshal`s the ENTIRE live config with no internal lock) while the backend mutates other sections under `configMu` — so a desktop marshal can read a backend mid-mutation, and a backend persist can read the `WebAccess` section mid-mutation: bidirectional, whole-struct. (ii) Two near-simultaneous persists (desktop `Save` vs backend `persistConfig`) interleave at whole-file granularity — last writer wins, so a web-access toggle can be silently dropped by an unrelated settings save landing in the same few-millisecond window (or vice versa). The "one-word window" comments at [desktop/app.go:165](desktop/app.go#L165), [desktop/app.go:1088](desktop/app.go#L1088) match neither the multi-word writes nor the whole-file write granularity. Fix option d) narrows option (a) to the seam: add an exported backend method (e.g. `UpdateWebAccessSection(mutate func(*config.WebAccessConfig) error)`) that mutates + persists under `configMu` and route the five control RPCs plus the token mint through it, deleting the zero-backend-edit exception; option e) is the minimum: correct the comments to state the real exposure (whole-struct writes; whole-file, bidirectional, lost-update-prone) so the accepted risk is honest.

---

### 18. SHOULD FIX — `connectWS` has no liveness probe: a half-open socket leaves the web tab silently deaf

*(Origin: pass 3 · Impact class: R — races, resource and reliability hardening · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/api/runtime.ts:427-437](frontend/src/api/runtime.ts#L427-L437) (server side defers keepalive: [internal/webaccess/ws.go:15-17](internal/webaccess/ws.go#L15-L17), "no keepalive timer yet (stage 2)")
**Category:** bug (transport reliability on the web transport's lifeline).
Neither side keeps the events socket alive. After laptop sleep or NAT rebinding the TCP socket can stay half-open: no `onclose` fires, so no reconnect, no `onWSReconnected` resync, and every `webEmit` is dropped warn-once until the user manually reloads. The reconnected-resync machinery already exists — only the dead-socket detection is missing.
**Suggested fix:**
a) Client-side staleness watchdog: track last inbound frame; after N idle minutes force `close()` + reconnect (the existing retry/backoff path then resyncs).
b) Implement the stage-2 server ping interval and have the client treat missing pongs as dead (closes both failure modes at once).

---

### 19. SHOULD FIX — `mlxSweepDownloads` evicts the llama family's cached downloads from the shared cache

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [core/embeddedllm/install_mlx.go:423-445](core/embeddedllm/install_mlx.go#L423-L445) (call site [core/embeddedllm/install_mlx.go:146](core/embeddedllm/install_mlx.go#L146)); affected layout: [core/embeddedllm/layout.go:249-260](core/embeddedllm/layout.go#L249-L260)
**Category:** behavior change / unintended cross-engine side effect

The downloads area is a persistent cache shared by BOTH engines — `Layout.Destination` routes `ComponentRuntime`/`ComponentCudart` (llama runtime/cudart archives) into the same `DownloadsDir` the mtplx wheel set uses. The sweep's pinned-name map contains only `pythonArchiveAsset` + the 46 wheels, so every other entry is deleted as "a download the current pin table does not carry". Realistic trigger: a darwin/arm64 user with a working llama install (cached `llama-<tag>-metal.tar.gz`, hundreds of MB) flips `embedded_llm.engine` to `mtplx` and clicks Install — the llama archive is silently deleted; switching back costs a full re-download. This contradicts the sweep's own doc comment (its purpose is `--find-links` pip hygiene; `--require-hashes` is already the enforcement) and the layout comment ("a persistent cache shared across installs and pin bumps"), and is untested for the llama case.

**Suggested fix:**
a) Restrict the sweep to entries that could participate in the offline pip step: delete only `*.whl` files plus the pinned python-archive name when the current table does not carry them; leave everything else (llama archives) alone.
b) Key the sweep on `ComponentEngineWheels`/`ComponentPython` identity (URL-tail names) instead of "anything not in the mtplx tables".
c) If the eviction is deliberate, document it at the sweep and add a test asserting the llama archive's fate on an mtplx install.

---

### 20. SHOULD FIX — `handleToolJudgeRequest` spawns an unbounded judge-evaluation goroutine per inbound frame; first-responder-wins protects the delivery, not the spawn

*(Origin: pass 7 · Impact class: R — races, resource and reliability hardening · Evidence: E3 — single-pass finding)*

**File:** [desktop/event_handlers.go:231-248](desktop/event_handlers.go#L231-L248) (spawn), [desktop/event_handlers.go:250-257](desktop/event_handlers.go#L250-L257) (`runJudgeEvaluation`)

**Why it is a problem:** Every accepted `tool_judge_request` frame — one of the seven whitelisted inbound web-transport events — unconditionally does `a.judgeWG.Add(1); go runJudgeEvaluation(...)` with no in-flight marker and no dedup per `confirm_id`. The pending-entry lookup happens before the spawn, and `pendingData` is captured by reference, so a second frame for the same confirmation while the first evaluation is in flight (an LLM call budgeted up to ~120 s) starts a full second evaluation whose result can only lose the first-responder race. An authenticated browser tab that double-clicks the judge button (or a scripted client) fans out parallel 120 s LLM evaluations for one `confirm_id` — token burn / provider-load amplification on the web transport, where the frame source is network-reachable by design. Verified in the working tree: no in-flight set, no singleflight, `judgeWG` joins only at shutdown; the webdispatch surface has no per-frame rate limit beyond the login limiter.

**Suggested fix:**
a) Track an in-flight set (e.g. a small map guarded by `pendingConfirmations`' mutex or a `singleflight.Group` keyed by `confirm_id`): repeat frames while an evaluation runs are dropped (Debug-logged, matching the file's invariant).
b) Record a `judging` flag on `pendingConfirmData` and refuse re-entry until the evaluation resolves or the entry is deleted.
c) Weaker alternative: serialize judge evaluations behind a single-slot semaphore so at most one evaluation runs at a time app-wide.

---

### 21. SHOULD FIX — Web-transport Create Project dialog is a dead end: the hint says "Type the workspace directory path" but no path input exists

*(Origin: pass 1 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**File:** [frontend/src/components/project/CreateProjectDialog.tsx:88-102](frontend/src/components/project/CreateProjectDialog.tsx#L88-L102) (guard at [CreateProjectDialog.tsx:37-39](frontend/src/components/project/CreateProjectDialog.tsx#L37-L39))
**Category:** bug / behavior (web transport)

This change hides the native picker button in the web transport and shows: "Type the workspace directory path — the native folder browser is only available in the desktop app." But the dialog contains no text input for the path — `externalPath` is set only by `pickDirectory()` (the hidden native picker), and `handleSubmit` requires `externalPath`, so **Create is permanently disabled**. The dialog is reachable from a browser tab via the sidebar CODE toggle and `ProjectSelector` (no transport gate on entry). The new test pins the hint copy but not the capability; its comment claims "The manual path entry stays usable" — an invariant the component does not implement.

**Why it is a problem:** the shipped UI instructs an impossible action and the dialog's primary action can never be enabled in that transport; the test enshrines the false invariant.

**Suggested fix:**
a) In the web transport render a real path `Input` bound to `externalPath` (the backend's `createProject` already validates the path) — the hint then becomes true.
b) If web creation is not intended yet, change the hint to say creation requires the desktop app and disable/omit the Create button; fix the test's "manual path entry stays usable" comment/expectations.
c) Least-effort honesty fix: hide the entire Directory block on web and gate the dialog entry points (SidebarHeader/ProjectSelector) on `!isWebTransport()`.

---

### 22. SHOULD FIX — Failed post-toggle re-read flips an APPLIED web-access enable back to "Off" (security-relevant status lie)

*(Origin: pass 1 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/settings/WebAccessSettings.tsx:152-155](frontend/src/components/settings/WebAccessSettings.tsx#L152-L155)
**Category:** bug / stale security status after failed action

`handleToggle` awaits `setWebAccessEnabled(next)` (persist + live apply succeed together), then `const fresh = await getWebAccessInfo(); setInfo(fresh ?? previous)`. `getWebAccessInfo` never throws — on any read failure it resolves `null`, and the UI reverts to `previous`: the toggle renders **Off** and the status line claims "the app is reachable from the desktop window only" **while the sidecar is actually serving and a browser tab may be connected**. The in-code justification ("the backend still holds the previous value") is false on this path: the write succeeded, only the read failed. The sibling TLS block handles the identical case the opposite (correct) way — it keeps the optimistic state when the re-read returns null (pinned by its own test).

**Why it is a problem:** this section exists to tell the operator honestly whether the app is network-exposed; a transient read failure after a successful enable produces the dangerous lie "not exposed".

**Suggested fix:**
a) `setInfo(fresh ?? { ...previous, enabled: next })` — on re-read failure keep the applied switch value instead of the pre-toggle snapshot.
b) Keep the optimistic object and patch only the fields the fresh read actually supplies, so a null re-read is a no-op.
c) Extract the TLS block's re-read-on-failure semantics into a shared helper used by both blocks so they cannot diverge again.

---

### 23. SHOULD FIX — A failed pending-actions poll clears a genuinely-blocked session's radar indicator, and it may not heal for a long time

*(Origin: pass 2 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/stores/activeSessionsStore.ts:239-241](frontend/src/stores/activeSessionsStore.ts#L239-L241) (via [frontend/src/api/chat.ts:466-469](frontend/src/api/chat.ts#L466-L469) and [activeSessionsStore.ts:162-163](frontend/src/stores/activeSessionsStore.ts#L162-L163))
**Category:** bug (introduced by the override re-poll in this diff).
The reworked `sweepPendingActions` correctly makes override-only `pending` rows poll targets — but on ANY RPC failure `getPendingActions` resolves `null`, the sweep feeds it straight into `applyPendingActions(id, null)` → `setPendingOverride(id, hasPendingActions(null) === false)` → the true bit is deleted. Before this change a pending row was never a poll target, so a failed poll could never clear a pending row's bit; now it can.
**Why it is a problem:** a background session blocked on a HITL prompt flips yellow→green while the prompt is still pending; sweeps run only on first snapshot load per mount and on dropdown open, so the attention signal can stay gone until the next dropdown open or app reload — precisely the signal the radar exists to give. The accompanying test mocks `mockResolvedValue(null)` under a name claiming the empty-answer path — it pins the FAILURE shape, and the genuine all-empty heal case (a real empty `PendingActionsResponse`) is untested.
**Suggested fix:**
a) In the sweep, apply only definitive answers: `const resp = await getPendingActions(row.session.id); if (resp !== null) store.applyPendingActions(row.session.id, resp)`.
b) Give the store ignore-null `applyPendingActions` semantics and update the doc comment; re-point the test at a real empty response and add an explicit failure-preserves-bit case.

---

**Folded companion entry #24 (pass 7, CONSIDER) — failed GetPendingActions treated as "no pending" — the frontend override-bit facet of #23's radar-indicator defect:**

### 24. CONSIDER — A failed `GetPendingActions` on an override-only pending row clears its bit, flickering the row until the next sweep re-flags it

**File:** [frontend/src/stores/activeSessionsStore.ts:223](frontend/src/stores/activeSessionsStore.ts#L223)

**Category:** documented deliberate tradeoff: the new re-poll filter re-asks override-only rows each sweep, and `applyPendingActions(id, null)` deletes the bit, so on an RPC failure the row loses its pending dot for one sweep interval and regains it on the next sweep. Worst case is a transient dot flicker on a failing backend; the doc comment names the tradeoff.

**Fix:** a) leave as-is (documented); b) on a null response skip the update instead of clearing the bit.

### Pass 7 dedupe and corroboration

**Confirmed known (re-reported independently, no changes):** #22, #4, #21 (rated MUST for a 4th time — kept SHOULD), #5, CS #122, CS #10, #2, #8, #32, CS #12 (re-rate to SHOULD declined — the quiesce `select` drains and asserts on events concurrently; it is a bounded-join watchdog, not an empty sleep, and CS #12's fix option (a) already covers the outer-deadline strengthening), the ADR-090 duplicate-number issue, the ADR-090 D6 gorilla→stdlib doc issue. **Extensions merged:** #15 (pass 7's "ServeTLS leaves h2 ALPN enabled → Hijack fails under TLS" is the same WS-under-TLS upgrade hazard with the same fix — the h2/ALPN trigger folded into #15's TLSNextProto/ALPN-regression-test remediation), #9 (CopyButton sync-revoke re-report), CS #64 (runtime.ts:504 emit-drop re-report), CS #132 (notifications.ts:58/:132/:171 direct `Notification.permission` reads bypassing `readNotificationPermission`), #17 (the `RefreshWebAccessLoadWarnings` configMu/webAccessMu reader-window re-report). **#39 extended** with the `frontend_api_config_test.go:4044` Windows-CI site (verified).

**Pass 7 additionally verified clean (selected):** webaccess auth core re-traced clean for the seventh pass (constant-time compares, per-launch cookie, rate limit, SameSite=Strict CSRF posture, denylist-before-reflection order, fan-out backpressure, stop/force-close bounds, panic isolation, atomic cert publication); inbound whitelist exactly mirrors the 7 wireWailsEventListeners subscriptions; hitl_resolved first-responder-wins preserved; control RPCs unreachable from the web dispatch surface; token mint/persist/rollback and TLS fail-closed paths as documented; SendMessage 13-arg order and 32 MiB cap parity re-confirmed; task_started exactly-once and transient whitelist entry re-confirmed; config load pipeline, normalizeWebAccess edge cases and every tested `config.example.yaml` claim re-verified against code; echo dedup identity-threading (optimisticId at both production send sites); clipboard false-verdict toasts; `generateUUID` insecure-context fix across 6 files; session list loading sentinels match the store; no viewport units / raw pointer anchors / selector allocations introduced; specs pass re-verified hitl_resolved/task_started/sessions:changed/message_received event rows, HITL whitelist, body caps, limiter, cookie flags, cert classes, CSP and all links.

---

### 25. SHOULD FIX — Repeated history-load failures stack duplicate error cards (one per focus/visibility/reconnect trigger)

*(Origin: pass 3 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/lib/sessionHistoryReload.ts:85-100](frontend/src/lib/sessionHistoryReload.ts#L85-L100)
**Category:** bug (UX degradation with a reproducible unbounded growth path).
Every failed `getSessionHistory` unconditionally `addMessage()`s an error card keyed by a fresh `generateMessageId()`; the new App-root shallow resync re-runs the loader on focus/visibility/WS-reconnect triggers — so with the history RPC down, each trigger (≥5 s apart) appends another identical "Failed to load session history" card. A later success reaps stale cards, but while the failure persists they accumulate without bound. Distinct from #26 (one card vs an already-populated transcript) and CS #95 (module-header contract wording): this is the repeated-failure accumulation path.
**Suggested fix:**
a) Upsert with a deterministic per-session semantic id (the HITL-card pattern, e.g. `history-load-failed:<sessionId>`).
b) Skip the add when a `historyLoadFailed` card for the session already exists.

---

**Folded companion entry #26 (pass 1, CONSIDER) — same failure-card mechanism in sessionHistoryReload.ts:85-100 — the populated-transcript facet of #25's stacking defect:**

### 26. CONSIDER — A failed history (re)load appends the "Failed to load session history" card even when the transcript is already populated

**File:** [frontend/src/components/chat/ChatArea.tsx:98-120](frontend/src/components/chat/ChatArea.tsx#L98-L120) and [frontend/src/lib/sessionHistoryReload.ts:86-104](frontend/src/lib/sessionHistoryReload.ts#L86-L104)
**Category:** behavior change / minor UX bug. New for the resync path: a focus/visibility/WS-reconnect re-run failing appends a false "history failed" card beneath a fully rendered transcript (web transport, brief desktop unreachability). Self-healing on the next successful load.
**Fix:** a) Append the card only when the session's transcript is empty; log otherwise. b) Render `historyLoadFailed` as a non-transcript banner. c) Reap stale failure cards at the start of every load.

---

### 27. SHOULD FIX — Failed Submit/Approve in the review surface is completely silent: log-only catches around a send this branch modified

*(Origin: pass 5 · Impact class: F — functional degradation / recoverable UX defect · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [frontend/src/components/review/useReviewActions.ts:218-220](frontend/src/components/review/useReviewActions.ts#L218-L220) (Submit outer catch), [:32-35](frontend/src/components/review/useReviewActions.ts#L32-L35) (Approve catch)
**Category:** silent-failure inconsistency on a user-facing action. `handleSubmit`'s send call is modified by this branch (it gained the `clientSendId` argument, [CS #101](specs/contracts/desktop-frontend.md) threading), and its failure path — after a correct optimistic rollback — rethrows into `catch (err) { logger.error('Submit flow failed:', err) }`: no toast, no inline error. `handleApprove`'s `stageAll()`/`clearReview()` failures are likewise caught and only logged. Everywhere else in the review surface failures toast (`runtime_error` in ReviewHeader, FileReviewBlock, HunkReviewBlock).

**Why it is a problem:** a transient failure (SQLite busy, backend restart) at submit time leaves the user having clicked Submit with the button un-spinning and nothing happening — the review buffer survives for retry, but nothing says the submit failed or that retry is expected. Same for Approve, the terminal action of the review loop.

**Suggested fix:**
a) In the outer Submit catch and the Approve catch, `emit('runtime_error', { id: generateUUID(), message: 'Failed to submit review — your comments are kept' })` / `'Failed to approve review'`.
b) Return an error state from the hook and render inline error text in ReviewHeader.
c) Minimum: make Approve consistent with the comment-save paths that already toast.

---

### 28. SHOULD FIX — Projection removal item renders the refusal with no separating space

*(Origin: pass 1 · out-of-scope annex (files absorbed into main mid-review — fix lands on main) · Impact class: F — functional degradation / recoverable UX defect · Evidence: E3 — single-pass finding)*

> Re-rated from CONSIDER in pass 2: under the mtplx engine the projector is never removable, so the garbled suffix renders on **every** open of the Remove dropdown for every mtplx user — a visible defect on the normal path of the new engine support, not an edge case. Verified: the refusal string at [EmbeddedLLMSettings.tsx:107](frontend/src/components/settings/EmbeddedLLMSettings.tsx#L107) carries no leading space, while the llama fallback literal does.

**File:** [frontend/src/components/settings/embedded/EmbeddedLLMActions.tsx:130-135](frontend/src/components/settings/embedded/EmbeddedLLMActions.tsx#L130-L135)
**Category:** cosmetic. JSX strips the whitespace between the text child and the expression: "Remove vision projector only**not removable under the MTPLX engine**".
**Fix:** a) Leading space in the refusal string at source. b) Separate `<span>` with a dash. c) Prefix at the call site.

---

### 29. SHOULD FIX — Three accepted ADRs share the number 090

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**Files:** [specs/decisions/090-browser-web-access.md](specs/decisions/090-browser-web-access.md), [specs/decisions/090-embedded-llm-mlx-mtplx.md](specs/decisions/090-embedded-llm-mlx-mtplx.md), [specs/decisions/090-openvino-device-resolution.md](specs/decisions/090-openvino-device-resolution.md) (all new in this diff)
**Category:** docs/structure (spec corpus integrity; META.md's `NNN-slug.md` convention implies unique numbers, and 001–089 are unique).
Bare textual references are now ambiguous across the corpus: SECURITY.md uses "ADR-090" for two different decisions (the web-server attack-surface bullet means the browser ADR; the embedded-LLM bullet means the mtplx ADR), AGENTS.md's bare "ADR-090" mentions mean mtplx, while `specs/domains/web-access.md` and ADR-092's "ADR-090 decision 3/4/12/13" mean the browser ADR, and `specs/domains/workspace.md`'s "ADR-090" means the OpenVINO ADR. An implementer following "ADR-090 decision 4" lands on the wrong document.
**Suggested fix:**
a) Renumber two of the three (e.g. 093/094) and update inbound links/text.
b) Minimum: make every prose mention carry the disambiguating slug alongside the number (all links already do — prose mentions don't).

---

### 30. SHOULD FIX — ADR-090 (browser) decision 6 contradicts the shipped implementation and was left unamended

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [specs/decisions/090-browser-web-access.md:30](specs/decisions/090-browser-web-access.md#L30) (Status at line 5)
**Category:** docs/spec-vs-code contradiction.
D6 states "WebSocket transport is `gorilla/websocket v1.5.3` … adopting it promotes an existing pinned version", but the implementation is a hand-rolled stdlib RFC6455 codec ([internal/webaccess/ws.go:4-5](internal/webaccess/ws.go#L4-L5): "no websocket library"; `go.mod:70` still marks gorilla `// indirect`; the package hygiene test bans non-stdlib imports). The domain spec carries only a parenthetical correction, and the ADR's Status — edited by this branch for the consolidation — was not extended, unlike the amendment pattern used in ADR-092/080/082. An implementer reading the accepted ADR would adopt gorilla/websocket and break the dependency contract the spec and its hygiene test enforce.
**Suggested fix:**
a) Append a Status amendment ("D6 superseded: hand-rolled stdlib RFC6455 codec; the library never left indirect").
b) Annotate D6 in place as amended with the narrowing.

---

### 31. SHOULD FIX — AGENTS.md still pins Go 1.27.0 while this branch bumps go.mod and CI to 1.27.3

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [AGENTS.md:33](AGENTS.md#L33) vs [go.mod:3](go.mod#L3)
**Category:** docs drift (violates the doc's own lockstep rule).
The branch's toolchain bump touched `go.mod` (`go 1.27.3`) and every `go-version`/`GO_VERSION` pin in the workflows, but not the Project-shape sentence that mandates lockstep ("CI builds with exactly this toolchain … bump both together whenever Go ships a security patch"). A contributor following AGENTS.md's stated version is two security patches behind and trips the `make vulncheck` gate the same sentence describes.
**Suggested fix:**
a) Update the line to 1.27.3.
b) Drop the patch version from the prose ("current Go toolchain, see go.mod") so the line cannot drift again.

---

### 32. SHOULD FIX — "An https:// scheme typed there is refused" is stale: the parser accepts and strips it

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [config.example.yaml:2163](config.example.yaml#L2163) and [specs/decisions/092-web-access-tls.md](specs/decisions/092-web-access-tls.md) (decision 1) vs [frontend/src/api/webAccess.ts:255-270](frontend/src/api/webAccess.ts#L255-L270) (`parseWebAccessAddress` accepts and strips both schemes; test-pinned)
**Category:** doc/implementation contradiction sitting on the feature's own security switch. An operator who types `https://host:port` (as the example invites) gets silent stripping; with `tls.enabled: false` the sidecar serves plain HTTP while the operator can reasonably believe HTTPS is active.
**Fix:** a) Reword the example parenthetical: the scheme is display-only, both schemes accepted and stripped, anything else refused — the transport is `tls.enabled` alone. b) Amend ADR-092 decision 1 in the same sweep (it is the source of the stale refusal claim).

---

### 33. SHOULD FIX — `config.example.yaml` claims every non-loopback bind loads with a warning; the warning is scoped to plain HTTP and a TLS-encrypted LAN bind loads warning-free

*(Origin: pass 5 · Impact class: D — documentation, spec or comment contradiction · Evidence: E2 — independently corroborated by a later blind pass)*

**File:** [config.example.yaml:2123-2127](config.example.yaml#L2123-L2127) vs [backend/config/web_access.go:341-344](backend/config/web_access.go#L341-L344)
**Category:** doc claims contradicted by code on the security-exposure surface. The bind paragraph states unconditionally: "A non-loopback bind is a LAN-exposed listener: it loads with a warning (…) and is saved as-is." The code returns no load warning when `section.TLS.Enabled` (`if IsLoopbackBind(section.Bind) || section.TLS.Enabled { return nil }`), and the warning text itself names the transport ("traffic is plain HTTP without TLS"). Both halves are test-pinned: `TestWebAccessTLS_NonLoopbackBindLoadsWarningFree` ([backend/config/web_access_test.go:209-233](backend/config/web_access_test.go#L209-L233)) asserts a TLS-encrypted LAN bind loads warning-free, and the warning-text assertions require the plain-HTTP phrasing.

**Why it is problem:** an operator reading the authoritative example believes any LAN listener announces itself in the config-errors banner at every load; a TLS-encrypted one will not (by design it is surfaced only via the Settings banner and the start log). This is exactly the drift class the example file is the reference for.

**Suggested fix:**
a) Scope the sentence: "over plain HTTP it loads with a warning (…); with the tls subsection enabled it loads warning-free (the exposure is surfaced by the Settings banner and the start log instead)".
b) Minimal: delete the quoted paraphrase and state "loads with a warning when TLS is off" (also resolves the paraphrase half of CS #103).
c) Move the warning sentence next to the tls paragraph so the TLS exemption reads as part of one contract.

---

### 34. SHOULD FIX — The event catalog's new `sessions:changed` row names a producer this same branch deleted

*(Origin: pass 2 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/contracts/event-catalog.md:21](specs/contracts/event-catalog.md#L21)
**Category:** docs/spec-vs-code contradiction.
The row's emitter enumeration reads "…create, fork (plain + managed), **managed-draft commit**, delete, archive, pin…", but the draft-commit path (`CreateManagedSession` / `lib/sessionDraft.createSessionFromDraft`) was removed by ADR-091 — no such call site exists (verified: the only `frontend_api_worktrees.go` emit is the managed fork). The row is new in this branch and its list is presented as exhaustive; a reader tracing the event greps for a path that no longer exists, while the actual new producer (the send-time workspace bind, covered transitively by the task-lifecycle mirror) is unnamed.
**Suggested fix:**
a) Drop "managed-draft commit" from the enumeration.
b) Replace it with "send-time workspace bind (via the task-lifecycle mirror)".

---

### 35. SHOULD FIX — The event catalog states the inbound whitelist's direction backwards

*(Origin: pass 4 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/contracts/event-catalog.md:16](specs/contracts/event-catalog.md#L16) (`runtime_error` row, new sentence)
**Category:** materially wrong spec text, self-contradicting within one sentence: "the inbound whitelist is backend→frontend-only and would drop the name". The inbound bridge resolves exactly the seven frontend→backend HITL events; `runtime_error` is backend→frontend — which is precisely why it would be dropped, and why the row's `emitLocalEvent` claim is correct. The Web Transport section of the same doc states the direction correctly.
**Fix:** a) Change to "the inbound whitelist is frontend→backend-only (the seven HITL events) and would drop the name". b) Drop the parenthetical and keep only the local-dispatch statement.

---

### 36. SHOULD FIX — ADR-092 D4 and the domain spec claim the TLS commit check classifies "the way `cert_status` classifies it" — for a key/cert mismatch the two classify oppositely

*(Origin: pass 5 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/decisions/092-web-access-tls.md:23](specs/decisions/092-web-access-tls.md#L23) (decision 4), [specs/domains/web-access.md:13](specs/domains/web-access.md#L13), mirrored comment at [desktop/app.go:1392-1394](desktop/app.go#L1392-L1394)
**Category:** doc/code contradiction on a security-relevant operator surface. `classifyWebAccessCert` ([desktop/app.go:1482-1495](desktop/app.go#L1482-L1495)) loads the pair first; a `tls.LoadX509KeyPair` failure — which is exactly what a key/cert mismatch is — lands in **unreadable**; its `mismatch` is reserved for SAN non-coverage of the pinned bind. The commit-time preflight in `setWebAccessTLSLocked` inspects the same error and refuses with the **mismatch-flavored** message ("TLS private key … does not match the certificate …"). Both docs assert the commit check is "classified the way `cert_status` classifies it: a key that does not match its certificate is a mismatch, every other load failure is unreadable" — the opposite of what `cert_status` reports for that very case.

**Why it is a problem:** an operator who hand-edits a mismatched pair sees the commit refuse with "does not match", then finds `cert_status: "unreadable"` in GetWebAccessInfo — and a reader of ADR-092 D4/web-access.md expects the docs' stated vocabulary, not two different buckets for the same defect. The docs normalize the divergent behavior instead of describing it.

**Suggested fix:**
a) Reword both docs (and the app.go comment) to state the actual split: "the commit check uses its own two-bucket error split (a key that does not match its certificate is refused as a mismatch, every other load failure as unreadable); `cert_status` reserves `mismatch` for SAN non-coverage and reports a key-mismatch pair as `unreadable`".
b) Align the code instead: have the commit message mirror cert_status (call every load failure unreadable) — weaker UX, loses the actionable "does not match" hint.
c) Note the divergence in ADR-092's amendment block without rewording the decision text.

---

### 37. SHOULD FIX — The new `sessions:changed` doc comment names creation emitters that do not exist

*(Origin: pass 8 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [backend/events.go:113](backend/events.go#L113)

**Category:** false documentation, added by this branch (the whole `EventSessionsChanged` doc block is new). The parenthetical claims the create sites are "the RPC, the SwitchProject fallback creation, and both managed-worktree creation paths". Verified against the working tree: exactly two production creation sites exist — the `CreateSession` RPC ([frontend_api_session.go:75](backend/frontend_api_session.go#L75)) and the SwitchProject fallback (`createSessionForProject`, [frontend_api_project.go:1230](backend/frontend_api_project.go#L1230)). `frontend_api_worktrees.go` contains no session-creation call — managed worktrees are created/bound around `ForkSession`, which the same sentence already lists separately as "fork (plain and managed)".

**Why it is a problem:** the comment is the event's contract. A developer implementing a new emitter or auditing emission coverage will hunt for two call sites that do not exist, and an auditor cross-checking the documented set against the real one concludes the doc cannot be trusted. Same defect class as #34 and #36 (doc claims contradicting the implementation), both rated SHOULD.

**Suggested fix:**
a) Drop "and both managed-worktree creation paths" from the parenthetical: "create (the RPC and the SwitchProject fallback creation)".
b) Alternatively reword to enumerate verified sites only and point fork-time tree creation at the fork clause.

---

### 38. SHOULD FIX — The frontend README's "exclusively via Wails IPC" claim and Wails-only architecture diagram are invalidated by this branch's dual-transport feature

*(Origin: pass 9 · Impact class: D — documentation, spec or comment contradiction · Evidence: E3 — single-pass finding)*

**File:** [specs/domains/frontend/README.md:5](specs/domains/frontend/README.md#L5) and the Communication Pattern diagram at [~L203-215](specs/domains/frontend/README.md#L203-L215)

**Category:** false documentation — made false BY this branch. On `main` the Purpose sentence "Communicates with Go backend exclusively via Wails IPC" was true. The branch adds the browser transport (POST `/api/rpc` + WebSocket served by `internal/webaccess`), and the branch-new [loading-states.md](specs/domains/frontend/loading-states.md) itself states behavior is "identical in both transports (wails webview + web-access sidecar)" — while the domain README's Purpose paragraph still claims exclusivity and its architecture diagram shows only `window.go.desktop.App.*` / `window.runtime.EventsOn`, with no sidecar path. The branch also touched this very file (added the loading-states.md index line) without amending the claims its own feature invalidated.

**Why it is a problem:** same false-doc class as #34/#36/#37. A reader auditing transport exposure starting from the README — the domain's front door — is materially misled about the network-reachable surface: a security-relevant omission for the branch's flagship feature.

**Suggested fix:**
a) Reword the Purpose sentence around the `runtime.ts` transport seam: Wails IPC in the desktop webview; POST `/api/rpc` + WebSocket via the web-access sidecar in browser tabs (ADR-090).
b) Extend the Communication Pattern diagram with the transport seam (`src/api/*` wrappers above `runtime.ts`, which picks Wails vs sidecar per transport detection).

---

### 39. SHOULD FIX — Tests pin OS-specific error substrings: the broken-pair cases and the experimental-persist case fail the Windows CI leg deterministically

*(Origin: pass 6 · Impact class: T — test / CI-only defect · Evidence: E1 — an independent pass rated it MUST (kept SHOULD) / proposed a SHOULD re-rate (kept CONSIDER); declined after verification)*

**Files:** [backend/config/web_access_test.go:759](backend/config/web_access_test.go#L759) (`wantReason` table in `TestWebAccessTLS_BrokenPairFilesDisableAtLoad`, both subtests); **pass-7 extension:** [backend/frontend_api_config_test.go:4044-4047](backend/frontend_api_config_test.go#L4044-L4047) (`TestUpdateExperimentalFeatures_PersistFailureSkipsHook` asserts the intercepted WARN contains `"no such file"`)

**Why it is a problem:** The load warning embeds the raw `tls.LoadX509KeyPair` error — [backend/config/web_access.go:411](backend/config/web_access.go#L411) appends `err.Error()` and `webAccessTLSPairError` wraps it as `certificate pair failed to load: %w` ([:261](backend/config/web_access.go#L261)). On Linux/macOS a missing file yields "open …: no such file or directory", so `strings.Contains(warning, "no such file")` passes; on Windows the ENOENT message is "The system cannot find the file specified.", which lacks the substring — both missing-file subtests fail deterministically on the `windows-latest` CI leg. Pass 7 found the identical defect class at a second site: the experimental-features persist-failure test ([backend/frontend_api_config_test.go:4024-4028](backend/frontend_api_config_test.go#L4024-L4028)) points `configPath` under a missing parent directory and then ([:4044-4047](backend/frontend_api_config_test.go#L4044-L4047)) requires the WARN record to contain `"no such file"` — on Windows the path-error message ("The system cannot find the path/file specified.") never contains that substring, so this test also fails the Windows CI leg deterministically. Verified in the working tree: both assertion sites and the missing-parent setup.

**Suggested fix:**
a) Classify in `webAccessTLSPairError` with `errors.Is(err, fs.ErrNotExist)` and emit platform-neutral wording, so the operator-facing warning text and the assertion stop depending on the OS strerror.
b) Assert only the stable wrapper text — "certificate pair failed to load" for the missing-file cases, "failed to persist experimental features toggle" for the persist case — dropping the raw OS-message matches at both sites.
c) For the persist test specifically, assert `errors.Is(err, fs.ErrNotExist)` on the returned error instead of matching the logged cause text.

