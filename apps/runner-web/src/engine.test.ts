import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureRunManifest,
  RUN_LIMITS,
} from '@code-along/contracts/execution';
import { ExecutionSupervisor, type EngineEvent } from './engine.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage = vi.fn();
  terminate() {
    this.terminated = true;
  }
  send(runId: string, body: Record<string, unknown>) {
    this.onmessage?.({
      data: { run_id: runId, ...body },
    } as MessageEvent<unknown>);
  }
}
async function fixture() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  const manifest = await captureRunManifest(
    [
      {
        document_id: id(1),
        generation: 1,
        path: 'main.py',
        source: 'print(42)',
      },
    ],
    'main.py',
    1,
  );
  const events: { id: string; body: EngineEvent }[] = [];
  const supervisor = new ExecutionSupervisor((id, body) =>
    events.push({ id, body }),
  );
  return { supervisor, manifest, events };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('shared trusted Worker supervisor', () => {
  it('reserves startup synchronously and honors cancel/disposal while hashing', async () => {
    const f = await fixture();
    const pending = f.supervisor.handle({
      type: 'run',
      run_id: id(2),
      manifest: f.manifest,
      stdin: [],
    });
    await f.supervisor.handle({
      type: 'run',
      run_id: id(3),
      manifest: f.manifest,
      stdin: [],
    });
    await f.supervisor.handle({ type: 'cancel', run_id: id(2) });
    await pending;
    expect(FakeWorker.instances).toHaveLength(0);
    expect(f.events.filter((event) => event.body.type === 'terminal')).toEqual([
      { id: id(2), body: expect.objectContaining({ status: 'cancelled' }) },
    ]);
    f.supervisor.destroy();
    await f.supervisor.handle({
      type: 'run',
      run_id: id(4),
      manifest: f.manifest,
      stdin: [],
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('terminates on output overflow and ignores the replaced Worker’s late result', async () => {
    const f = await fixture();
    await f.supervisor.handle({
      type: 'run',
      run_id: id(2),
      manifest: f.manifest,
      stdin: [],
    });
    const worker = FakeWorker.instances[0]!;
    worker.send(id(2), { type: 'ready' });
    for (let n = 0; n <= RUN_LIMITS.outputBytes / 8192; n++)
      worker.send(id(2), {
        type: 'output',
        stream: 'stdout',
        text: 'x'.repeat(8192),
      });
    worker.send(id(2), { type: 'done', status: 'succeeded' });
    expect(worker.terminated).toBe(true);
    expect(
      f.events.filter((event) => event.body.type === 'terminal'),
    ).toHaveLength(1);
    expect(f.events.at(-1)?.body).toMatchObject({
      type: 'terminal',
      status: 'output_limit',
    });
    await f.supervisor.handle({
      type: 'run',
      run_id: id(3),
      manifest: f.manifest,
      stdin: [],
    });
    expect(FakeWorker.instances).toHaveLength(2);
    worker.send(id(2), { type: 'done', status: 'succeeded' });
    expect(
      f.events.filter((event) => event.body.type === 'terminal'),
    ).toHaveLength(1);
    f.supervisor.destroy();
  });
  it('keeps the wall clock outside Python and emits exactly one terminal on timeout', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    await f.supervisor.handle({
      type: 'run',
      run_id: id(2),
      manifest: f.manifest,
      stdin: [],
    });
    const worker = FakeWorker.instances[0]!;
    worker.send(id(2), { type: 'ready' });
    vi.advanceTimersByTime(RUN_LIMITS.wallMs);
    worker.send(id(2), { type: 'done', status: 'succeeded' });
    expect(worker.terminated).toBe(true);
    expect(
      f.events.filter((event) => event.body.type === 'terminal'),
    ).toHaveLength(1);
    expect(f.events.at(-1)?.body).toMatchObject({ status: 'timed_out' });
    f.supervisor.destroy();
  });
  it('fails closed when product manifest verification or the digest service fails', async () => {
    const f = await fixture();
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(
      new Error('unavailable'),
    );
    await f.supervisor.handle({
      type: 'run',
      run_id: id(2),
      manifest: f.manifest,
      stdin: [],
    });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(f.events.at(-1)?.body).toMatchObject({ status: 'failed' });
    f.supervisor.destroy();
  });
});
