# Source backups, templates and local drafts

M2 project tools use an independently authored, source-only format. Creating a local copy never changes the original project, permissions or server document history. Import and template creation do not execute Python.

## Source archive v1

A `.codealong.json` is UTF-8 JSON with exactly these fields:

```json
{
  "version": 1,
  "name": "My Python project",
  "runtime_id": "pyodide-314.0.7-core",
  "entrypoint": "main.py",
  "files": [{ "path": "main.py", "source": "print('Hello')\n" }]
}
```

Only reviewed runtime IDs are admitted. The entrypoint must exist in the complete 1–20-file set. Each file contains only `path` and `source`, with valid non-NUL Unicode and at most 128 KiB UTF-8 source. Paths use the same strict Python-module rules as Run: no traversal, absolute paths, backslashes, case collisions, duplicate paths, or ambiguous file/folder imports. Exact source bytes, including CRLF and a missing final newline, round trip unchanged.

The file and decoded input are bounded to 16 MiB. A shallow nesting scan skips quoted/escaped string content before JSON allocation; schema validation rejects unknown fields and nested objects in place of source. ZIP files, arbitrary dependencies, filesystem permissions, symlinks, binary Yjs history, account identifiers, credentials and server grants are not part of this format. The browser treats imported source as untrusted text until an explicit Run in the existing isolated Worker.

Exports/imports preserve all admitted files, even when combined source exceeds Run's separate 1 MiB budget. Such a draft remains editable/exportable; reduce it before running. This avoids dropping files from a recovery backup. Runtime assets still have their own reviewed hash/size/advisory checks; an archive cannot install a package or change the runner policy.

## Local copies

`features/project-tools/local-draft.ts` validates the whole archive before any storage access, assigns a fresh project UUID plus fresh file/document UUIDs and generation 1, seeds each new document once, then writes one complete validated recovery record. No API metadata write or server source-save path is involved. A failed local write reports failure without exposing a partially imported project. The ephemeral workbench's owner role describes local editing only; it is never a server authorization grant.

Account partitioning, epoch/revision CAS, byte/record quotas, unencrypted storage and sign-out retention follow [local recovery v1](local-recovery.md). Forking a project recovery uses only its validated source, without merging independently seeded history into another room. M3 must preserve that source-only fork boundary for legacy M2 data.

The original starter collection covers multi-file functions, input/EOF and an opt-in NumPy line plot. The reviewed registry controls each template's runtime. Templates are source examples, not trusted checks or grades.

`archive.test.ts` verifies exact round trips, escaped Python strings, invalid paths/fields/encoding/limits, complete over-Run-limit backups, fresh copy identities and local-draft manifests. The `/drafts` hub previews templates/imports before creating a new copy, lists only the current account's local records and offers export/confirmed deletion. `/drafts/:id` opens a validated local workbench with add/rename/delete/entrypoint/name operations. Its ephemeral owner flag enables local editing only. Project workbenches offer **Open local copy** from the recovery area; current Y.Text is copied synchronously before hashing or navigation.

The local workbench loads complete validated binary state before editing is available. Its controller acknowledges only the unchanged opened record; a newer record prompts review and cannot replace typing done during a delayed lookup. Local record queries are released when their route closes, so reopening reads current storage rather than an older in-memory copy. Metadata is local React state; live source remains exclusively in the per-file Yjs models. Local file operations never call server project mutation endpoints.

The browser scenarios in `project-tools.spec.ts` cover all three templates, actual multi-file/NumPy/PNG runs, file operations, export/import/reload/revisit, source preview injection, private account separation, explicit deletion/focus and independent current-project copies. Warmed offline verification is recorded separately in the M2 handoff report.
