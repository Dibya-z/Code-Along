import { RuntimeAssetCache, type RuntimeAssets } from './asset-cache.ts';
import {
  RUN_LIMITS,
  RUNTIME_ID,
  verifyRunManifest,
  type RunManifest,
  type RunnerEventBody,
  type TerminalStatus,
} from '@code-along/contracts/execution';
import {
  verifyProjectManifest,
  type ProjectRunManifest,
} from '@code-along/contracts/execution/project';
import {
  isRasterPlot,
  PLOT_LIMITS,
  type RasterPlot,
} from '@code-along/contracts/execution/plots';
import { PRACTICE_BUDGETS } from '@code-along/contracts/execution/budgets';
import {
  verifyPracticeManifest,
  type PracticeManifest,
} from '@code-along/contracts/execution/practice';
export type EngineCommand =
  | {
      type: 'run';
      run_id: string;
      manifest: RunManifest | ProjectRunManifest;
      stdin: readonly string[];
      practice?: PracticeManifest;
    }
  | { type: 'cancel'; run_id: string }
  | { type: 'stdin'; run_id: string; text: string | null };
export type EngineEvent =
  | RasterPlot
  | Exclude<RunnerEventBody, { type: 'terminal' }>
  | {
      type: 'terminal';
      status: TerminalStatus;
      manifest_sha256: string;
      runtime_id: string;
      practice?: {
        readonly practice_manifest_sha256: string;
        readonly checks_sha256: string;
        readonly helper_release_sha256: string;
      };
    };
