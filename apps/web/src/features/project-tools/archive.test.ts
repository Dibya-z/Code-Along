import { describe, expect, it } from 'vitest';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { captureRecovery, validateRecovery } from '../recovery/codec.ts';
import type { RecoveryStore } from '../recovery/store.ts';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import {
  ARCHIVE_BYTES,
  decodeArchive,
  encodeArchive,
  recoveryArchive,
  validateArchive,
  type SourceArchive,
} from './archive.ts';
import { createLocalDraft, localDraftProject } from './local-draft.ts';
import { TEMPLATES } from './templates.ts';
const bytes = (text: string) => new TextEncoder().encode(text);
const source: SourceArchive = {
  version: 1,
  name: 'Exact source',
  runtime_id: CORE_RUNTIME.runtime_id,
  entrypoint: 'main.py',
  files: [
    { path: 'main.py', source: '# 🐍\r\nprint("[{\\"}]")\r\n' },
    { path: 'module/lesson.py', source: 'answer = 42\n' },
  ],
};

describe('source-only project archives and local forks', () => {
  it('round trips exact Unicode/CRLF and nested Python paths without auth/history fields', () => {
    const decoded = decodeArchive(bytes(encodeArchive(source)));
    expect(decoded).toEqual(source);
    const bracketSource = {
      ...source,
      files: [
        { path: 'main.py', source: 'print("' + '['.repeat(32) + '")\r\n' },
      ],
    };
    expect(decodeArchive(bytes(encodeArchive(bracketSource)))).toEqual(
      bracketSource,
    );
    expect(Object.isFrozen(decoded.files[0])).toBe(true);
    expect(Object.keys(decoded).sort()).toEqual(
      ['version', 'name', 'runtime_id', 'entrypoint', 'files'].sort(),
    );
  });
  it('rejects traversal, case/import collisions, duplicates, non-Python paths and missing entrypoints', () => {
    for (const path of [
      '../main.py',
      '/main.py',
      'module\\main.py',
      'code.html',
      'main.py/other.py',
      'Module.py',
    ]) {
      const files = [...source.files, { path, source: '' }];
      if (path === 'Module.py') files.push({ path: 'module.py', source: '' });
      expect(() => validateArchive({ ...source, files })).toThrow();
    }
    expect(() =>
      validateArchive({ ...source, files: [...source.files, source.files[0]] }),
    ).toThrow();
    expect(() =>
      validateArchive({ ...source, entrypoint: 'missing.py' }),
    ).toThrow();
  });
  it('rejects unknown fields/profiles, excessive nesting, bad UTF-8/NUL, large files and bounded input', () => {
    for (const value of [
      { ...source, version: 2 },
      { ...source, role: 'owner' },
      { ...source, runtime_id: 'arbitrary' },
      {
        ...source,
        files: [{ path: 'main.py', source: '', initial_source: '' }],
      },
      { ...source, files: [] },
      {
        ...source,
        files: Array.from({ length: 21 }, (_, i) => ({
          path: `file${i}.py`,
          source: '',
        })),
      },
      { ...source, files: [{ path: 'main.py', source: '\0' }] },
      { ...source, files: [{ path: 'main.py', source: '\ud800' }] },
      {
        ...source,
        files: [{ path: 'main.py', source: 'a'.repeat(128 * 1024 + 1) }],
      },
    ])
      expect(() => validateArchive(value)).toThrow();
    expect(() => decodeArchive(bytes('[[[[[[]]]]]]'))).toThrow('nesting');
    expect(() => decodeArchive(new Uint8Array([255]))).toThrow('UTF-8');
    expect(() => decodeArchive(bytes('{'))).toThrow('JSON');
    expect(() => decodeArchive(new Uint8Array(ARCHIVE_BYTES + 1))).toThrow(
      '16 MiB',
    );
    expect(() =>
      decodeArchive(new Uint8Array(new SharedArrayBuffer(8))),
    ).toThrow();
  });
  it('preserves a complete backup above the Run budget instead of dropping files', () => {
    const files = Array.from({ length: 9 }, (_, index) => ({
      path: `lesson${index}.py`,
      source: '#'.repeat(128 * 1024),
    }));
    expect(
      decodeArchive(
        bytes(encodeArchive({ ...source, entrypoint: 'lesson0.py', files })),
      ).files,
    ).toEqual(files);
  });
  it('independently creates fresh file/document identities and exact local-draft manifests', async () => {
    let stored: unknown;
    const store: Pick<RecoveryStore, 'read' | 'save'> = {
      async read(account, project) {
        return {
          policy: {
            account_id: account,
            epoch: crypto.randomUUID(),
            retain: false,
            count: 0,
            used_bytes: 0,
          },
          record: undefined,
          project,
        };
      },
      async save(account, project, _epoch, expected, recovery) {
        expect(expected).toBe(0);
        stored = recovery.data;
        return {
          account_id: account,
          project_id: project,
          revision: 1,
          updated_at: Date.now(),
          bytes: recovery.bytes,
          data: recovery.data,
        };
      },
    };
    const account = crypto.randomUUID();
    const id = await createLocalDraft(account, source, store);
    const first = await validateRecovery(stored);
    expect(first.data.project_id).toBe(id);
    expect(first.data.account_id).toBe(account);
    expect(first.data.kind).toBe('local_draft');
    expect(recoveryArchive(first)).toEqual(source);
    const secondId = await createLocalDraft(
      account,
      recoveryArchive(first),
      store,
    );
    const second = await validateRecovery(stored);
    expect(secondId).not.toBe(id);
    expect(
      second.data.files.some((file) =>
        first.data.files.some(
          (old) =>
            old.metadata.id === file.metadata.id ||
            old.metadata.document_id === file.metadata.document_id,
        ),
      ),
    ).toBe(false);
    const workspace = new EditorWorkspace(account, secondId, 'local_draft');
    workspace.reconcile(
      localDraftProject(second),
      second.data.files.map((file) => file.metadata),
    );
    workspace.restoreFiles(second.data.files);
    expect(workspace.snapshotInput().source_kind).toBe('local_draft');
    expect(
      recoveryArchive(await captureRecovery(workspace, source.name)),
    ).toEqual(source);
    workspace.destroy();
  });
  it('ships three reviewed source templates without executing or importing their Python', () => {
    expect(TEMPLATES).toHaveLength(3);
    for (const template of TEMPLATES)
      expect(decodeArchive(bytes(encodeArchive(template.archive)))).toEqual(
        template.archive,
      );
  });
});
