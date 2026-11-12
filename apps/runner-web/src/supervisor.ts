import {
  RUNNER_PROTOCOL,
  RUNNER_VERSION,
  RUN_LIMITS,
  RUNTIME_ID,
  parseRunnerCommand,
  verifyRunManifest,
  type RunManifest,
  type RunnerEvent,
  type RunnerEventBody,
  type TerminalStatus,
} from '@code-along/contracts/execution';

interface ActiveRun {
  id: string;
  manifest: RunManifest;
  worker: Worker | null;
  timer: ReturnType<typeof setTimeout>;
  input: Int32Array | null;
  waiting: boolean;
  outputBytes: number;
  sequence: number;
  running: boolean;
}
/** Trusted shell: owns worker handles, time and output budgets; never trusts Python as a grader. */
export class RunnerSupervisor {
  private active: ActiveRun | null = null;
  private readonly usedIds = new Set<string>();
  private readonly nonce: string;
  private readonly emit: (event: RunnerEvent) => void;
  constructor(nonce: string, emit: (event: RunnerEvent) => void) {
    this.nonce = nonce;
    this.emit = emit;
  }
  private send(run: ActiveRun, event: RunnerEventBody): void {
    this.emit({
      protocol: RUNNER_PROTOCOL,
      version: RUNNER_VERSION,
      session_nonce: this.nonce,
      run_id: run.id,
      ...event,
    });
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
      runtime_id: RUNTIME_ID,
    });
  }
  async handle(value: unknown): Promise<void> {
    const command = parseRunnerCommand(value, this.nonce);
    if (!command) return;
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
    const run: ActiveRun = {
      id: command.run_id,
      manifest: command.manifest,
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
    };
    this.active = run;
    this.state(run, 'initializing');
    if (!(await verifyRunManifest(command.manifest))) {
      this.finish(run, 'failed');
      return;
    }
    if (this.active !== run) return;
    if (command.manifest.stdin_mode === 'interactive') {
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
        if (m['type'] === 'ready' && !run.running) {
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
        } else if (
          m['type'] === 'output' &&
          typeof m['text'] === 'string' &&
          m['text'].length <= 8192 &&
          ['stdout', 'stderr'].includes(String(m['stream']))
        ) {
          const size = new TextEncoder().encode(m['text']).length;
          if (run.outputBytes + size > RUN_LIMITS.outputBytes) {
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
        manifest: command.manifest,
        stdin: command.stdin,
        input: run.input?.buffer,
      });
    } catch {
      this.finish(run, 'failed');
    }
  }
  destroy(): void {
    if (this.active) this.finish(this.active, 'cancelled');
  }
}
