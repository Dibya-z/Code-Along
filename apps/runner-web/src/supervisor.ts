import {
  RUNNER_PROTOCOL,
  RUNNER_VERSION,
  RUNTIME_ID,
  parseRunnerCommand,
  type RunnerEvent,
} from '@code-along/contracts/execution';
import {
  PRODUCT_RUNNER_VERSION,
  parseProductCommand,
  type ProductRunnerEvent,
} from '@code-along/contracts/execution/product-runner';
import { ExecutionSupervisor } from './engine.ts';
import {
  PRACTICE_PROTOCOL,
  PRACTICE_VERSION,
  parsePracticeCommand,
  type PracticeRunnerEvent,
} from '@code-along/contracts/execution/practice';

/** Preserve the M0 proof's v1 wire contract while sharing the supervised worker boundary. */
export class RunnerSupervisor {
  private readonly engine: ExecutionSupervisor;
  constructor(
    private readonly nonce: string,
    emit: (event: RunnerEvent) => void,
  ) {
    this.engine = new ExecutionSupervisor((runId, event) => {
      if (event.type === 'plot') return; // Additive product v2 only; v1 remains unchanged.
      const envelope = {
        protocol: RUNNER_PROTOCOL,
        version: RUNNER_VERSION,
        session_nonce: nonce,
        run_id: runId,
      } as const;
      emit(
        event.type === 'terminal'
          ? { ...envelope, ...event, runtime_id: RUNTIME_ID }
          : { ...envelope, ...event },
      );
    });
  }
  async handle(value: unknown): Promise<void> {
    const command = parseRunnerCommand(value, this.nonce);
    if (command) await this.engine.handle(command);
  }
  destroy(): void {
    this.engine.destroy();
  }
}
export class ProductRunnerSupervisor {
  private readonly engine: ExecutionSupervisor;
  constructor(
    private readonly nonce: string,
    emit: (event: ProductRunnerEvent) => void,
  ) {
    this.engine = new ExecutionSupervisor((runId, event) =>
      emit({
        protocol: RUNNER_PROTOCOL,
        version: PRODUCT_RUNNER_VERSION,
        session_nonce: nonce,
        run_id: runId,
        ...event,
      }),
    );
  }
  async handle(value: unknown): Promise<void> {
    const command = parseProductCommand(value, this.nonce);
    if (command) await this.engine.handle(command);
  }
  destroy(): void {
    this.engine.destroy();
  }
}

/** New practice wire only; source and all terminal identities stay shell-owned. */
export class PracticeRunnerSupervisor {
  private readonly engine: ExecutionSupervisor;
  constructor(
    private readonly nonce: string,
    emit: (event: PracticeRunnerEvent) => void,
  ) {
    this.engine = new ExecutionSupervisor((runId, event) => {
      const envelope = {
        protocol: PRACTICE_PROTOCOL,
        version: PRACTICE_VERSION,
        session_nonce: nonce,
        run_id: runId,
      } as const;
      if (event.type === 'terminal') {
        if (!event.practice) return;
        emit({
          ...envelope,
          type: 'terminal',
          status: event.status,
          source_manifest_sha256: event.manifest_sha256,
          practice_manifest_sha256: event.practice.practice_manifest_sha256,
          checks_sha256: event.practice.checks_sha256,
          helper_release_sha256: event.practice.helper_release_sha256,
          runtime_id: event.runtime_id,
        });
      } else emit({ ...envelope, ...event });
    });
  }
  async handle(value: unknown): Promise<void> {
    const command = parsePracticeCommand(value, this.nonce);
    if (!command) return;
    await this.engine.handle(
      command.type === 'run'
        ? {
            type: 'run',
            run_id: command.run_id,
            manifest: command.manifest.source,
            practice: command.manifest,
            stdin: command.stdin,
          }
        : command,
    );
  }
  destroy(): void {
    this.engine.destroy();
  }
}
