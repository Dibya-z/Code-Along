import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  RUNTIME_ID,
  RUN_LIMITS,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import type { Project } from '../../projects/types.ts';
import { EditorWorkspace, type FileSource } from './workspace.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const createState = (source: string) =>
  EditorState.create({
    doc: source,
    extensions: [EditorState.lineSeparator.of('\n')],
  });
async function fixture(count = 2) {
  const files: FileSource[] = await Promise.all(
    Array.from({ length: count }, async (_, n) => {
      const source = n === 0 ? 'print("hello")\n' : 'answer = 42\n';
      return {
        id: id(n + 1),
        document_id: id(n + 101),
        generation: 1,
        path: n === 0 ? 'main.py' : `helper${n}.py`,
        kind: 'python' as const,
        initial_source: source,
        initial_sha256: await sha256(sourceBytes(source)),
      };
    }),
  );
  const project: Project = {
    id: id(900),
    name: 'Learning project',
    owner_id: id(800),
    workspace_id: id(700),
    role: 'owner',
    archived: false,
    workspace_archived: false,
    acl_version: '1',
    metadata_version: 1,
    entrypoint_file_id: files[0]!.id,
    entrypoint_path: 'main.py',
    runtime_id: RUNTIME_ID,
    runtime_profile_id: id(600),
  };
  const workspace = new EditorWorkspace(id(800), project.id);
  workspace.reconcile(project, files);
  return { workspace, files, project };
}

