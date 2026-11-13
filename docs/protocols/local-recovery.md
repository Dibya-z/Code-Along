# Local recovery v1

M2 stores a private browser recovery copy, not a server save or collaboration checkpoint. The UI reports **Local recovery updated** only after its IndexedDB transaction completes. Wait for that label before refreshing or closing the tab; abrupt termination can interrupt a pending write. An exported file is a separate backup.

## Identity and validation

`apps/web/src/features/recovery/codec.ts` captures the complete Yjs state, immutable starter baseline, file/document UUIDs, generation and exact source digest for every loaded file. Capture copies all live bytes synchronously before asynchronous hashing. The strict record also includes account/project UUIDs, project/local-draft kind, entrypoint, observed metadata version, reviewed runtime and name. Credentials, session responses, roles and authorization grants are never stored in these records.

Validation checks exact fields, SHA-256 digests, UTF-8/source bounds, Python module paths and unique identities. Binary updates accept only the `source` text root and bounded string/deletion/GC structs; pending causal fragments, formatting, other roots and shared backing memory are rejected. Recovery replaces empty documents with the validated full binary state. It does not seed starter text a second time. Undo history from the previous tab is not restored.

Project recovery requires the currently authorized, writable account/project and the same complete file/document/generation/baseline set. Current server metadata, including renames and entrypoint selection, remains authoritative. A stale generation can be exported but cannot be applied over a different document. No partial project is silently restored or exported.

Opening an explicit local draft restores its validated binary state before the editor becomes interactive. The subsequent store lookup acknowledges the unchanged opened record without applying it again. Typing during that lookup is preserved; a competing record pauses recovery for review. Project recovery continues to require the explicit Restore action.

## Storage and concurrency

`store.ts` uses Dexie 4.4.7 over IndexedDB database `code-along-local`. The `accounts` table contains an account UUID, random epoch, retention preference, byte accounting and record count. The `drafts` table has compound key `[account_id+project_id]`, revision, timestamp, accounted size and validated data.

Hashing and Yjs decoding finish before opening the write transaction. A single transaction checks the account epoch and expected record revision, writes the record and updates accounting. A second tab cannot overwrite a newer revision silently. The controller pauses recovery, preserves its current editor text, and offers export/review. Explicit replacement requires a confirmation dialog. A decision counter also rejects an older queued capture after the user restores a newer copy.

Writes debounce for 300 ms and serialize per controller. Route teardown copies pending text before document disposal and allows the private write to finish. Full browser termination cannot guarantee that completion. Storage failures leave editor text and earlier stored data intact; export remains available without IndexedDB. The storage library is loaded asynchronously so initialization failures, including privacy-blocked messaging, become a recoverable notice rather than a page crash.

Limits are 20 files, 128 KiB UTF-8 source per file, 1 MiB binary state per file, 8 MiB combined binary state, 32 records and 32 MiB accounted storage per account. Accounting includes binary state, immutable baseline and a conservative metadata allowance. Browser quota can be lower. No old record is evicted automatically. Recovery/backup can preserve edits exceeding the separate 1 MiB aggregate Run limit; Run still refuses that complete snapshot.

## Privacy and session changes

Local drafts are unencrypted and available to scripts running on the application origin. Account UUID partitioning is a UI/data-separation measure, not encryption against another person using the same browser profile. Export important work and use a private device for sensitive source.

The default is to purge the current account's drafts on successful server sign-out. Retention is an explicit device preference. Sign-out rotates the epoch even when retaining data, and marks the account as ending in memory before queued work can write again. BroadcastChannel and a metadata-only storage event notify other tabs to discard their identity-scoped application state. Generic sign-in/session changes also invalidate other tabs. Neither channel contains source or credentials.

If IndexedDB cleanup fails, server sign-out still succeeds and the landing page reports that local cleanup could not be confirmed. The application does not claim that inaccessible bytes were erased. Retained records become visible only after a fresh verified session for the same account.

## Backup format and canonical collaboration

`features/project-tools/archive.ts` exports a bounded `.codealong.json` containing only a version, name, runtime, entrypoint path and complete source/path pairs. A loaded individual file can also be downloaded as Python text when another file is unavailable. Exports do not include account IDs, document history, permissions or session data.

M2 binary records have `origin: "m2-local"`. Those documents were independently seeded. M3 offers **Open stored local copy** to fork them through source-only archives into fresh local identities; it disables merging that history into canonical rooms. Keep the original recovery until the fresh copy's storage transaction completes. Export remains available when copying fails.

New server-backed records use `origin: "m3-canonical"`. Restoring requires current authorization and matching account/project/file/document/generation/baseline identities. All merged files are validated before any live application; oversized or invalid merged branches leave every current file unchanged. A canonical restore applies Yjs history to the same document and cannot overwrite newer canonical changes by replacing plaintext. Local-only drafts retain their independent restore behavior.

Wait for **Saved** to confirm server durability in a shared project. **Local recovery updated** confirms only the supplementary copy on this device. Multiple tabs can share canonical source while competing for one device recovery record; a paused local writer does not pause the server checkpoint path. Review or export the stored record explicitly. Server authentication and project authorization remain online API responsibilities; a recovery record never grants access.

Verification lives in `codec.test.ts`, `controller.test.ts` and the real-IndexedDB Chromium/WebKit product recovery cases. They cover deletion-only history, exact Unicode/CRLF bytes, baseline identity, complete over-Run-limit backups, late queued captures, generation mismatch, tab conflicts, unavailable/quota-limited storage, retention and account/session separation.
