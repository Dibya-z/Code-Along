import { describe, expect, it, vi } from 'vitest';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import { captureRecovery, type ValidatedRecovery } from './codec.ts';
import { RecoveryController } from './controller.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function workspace(
  source: string,
  kind: 'project' | 'local_draft' = 'project',
  canonical = false,
) {
  const model = new EditorWorkspace(id(1), id(2), kind, canonical);
  const file = {
    id: id(3),
    document_id: id(4),
    generation: 1,
    path: 'main.py',
    kind: 'python' as const,
    initial_source: '',
    initial_sha256: await sha256(sourceBytes('')),
  };
  model.reconcile(
    {
      id: id(2),
      owner_id: id(1),
      workspace_id: id(5),
      name: 'Draft',
      role: 'owner',
      archived: false,
      workspace_archived: false,
      acl_version: '1',
      metadata_version: 1,
      entrypoint_file_id: file.id,
      entrypoint_path: file.path,
      runtime_id: CORE_RUNTIME.runtime_id,
      runtime_profile_id: id(6),
    },
    [file],
  );
  await model.loadSource(file);
  if (canonical) model.file(file.id)!.synchronizedFromServer();
  model.replaceSource(file.id, source);
  return model;
}
describe('local recovery decision ordering', () => {
  it('keeps canonical Restore unavailable until every file has its verified baseline and actual server sync', async () => {
    const files = [
      {
        id: id(3),
        document_id: id(4),
        generation: 1,
        path: 'main.py',
        kind: 'python' as const,
        initial_source: '',
        initial_sha256: await sha256(sourceBytes('')),
      },
      {
        id: id(7),
        document_id: id(8),
        generation: 1,
        path: 'helper.py',
        kind: 'python' as const,
        initial_source: '',
        initial_sha256: await sha256(sourceBytes('')),
      },
    ];
    const project = {
      id: id(2),
      owner_id: id(1),
      workspace_id: id(5),
      name: 'Shared',
      role: 'owner' as const,
      archived: false,
      workspace_archived: false,
      acl_version: '1',
      metadata_version: 1,
      entrypoint_file_id: id(3),
      entrypoint_path: 'main.py',
      runtime_id: CORE_RUNTIME.runtime_id,
      runtime_profile_id: id(6),
    };
    const saved = new EditorWorkspace(id(1), id(2), 'project', true),
      current = new EditorWorkspace(id(1), id(2), 'project', true);
    saved.reconcile(project, files);
    current.reconcile(project, files);
    for (const file of files) {
      await saved.loadSource(file);
      saved.file(file.id)!.synchronizedFromServer();
    }
    saved.replaceSource(id(3), 'retained main\n');
    saved.replaceSource(id(7), 'retained helper\n');
    const found = await captureRecovery(saved, 'Shared');
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
          updated_at: Date.now(),
          bytes: found.bytes,
          data: found.data,
        },
      }),
      save: vi.fn(),
      retention: vi.fn(),
      remove: vi.fn(),
    };
    const model = new RecoveryController(current, () => 'Shared', store);
    try {
      model.start();
      await vi.waitFor(() => expect(model.getSnapshot().phase).toBe('found'));
      expect(model.canRestore()).toBe(false);
      await current.loadSource(files[0]!);
      current.file(id(3))!.synchronizedFromServer();
      await current.loadSource(files[1]!);
      expect(current.file(id(3))!.loaded).toBe(true);
      expect(current.file(id(7))!.loaded).toBe(false);
      expect(model.canRestore()).toBe(false);
      current.file(id(7))!.synchronizedFromServer();
      expect(model.canRestore()).toBe(true);
      model.restore();
      expect(current.file(id(3))!.text.toString()).toBe('retained main\n');
      expect(current.file(id(7))!.text.toString()).toBe('retained helper\n');
      expect(model.getSnapshot().found).toBeNull();
      expect(model.getSnapshot().error).toBe('');
    } finally {
      model.dispose();
      current.destroy();
      saved.destroy();
    }
  });
  it('settles an initial canonical backup that becomes server Saved before debounce without claiming a local record', async () => {
    const current = await workspace('canonical source', 'project', true);
    const store = {
      read: vi.fn().mockResolvedValue({
        policy: {
          account_id: id(1),
          epoch: id(9),
          retain: false,
          used_bytes: 0,
          count: 0,
        },
        record: undefined,
      }),
      save: vi.fn(),
      retention: vi.fn(),
      remove: vi.fn(),
    };
    const model = new RecoveryController(current, () => 'Shared', store);
    vi.useFakeTimers();
    try {
      model.start();
      await Promise.resolve();
      expect(model.getSnapshot().phase).toBe('pending');
      current.file(id(3))!.markSaved(true);
      await vi.advanceTimersByTimeAsync(301);
      expect(model.getSnapshot().phase).toBe('ready');
      expect(model.getSnapshot().updatedAt).toBe(0);
      expect(store.save).not.toHaveBeenCalled();
    } finally {
      model.dispose();
      current.destroy();
      vi.useRealTimers();
    }
  });
  it('abandons a delayed old capture after the user reviews and restores a newer copy', async () => {
    const current = await workspace('old capture'),
      newer = await workspace('newer recovery');
    const old = await captureRecovery(current, 'Draft'),
      fresh = await captureRecovery(newer, 'Draft');
    let release!: (value: ValidatedRecovery) => void;
    const capture = vi.fn(
      () =>
        new Promise<ValidatedRecovery>((resolve) => {
          release = resolve;
        }),
    );
    const policy = {
      account_id: id(1),
      epoch: id(9),
      retain: false,
      used_bytes: fresh.bytes,
      count: 1,
    };
    const store = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ policy, record: undefined })
        .mockResolvedValue({
          policy,
          record: {
            account_id: id(1),
            project_id: id(2),
            revision: 1,
            updated_at: Date.now(),
            bytes: fresh.bytes,
            data: fresh.data,
          },
        }),
      save: vi.fn(),
      retention: vi.fn(),
      remove: vi.fn(),
    };
    const model = new RecoveryController(
      current,
      () => 'Draft',
      store,
      capture,
    );
    model.start();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    model.retry();
    await vi.waitFor(() => expect(model.getSnapshot().phase).toBe('found'));
    model.restore();
    release(old);
    await vi.waitFor(() => expect(model.getSnapshot().phase).toBe('ready'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.save).not.toHaveBeenCalled();
    expect(current.file(id(3))!.text.toString()).toBe('newer recovery');
    model.dispose();
    current.destroy();
    newer.destroy();
  });
});

