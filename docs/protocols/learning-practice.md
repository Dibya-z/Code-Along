# Visible-check practice execution

M4.3 adds an explicit practice adapter to the existing separate-site supervised Pyodide runner. It introduces no server execution endpoint, trusted grade or assessment write. [Assignment versions](assignments.md) freeze public checks and runtime/helper identities; [learning work](participation-and-work.md) pins the version. Practice captures bind those identities to exact source H, even after live source changes to H2.

## Independent wire and capture

The existing `code-along.runner` v1 proof and ordinary product v2 remain separate, with their existing fields and canonical source encoding. The new [practice contract](../../packages/contracts/execution/practice.ts) uses:

```text
protocol: code-along.practice
version: 1
session_nonce: canonical UUID
run_id: canonical UUID
```

Every command/event is field-exact. Run contains a complete immutable practice manifest and bounded stdin. Cancel has no additional field; stdin contains valid bounded text or null for EOF. Output/state/PNG plot bodies retain the existing product bounds under the new envelope. Connect/ready use this protocol/version and the existing strict shapes; the bootstrap admits only the exact `runner/1`, `runner/2` and `practice/1` pairings.

`capturePracticeManifest()` copies assignment/version/content/helper/check context synchronously and invokes unchanged v2 source capture before its first await. Every source/model value and the selected effective check string therefore belong to one capture turn. It never changes the source entrypoint, appends a synthetic file or replaces H with later room contents. Source file ordering, identities, metadata revision, generation, runtime and stdin mode remain part of the existing ProjectRunManifest v2 digest.

PracticeManifest exact fields are:

```text
protocol: code-along.practice-manifest
version: 1
assignment_id, assignment_version_id, assignment_content_sha256
source: ProjectRunManifest v2
helper_release: {release_id, source_sha256}
published_checks_sha256
checks: PublicChecksManifest v1
check_origin: published | local_practice
sha256
```

The practice digest is SHA-256 of compact UTF-8 JSON:

```text
["code-along.practice-manifest",1,assignment_id,assignment_version_id,
 assignment_content_sha256,source.sha256,helper.release_id,
 helper.source_sha256,published_checks_sha256,checks.sha256,check_origin]
```

The original v2 source digest and revision-v1 history digest retain their different encodings and meanings. Neither becomes a practice digest merely by renaming it.

## Public and edited checks

Checks are publicly inspectable Python text, with no NUL or isolated surrogate, bounded to 16 KiB of nonblank UTF-8 using the same fixed blank-codepoint set as published assignments. Accepted source/check bytes are never trimmed or normalized. Literal leading U+FEFF is preserved as UTF-8 EF BB BF by both capture and the strict shared-document source/string decoders; NUL, isolated surrogates, malformed wire UTF-8 and byte limits remain enforced. PublicChecksManifest is exact `{protocol,version,language,source,source_sha256,sha256}` with `code-along.public-checks`, version 1 and language `python`. Its digest remains the M4.1 encoding:

```text
["code-along.public-checks",1,"python",source_sha256,source]
```

Published mode requires the effective check digest to equal the frozen published digest. A learner's explicit **Make a practice copy** keeps an in-memory edited string, creates its own effective digest and labels it `local_practice`, retaining the original `published_checks_sha256`. It never patches the instructor's version, creates a fake project file, joins a check-copy collaboration room or implies an assessed result. The application binds the capture to the actual Work project and its pinned version/runtime before execution.

The [reviewed helper release](../../packages/contracts/execution/helper-release.ts) is the existing `code-along-python-helpers-v1` with its exact source SHA. Unknown helper/runtime identities, malformed fields or mismatched source/check/practice digests fail before Worker creation. JavaScript contracts and the pinned helper-source regression preserve the same identity used by the backend and source history.

## Admission and supervised execution

[Bootstrap](../../apps/runner-web/src/bootstrap.ts) checks the exact configured parent origin/window, canonical nonce, one transferred MessagePort and a valid paired protocol/version. A malformed attempt does not consume the connection. A successful connection is private to its chosen adapter and is disposed on pagehide. An ordinary v2 session cannot receive practice messages as an alternate command channel.

