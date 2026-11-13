import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import type { Project } from '../projects/types.ts';
import { captureRecovery, recoveryMatches, validateRecovery } from './codec.ts';
import { encodeArchive, recoveryArchive } from '../project-tools/archive.ts';
import { captureWorkspaceRun } from '../editor/model/snapshot.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const file = {
    id: id(3),
    document_id: id(4),
    generation: 1,
    path: 'main.py',
    kind: 'python' as const,
    initial_source: 'print("start")\r\n',
    initial_sha256: await sha256(sourceBytes('print("start")\r\n')),
  };
  const project: Project = {
    id: id(2),
    owner_id: id(1),
    workspace_id: id(5),
    name: 'Recovery',
    role: 'owner',
    archived: false,
    workspace_archived: false,
    acl_version: '1',
    metadata_version: 1,
    entrypoint_file_id: file.id,
    entrypoint_path: file.path,
    runtime_id: CORE_RUNTIME.runtime_id,
    runtime_profile_id: id(6),
  };
  const workspace = new EditorWorkspace(id(1), project.id);
  workspace.reconcile(project, [file]);
  await workspace.loadSource(file);
  return { workspace, project, file };
}
describe('binary local recovery', () => {
  it('retains deletion-only history so replaying an old seed cannot resurrect cleared source', async () => {
    const f = await fixture();
    const previous = Y.encodeStateAsUpdate(f.workspace.file(id(3))!.doc);
    f.workspace.replaceSource(id(3), '');
    const recovered = await captureRecovery(f.workspace, 'Recovery');
    const opened = await fixture();
    opened.workspace.restoreFiles(recovered.data.files);
    Y.applyUpdate(opened.workspace.file(id(3))!.doc, previous);
    expect(opened.workspace.file(id(3))!.text.toString()).toBe('');
    f.workspace.destroy();
    opened.workspace.destroy();
  });
  it('preserves a complete source backup even when local edits exceed the separate Run aggregate budget', async () => {
    const f = await fixture(),
      initial_sha256 = await sha256(sourceBytes(''));
    const files = Array.from({ length: 9 }, (_, index) => ({
      id: id(300 + index),
      document_id: id(400 + index),
      generation: 1,
      path: `part${index}.py`,
      kind: 'python' as const,
      initial_sha256,
      initial_source: '',
    }));
    f.workspace.reconcile(
      {
        ...f.project,
        metadata_version: 2,
        entrypoint_file_id: files[0]!.id,
        entrypoint_path: files[0]!.path,
      },
      files,
    );
    await Promise.all(files.map((file) => f.workspace.loadSource(file)));
    for (const file of files)
      f.workspace.replaceSource(file.id, 'x'.repeat(128 * 1024));
    await expect(captureWorkspaceRun(f.workspace)).rejects.toThrow('oversized');
    const recovered = await captureRecovery(f.workspace, 'Recovery');
    const archive = JSON.parse(encodeArchive(recoveryArchive(recovered)));
    expect(archive.files).toHaveLength(9);
    expect(
      archive.files.every(
        (file: { source: string }) => file.source.length === 128 * 1024,
      ),
    ).toBe(true);
    f.workspace.destroy();
  });
  it('restores full Yjs identity without duplicating an already loaded starter', async () => {
    const original = await fixture();
    original.workspace.replaceSource(id(3), '# 🐍\r\nprint("draft")\r\n');
    const recovered = await captureRecovery(original.workspace, 'Recovery');
    const vector = Y.encodeStateVector(original.workspace.file(id(3))!.doc);
    const opened = await fixture();
    expect(recoveryMatches(opened.workspace, recovered)).toBe(true);
    opened.workspace.restoreFiles(recovered.data.files);
    expect(opened.workspace.file(id(3))!.text.toString()).toBe(
      '# 🐍\r\nprint("draft")\r\n',
    );
    expect(Y.encodeStateVector(opened.workspace.file(id(3))!.doc)).toEqual(
      vector,
    );
    expect(opened.workspace.file(id(3))!.dirty).toBe(true);
    opened.workspace.replaceSource(id(3), 'later');
    opened.workspace.file(id(3))!.undo.undo();
    expect(opened.workspace.file(id(3))!.text.toString()).toBe(
      '# 🐍\r\nprint("draft")\r\n',
    );
    expect(await opened.workspace.loadSource(opened.file)).toBe(false);
    original.workspace.destroy();
    opened.workspace.destroy();
  });
  it('keeps current renamed metadata and rejects stale generations/account scopes before mutation', async () => {
    const f = await fixture();
    f.workspace.replaceSource(id(3), 'draft');
    const recovered = await captureRecovery(f.workspace, 'Recovery');
    const opened = await fixture();
    opened.workspace.reconcile({ ...opened.project, metadata_version: 2 }, [
      { ...opened.file, path: 'lesson.py' },
    ]);
    opened.workspace.restoreFiles(recovered.data.files);
    expect(opened.workspace.file(id(3))!.metadata.path).toBe('lesson.py');
    opened.workspace.reconcile({ ...opened.project, metadata_version: 3 }, [
      { ...opened.file, generation: 2 },
    ]);
    expect(recoveryMatches(opened.workspace, recovered)).toBe(false);
    expect(() => opened.workspace.restoreFiles(recovered.data.files)).toThrow(
      'generations',
    );
    expect(opened.workspace.file(id(3))!.loaded).toBe(false);
    expect(recoveryMatches(new EditorWorkspace(id(9), id(2)), recovered)).toBe(
      false,
    );
    f.workspace.destroy();
    opened.workspace.destroy();
  });
  it('rejects corrupted hashes, unexpected roots, formatted text and incomplete causal fragments', async () => {
    const f = await fixture(),
      recovered = await captureRecovery(f.workspace, 'Recovery');
    const good = recovered.data.files[0]!;
    await expect(
      validateRecovery({
        ...recovered.data,
        files: [{ ...good, state_sha256: '0'.repeat(64) }],
      }),
    ).rejects.toThrow('validated');
    for (const formatted of [false, true]) {
      const doc = new Y.Doc();
      if (formatted) {
        doc.getText('source').insert(0, 'text');
        doc.getText('source').format(0, 4, { bold: true });
      } else doc.getMap('unexpected').set('key', 'value');
      const state = Y.encodeStateAsUpdate(doc);
      await expect(
        validateRecovery({
          ...recovered.data,
          files: [{ ...good, state, state_sha256: await sha256(state) }],
        }),
      ).rejects.toThrow('validated');
      doc.destroy();
    }
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'first');
    const vector = Y.encodeStateVector(doc);
    doc.getText('source').insert(5, 'second');
    const fragment = Y.encodeStateAsUpdate(doc, vector);
    await expect(
      validateRecovery({
        ...recovered.data,
        files: [
          { ...good, state: fragment, state_sha256: await sha256(fragment) },
        ],
      }),
    ).rejects.toThrow('validated');
    doc.destroy();
    f.workspace.destroy();
  });
  it('rejects unsafe paths, unknown fields, shared bytes and source tampering without deleting the copy', async () => {
    const f = await fixture(),
      recovered = await captureRecovery(f.workspace, 'Recovery'),
      good = recovered.data.files[0]!;
    for (const data of [
      { ...recovered.data, token: 'never stored' },
      {
        ...recovered.data,
        files: [
          { ...good, metadata: { ...good.metadata, path: '../escape.py' } },
        ],
      },
      {
        ...recovered.data,
        files: [{ ...good, source_sha256: '0'.repeat(64) }],
      },
      {
        ...recovered.data,
        files: [{ ...good, state: new Uint8Array(new SharedArrayBuffer(16)) }],
      },
      {
        ...recovered.data,
        files: [{ ...good, state: new Uint8Array(1024 * 1024 + 1) }],
      },
    ])
      await expect(validateRecovery(data)).rejects.toThrow();
    expect((await validateRecovery(recovered.data)).sources.get(id(3))).toBe(
      f.file.initial_source,
    );
    f.workspace.destroy();
  });
  it('exports exact current source from the validated binary state with no authentication fields', async () => {
    const f = await fixture();
    f.workspace.replaceSource(id(3), '# 🐍\r\nprint(42)\r\n');
    const recovered = await captureRecovery(f.workspace, 'Recovery');
    const encoded = encodeArchive(recoveryArchive(recovered));
    expect(JSON.parse(encoded)).toEqual({
      version: 1,
      name: 'Recovery',
      runtime_id: CORE_RUNTIME.runtime_id,
      entrypoint: 'main.py',
      files: [{ path: 'main.py', source: '# 🐍\r\nprint(42)\r\n' }],
    });
    expect(encoded).not.toContain('account_id');
    expect(encoded).not.toContain('state_sha256');
    f.workspace.destroy();
  });
});