it.each([false, true])(
  'a delayed local-draft lookup preserves new typing (competing record: %s)',
  async (competing) => {
    const current = await workspace('opened source', 'local_draft');
    const opened = await captureRecovery(current, 'Draft');
    const other = await workspace('other tab source', 'local_draft');
    const found = competing ? await captureRecovery(other, 'Draft') : opened;
    const record = {
      account_id: id(1),
      project_id: id(2),
      revision: 1,
      updated_at: Date.now(),
      bytes: found.bytes,
      data: found.data,
    };
    const scope = {
      policy: {
        account_id: id(1),
        epoch: id(9),
        retain: false,
        used_bytes: found.bytes,
        count: 1,
      },
      record,
    };
    let release!: (value: typeof scope) => void;
    const store = {
      read: () =>
        new Promise<typeof scope>((resolve) => {
          release = resolve;
        }),
      save: vi.fn(
        async (
          _account: string,
          _project: string,
          _epoch: string,
          expected: number,
          recovery: ValidatedRecovery,
        ) => ({
          ...record,
          revision: expected + 1,
          data: recovery.data,
          bytes: recovery.bytes,
        }),
      ),
      retention: vi.fn(),
      remove: vi.fn(),
    };
    const model = new RecoveryController(
      current,
      () => 'Draft',
      store,
      undefined,
      opened,
    );
    model.start();
    current.replaceSource(id(3), 'typed while opening');
    release(scope);
    if (competing) {
      await vi.waitFor(() => expect(model.getSnapshot().phase).toBe('found'));
      expect(store.save).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce());
      const written = store.save.mock.calls[0]![4];
      expect(written.sources.get(id(3))).toBe('typed while opening');
      expect(model.getSnapshot().found).toBeNull();
    }
    expect(current.file(id(3))!.text.toString()).toBe('typed while opening');
    model.dispose();
    current.destroy();
    other.destroy();
  },
);
