import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_LIMITS } from '@code-along/contracts/execution';
import { captureProjectManifest } from '@code-along/contracts/execution/project';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  PRACTICE_PROTOCOL,
  PRACTICE_VERSION,
  REVIEWED_HELPER_RELEASE,
  capturePracticeManifest,
  capturePublicChecksManifest,
  parsePracticeEvent,
  type PracticeManifest,
  type PracticeRunnerEvent,
} from '@code-along/contracts/execution/practice';
import { ExecutionSupervisor, type EngineEvent } from './engine.ts';
import { RuntimeAssetCache } from './asset-cache.ts';
import { PracticeRunnerSupervisor } from './supervisor.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;
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
async function fixture(fileCount = 1) {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  const checks = await capturePublicChecksManifest(
    'import main\nassert main.answer == 42\n',
  );
  const manifest = await capturePracticeManifest({
    assignment_id: id(1),
    assignment_version_id: id(2),
    assignment_content_sha256: 'a'.repeat(64),
    source: {
      project_id: id(3),
      source_kind: 'project',
      metadata_version: 1,
      entrypoint_file_id: id(100),
      runtime: CORE_RUNTIME,
      stdin_mode: 'batch',
      files: Array.from({ length: fileCount }, (_, n) => ({
        file_id: id(100 + n),
        document_id: id(200 + n),
        generation: 1,
        path: n === 0 ? 'main.py' : `module_${n}.py`,
        source: n === 0 ? 'answer = 42\r\n' : `value = ${n}\n`,
      })),
    },
    helper_release: REVIEWED_HELPER_RELEASE,
    published_checks_sha256: checks.sha256,
    checks_source: checks.source,
    check_origin: 'published',
  });
  const events: { id: string; body: EngineEvent }[] = [];
  const supervisor = new ExecutionSupervisor((runId, body) =>
    events.push({ id: runId, body }),
  );
  return { manifest, events, supervisor };
}
function run(
  f: Awaited<ReturnType<typeof fixture>>,
  runId = id(10),
  manifest = f.manifest,
) {
  return f.supervisor.handle({
    type: 'run',
    run_id: runId,
    manifest: manifest.source,
    practice: manifest,
    stdin: [],
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('practice on the shared supervised Worker boundary', () => {
  it('keeps twenty exact source files and sends checks separately without assignment authority', async () => {
    const f = await fixture(20);
    await run(f);
    expect(FakeWorker.instances).toHaveLength(1);
    const posted = FakeWorker.instances[0]!.postMessage.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(posted).sort()).toEqual([
      'checks_source',
      'input',
      'manifest',
      'run_id',
      'runtime_cache',
      'stdin',
    ]);
    expect(posted['manifest']).toEqual(f.manifest.source);
    expect(posted['manifest']).not.toBe(f.manifest.source);
    expect(posted['checks_source']).toBe(f.manifest.checks.source);
    expect(f.manifest.source.files).toHaveLength(20);
    expect(JSON.stringify(posted)).not.toContain(f.manifest.assignment_id);
    expect(JSON.stringify(posted)).not.toContain(
      f.manifest.assignment_version_id,
    );
    f.supervisor.destroy();
  });

  it('reports shell-owned terminal identities after termination even when the Worker forges them', async () => {
    const f = await fixture();
    const nonce = id(30),
      runId = id(10);
    const events: PracticeRunnerEvent[] = [];
    const ended: boolean[] = [];
    const supervisor = new PracticeRunnerSupervisor(nonce, (event) => {
      events.push(event);
      if (event.type === 'terminal')
        ended.push(FakeWorker.instances[0]!.terminated);
    });
    await supervisor.handle({
      protocol: PRACTICE_PROTOCOL,
      version: PRACTICE_VERSION,
      session_nonce: nonce,
      run_id: runId,
      type: 'run',
      manifest: f.manifest,
      stdin: [],
    });
    const worker = FakeWorker.instances[0]!;
    worker.send(runId, {
      type: 'done',
      status: 'succeeded',
      source_manifest_sha256: '0'.repeat(64),
      practice_manifest_sha256: '0'.repeat(64),
      checks_sha256: '0'.repeat(64),
      helper_release_sha256: '0'.repeat(64),
      runtime_id: 'forged',
    });
    const terminal = events.at(-1)!;
    expect(terminal).toEqual({
      protocol: PRACTICE_PROTOCOL,
      version: PRACTICE_VERSION,
      session_nonce: nonce,
      run_id: runId,
      type: 'terminal',
      status: 'succeeded',
      source_manifest_sha256: f.manifest.source.sha256,
      practice_manifest_sha256: f.manifest.sha256,
      checks_sha256: f.manifest.checks.sha256,
      helper_release_sha256: REVIEWED_HELPER_RELEASE.source_sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    });
    expect(parsePracticeEvent(terminal, nonce)).toEqual(terminal);
    expect(ended).toEqual([true]);
    worker.send(runId, { type: 'done', status: 'failed' });
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
    supervisor.destroy();
    f.supervisor.destroy();
  });

  it.each(['checks', 'practice', 'helper', 'published', 'source'] as const)(
    'rejects tampered %s before creating any Worker',
    async (field) => {
      const f = await fixture();
      const altered = structuredClone(f.manifest) as Mutable<PracticeManifest>;
      if (field === 'checks') altered.checks.source += '# changed\n';
      if (field === 'practice') altered.sha256 = '0'.repeat(64);
      if (field === 'helper')
        altered.helper_release.source_sha256 = '0'.repeat(64);
      if (field === 'published')
        altered.published_checks_sha256 = '0'.repeat(64);
      if (field === 'source') altered.source.files[0]!.source += '# changed\n';
      await run(f, id(10), altered);
      expect(FakeWorker.instances).toHaveLength(0);
      expect(
        f.events.filter((event) => event.body.type === 'terminal'),
      ).toEqual([
        { id: id(10), body: expect.objectContaining({ status: 'failed' }) },
      ]);
      f.supervisor.destroy();
    },
  );

  it('refuses an unverified second source object even when it claims the admitted source SHA', async () => {
    const f = await fixture();
    const separate = structuredClone(f.manifest.source) as Mutable<
      PracticeManifest['source']
    >;
    separate.files[0]!.source =
      'answer = 0 # forged identical claimed digest\n';
    await f.supervisor.handle({
      type: 'run',
      run_id: id(10),
      manifest: separate,
      practice: f.manifest,
      stdin: [],
    });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(f.events.at(-1)?.body).toMatchObject({
      type: 'terminal',
      status: 'failed',
    });
    f.supervisor.destroy();
  });

  it('owns source, check, helper and input bytes before the caller can mutate a pending verification', async () => {
    const f = await fixture();
    const mutable = structuredClone(f.manifest) as Mutable<PracticeManifest>;
    const stdin = ['original input'];
    const pending = f.supervisor.handle({
      type: 'run',
      run_id: id(10),
      manifest: mutable.source,
      practice: mutable,
      stdin,
    });
    mutable.source.files[0]!.source = 'later live H2\n';
    mutable.checks.source = 'raise RuntimeError("later checks")\n';
    mutable.helper_release.source_sha256 = '0'.repeat(64);
    mutable.assignment_version_id = id(999);
    stdin[0] = 'later input';
    await pending;
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({
      manifest: f.manifest.source,
      checks_source: f.manifest.checks.source,
      stdin: ['original input'],
    });
    worker.send(id(10), { type: 'done', status: 'succeeded' });
    expect(f.events.at(-1)?.body).toMatchObject({
      manifest_sha256: f.manifest.source.sha256,
      practice: {
        practice_manifest_sha256: f.manifest.sha256,
        helper_release_sha256: REVIEWED_HELPER_RELEASE.source_sha256,
      },
    });
    f.supervisor.destroy();
  });

  it('cancels during real pending digest verification without copying cache or touching the replacement run', async () => {
    const f = await fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release: (() => void) | undefined;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      (algorithm, bytes) =>
        new Promise((resolve, reject) => {
          release = () => {
            void digest(algorithm, bytes).then(resolve, reject);
          };
        }),
    );
    const copying = vi.spyOn(RuntimeAssetCache.prototype, 'copy');
    const pending = run(f);
    expect(release).toBeTypeOf('function');
    await f.supervisor.handle({ type: 'cancel', run_id: id(10) });
    await run(f, id(11));
    expect(copying).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(1);
    release!();
    await pending;
    expect(copying).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(
      f.events.filter(
        (event) => event.id === id(10) && event.body.type === 'terminal',
      ),
    ).toEqual([
      { id: id(10), body: expect.objectContaining({ status: 'cancelled' }) },
    ]);
    FakeWorker.instances[0]!.send(id(11), {
      type: 'done',
      status: 'succeeded',
    });
    expect(f.events.at(-1)?.id).toBe(id(11));
    f.supervisor.destroy();
  });

  it('turns a cache-copy exception into one failed terminal without an unhandled rejection', async () => {
    const f = await fixture();
    vi.spyOn(RuntimeAssetCache.prototype, 'copy').mockRejectedValue(
      new Error('cache unavailable'),
    );
    await expect(run(f)).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(f.events.filter((event) => event.body.type === 'terminal')).toEqual([
      {
        id: id(10),
        body: expect.objectContaining({
          status: 'failed',
          practice: {
            practice_manifest_sha256: f.manifest.sha256,
            checks_sha256: f.manifest.checks.sha256,
            helper_release_sha256: REVIEWED_HELPER_RELEASE.source_sha256,
          },
        }),
      },
    ]);
    f.supervisor.destroy();
  });

  it('keeps output limits and stale Worker guards for practice with a fresh Worker after failure', async () => {
    const f = await fixture();
    await run(f);
    const worker = FakeWorker.instances[0]!;
    worker.send(id(10), { type: 'ready' });
    for (let n = 0; n <= RUN_LIMITS.outputBytes / 8192; n++)
      worker.send(id(10), {
        type: 'output',
        stream: 'stdout',
        text: 'x'.repeat(8192),
      });
    expect(worker.terminated).toBe(true);
    expect(f.events.at(-1)?.body).toMatchObject({
      status: 'output_limit',
      practice: { practice_manifest_sha256: f.manifest.sha256 },
    });
    await run(f, id(11));
    expect(FakeWorker.instances).toHaveLength(2);
    worker.send(id(10), { type: 'done', status: 'succeeded' });
    expect(
      f.events.filter((event) => event.body.type === 'terminal'),
    ).toHaveLength(1);
    FakeWorker.instances[1]!.send(id(11), {
      type: 'done',
      status: 'succeeded',
    });
    expect(
      f.events.filter((event) => event.body.type === 'terminal'),
    ).toHaveLength(2);
    f.supervisor.destroy();
  });

  it('keeps practice wall deadlines outside Python and terminates before one timed-out result', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    await run(f);
    const worker = FakeWorker.instances[0]!;
    worker.send(id(10), { type: 'ready' });
    vi.advanceTimersByTime(RUN_LIMITS.wallMs);
    worker.send(id(10), { type: 'done', status: 'succeeded' });
    expect(worker.terminated).toBe(true);
    expect(f.events.filter((event) => event.body.type === 'terminal')).toEqual([
      { id: id(10), body: expect.objectContaining({ status: 'timed_out' }) },
    ]);
    f.supervisor.destroy();
  });

  it('leaves ordinary product terminal objects free from a practice key', async () => {
    const f = await fixture();
    const manifest = await captureProjectManifest(f.manifest.source);
    await f.supervisor.handle({
      type: 'run',
      run_id: id(10),
      manifest,
      stdin: [],
    });
    FakeWorker.instances[0]!.send(id(10), {
      type: 'done',
      status: 'succeeded',
    });
    expect(f.events.at(-1)?.body).toEqual({
      type: 'terminal',
      status: 'succeeded',
      manifest_sha256: manifest.sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    });
    expect(Object.hasOwn(f.events.at(-1)!.body, 'practice')).toBe(false);
    f.supervisor.destroy();
  });
});
