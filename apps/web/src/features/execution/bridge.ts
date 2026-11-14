import { RUNNER_PROTOCOL } from '@code-along/contracts/execution';
import {
  PRODUCT_RUNNER_VERSION,
  parseProductEvent,
  parseProductReady,
  type ProductRunnerEvent,
  type ProductRunnerReady,
  type ProductRunnerCommand,
} from '@code-along/contracts/execution/product-runner';
import type { ProjectRunManifest } from '@code-along/contracts/execution/project';
import {
  PRACTICE_PROTOCOL,
  PRACTICE_VERSION,
  parsePracticeEvent,
  parsePracticeReady,
  type PracticeManifest,
  type PracticeRunnerCommand,
  type PracticeRunnerEvent,
  type PracticeRunnerReady,
} from '@code-along/contracts/execution/practice';

export type ExecutionKind = 'product' | 'practice';
export type ExecutionEvent = ProductRunnerEvent | PracticeRunnerEvent;
export type ExecutionReady = ProductRunnerReady | PracticeRunnerReady;

export interface RunnerBridge {
  start(
    runId: string,
    manifest: ProjectRunManifest,
    stdin: readonly string[],
    practice?: PracticeManifest,
  ): Promise<ExecutionReady>;
  input(text: string | null): void;
  cancel(): void;
  destroy(): void;
}
export function checkedRunnerOrigin(raw: string, app: string): string {
  const runner = new URL(raw),
    application = new URL(app);
  if (
    runner.origin !== raw ||
    application.origin !== app ||
    runner.protocol !== 'https:' ||
    application.protocol !== 'https:' ||
    runner.hostname === application.hostname
  ) {
    throw new Error('The separate-site Python runtime is not configured.');
  }
  return runner.origin;
}
export function configuredRunnerOrigin(): string {
  const configured = document.querySelector<HTMLMetaElement>(
    'meta[name="runner-origin"]',
  )?.content;
  if (!configured) throw new Error('The Python runtime origin is missing.');
  try {
    return checkedRunnerOrigin(configured, location.origin);
  } catch {
    throw new Error('The separate-site Python runtime is not configured.');
  }
}
/** A private connection may survive success; every run still has a fresh supervised Worker. */
export class IframeRunnerBridge implements RunnerBridge {
  private readonly frame = document.createElement('iframe');
  private readonly channel = new MessageChannel();
  private readonly nonce = crypto.randomUUID();
  private runId = '';
  private closed = false;
  private capability: ExecutionReady | undefined;
  private connecting: Promise<ExecutionReady> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  constructor(
    private readonly onEvent: (event: ExecutionEvent) => void,
    private readonly onFault: (message: string) => void,
    private readonly kind: ExecutionKind = 'product',
  ) {}
  async start(
    runId: string,
    manifest: ProjectRunManifest,
    stdin: readonly string[],
    practice?: PracticeManifest,
  ): Promise<ExecutionReady> {
    if (this.closed || this.runId)
      throw new Error('This Python runtime session is closed.');
    if (
      (this.kind === 'practice' &&
        (!practice || practice.source !== manifest)) ||
      (this.kind === 'product' && practice)
    )
      throw new Error(
        'The Python connection does not match this captured run.',
      );
    this.runId = runId;
    const capability = await this.connect();
    if (this.closed) throw new Error('This Python run was stopped.');
    if (manifest.stdin_mode === 'interactive' && !capability.interactive)
      throw new Error(
        'Interactive input is unavailable. Choose input before Run instead.',
      );
    if (this.kind === 'practice')
      this.post({
        protocol: PRACTICE_PROTOCOL,
        version: PRACTICE_VERSION,
        session_nonce: this.nonce,
        run_id: this.runId,
        type: 'run',
        manifest: practice!,
        stdin,
      } satisfies PracticeRunnerCommand);
    else
      this.post({
        protocol: RUNNER_PROTOCOL,
        version: PRODUCT_RUNNER_VERSION,
        session_nonce: this.nonce,
        run_id: this.runId,
        type: 'run',
        manifest,
        stdin,
      } satisfies ProductRunnerCommand);
    return capability;
  }
  private connect(): Promise<ExecutionReady> {
    if (this.connecting) return this.connecting;
    const origin = configuredRunnerOrigin();
    const ready = (this.connecting = new Promise<ExecutionReady>(
      (resolve, reject) => {
        this.rejectReady = reject;
        this.timer = setTimeout(
          () =>
            this.fail(
              'The Python runtime did not connect. Check its separate-site HTTPS certificate and try again.',
            ),
          10_000,
        );
        this.channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          if (this.closed) return;
          if (!this.capability) {
            const message =
              this.kind === 'practice'
                ? parsePracticeReady(event.data, this.nonce)
                : parseProductReady(event.data, this.nonce);
            if (!message) return;
            this.capability = message;
            clearTimeout(this.timer);
            this.rejectReady = undefined;
            resolve(message);
            return;
          }
          const message =
            this.kind === 'practice'
              ? parsePracticeEvent(event.data, this.nonce)
              : parseProductEvent(event.data, this.nonce);
          if (message && message.run_id === this.runId) {
            if (message.type === 'terminal') this.runId = '';
            this.onEvent(message);
          }
        };
        this.channel.port1.onmessageerror = () =>
          this.fail('The Python runtime connection was lost. Try a fresh run.');
        this.channel.port1.start();
      },
    ));
    this.frame.title = 'Isolated Python runtime';
    this.frame.hidden = true;
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.tabIndex = -1;
    this.frame.referrerPolicy = 'no-referrer';
    this.frame.sandbox.add('allow-scripts', 'allow-same-origin');
    this.frame.allow = `cross-origin-isolated ${origin}`;
    let transferred = false;
    this.frame.onload = () => {
      if (this.closed || !this.frame.contentWindow) return;
      if (transferred) {
        this.fail('The Python runtime page changed. Try a fresh run.');
        return;
      }
      transferred = true;
      this.frame.contentWindow.postMessage(
        {
          protocol:
            this.kind === 'practice' ? PRACTICE_PROTOCOL : RUNNER_PROTOCOL,
          version:
            this.kind === 'practice'
              ? PRACTICE_VERSION
              : PRODUCT_RUNNER_VERSION,
          type: 'connect',
          session_nonce: this.nonce,
        },
        origin,
        [this.channel.port2],
      );
    };
    this.frame.onerror = () =>
      this.fail('The Python runtime page could not load.');
    this.frame.src = `${origin}/`;
    document.body.append(this.frame);
    return ready;
  }
  private post(message: ProductRunnerCommand | PracticeRunnerCommand) {
    if (!this.closed && this.capability && this.runId)
      this.channel.port1.postMessage(message);
  }
  private send(
    body: { type: 'stdin'; text: string | null } | { type: 'cancel' },
  ) {
    if (this.kind === 'practice')
      this.post({
        protocol: PRACTICE_PROTOCOL,
        version: PRACTICE_VERSION,
        session_nonce: this.nonce,
        run_id: this.runId,
        ...body,
      } satisfies PracticeRunnerCommand);
    else
      this.post({
        protocol: RUNNER_PROTOCOL,
        version: PRODUCT_RUNNER_VERSION,
        session_nonce: this.nonce,
        run_id: this.runId,
        ...body,
      } satisfies ProductRunnerCommand);
  }
  input(text: string | null): void {
    this.send({ type: 'stdin', text });
  }
  cancel(): void {
    this.send({ type: 'cancel' });
  }
  private fail(message: string) {
    if (this.closed) return;
    this.rejectReady?.(new Error(message));
    this.rejectReady = undefined;
    this.onFault(message);
    this.destroy();
  }
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.rejectReady?.(new Error('This Python run was stopped.'));
    this.rejectReady = undefined;
    this.frame.onload = null;
    this.frame.onerror = null;
    this.frame.remove();
    this.channel.port1.close();
    this.channel.port2.close();
  }
}
