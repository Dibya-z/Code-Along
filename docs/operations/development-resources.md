# Development storage and verification

The source repository is small; the local development environment accounts for most of its disk usage. Docker images and build layers live inside the owned Lima disk. Installed JavaScript/Python packages, reviewed Python runtime assets, browser engines and disposable test clusters also consume space. None of these represents additional application features.

## Working with limited free space

Check `df -h .` before builds and browser suites. Run the normal development stack or the isolated native browser stack sequentially. Use `npm run stop` to release the owned development services and VM while preserving their volumes. A stopped VM retains its disk contents; stopping it primarily releases memory and CPU.

Preserve `.env`, local certificates/CA, database and mail volumes, browser profiles/drafts, the reference repository and installed test prerequisites. Never run a blanket volume prune, delete the Lima disk or remove an entire scratch directory containing database/browser state. Identify the owner, purpose, active users and replacement cost of each disposable path before removing it.

Unused Docker build cache can be reclaimed inside the owned VM. A guest discard/TRIM may be needed before its sparse disk releases host blocks. Recheck actual host free space afterward; guest free space and the virtual disk's maximum size are different measurements. Avoid repeatedly rebuilding images after deleting their useful layers.

On 14 November 2026, reviewed inactive reference-investigation caches/dependency trees and uninstalled native build sources were removed. Installed PostgreSQL/Redis tools, reference source, existing browser state and persistent development data were preserved. Removing unused Docker build cache and trimming the guest brought measured host free space from **5.6 GiB to approximately 8.4 GiB**; the owned VM disk fell from approximately **10.5 GiB to 8.9 GiB allocated**. These are workstation observations, not a fixed installation requirement or a guarantee of future free space.

During final M4 verification on 15 November (Asia/Kolkata), the browser monitor stopped at **3.426GiB**, below its unchanged 3.5GiB floor. All owned services/browsers stopped normally; passing cases were retained for the unchanged build. A read-only audit found no useful large disposable host artifacts, so no browser profile, database, reference file or installed prerequisite was removed.

The existing idle VM then exposed two obsolete private frontend build-cache families. Ten exact records were individually checked as immutable, private and reclaimable before exact-ID removal; the two terminal records were explicitly reviewed through their obsolete ancestry. Current images, latest install/API cache, shared/mutable cache and all data volumes were preserved. Installed CLI formatting/filter differences caused validation-only stops before any removal; no broad prune was substituted. Final cleanup/guest-root TRIM raised measured host free space from about **3.74GiB to 5.89GiB**, with a **3.741GiB** monitored minimum and the VM stopped. All ten images, ten containers, three volumes and 66 protected cache records compare equal before/after; the immutable preservation baseline file is unchanged. Actual image/data reuse and remaining primary acceptance are recorded in the [M4 validation report](../architecture/m4-validation.md). Docker's [exact cache filters](https://docs.docker.com/reference/cli/docker/buildx/prune/) permit a narrower operation than blanket pruning; verify the installed CLI's actual selection before removal.

The subsequent normal `npm run dev` rebuild began with **5.29GiB** free but was interrupted at **3.483GiB** before readiness. Explicit `npm run stop` then confirmed the owned VM stopped and all seven application/test ports closed. The immutable baseline and all eleven static preservation checks remain unchanged; live database/mount checks did not run. A separate idle guest-root TRIM deleted no files or cache and returned essentially no additional space (about **4.07GiB** after stop). Final local startup acceptance needs more headroom; do not lower the safety floor or repeatedly restart the build. The [M4 validation report](../architecture/m4-validation.md) records its pending status.

If headroom becomes inadequate, pause disk-heavy work and inspect verified disposable artifacts again. Do not solve a storage limit by weakening database durability, runtime integrity, browser isolation or preservation rules.

## Verification without repeated heavy work

Each coherent feature bundle receives relevant local tests, type/lint checks and diff review. Repeat broader suites when the changed behavior, failures or unresolved risks require them. The milestone gate still includes the complete integration/browser regression; focused local checks do not replace it.

CI preserves the existing required `foundation` and `compose` job names. One shared `changes` job classifies the complete immutable push diff or pull-request merge-base diff. Only a nonempty change containing ordinary root README/tracker or `docs/**/*.md` prose selects lightweight verification. Protocol/security specifications, architecture decisions, application source, configuration, dependencies, symlinks, executable files, unknown paths and ambiguous/missing history retain full checks. Manual runs always use full verification.

The lightweight path installs only locked root tooling, checks Markdown formatting and local file-link targets, and tests the conservative classifier. Browser and Compose work is explicitly skipped for that verified prose classification; it is not reported as executed. Heading anchors and remote website availability are outside the local link check.

Full verification runs source/backend/transport/build checks, Compose and a Chromium/WebKit browser matrix independently. Each browser job retains its engine's isolation, foundation and complete product cases, using a private disposable database and the same assertions and per-test deadlines. The `foundation` aggregate succeeds only when all required full-source results succeed; missing, failed or cancelled results fail it. Prose-only skipped browser/Compose jobs are accepted only after successful exact prose classification and source/document checks.

This separation follows a measured cancellation of the old combined job at its 35-minute budget as the browser matrix grew. It reduces the critical path and keeps one stable complete result without dropping tests or increasing their timeouts. Each browser engine retains separately named failure evidence.

Run the same prose check locally with the documented project-local cache environment:

```sh
uv run --locked --offline python tools/ci/check_changes.py --check-docs
```

Application/security/protocol changes still run the full pinned CI pipeline. A source bundle must pass before a later prose-only handoff can use the fast path. Commits and pushes are grouped around meaningful verified functionality rather than every small edit.
