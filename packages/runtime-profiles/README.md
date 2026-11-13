# Reviewed browser runtime profiles

The product offers Python core and an opt-in NumPy 2.4.6 profile on Pyodide 314.0.7 / Python 3.14.2. The project runtime is the default; a local practice run may explicitly select another reviewed profile without changing shared project metadata. Its complete identity and inventory digest are frozen into the run manifest.

`manifests/pyodide-scientific.json` contains the core asset inventory plus the exact NumPy wheel. The historical core inventory stays in `apps/runner-web/public/runtime-manifests/pyodide-core.json`; changing its bytes would invalidate the already shipped v1 proof. Profile identities in `packages/contracts/execution/profiles.ts` and Django's frozen data migrations are immutable review records. Add a new profile identity when a shipped package set changes.

The runner build calls `tools/dev/copy_runtime.mjs`. It verifies local core assets, downloads only inventory-listed wheels from the exact official Pyodide release, checks lengths/SHA-256, uses an ignored `.runtime/runtime-assets` cache and emits self-hosted files under content-addressed paths. It rejects redirects, traversal, symlinks as asset files, corrupt cache bytes and oversized/chunked downloads. A profile allows at most 32 assets, 32 MiB per asset and 64 MiB total. Failed integrity checks do not silently substitute packages.

The Worker verifies the selected inventory and core bytes before booting, uses a package lock restricted to the profile and asks Pyodide to verify wheel integrity. Browser network requests stay on the runner site. Packages load when the corresponding profile is selected; importing NumPy in a core run does not auto-install it. The profile describes initial practice configuration, not an authoritative assessment or a protection against deliberately altered learner code.

Matplotlib is currently excluded. Its Pillow 12.2.0 wheel in the compatible official distribution has published vulnerabilities; Pillow 13.0.0 has fixes, but no compatible patched wheel was found in the checked upstream/stable/nightly indexes on 13 November 2026. Do not suppress the advisory gate or substitute a native CPython wheel. Add a separate reviewed Matplotlib profile when a compatible patched artifact is available. Bounded PNG display belongs to the M2 console unit. See [Pillow's security advisories](https://github.com/python-pillow/Pillow/security) and [13.0.0 release notes](https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html).

The advisory gate in `tools/ci/check_python_advisories.py` checks exact backend and browser package versions. It is a point-in-time public advisory check, not a complete security audit. Asset hashes establish integrity, not the absence of vulnerabilities.

Artifacts retain their upstream license files. Pyodide uses MPL-2.0; the selected NumPy wheel declares `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`. Preserve all bundled notices when self-hosting. No wheels/build output are committed to Git.

Upstream behavior: [Pyodide package loading](https://pyodide.org/en/stable/usage/loading-packages.html), [loadPackage integrity and configuration](https://pyodide.org/en/stable/usage/api/js-api.html), [official package indexes](https://github.com/pyodide/pyodide-recipes).
