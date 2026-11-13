import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  RUNNER_PROTOCOL,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import type {
  ProductRunnerEvent,
  ProductRunnerReady,
} from '@code-along/contracts/execution/product-runner';
import type { ProjectRunManifest } from '@code-along/contracts/execution/project';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import { ExecutionController } from './controller.ts';
import { checkedRunnerOrigin, type RunnerBridge } from './bridge.ts';
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
  workspace.reconcile(
    {
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
    },
    [file],
  );
  await workspace.loadSource(file);
  const sessions: {
    emit: (value: ProductRunnerEvent) => void;
    fault: (message: string) => void;
    bridge: RunnerBridge;
    runId: string;
    manifest: ProjectRunManifest | null;
  }[] = [];
  const controller = new ExecutionController(workspace, (emit, fault) => {
    const session = {
      emit,
      fault,
      runId: '',
      manifest: null as ProjectRunManifest | null,
      bridge: {} as RunnerBridge,
    };
    session.bridge = {
      start: vi.fn(
        async (
          runId: string,
          manifest: ProjectRunManifest,
        ): Promise<ProductRunnerReady> => {
          session.runId = runId;
          session.manifest = manifest;
          return {
            protocol: RUNNER_PROTOCOL,
            version: 2,
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
      protocol: RUNNER_PROTOCOL,
      version: 2,
      session_nonce: id(90),
      run_id: sessions[index]!.runId,
      ...body,
    } as ProductRunnerEvent);
  const finish = (index = 0) =>
    event(index, {
      type: 'terminal',
      status: 'succeeded',
      manifest_sha256: sessions[index]!.manifest!.sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    });
  return { workspace, controller, sessions, event, finish };
}
afterEach(() => vi.useRealTimers());
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
