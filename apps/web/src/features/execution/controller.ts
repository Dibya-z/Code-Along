import {
  RUN_LIMITS,
  type TerminalStatus,
} from '@code-along/contracts/execution';
import {
  validBatchInput,
  type ProductRunnerEvent,
} from '@code-along/contracts/execution/product-runner';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
import {
  captureWorkspaceRun,
  isCurrentRun,
  type CapturedRun,
} from '../editor/model/snapshot.ts';
import type { RunnerBridge } from './bridge.ts';
import type { RuntimeIdentity } from '@code-along/contracts/execution/profiles';
import { ConsoleBuffer, type ConsoleLine } from './console-buffer.ts';

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
  readonly earlierSource: boolean;
  readonly output: readonly ConsoleLine[];
  readonly error: string;
}
export function running(phase: RunPhase): boolean {
  return ['capturing', 'initializing', 'running', 'waiting_for_input'].includes(
    phase,
  );
}
type BridgeFactory = (
  event: (event: ProductRunnerEvent) => void,
  fault: (message: string) => void,
) => RunnerBridge;
/** UI state owns no writable source. Every run has a new bridge and immutable capture. */
export class ExecutionController {
  private snapshot: ExecutionSnapshot = Object.freeze({
    runId: '',
    phase: 'idle',
    captured: null,
    earlierSource: false,
    output: [],
    error: '',
  });
  private readonly listeners = new Set<() => void>();
  private bridge: RunnerBridge | null = null;
  private closed = false;
  private sequence = 0;
  private bytes = 0;
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
  async run(
    stdin: readonly string[] = [],
    runtime?: RuntimeIdentity,
    mode: 'batch' | 'interactive' = 'batch',
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
    this.release();
    this.sequence = 0;
    this.bytes = 0;
    this.console = new ConsoleBuffer();
    this.outputChanged = false;
    const runId = crypto.randomUUID();
    this.publish({
      runId,
      phase: 'capturing',
      captured: null,
      earlierSource: false,
      output: [],
      error: '',
    });
    try {
      if (!validBatchInput(stdin))
        throw new Error(
          'Use at most 100 input lines, 4 KiB per line and 64 KiB total.',
        );
      const input = Object.freeze([...stdin]);
      const captured = await captureWorkspaceRun(this.workspace, mode, runtime);
      if (!this.active(runId)) return;
      this.publish({
        phase: 'initializing',
        captured,
        earlierSource: !isCurrentRun(this.workspace, captured),
      });
      this.bridge = this.createBridge(
        (event) => this.receive(event),
        (message) => {
          if (this.active(runId)) this.finish('failed', message);
        },
      );
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
      await this.bridge.start(runId, captured.manifest, input);
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
  private receive(event: ProductRunnerEvent) {
    if (!this.active(event.run_id)) return;
    if (event.type === 'state') {
      this.publish({ phase: event.state });
      return;
    }
    if (event.type === 'terminal') {
      if (
        event.manifest_sha256 !== this.snapshot.captured?.manifest.sha256 ||
        event.runtime_id !== this.snapshot.captured.manifest.runtime.runtime_id
      ) {
        this.finish(
          'failed',
          'The runtime result did not match its captured source.',
        );
        return;
      }
      this.finish(event.status);
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
  private finish(phase: TerminalStatus, error = '') {
    this.flush();
    this.publish({ phase, error });
    this.release();
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
  private release() {
    clearTimeout(this.deadline);
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.bridge?.destroy();
    this.bridge = null;
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