describe('canonical editor workspace', () => {
  it('loads each immutable starter exactly once even when responses race', async () => {
    const { workspace, files } = await fixture();
    const source = files[0]!;
    const loaded = await Promise.all([
      workspace.loadSource(source),
      workspace.loadSource(source),
    ]);
    // Digest completion order is unspecified; exactly one response may seed.
    expect(loaded.sort()).toEqual([false, true]);
    expect(workspace.file(source.id)?.text.toString()).toBe(
      source.initial_source,
    );
    expect(workspace.file(source.id)?.dirty).toBe(false);
    expect(workspace.getSnapshot().files[0]).not.toHaveProperty(
      'initial_source',
    );
    workspace.destroy();
  });

  it('preserves edits, undo and cached editor selection across metadata refresh/rename', async () => {
    const { workspace, files, project } = await fixture();
    const source = files[0]!;
    await workspace.loadSource(source);
    const document = workspace.file(source.id)!;
    workspace.replaceSource(source.id, 'print("my edit")\n');
    const state = document.controller
      .state(createState)
      .update({ selection: { anchor: 3 } }).state;
    document.controller.remember(state);
    const renamed = { ...source, path: 'lessons/start.py' };
    workspace.reconcile({ ...project, metadata_version: 2 }, [
      renamed,
      files[1]!,
    ]);
    expect(workspace.file(source.id)).toBe(document);
    expect(document.metadata.path).toBe('lessons/start.py');
    expect(document.controller.state(createState)).toBe(state);
    expect(document.controller.state(createState).selection.main.anchor).toBe(
      3,
    );
    expect(await workspace.loadSource(source)).toBe(false);
    expect(document.text.toString()).toBe('print("my edit")\n');
    document.undo.undo();
    expect(document.text.toString()).toBe(source.initial_source);
    expect(document.dirty).toBe(false);
    workspace.destroy();
  });

  it('updates inactive editor text from Y.Text without recreating the controller', async () => {
    const { workspace, files } = await fixture();
    await workspace.loadSource(files[0]!);
    const document = workspace.file(files[0]!.id)!;
    let calls = 0;
    const create = (source: string) => {
      calls++;
      return createState(source);
    };
    document.controller.state(create);
    workspace.replaceSource(files[0]!.id, 'value = "雪"\r\nprint(value)\r\n');
    expect(document.controller.state(create).doc.toString()).toBe(
      document.text.toString(),
    );
    expect(calls).toBe(1);
    workspace.destroy();
  });

  it('retains exact CRLF and rejects editor configuration that normalizes source', async () => {
    const { workspace, files } = await fixture();
    await workspace.loadSource(files[0]!);
    workspace.replaceSource(files[0]!.id, 'x = 1\r\nprint(x)\r\n');
    const document = workspace.file(files[0]!.id)!;
    expect(() =>
      document.controller.state((source) =>
        EditorState.create({ doc: source }),
      ),
    ).toThrow('preserve the exact source');
    expect(document.controller.state(createState).doc.toString()).toBe(
      document.text.toString(),
    );
    workspace.destroy();
  });

  it('does not reset per-file undo or structural React snapshots on every keystroke', async () => {
    const { workspace, files } = await fixture();
    await workspace.loadSource(files[0]!);
    await workspace.loadSource(files[1]!);
    workspace.replaceSource(files[0]!.id, 'first edit');
    const snapshot = workspace.getSnapshot(),
      revision = workspace.sourceRevision;
    workspace.replaceSource(files[0]!.id, 'second edit');
    expect(workspace.getSnapshot()).toBe(snapshot);
    expect(workspace.sourceRevision).toBe(revision + 1);
    workspace.replaceSource(files[1]!.id, 'other file edit');
    workspace.file(files[0]!.id)!.undo.undo();
    expect(workspace.file(files[0]!.id)!.text.toString()).toBe('first edit');
    expect(workspace.file(files[1]!.id)!.text.toString()).toBe(
      'other file edit',
    );
    workspace.destroy();
  });

  it('rejects stale metadata without rolling back local identity or permissions', async () => {
    const { workspace, files, project } = await fixture();
    workspace.reconcile(
      { ...project, metadata_version: 3, role: 'viewer' },
      files,
    );
    expect(workspace.reconcile(project, files)).toBe(false);
    expect(workspace.getSnapshot().writable).toBe(false);
    workspace.destroy();
  });

  it('rejects incomplete, duplicate, missing-entrypoint and wrong-project lists atomically', async () => {
    const { workspace, files, project } = await fixture();
    const document = workspace.file(files[0]!.id);
    expect(() => workspace.reconcile(project, [files[0]!], 2)).toThrow(
      'complete project',
    );
    expect(() => workspace.reconcile(project, [files[0]!, files[0]!])).toThrow(
      'duplicate',
    );
    expect(() =>
      workspace.reconcile({ ...project, entrypoint_file_id: id(999) }, files),
    ).toThrow('entrypoint');
    expect(() =>
      workspace.reconcile({ ...project, id: id(999) }, files),
    ).toThrow('identity');
    expect(workspace.file(files[0]!.id)).toBe(document);
    expect(document?.disposed).toBe(false);
    workspace.destroy();
  });

  it('disposes removed/replaced generations and rejects late source responses', async () => {
    const { workspace, files, project } = await fixture();
    const old = workspace.file(files[0]!.id)!;
    const inFlight = workspace.loadSource(files[0]!);
    const replacement = { ...files[0]!, generation: 2 };
    workspace.reconcile({ ...project, metadata_version: 2 }, [replacement]);
    expect(await inFlight).toBe(false);
    expect(old.disposed).toBe(true);
    expect(workspace.file(files[1]!.id)).toBeUndefined();
    expect(await workspace.loadSource(files[0]!)).toBe(false);
    expect(await workspace.loadSource(replacement)).toBe(true);
    expect(() => old.controller.state(createState)).toThrow('no longer active');
    workspace.destroy();
  });

  it('rejects a changed immutable starter hash in the same generation', async () => {
    const { workspace, files, project } = await fixture();
    expect(() =>
      workspace.reconcile({ ...project, metadata_version: 2 }, [
        { ...files[0]!, initial_sha256: 'f'.repeat(64) },
        files[1]!,
      ]),
    ).toThrow('Immutable starter');
    workspace.destroy();
  });

  it('checks source integrity/UTF-8/budgets before installing any content', async () => {
    const { workspace, files } = await fixture();
    await expect(
      workspace.loadSource({ ...files[0]!, initial_source: 'tampered' }),
    ).rejects.toThrow('integrity');
    await expect(
      workspace.loadSource({ ...files[0]!, initial_source: '\ud800' }),
    ).rejects.toThrow('invalid_source');
    await expect(
      workspace.loadSource({
        ...files[0]!,
        initial_source: 'x'.repeat(RUN_LIMITS.fileBytes + 1),
      }),
    ).rejects.toThrow('size');
    expect(workspace.file(files[0]!.id)?.loaded).toBe(false);
    expect(workspace.file(files[0]!.id)?.text.length).toBe(0);
    workspace.destroy();
  });

  it('freezes edits after viewer/archive transitions while retaining the local buffer', async () => {
    const { workspace, files, project } = await fixture();
    await workspace.loadSource(files[0]!);
    workspace.replaceSource(files[0]!.id, 'my draft');
    const document = workspace.file(files[0]!.id)!;
    for (const policy of [
      { role: 'viewer' as const },
      { archived: true },
      { workspace_archived: true },
    ]) {
      workspace.reconcile({ ...project, ...policy }, files);
      expect(() =>
        workspace.replaceSource(files[0]!.id, 'must not apply'),
      ).toThrow('read-only');
      expect(document.text.toString()).toBe('my draft');
    }
    workspace.destroy();
  });

  it('isolates two account workbenches and releases all documents on destruction', async () => {
    const { workspace, files, project } = await fixture();
    const other = new EditorWorkspace(id(801), project.id);
    other.reconcile(project, files);
    await workspace.loadSource(files[0]!);
    await other.loadSource(files[0]!);
    workspace.replaceSource(files[0]!.id, 'private draft');
    expect(other.file(files[0]!.id)?.text.toString()).toBe(
      files[0]!.initial_source,
    );
    const document = workspace.file(files[0]!.id)!;
    workspace.destroy();
    expect(document.disposed).toBe(true);
    expect(workspace.documents()).toEqual([]);
    expect(await workspace.loadSource(files[0]!)).toBe(false);
    expect(() => workspace.reconcile(project, files)).toThrow('closed');
    other.destroy();
  });
});
