# Development storage and verification

The source repository is small; the local development environment accounts for most of its disk usage. Docker images and build layers live inside the owned Lima disk. Installed JavaScript/Python packages, reviewed Python runtime assets, browser engines and disposable test clusters also consume space. None of these represents additional application features.

## Working with limited free space

Check `df -h .` before builds and browser suites. Run the normal development stack or the isolated native browser stack sequentially. Use `npm run stop` to release the owned development services and VM while preserving their volumes. A stopped VM retains its disk contents; stopping it primarily releases memory and CPU.

Preserve `.env`, local certificates/CA, database and mail volumes, browser profiles/drafts, the reference repository and installed test prerequisites. Never run a blanket volume prune, delete the Lima disk or remove an entire scratch directory containing database/browser state. Identify the owner, purpose, active users and replacement cost of each disposable path before removing it.

Unused Docker build cache can be reclaimed inside the owned VM. A guest discard/TRIM may be needed before its sparse disk releases host blocks. Recheck actual host free space afterward; guest free space and the virtual disk's maximum size are different measurements. Avoid repeatedly rebuilding images after deleting their useful layers.

On 14 November 2026, reviewed inactive reference-investigation caches/dependency trees and uninstalled native build sources were removed. Installed PostgreSQL/Redis tools, reference source, existing browser state and persistent development data were preserved. Removing unused Docker build cache and trimming the guest brought measured host free space from **5.6 GiB to approximately 8.4 GiB**; the owned VM disk fell from approximately **10.5 GiB to 8.9 GiB allocated**. These are workstation observations, not a fixed installation requirement or a guarantee of future free space.

If headroom becomes inadequate, pause disk-heavy work and inspect verified disposable artifacts again. Do not solve a storage limit by weakening database durability, runtime integrity, browser isolation or preservation rules.

## Verification without repeated heavy work

Each coherent feature bundle receives relevant local tests, type/lint checks and diff review. Repeat broader suites when the changed behavior, failures or unresolved risks require them. The milestone gate still includes the complete integration/browser regression; focused local checks do not replace it.

CI preserves the existing `foundation` and `compose` job names. Both classify the complete immutable push diff or pull-request merge-base diff. Only a nonempty change containing ordinary root README/tracker or `docs/**/*.md` prose selects lightweight verification. Protocol/security specifications, architecture decisions, application source, configuration, dependencies, symlinks, executable files, unknown paths and ambiguous/missing history retain full checks. Manual runs always use full verification.

The lightweight path installs only locked root tooling, checks Markdown formatting and local file-link targets, and tests the conservative classifier. Its Compose job explicitly records why no container validation is needed. It does not report browser/database tests as executed. Heading anchors and remote website availability are outside the local link check.

Run the same prose check locally with the documented project-local cache environment:

```sh
uv run --locked --offline python tools/ci/check_changes.py --check-docs
```

Application/security/protocol changes still run the full pinned CI pipeline. A source bundle must pass before a later prose-only handoff can use the fast path. Commits and pushes are grouped around meaningful verified functionality rather than every small edit.
