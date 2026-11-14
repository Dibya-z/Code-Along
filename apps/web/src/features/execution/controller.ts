import {
  RUN_LIMITS,
  RUNNER_PROTOCOL,
  type TerminalStatus,
} from '@code-along/contracts/execution';
import { validBatchInput } from '@code-along/contracts/execution/product-runner';
import {
  PRACTICE_PROTOCOL,
  type PracticeManifest,
} from '@code-along/contracts/execution/practice';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
import {
  captureWorkspaceRun,
  isCurrentRun,
  type CapturedRun,
} from '../editor/model/snapshot.ts';
import type { RunnerBridge, ExecutionEvent, ExecutionKind } from './bridge.ts';
import {
  captureWorkspacePractice,
  captureWorkspaceWorkRun,
  type WorkExecutionContext,
  type WorkPracticeInput,
} from './practice.ts';
import type { RuntimeIdentity } from '@code-along/contracts/execution/profiles';
import { ConsoleBuffer, type ConsoleLine } from './console-buffer.ts';
import {
  isRasterPlot,
  PLOT_LIMITS,
  type RasterPlot,
} from '@code-along/contracts/execution/plots';
import { PRACTICE_BUDGETS } from '@code-along/contracts/execution/budgets';

export type RunPhase =
  | 'idle'
  | 'capturing'
  | 'initializing'
  | 'running'
  | 'waiting_for_input'
  | TerminalStatus;
