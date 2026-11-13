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

/** Preserve the M0 proof's v1 wire contract while sharing the supervised worker boundary. */
export class RunnerSupervisor {
  private readonly engine: ExecutionSupervisor;
  constructor(
    private readonly nonce: string,
    emit: (event: RunnerEvent) => void,
  ) {
    this.engine = new ExecutionSupervisor((runId, event) => {
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
