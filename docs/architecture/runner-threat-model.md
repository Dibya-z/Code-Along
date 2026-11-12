# Browser practice execution boundary

Status: M0 proof design. Production identity, routing and deployment arrive in M1/M2. Browser results are untrusted learning feedback; authoritative grading remains disabled.

## Assets, attacker and trust

Learners control every source byte, imports, input, Python output and the Pyodide JavaScript bridge. Treat a Worker as hostile after execution begins. Protect application sessions, storage, product APIs and the trusted supervisor's ability to terminate work. Do not send application credentials, MessagePorts, hidden tests or privileged fetch helpers to Python. Python import restrictions are not an isolation boundary.

The authenticated application and runner use different registrable sites, not sibling subdomains sharing cookies. The local proof uses HTTPS `127.0.0.1` for the app and HTTPS `localhost` for the runner; these are distinct sites. A temporary self-signed certificate is used only by an owned test browser. Production requires normal trusted TLS on separately controlled sites. No global trust-store/hosts changes are part of this proof.

## Boundaries and policy

| Boundary            | Rule                                                                                                                             | Acceptance evidence                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| App → iframe        | Restricted sandbox: scripts and same-origin only; no forms, navigation, popups, downloads, devices or arbitrary network          | Browser tests verify actual cross-site embedding and denied app access           |
| Initial handshake   | Exact configured app origin, `event.source === parent`, version and UUID nonce; accept a single transferred port                 | Wrong-source/origin/nonce and repeated connection cases                          |
| Private port        | Only run, stdin, cancel; strict fields, version, nonce and run ID; no API/URL/credential operation                               | Contract and browser negative tests                                              |
| Supervisor → Worker | New Worker per run; immutable verified source manifest; private port stays in supervisor                                         | Repeated-run globals/files, tampered source and cancellation cases               |
| Worker network      | Worker **response** CSP plus isolated-site fixed asset routes; no proxy, external origins, app APIs or runtime package downloads | Header assertions and hostile fetch tests                                        |
| Output              | Sequenced bounded text only; terminal control belongs to supervisor; never render HTML/SVG                                       | Chunk/output flood and late-output cases                                         |
| Resource control    | 30s startup and execution deadlines; hard Worker termination; 1MiB output; 20 files, 128KiB/file, 1MiB total; bounded stdin      | Deadline, Stop and flood cases; these are proof budgets, not capacity guarantees |

Both app and runner send COEP `require-corp`; app sends COOP `same-origin`. Permissions Policy and iframe `allow` delegate cross-origin isolation to the configured runner only. Runtime assets are self-hosted from pinned Pyodide 314.0.7 with SHA-256 inventory. The shell and Worker have separate CSPs, using `wasm-unsafe-eval` only where required, never general `unsafe-eval`. No service worker, credential forwarding, arbitrary wheels or packages.

Interactive stdin is capability gated on `crossOriginIsolated` and SharedArrayBuffer in the **embedded runner**. The supervisor owns a bounded SAB mailbox and writes validated input; the Worker can block with Atomics.wait without blocking the app. Without that capability the caller must explicitly choose batch mode. Do not silently advertise interactive support based on top-level headers. Cancellation always terminates the Worker; cooperative interrupts are optional later.

## Manifest v1

`packages/contracts/execution/runner.ts` defines version, runtime ID, positive metadata version, normalized ASCII relative Python paths, unique document IDs/generations, exact source strings, per-file SHA-256 and manifest SHA-256. Reject NUL/lone surrogates, traversal, duplicate/missing files and over-budget payloads. Capture all model values synchronously before hashing. Sort paths by codepoint, serialize fixed-key UTF-8 JSON without whitespace and hash those exact bytes. Runtime asset digest inventory is separate from source identity. Batch input contents are run inputs alongside the source manifest; persist them separately if replay becomes a product feature.

One active run per session. Reject run-ID reuse. Lifecycle: initializing → running → waiting_for_input → running → one terminal result: succeeded, failed, cancelled, timed_out or output_limit. Stale commands/output cannot affect a replacement run. Terminal results identify the source hash and pinned runtime. Plots, arbitrary virtual-file export, extra packages and persistent REPL are intentionally outside the M0 core proof; define bounded typed formats before enabling them in M2.

## Residual risks and release gates

Browser Workers have no enforceable hard memory quota; hostile code can exhaust a tab/browser. Worker messages and practice results can be forged by learner Python and do not establish authorship, safety or grades. Same-site runtime fetches can touch the isolated asset host; it must contain no secrets and expose only bounded static assets. CSP does not stop all timing/covert channels. A browser exploit is outside this application's isolation guarantee. Hard process resource/network controls are required for future authoritative grading.

Actual browser/version results and untested engines belong in `docs/architecture/m0-validation.md`. Supporting an engine requires passing this suite on that engine and the intended deployed TLS/header topology. Mobile editing, accessibility and full product browser certification remain M2/M5. No production or remote grading enablement is authorized by this proof.

Primary references: [Pyodide streams](https://pyodide.org/en/stable/usage/streams.html), [Pyodide interrupts](https://pyodide.org/en/stable/usage/keyboard-interrupts.html), [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated), [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).