export interface ExecutionSnapshot {
  readonly runId: string;
  readonly phase: RunPhase;
  readonly captured: CapturedRun | null;
  readonly kind: ExecutionKind;
  readonly practice: PracticeManifest | null;
  readonly task: WorkExecutionContext | null;
  readonly earlierSource: boolean;
  readonly output: readonly ConsoleLine[];
  readonly plots: readonly RasterPlot[];
  readonly error: string;
}
export function running(phase: RunPhase): boolean {
  return ['capturing', 'initializing', 'running', 'waiting_for_input'].includes(
    phase,
  );
}
type BridgeFactory = (
  event: (event: ExecutionEvent) => void,
  fault: (message: string) => void,
  kind: ExecutionKind,
) => RunnerBridge;
/** UI state owns no writable source. Immutable runs use fresh Workers on a private runner connection. */
export class ExecutionController {
  private snapshot: ExecutionSnapshot = Object.freeze({
    runId: '',
    phase: 'idle',
    captured: null,
    kind: 'product',
    practice: null,
    task: null,
    earlierSource: false,
    output: [],
    plots: [],
    error: '',
  });
  private readonly listeners = new Set<() => void>();
  private bridge: RunnerBridge | null = null;
  private bridgeKind: ExecutionKind | null = null;
  private connection = 0;
  private runsOnBridge = 0;
  private closed = false;
  private sequence = 0;
  private bytes = 0;
  private plotBytes = 0;
  private console = new ConsoleBuffer();
  private outputChanged = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  constructor(
    private readonly workspace: EditorWorkspace,
    private readonly createBridge: BridgeFactory,
  ) {}
  getSnapshot = (): ExecutionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(update: Partial<ExecutionSnapshot>) {
    if (this.closed) return;
    this.snapshot = Object.freeze({ ...this.snapshot, ...update });
    for (const listener of this.listeners) listener();
  }
  run(
    stdin: readonly string[] = [],
    runtime?: RuntimeIdentity,
    mode: 'batch' | 'interactive' = 'batch',
    task?: WorkExecutionContext,
  ): Promise<void> {
    return this.execute('product', stdin, () =>
      task
        ? captureWorkspaceWorkRun(this.workspace, task, mode, runtime)
        : captureWorkspaceRun(this.workspace, mode, runtime).then(
            (captured) => ({ captured, practice: null, task: null }),
          ),
    );
  }
  runChecks(
    input: WorkPracticeInput,
    stdin: readonly string[] = [],
    mode: 'batch' | 'interactive' = 'batch',
  ): Promise<void> {
    return this.execute('practice', stdin, () =>
      captureWorkspacePractice(this.workspace, input, mode),
    );
  }
  private async execute(
    kind: ExecutionKind,
    stdin: readonly string[],
    capture: () => Promise<{
      captured: CapturedRun;
      practice: PracticeManifest | null;
      task: WorkExecutionContext | null;
    }>,
  ): Promise<void> {
    if (this.closed || running(this.snapshot.phase)) return;
    this.unsubscribe ??= this.workspace.subscribe(() => {
      if (
        this.snapshot.captured &&
        !this.snapshot.earlierSource &&
        !isCurrentRun(this.workspace, this.snapshot.captured)
      )
        this.publish({ earlierSource: true });
    });
    this.clearTimers();
    if (
      this.runsOnBridge >= 90 ||
      (this.bridgeKind !== null && this.bridgeKind !== kind)
    )
      this.release();
    this.sequence = 0;
    this.bytes = 0;
    this.plotBytes = 0;
    this.console = new ConsoleBuffer();
    this.outputChanged = false;
    const runId = crypto.randomUUID();
    this.publish({
      runId,
      phase: 'capturing',
      captured: null,
      kind,
      practice: null,
      task: null,
      earlierSource: false,
      output: [],
      plots: [],
      error: '',
    });
    try {
      if (!validBatchInput(stdin))
        throw new Error(
          'Use at most 100 input lines, 4 KiB per line and 64 KiB total.',
        );
      const input = Object.freeze([...stdin]);
      const { captured, practice, task } = await capture();
      if (!this.active(runId)) return;
      this.publish({
        phase: 'initializing',
        captured,
        practice,
        task,
        earlierSource: !isCurrentRun(this.workspace, captured),
      });
      if (!this.bridge) {
        const connection = ++this.connection;
        this.bridgeKind = kind;
        this.bridge = this.createBridge(
          (event) => {
            if (connection === this.connection) this.receive(event);
          },
          (message) => {
            if (connection !== this.connection || this.closed) return;
            if (running(this.snapshot.phase)) this.finish('failed', message);
            else {
              this.release();
              this.publish({ error: message });
            }
          },
          kind,
        );
      }
      this.runsOnBridge++;
      this.deadline = setTimeout(
        () => {
          if (this.active(runId))
            this.finish(
              'timed_out',
              'The Python runtime did not finish within its deadline.',
            );
        },
        RUN_LIMITS.startupMs + RUN_LIMITS.wallMs + 15_000,
      );
      if (practice)
        await this.bridge.start(runId, captured.manifest, input, practice);
      else await this.bridge.start(runId, captured.manifest, input);
    } catch (error) {
      if (this.active(runId))
        this.finish(
          'failed',
          error instanceof Error
            ? error.message
            : 'The Python run could not start.',
        );
    }
  }
  private active(id: string) {
    return (
      !this.closed && this.snapshot.runId === id && running(this.snapshot.phase)
    );
  }
  private receive(event: ExecutionEvent) {
    if (!this.active(event.run_id)) return;
    if (
      event.protocol !==
      (this.snapshot.kind === 'practice' ? PRACTICE_PROTOCOL : RUNNER_PROTOCOL)
    ) {
      this.finish(
        'failed',
        'The runtime response used a different execution connection.',
      );
      return;
    }
    if (event.type === 'state') {
      this.publish({ phase: event.state });
      return;
    }
    if (event.type === 'terminal') {
      const source = this.snapshot.captured?.manifest;
      const practice = this.snapshot.practice;
      const matches =
        source &&
        (this.snapshot.kind === 'practice'
          ? practice &&
            event.protocol === PRACTICE_PROTOCOL &&
            event.source_manifest_sha256 === source.sha256 &&
            event.practice_manifest_sha256 === practice.sha256 &&
            event.checks_sha256 === practice.checks.sha256 &&
            event.helper_release_sha256 ===
              practice.helper_release.source_sha256 &&
            event.runtime_id === source.runtime.runtime_id
          : event.protocol === RUNNER_PROTOCOL &&
            event.manifest_sha256 === source.sha256 &&
            event.runtime_id === source.runtime.runtime_id);
      if (!matches) {
        this.finish(
          'failed',
          'The runtime result did not match its captured source.',
        );
        return;
      }
      // The trusted shell terminates the Worker before sending this terminal event.
      const reusable =
        event.status === 'succeeded' || event.status === 'failed';
      this.finish(
        event.status,
        event.status === 'failed' && this.bytes === 0
          ? 'Python could not start. Check the runtime connection and try again.'
          : '',
        reusable,
      );
      return;
    }
    if (event.type === 'plot') {
      if (
        !isRasterPlot(event) ||
        event.index !== this.snapshot.plots.length ||
        this.plotBytes + event.png.length > PLOT_LIMITS.totalBytes
      ) {
        this.finish('output_limit', 'The plot limit was reached.');
        return;
      }
      this.plotBytes += event.png.length;
      this.publish({
        plots: Object.freeze([
          ...this.snapshot.plots,
          Object.freeze({
            type: 'plot' as const,
            index: event.index,
            title: event.title,
            png: Uint8Array.from(event.png),
          }),
        ]),
      });
      return;
    }
    if (this.sequence >= PRACTICE_BUDGETS.outputMessages) {
      this.finish('output_limit');
      return;
    }
    if (event.sequence !== this.sequence++) {
      this.finish(
        'failed',
        'Python output arrived out of sequence. Run again.',
      );
      return;
    }
    this.bytes += new TextEncoder().encode(event.text).length;
    if (this.bytes > RUN_LIMITS.outputBytes) {
      this.finish('output_limit');
      return;
    }
    const admitted = this.console.append(event.stream, event.text);
    this.outputChanged = true;
    if (!admitted) {
      this.finish('output_limit', 'The console reached its 5,000-line limit.');
      return;
    }
    this.flushTimer ??= setTimeout(() => this.flush(), 32);
  }
  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.outputChanged) return;
    this.outputChanged = false;
    this.publish({ output: this.console.snapshot() });
  }
  private finish(phase: TerminalStatus, error = '', reusable = false) {
    this.flush();
    this.clearTimers();
    if (!reusable) this.release();
    this.publish({ phase, error });
  }
  stop(): void {
    if (running(this.snapshot.phase)) {
      this.bridge?.cancel();
      this.finish('cancelled');
    }
  }
  input(text: string | null): boolean {
    if (
      this.snapshot.phase !== 'waiting_for_input' ||
      (text !== null && !validBatchInput([text]))
    )
      return false;
    this.bridge?.input(text);
    // Prevent double submission while the runner acknowledges this input line.
    this.publish({ phase: 'running' });
    return true;
  }
  clearOutput(): void {
    this.console.clear();
    this.outputChanged = false;
    this.publish({ output: [] });
  }
  private clearTimers() {
    clearTimeout(this.deadline);
    clearTimeout(this.flushTimer);
    this.deadline = undefined;
    this.flushTimer = undefined;
  }
  private release() {
    this.clearTimers();
    const previous = this.bridge;
    this.bridge = null;
    this.bridgeKind = null;
    this.runsOnBridge = 0;
    this.connection++;
    previous?.destroy();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    this.unsubscribe?.();
    this.listeners.clear();
    this.console.clear();
  }
}