[PracticeRunnerSupervisor](../../apps/runner-web/src/supervisor.ts) unwraps the practice source and passes one internal binding to the existing [ExecutionSupervisor](../../apps/runner-web/src/engine.ts). Before callbacks or async verification, the engine defensively clones the complete command, preserving the adapter's exact source/practice alias while removing external aliases, then freezes the owned data. It requires that exact source binding and verifies the full practice manifest. A second source object that merely claims the same digest cannot replace the verified source.

Run admission is reserved before hashes. Active-run identity is checked after verification and runtime-cache copying, so cancelled verification cannot create a Worker or affect a replacement run. Cache-copy exceptions produce a bounded failed terminal. The same existing replay cap, startup/wall deadlines, output/plot/message limits, stdin mailbox and fresh Worker lifecycle apply. The trusted shell terminates the Worker before emitting exactly one terminal result.

The Worker receives only project manifest, exact `checks_source`, stdin/input and reviewed runtime-cache bytes. It receives no assignment/user/session identity, API URL, capability or parent port. Practice identity provenance stays in the shell, outside learner-controlled Python.

## Python entry behavior

The [Worker](../../apps/runner-web/src/worker.ts) prepares the same verified runtime/packages, exact `/project` files and pinned helper, then installs the existing virtual-file limits before executing learner/check code. Check source is a separate bounded string, so a project with twenty files still has twenty source files. It cannot collide with a learner module path or consume an extra on-disk source slot.

Ordinary Run still executes the captured entrypoint. Check mode does not automatically run main first: author checks explicitly import learner modules or run the entrypoint when needed. The Worker passes check text as a Python global and invokes a fixed `compile`/`exec` program with diagnostic filename `<Code Along visible checks>` and `__name__ == '__main__'`. It never interpolates learner text into that program. `/project` precedes imports, and stdout/stderr flush in `finally` on success or error.

Input/EOF, stdout/stderr, PNG plots, Stop, startup/wall timeouts and output/file limits retain their existing semantics. Each Run or Check creates a fresh Worker/interpreter/filesystem. Only verified public runtime asset bytes may survive in the trusted shell cache; source, check text, credentials and results are not cached there. Worker-response CSP and separate-site credential isolation remain unchanged.

## Terminal correlation and authority

Practice terminal bodies are exact:

```text
type: terminal
status
source_manifest_sha256
practice_manifest_sha256
checks_sha256
helper_release_sha256
runtime_id
```

`helper_release_sha256` is the reviewed helper's source digest. The shell derives every identity from its owned admitted capture, ignoring any identity claims in Worker messages. The application compares every direct identity against its retained capture; assignment/version/content, published digest and copy origin are also bound by the practice digest. Late events from a replaced connection/run cannot update current state.

Status and output remain untrusted browser-reported practice. Learner Python can forge its own success or output; neither a successful check nor this identity correlation establishes assessment, enrollment, submission eligibility or a trusted grade. A no-check assignment continues to use ordinary Run and its retained exact source capture. Later submission work must validate its own authority and exact chosen source independently.

## Verification

[Contract tests](../../packages/contracts/tests/practice.test.ts) cover exact bytes/digests, synchronous capture and strict shape/runtime/helper/check rejection. [Bootstrap tests](../../apps/runner-web/src/bootstrap.test.ts) cover protocol/version pairing, origin/window/ports, extra fields and one-use connection disposal. [Practice engine tests](../../apps/runner-web/src/practice-engine.test.ts) cover twenty-file input, defensive ownership, forged Worker identities, pending-hash cancellation, stale Workers, cache faults, resource limits, terminal ordering and unchanged ordinary event shape. Existing v1/v2 tests remain required.

Fake Worker unit tests verify admission/control, not actual Pyodide execution or browser isolation. The milestone gate additionally requires real Chromium/WebKit separate-site practice runs for success/assertion errors, exact H versus H2, edited copies, imports, input/EOF, Stop/deadline/output, fresh repeated interpreters and preserved Worker CSP/credential boundaries. Integration results belong in the [M4 validation record](../architecture/m4-validation.md).