interface ActiveRun {
  id: string;
  manifest: RunManifest | ProjectRunManifest;
  practice: PracticeManifest | null;
  worker: Worker | null;
  timer: ReturnType<typeof setTimeout>;
  input: Int32Array | null;
  waiting: boolean;
  outputBytes: number;
  sequence: number;
  running: boolean;
  plots: number;
  plotBytes: number;
  outputMessages: number;
  cacheOffered: boolean;
}
function ownRun(
  command: Extract<EngineCommand, { type: 'run' }>,
): Extract<EngineCommand, { type: 'run' }> {
  // A boolean verifier cannot transfer ownership of an object a caller can mutate.
  // One clone preserves the adapter's source/practice alias while removing external aliases.
  const owned = structuredClone(command);
  const seen = new WeakSet<object>();
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(owned);
  return owned;
}
/** Trusted shell: owns worker handles, time and output budgets; never trusts Python as a grader. */
export class ExecutionSupervisor {
  private closed = false;
  private readonly runtimeAssets = new RuntimeAssetCache();
  private active: ActiveRun | null = null;
  private readonly usedIds = new Set<string>();
  constructor(
    private readonly emit: (runId: string, event: EngineEvent) => void,
  ) {}
  private send(run: ActiveRun, event: EngineEvent): void {
    this.emit(run.id, event);
  }
  private state(
    run: ActiveRun,
    state: 'initializing' | 'running' | 'waiting_for_input',
  ): void {
    this.send(run, { type: 'state', state });
  }
  private finish(run: ActiveRun, status: TerminalStatus): void {
    if (this.active !== run) return;
    this.active = null;
    clearTimeout(run.timer);
    run.worker?.terminate();
    this.send(run, {
      type: 'terminal',
      status,
      manifest_sha256: run.manifest.sha256,
      runtime_id:
        run.manifest.version === 1
          ? RUNTIME_ID
          : run.manifest.runtime.runtime_id,
      ...(run.practice
        ? {
            practice: {
              practice_manifest_sha256: run.practice.sha256,
              checks_sha256: run.practice.checks.sha256,
              helper_release_sha256: run.practice.helper_release.source_sha256,
            },
          }
        : {}),
    });
  }
  async handle(command: EngineCommand): Promise<void> {
    if (this.closed) return;
    if (command.type === 'cancel') {
      if (this.active?.id === command.run_id)
        this.finish(this.active, 'cancelled');
      return;
    }
    if (command.type === 'stdin') {
      const r = this.active;
      if (!r || r.id !== command.run_id || !r.input || !r.waiting) return;
      const bytes =
        command.text === null ? null : new TextEncoder().encode(command.text);
      if (bytes && bytes.length > RUN_LIMITS.inputBytes) return;
      if (bytes) new Uint8Array(r.input.buffer, 8).set(bytes);
      Atomics.store(r.input, 1, bytes?.length ?? 0);
      Atomics.store(r.input, 0, bytes === null ? 2 : 1);
      r.waiting = false;
      this.state(r, 'running');
      Atomics.notify(r.input, 0);
      return;
    }
    if (
      this.active ||
      this.usedIds.has(command.run_id) ||
      this.usedIds.size >= 100
    )
      return;
    // Reserve before hashing: cancel/new messages cannot race two starts.
    this.usedIds.add(command.run_id);
    let owned: Extract<EngineCommand, { type: 'run' }>;
    try {
      owned = ownRun(command);
    } catch {
      // Parsed wire manifests are bounded plain data. Uncloneable internal input is not admitted.
      return;
    }
    const run: ActiveRun = {
      id: owned.run_id,
      manifest: owned.manifest,
      practice: owned.practice ?? null,
      worker: null,
      timer: setTimeout(
        () => this.finish(run, 'timed_out'),
        RUN_LIMITS.startupMs,
      ),
      input: null,
      waiting: false,
      outputBytes: 0,
      sequence: 0,
      running: false,
      plots: 0,
      plotBytes: 0,
      outputMessages: 0,
      cacheOffered: false,
    };
    this.active = run;
    this.state(run, 'initializing');
    let valid: boolean;
    try {
      valid =
        run.practice !== null
          ? run.manifest.version === 2 &&
            run.manifest === run.practice.source &&
            (await verifyPracticeManifest(run.practice))
          : run.manifest.version === 1
            ? await verifyRunManifest(run.manifest)
            : await verifyProjectManifest(run.manifest);
    } catch {
      this.finish(run, 'failed');
      return;
    }
    if (this.active !== run) return;
    if (!valid) {
      this.finish(run, 'failed');
      return;
    }
    let runtime_cache: RuntimeAssets | undefined;
    try {
      runtime_cache =
        run.manifest.version === 2
          ? await this.runtimeAssets.copy(run.manifest.runtime)
          : undefined;
    } catch {
      this.finish(run, 'failed');
      return;
    }
    if (this.active !== run) return;
    if (run.manifest.stdin_mode === 'interactive') {
      if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        this.finish(run, 'failed');
        return;
      }
      run.input = new Int32Array(
        new SharedArrayBuffer(8 + RUN_LIMITS.inputBytes),
      );
    }
    try {
      run.worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
      });
      run.worker.onerror = (event) => {
        event.preventDefault();
        this.finish(run, 'failed');
      };
      run.worker.onmessage = (event: MessageEvent<unknown>) => {
        if (
          this.active !== run ||
          typeof event.data !== 'object' ||
          event.data === null
        )
          return;
        const m = event.data as Record<string, unknown>;
        if (m['run_id'] !== run.id) return;
        if (
          m['type'] === 'runtime_assets' &&
          run.manifest.version === 2 &&
          !run.running &&
          !run.cacheOffered
        ) {
          run.cacheOffered = true;
          void this.runtimeAssets
            .admit(m['cache'], run.manifest.runtime)
            .catch(() => {
              /* Untrusted/incomplete assets never become a cache entry. */
            });
        } else if (m['type'] === 'limit') {
          this.finish(run, 'output_limit');
        } else if (m['type'] === 'ready' && !run.running) {
          run.running = true;
          clearTimeout(run.timer);
          run.timer = setTimeout(
            () => this.finish(run, 'timed_out'),
            RUN_LIMITS.wallMs,
          );
          this.state(run, 'running');
        } else if (m['type'] === 'input' && run.input && !run.waiting) {
          run.waiting = true;
          this.state(run, 'waiting_for_input');
        } else if (m['type'] === 'plot' && run.manifest.version === 2) {
          if (
            !isRasterPlot(m) ||
            m.index !== run.plots ||
            run.plotBytes + m.png.length > PLOT_LIMITS.totalBytes
          ) {
            this.finish(run, 'output_limit');
            return;
          }
          run.plots++;
          run.plotBytes += m.png.length;
          this.send(run, {
            type: 'plot',
            index: m.index,
            title: m.title,
            png: Uint8Array.from(m.png),
          });
        } else if (
          m['type'] === 'output' &&
          typeof m['text'] === 'string' &&
          m['text'].length <= 8192 &&
          ['stdout', 'stderr'].includes(String(m['stream']))
        ) {
          const size = new TextEncoder().encode(m['text']).length;
          if (
            ++run.outputMessages > PRACTICE_BUDGETS.outputMessages ||
            run.outputBytes + size > RUN_LIMITS.outputBytes
          ) {
            this.finish(run, 'output_limit');
            return;
          }
          run.outputBytes += size;
          this.send(run, {
            type: 'output',
            stream: m['stream'] as 'stdout' | 'stderr',
            text: m['text'],
            sequence: run.sequence++,
          });
        } else if (
          m['type'] === 'done' &&
          (m['status'] === 'succeeded' || m['status'] === 'failed')
        )
          this.finish(run, m['status']);
      };
      run.worker.postMessage({
        run_id: run.id,
        manifest: run.manifest,
        stdin: owned.stdin,
        input: run.input?.buffer,
        ...(run.manifest.version === 2 ? { runtime_cache } : {}),
        ...(run.practice ? { checks_source: run.practice.checks.source } : {}),
      });
    } catch {
      this.finish(run, 'failed');
    }
  }
  destroy(): void {
    this.closed = true;
    this.runtimeAssets.close();
    if (this.active) this.finish(this.active, 'cancelled');
  }
}
