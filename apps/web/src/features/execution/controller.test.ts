import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
} from '@code-along/contracts/execution/profiles';
import {
  RUNNER_PROTOCOL,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import {
  PRACTICE_PROTOCOL,
  REVIEWED_HELPER_RELEASE,
  capturePublicChecksManifest,
  type PracticeManifest,
} from '@code-along/contracts/execution/practice';
import type { ProjectRunManifest } from '@code-along/contracts/execution/project';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import { ExecutionController } from './controller.ts';
import {
  checkedRunnerOrigin,
  type RunnerBridge,
  type ExecutionEvent,
  type ExecutionKind,
  type ExecutionReady,
} from './bridge.ts';
import type { WorkPracticeInput } from './practice.ts';
import type { Project } from '../projects/types.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const workspace = new EditorWorkspace(id(1), id(2));
  const file = {
    id: id(3),
    document_id: id(4),
    generation: 1,
    path: 'main.py',
    kind: 'python' as const,
    initial_source: 'print(42)',
    initial_sha256: await sha256(sourceBytes('print(42)')),
  };
  const project: Project = {
    id: id(2),
    owner_id: id(1),
    workspace_id: id(5),
    name: 'Run',
    metadata_version: 1,
    acl_version: '1',
    role: 'owner',
    archived: false,
    workspace_archived: false,
    entrypoint_file_id: file.id,
    entrypoint_path: file.path,
    runtime_id: CORE_RUNTIME.runtime_id,
    runtime_profile_id: id(6),
  };
  workspace.reconcile(project, [file]);
  await workspace.loadSource(file);
  const sessions: {
    emit: (value: ExecutionEvent) => void;
    fault: (message: string) => void;
    bridge: RunnerBridge;
    runId: string;
    manifest: ProjectRunManifest | null;
    practice: PracticeManifest | null;
    kind: ExecutionKind;
  }[] = [];
  const controller = new ExecutionController(workspace, (emit, fault, kind) => {
    const session = {
      emit,
      fault,
      runId: '',
      manifest: null as ProjectRunManifest | null,
      practice: null as PracticeManifest | null,
      kind,
      bridge: {} as RunnerBridge,
    };
    session.bridge = {
      start: vi.fn(
        async (
          runId: string,
          manifest: ProjectRunManifest,
          _stdin: readonly string[],
          practice?: PracticeManifest,
        ): Promise<ExecutionReady> => {
          session.runId = runId;
          session.manifest = manifest;
          session.practice = practice ?? null;
          const envelope =
            kind === 'practice'
              ? ({ protocol: PRACTICE_PROTOCOL, version: 1 } as const)
              : ({ protocol: RUNNER_PROTOCOL, version: 2 } as const);
          return {
            ...envelope,
            type: 'ready',
            session_nonce: id(90),
            interactive: false,
            cross_origin_isolated: false,
          };
        },
      ),
      input: vi.fn(),
      cancel: vi.fn(),
      destroy: vi.fn(),
    };
    sessions.push(session);
    return session.bridge;
  });
  const event = (index: number, body: Record<string, unknown>) =>
    sessions[index]!.emit({
      protocol:
        sessions[index]!.kind === 'practice'
          ? PRACTICE_PROTOCOL
          : RUNNER_PROTOCOL,
      version: sessions[index]!.kind === 'practice' ? 1 : 2,
      session_nonce: id(90),
      run_id: sessions[index]!.runId,
      ...body,
    } as ExecutionEvent);
  const finish = (index = 0) =>
    event(index, {
      type: 'terminal',
      status: 'succeeded',
      ...(sessions[index]!.practice
        ? {
            source_manifest_sha256: sessions[index]!.manifest!.sha256,
            practice_manifest_sha256: sessions[index]!.practice!.sha256,
            checks_sha256: sessions[index]!.practice!.checks.sha256,
            helper_release_sha256:
              sessions[index]!.practice!.helper_release.source_sha256,
          }
        : { manifest_sha256: sessions[index]!.manifest!.sha256 }),
      runtime_id: CORE_RUNTIME.runtime_id,
    });
  return { workspace, controller, sessions, event, finish, project, file };
}
afterEach(() => vi.useRealTimers());
async function checksInput(): Promise<WorkPracticeInput> {
  const checks = await capturePublicChecksManifest(
    'import main\nassert main.answer == 42\n',
  );
  return {
    project_id: id(2),
    assignment_id: id(200),
    assignment_version_id: id(201),
    assignment_content_sha256: 'a'.repeat(64),
    runtime: CORE_RUNTIME,
    helper_release: REVIEWED_HELPER_RELEASE,
    published_checks_sha256: checks.sha256,
    checks_source: checks.source,
    check_origin: 'published',
  };
}
describe('product execution state', () => {
  it('caps empty output packets and keeps repeated Stop/late events terminal exactly once', async () => {
    const f = await fixture();
    await f.controller.run();
    const phases: string[] = [];
    const unsubscribe = f.controller.subscribe(() =>
      phases.push(f.controller.getSnapshot().phase),
    );
    f.controller.stop();
    f.controller.stop();
    f.event(0, { type: 'state', state: 'running' });
    expect(phases.filter((phase) => phase === 'cancelled')).toHaveLength(1);
    await f.controller.run();
    for (let sequence = 0; sequence < 4098; sequence++)
      f.event(1, { type: 'output', stream: 'stdout', text: '', sequence });
    f.finish(1);
    expect(f.controller.getSnapshot().phase).toBe('output_limit');
    expect(phases.filter((phase) => phase === 'output_limit')).toHaveLength(1);
    unsubscribe();
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('admits input once only while waiting and records interactive mode in the capture', async () => {
    const f = await fixture();
    await f.controller.run([], undefined, 'interactive');
    expect(f.sessions[0]!.manifest!.stdin_mode).toBe('interactive');
    expect(f.controller.input('early')).toBe(false);
    f.event(0, { type: 'state', state: 'waiting_for_input' });
    expect(f.controller.input('🐍'.repeat(2000))).toBe(false);
    expect(f.controller.input('River')).toBe(true);
    expect(f.controller.input('double')).toBe(false);
    expect(f.sessions[0]!.bridge.input).toHaveBeenCalledExactlyOnceWith(
      'River',
    );
    f.event(0, { type: 'state', state: 'waiting_for_input' });
    expect(f.controller.input(null)).toBe(true);
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('retains sequence and raw byte budgets after clearing displayed output', async () => {
    const f = await fixture();
    await f.controller.run();
    for (let sequence = 0; sequence < 128; sequence++)
      f.event(0, {
        type: 'output',
        stream: 'stdout',
        text: 'a'.repeat(8192),
        sequence,
      });
    f.controller.clearOutput();
    f.event(0, { type: 'output', stream: 'stdout', text: 'b', sequence: 128 });
    expect(f.controller.getSnapshot().phase).toBe('output_limit');
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('reuses an idle successful connection while rejecting packets from earlier run IDs', async () => {
    const f = await fixture();
    await f.controller.run();
    const oldId = f.sessions[0]!.runId,
      oldManifest = f.sessions[0]!.manifest!;
    f.finish();
    expect(f.sessions[0]!.bridge.destroy).not.toHaveBeenCalled();
    await f.controller.run();
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.bridge.start).toHaveBeenCalledTimes(2);
    f.sessions[0]!.emit({
      protocol: RUNNER_PROTOCOL,
      version: 2,
      session_nonce: id(90),
      run_id: oldId,
      type: 'output',
      stream: 'stdout',
      text: 'late',
      sequence: 0,
    });
    f.sessions[0]!.emit({
      protocol: RUNNER_PROTOCOL,
      version: 2,
      session_nonce: id(90),
      run_id: oldId,
      type: 'terminal',
      status: 'succeeded',
      manifest_sha256: oldManifest.sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    });
    expect(f.controller.getSnapshot().phase).toBe('initializing');
    expect(f.controller.getSnapshot().output).toEqual([]);
    f.finish();
    f.controller.destroy();
    expect(f.sessions[0]!.bridge.destroy).toHaveBeenCalledOnce();
    f.workspace.destroy();
  });
  it.each([false, true])(
    'drops a faulted connection and ignores its late callback (active: %s)',
    async (active) => {
      const f = await fixture();
      await f.controller.run();
      f.finish();
      if (active) await f.controller.run();
      f.sessions[0]!.fault('connection lost');
      expect(f.controller.getSnapshot().phase).toBe(
        active ? 'failed' : 'succeeded',
      );
      expect(f.sessions[0]!.bridge.destroy).toHaveBeenCalledOnce();
      await f.controller.run();
      expect(f.sessions).toHaveLength(2);
      f.sessions[0]!.fault('late connection fault');
      expect(f.controller.getSnapshot().phase).toBe('initializing');
      f.controller.stop();
      expect(f.sessions[1]!.bridge.destroy).toHaveBeenCalledOnce();
      f.controller.destroy();
      f.workspace.destroy();
    },
  );
  it('keeps a shell-confirmed failed run reusable but reports a worker that produced no output', async () => {
    const f = await fixture();
    await f.controller.run();
    f.event(0, {
      type: 'terminal',
      status: 'failed',
      manifest_sha256: f.sessions[0]!.manifest!.sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    });
    expect(f.controller.getSnapshot().phase).toBe('failed');
    expect(f.controller.getSnapshot().error).toContain(
      'Python could not start',
    );
    expect(f.sessions[0]!.bridge.destroy).not.toHaveBeenCalled();
    await f.controller.run();
    expect(f.sessions).toHaveLength(1);
    f.finish();
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('rotates successful connections before the supervisor replay-ID budget is exhausted', async () => {
    const f = await fixture();
    for (let run = 0; run < 91; run++) {
      await f.controller.run();
      f.finish(f.sessions.length - 1);
    }
    expect(f.sessions).toHaveLength(2);
    expect(f.sessions[0]!.bridge.start).toHaveBeenCalledTimes(90);
    expect(f.sessions[0]!.bridge.destroy).toHaveBeenCalledOnce();
    expect(f.sessions[1]!.bridge.start).toHaveBeenCalledOnce();
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('does not admit a run cancelled during snapshot hashing or another start while busy', async () => {
    const f = await fixture();
    const pending = f.controller.run();
    await f.controller.run();
    f.controller.stop();
    await pending;
    expect(f.sessions).toHaveLength(0);
    expect(f.controller.getSnapshot().phase).toBe('cancelled');
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('marks earlier source without replacing the captured manifest and fails on output gaps', async () => {
    const f = await fixture();
    await f.controller.run();
    const captured = f.controller.getSnapshot().captured;
    f.workspace.replaceSource(id(3), 'print("later")');
    expect(f.controller.getSnapshot().earlierSource).toBe(true);
    expect(f.controller.getSnapshot().captured).toBe(captured);
    f.event(0, {
      type: 'output',
      stream: 'stdout',
      text: 'missing first packet',
      sequence: 1,
    });
    expect(f.controller.getSnapshot().phase).toBe('failed');
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('keeps one terminal state, rejects mismatched manifests and closes resources on disposal', async () => {
    const f = await fixture();
    await f.controller.run();
    f.event(0, {
      type: 'terminal',
      status: 'succeeded',
      manifest_sha256: '0'.repeat(64),
      runtime_id: CORE_RUNTIME.runtime_id,
    });
    expect(f.controller.getSnapshot().phase).toBe('failed');
    f.finish();
    expect(f.controller.getSnapshot().phase).toBe('failed');
    await f.controller.run();
    f.controller.destroy();
    expect(f.sessions[1]!.bridge.destroy).toHaveBeenCalledOnce();
    f.event(1, { type: 'state', state: 'running' });
    f.workspace.destroy();
  });
  it('stops a lost runtime using the independent parent deadline', async () => {
    const f = await fixture();
    await f.controller.run();
    vi.useFakeTimers();
    // A new run creates its parent deadline under the fake clock.
    f.controller.stop();
    await f.controller.run();
    vi.advanceTimersByTime(75_000);
    expect(f.controller.getSnapshot().phase).toBe('timed_out');
    expect(f.sessions[1]!.bridge.destroy).toHaveBeenCalledOnce();
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('requires an exact separate HTTPS hostname rather than another port on the app host', () => {
    expect(
      checkedRunnerOrigin('https://localhost:18443', 'https://127.0.0.1:18443'),
    ).toBe('https://localhost:18443');
    for (const raw of [
      'http://localhost:18443',
      'https://127.0.0.1:9443',
      'https://localhost:18443/',
      'https://user@localhost:18443',
    ])
      expect(() =>
        checkedRunnerOrigin(raw, 'https://127.0.0.1:18443'),
      ).toThrow();
  });
});
describe('visible check execution through the retained controller', () => {
  it('pins a no-check task run to A without changing its ordinary source wire', async () => {
    const f = await fixture();
    const task = { ...(await checksInput()) };
    const pending = f.controller.run([], CORE_RUNTIME, 'batch', task);
    task.assignment_version_id = id(202);
    await pending;
    expect(f.sessions[0]!.kind).toBe('product');
    expect(f.sessions[0]!.practice).toBeNull();
    expect(f.controller.getSnapshot()).toMatchObject({
      kind: 'product',
      practice: null,
      task: { assignment_version_id: id(201), runtime: CORE_RUNTIME },
      captured: { manifest: { runtime: CORE_RUNTIME } },
    });
    f.finish();
    await f.controller.run(
      [],
      SCIENTIFIC_RUNTIME,
      'batch',
      await checksInput(),
    );
    expect(f.controller.getSnapshot().error).toContain('published version');
    expect(f.sessions).toHaveLength(1);
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('freezes source H, pinned A and checks before hashing while later edits remain distinct', async () => {
    const f = await fixture();
    const input = { ...(await checksInput()) };
    const original = { ...input };
    const pending = f.controller.runChecks(input, [], 'interactive');
    input.assignment_version_id = id(202);
    input.checks_source = 'raise RuntimeError("later copy")';
    input.check_origin = 'local_practice';
    input.published_checks_sha256 = 'f'.repeat(64);
    f.workspace.replaceSource(f.file.id, 'print("later source")');
    f.workspace.reconcile(
      { ...f.project, metadata_version: 2, entrypoint_path: 'renamed.py' },
      [{ ...f.file, path: 'renamed.py' }],
    );
    await pending;
    const snapshot = f.controller.getSnapshot();
    expect(snapshot.practice).toMatchObject({
      assignment_version_id: original.assignment_version_id,
      published_checks_sha256: original.published_checks_sha256,
      check_origin: 'published',
      checks: { source: original.checks_source },
      source: {
        metadata_version: 1,
        stdin_mode: 'interactive',
        files: [{ path: 'main.py', source: 'print(42)' }],
      },
    });
    expect(snapshot.captured?.manifest).toBe(snapshot.practice?.source);
    expect(snapshot.earlierSource).toBe(true);
    expect(f.sessions[0]!.kind).toBe('practice');
    expect(f.sessions[0]!.practice).toBe(snapshot.practice);
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('uses one busy guard and releases the fixed protocol connection in both directions', async () => {
    const f = await fixture();
    const input = await checksInput();
    await f.controller.run();
    f.finish();
    const pending = f.controller.runChecks(input);
    await f.controller.run();
    await f.controller.runChecks(input);
    await pending;
    expect(f.sessions).toHaveLength(2);
    expect(f.sessions[0]!.bridge.destroy).toHaveBeenCalledOnce();
    expect(f.sessions[1]!.kind).toBe('practice');
    const practice = f.sessions[1]!.practice!;
    f.sessions[0]!.emit({
      protocol: PRACTICE_PROTOCOL,
      version: 1,
      session_nonce: id(90),
      run_id: f.sessions[1]!.runId,
      type: 'terminal',
      status: 'succeeded',
      source_manifest_sha256: practice.source.sha256,
      practice_manifest_sha256: practice.sha256,
      checks_sha256: practice.checks.sha256,
      helper_release_sha256: practice.helper_release.source_sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    });
    expect(f.controller.getSnapshot().phase).toBe('initializing');
    f.finish(1);
    expect(f.controller.getSnapshot().phase).toBe('succeeded');
    await f.controller.run();
    expect(f.sessions).toHaveLength(3);
    expect(f.sessions[1]!.bridge.destroy).toHaveBeenCalledOnce();
    expect(f.sessions[2]!.kind).toBe('product');
    expect(f.controller.getSnapshot().practice).toBeNull();
    f.sessions[1]!.fault('old practice connection');
    expect(f.controller.getSnapshot().phase).toBe('initializing');
    f.controller.destroy();
    f.workspace.destroy();
  });
  it.each(['stop', 'destroy'] as const)(
    'never starts a checks bridge after %s during capture',
    async (action) => {
      const f = await fixture();
      const input = await checksInput();
      const pending = f.controller.runChecks(input);
      f.controller[action]();
      await pending;
      expect(f.sessions).toHaveLength(0);
      f.controller.destroy();
      f.workspace.destroy();
    },
  );
  it.each([
    'source_manifest_sha256',
    'practice_manifest_sha256',
    'checks_sha256',
    'helper_release_sha256',
    'runtime_id',
    'missing-field',
    'ordinary-wire',
  ])(
    'rejects a mismatched or malformed practice terminal (%s)',
    async (field) => {
      const f = await fixture();
      await f.controller.runChecks(await checksInput());
      const session = f.sessions[0]!,
        practice = session.practice!;
      const terminal: Record<string, unknown> = {
        type: 'terminal',
        status: 'succeeded',
        source_manifest_sha256: practice.source.sha256,
        practice_manifest_sha256: practice.sha256,
        checks_sha256: practice.checks.sha256,
        helper_release_sha256: practice.helper_release.source_sha256,
        runtime_id: CORE_RUNTIME.runtime_id,
      };
      if (field === 'missing-field')
        delete terminal['practice_manifest_sha256'];
      else if (field === 'ordinary-wire')
        Object.assign(terminal, {
          protocol: RUNNER_PROTOCOL,
          version: 2,
          manifest_sha256: practice.source.sha256,
        });
      else terminal[field] = 'f'.repeat(64);
      f.event(0, terminal);
      expect(f.controller.getSnapshot().phase).toBe('failed');
      expect(session.bridge.destroy).toHaveBeenCalledOnce();
      f.controller.destroy();
      f.workspace.destroy();
    },
  );
  it('refuses a different work project or a changed runtime without relabeling its capture', async () => {
    const f = await fixture();
    const input = await checksInput();
    await f.controller.runChecks({ ...input, project_id: id(700) });
    expect(f.controller.getSnapshot().error).toContain(
      'different work project',
    );
    f.workspace.reconcile(
      {
        ...f.project,
        runtime_id: SCIENTIFIC_RUNTIME.runtime_id,
        metadata_version: 2,
      },
      [f.file],
    );
    await f.controller.runChecks(input);
    expect(f.controller.getSnapshot().error).toContain(
      'different Python environments',
    );
    expect(f.sessions).toHaveLength(0);
    expect(f.controller.getSnapshot().captured).toBeNull();
    f.controller.destroy();
    f.workspace.destroy();
  });
  it('shares bounded interactive input and the same sequenced console with checks', async () => {
    const f = await fixture();
    await f.controller.runChecks(await checksInput(), [], 'interactive');
    f.event(0, { type: 'state', state: 'waiting_for_input' });
    expect(f.controller.input('River')).toBe(true);
    expect(f.controller.input('again')).toBe(false);
    f.event(0, {
      type: 'output',
      sequence: 0,
      stream: 'stdout',
      text: 'PASS is learner output\n',
    });
    f.finish();
    expect(f.controller.getSnapshot().phase).toBe('succeeded');
    expect(
      f.controller
        .getSnapshot()
        .output.map((line) => line.text)
        .join(''),
    ).toBe('PASS is learner output');
    expect(f.sessions[0]!.bridge.input).toHaveBeenCalledExactlyOnceWith(
      'River',
    );
    f.controller.destroy();
    f.workspace.destroy();
  });
});
