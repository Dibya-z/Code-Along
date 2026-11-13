import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { EditorWorkspace } from './workspace.ts';
import {
  captureRecovery,
  recoveryMatches,
  validateRecovery,
} from '../../recovery/codec.ts';
import { RecoveryController } from '../../recovery/controller.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function setup(canonical = true) {
  const file = {
    id: id(3),
    document_id: id(4),
    generation: 1,
    path: 'main.py',
    kind: 'python' as const,
    initial_source: 'print("starter")\r\n',
    initial_sha256: await sha256(sourceBytes('print("starter")\r\n')),
  };
  const project = {
    id: id(2),
    name: 'Shared project',
    role: 'owner' as const,
    archived: false,
    workspace_archived: false,
    metadata_version: 1,
    entrypoint_file_id: file.id,
    runtime_id: CORE_RUNTIME.runtime_id,
  };
  const model = new EditorWorkspace(id(1), id(2), 'project', canonical);
  model.reconcile(project, [file]);
  return { model, file, project };
}
describe('canonical server editor documents', () => {
  it('verifies immutable REST baselines without inserting an independent starter seed', async () => {
    const f = await setup();
    await f.model.loadSource(f.file);
    const file = f.model.file(f.file.id)!;
    expect(file.text.toString()).toBe('');
    expect(file.loaded).toBe(false);
    expect(() => f.model.snapshotInput()).toThrow('finish loading');
    const server = new Y.Doc();
    server.getText('source').insert(0, '# saved server content\r\n');
    Y.applyUpdate(file.doc, Y.encodeStateAsUpdate(server));
    file.synchronizedFromServer();
    expect(file.loaded).toBe(true);
    expect(file.text.toString()).toBe('# saved server content\r\n');
    expect(file.initialSource).toBe(f.file.initial_source);
    expect(f.model.snapshotInput().files[0]!.source).toBe(
      '# saved server content\r\n',
    );
    server.destroy();
    f.model.destroy();
  });
  it('keeps empty/deleted server content empty after sync and late baseline verification', async () => {
    const f = await setup(),
      file = f.model.file(f.file.id)!,
      server = new Y.Doc();
    server.getText('source').insert(0, f.file.initial_source);
    server.getText('source').delete(0, server.getText('source').length);
    Y.applyUpdate(file.doc, Y.encodeStateAsUpdate(server));
    file.synchronizedFromServer();
    expect(file.loaded).toBe(false);
    await f.model.loadSource(f.file);
    expect(file.loaded).toBe(true);
    expect(file.text.toString()).toBe('');
    expect(file.dirty).toBe(true);
    const revision = f.model.sourceRevision;
    file.markSaved(true);
    expect(file.dirty).toBe(false);
    expect(f.model.sourceRevision).toBe(revision);
    file.replace('later');
    expect(file.dirty).toBe(true);
    server.destroy();
    f.model.destroy();
  });
  it('marks canonical recovery separately and merges only matching generation history', async () => {
    const f = await setup();
    await f.model.loadSource(f.file);
    const file = f.model.file(f.file.id)!;
    file.synchronizedFromServer();
    file.replace('local change');
    const recovery = await captureRecovery(f.model, 'Shared project');
    expect(recovery.data.origin).toBe('m3-canonical');
    expect(recoveryMatches(f.model, recovery)).toBe(true);
    await expect(validateRecovery(recovery.data)).resolves.toBeDefined();
    f.model.mergeCanonicalRecovery(recovery);
    expect(file.text.toString()).toBe('local change');
    expect(() =>
      f.model.mergeCanonicalRecovery({
        ...recovery,
        data: {
          ...recovery.data,
          files: [
            {
              ...recovery.data.files[0]!,
              metadata: { ...f.file, generation: 2 },
            },
          ],
        },
      }),
    ).toThrow('generations');
    expect(file.text.toString()).toBe('local change');
    f.model.destroy();
  });
  it('requires source-only forking of legacy m2-local recovery even when identities match', async () => {
    const legacy = await setup(false),
      current = await setup();
    await legacy.model.loadSource(legacy.file);
    legacy.model.replaceSource(legacy.file.id, 'legacy edits');
    const found = await captureRecovery(legacy.model, 'Legacy');
    await current.model.loadSource(current.file);
    current.model.file(current.file.id)!.synchronizedFromServer();
    expect(found.data.origin).toBe('m2-local');
    expect(recoveryMatches(current.model, found)).toBe(false);
    expect(() => current.model.mergeCanonicalRecovery(found)).toThrow(
      'generations',
    );
    expect(() => current.model.restoreFiles(found.data.files)).toThrow(
      'Legacy',
    );
    const store = {
      read: vi.fn().mockResolvedValue({
        policy: {
          account_id: id(1),
          epoch: id(9),
          retain: false,
          used_bytes: found.bytes,
          count: 1,
        },
        record: {
          account_id: id(1),
          project_id: id(2),
          revision: 1,
          updated_at: 1,
          bytes: found.bytes,
          data: found.data,
        },
      }),
      save: vi.fn(),
      retention: vi.fn(),
      remove: vi.fn(),
    };
    const recovery = new RecoveryController(
      current.model,
      () => 'Shared project',
      store,
    );
    recovery.start();
    await vi.waitFor(() => expect(recovery.getSnapshot().phase).toBe('found'));
    expect(recovery.canRestore()).toBe(false);
    recovery.restore();
    expect(current.model.file(current.file.id)!.text.toString()).toBe('');
    expect(store.save).not.toHaveBeenCalled();
    recovery.dispose();
    legacy.model.destroy();
    current.model.destroy();
  });
  it('rejects oversized same-generation branch merges before changing the live source', async () => {
    const current = await setup(),
      branch = await setup();
    for (const f of [current, branch]) {
      await f.model.loadSource(f.file);
      f.model.file(f.file.id)!.synchronizedFromServer();
    }
    current.model.replaceSource(current.file.id, 'a'.repeat(70000));
    branch.model.replaceSource(branch.file.id, 'b'.repeat(70000));
    const recovery = await captureRecovery(branch.model, 'Branch');
    const live = current.model.file(current.file.id)!,
      before = Y.encodeStateAsUpdate(live.doc),
      revision = current.model.sourceRevision;
    expect(() => current.model.mergeCanonicalRecovery(recovery)).toThrow(
      'could not be validated',
    );
    expect(Y.encodeStateAsUpdate(live.doc)).toEqual(before);
    expect(current.model.sourceRevision).toBe(revision);
    current.model.destroy();
    branch.model.destroy();
  });
  it('preflights every file so a later invalid merged file cannot partially restore an earlier file', async () => {
    const current = await setup(),
      branch = await setup();
    for (const f of [current, branch]) {
      const helper = {
        ...f.file,
        id: id(6),
        document_id: id(7),
        path: 'helper.py',
      };
      f.model.reconcile({ ...f.project, metadata_version: 2 }, [
        f.file,
        helper,
      ]);
      await Promise.all(
        [f.file, helper].map((file) => f.model.loadSource(file)),
      );
      for (const file of f.model.documents()) file.synchronizedFromServer();
    }
    current.model.replaceSource(id(3), 'current first');
    branch.model.replaceSource(id(3), 'recovered first');
    current.model.replaceSource(id(6), 'a'.repeat(70000));
    branch.model.replaceSource(id(6), 'b'.repeat(70000));
    const recovery = await captureRecovery(branch.model, 'Branch');
    const ordered = {
      ...recovery,
      data: {
        ...recovery.data,
        files: [...recovery.data.files].sort((left) =>
          left.metadata.id === id(3) ? -1 : 1,
        ),
      },
    };
    const before = current.model
      .documents()
      .map((file) => Y.encodeStateAsUpdate(file.doc));
    expect(() => current.model.mergeCanonicalRecovery(ordered)).toThrow(
      'could not be validated',
    );
    expect(
      current.model.documents().map((file) => Y.encodeStateAsUpdate(file.doc)),
    ).toEqual(before);
    expect(current.model.file(id(3))!.text.toString()).toBe('current first');
    current.model.destroy();
    branch.model.destroy();
  });
});
