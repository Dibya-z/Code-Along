import type { EditorWorkspace } from '../editor/model/workspace.ts';
import {
  captureRecovery,
  recoveryMatches,
  recoveryStamp,
  validateRecovery,
  type ValidatedRecovery,
} from './codec.ts';
import {
  RecoveryConflict,
  RecoverySessionEnded,
  type RecoveryStore,
} from './store.ts';
type Phase =
  'loading' | 'ready' | 'pending' | 'saving' | 'found' | 'error' | 'conflict';
interface Snapshot {
  readonly phase: Phase;
  readonly updatedAt: number;
  readonly found: ValidatedRecovery | null;
  readonly error: string;
  readonly retain: boolean;
  readonly policyPending: boolean;
}
type Storage = Pick<RecoveryStore, 'read' | 'save' | 'retention' | 'remove'>;
function message(error: unknown): string {
  if (
    error instanceof RecoveryConflict ||
    error instanceof RecoverySessionEnded
  )
    return error.message;
  return 'Local recovery is unavailable or full. Your code is still in this tab. Export it before closing.';
}
export class RecoveryController {
  private snapshot: Snapshot = Object.freeze({
    phase: 'loading',
    updatedAt: 0,
    found: null,
    error: '',
    retain: false,
    policyPending: false,
  });
  private readonly listeners = new Set<() => void>();
  private epoch = '';
  private revision = 0;
  private blocked = false;
  private closed = false;
  private started = false;
  private lastQueued = '';
  private decision = 0;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  constructor(
    readonly workspace: EditorWorkspace,
    private readonly name: () => string,
    private readonly store: Storage,
    private readonly capture = captureRecovery,
    private opened?: ValidatedRecovery,
  ) {
    this.openedStamp = recoveryStamp(workspace);
  }
  private readonly openedStamp: string;
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(update: Partial<Snapshot>) {
    if (
      this.closed ||
      Object.entries(update).every(
        ([key, value]) => this.snapshot[key as keyof Snapshot] === value,
      )
    )
      return;
    this.snapshot = Object.freeze({ ...this.snapshot, ...update });
    for (const listener of this.listeners) listener();
  }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribe = this.workspace.subscribe(this.changed);
    void this.load();
  }
  private async load() {
    this.decision++;
    clearTimeout(this.timer);
    this.blocked = true;
    this.publish({ phase: 'loading', error: '' });
    try {
      const scope = await this.store.read(
        this.workspace.accountId,
        this.workspace.projectId,
      );
      if (this.closed) return;
      if (this.epoch && this.epoch !== scope.policy.epoch)
        throw new RecoverySessionEnded();
      this.epoch = scope.policy.epoch;
      this.revision = scope.record?.revision ?? 0;
      const found = scope.record
        ? await validateRecovery(scope.record.data)
        : null;
      if (this.closed) return;
      if (
        found &&
        (found.data.account_id !== this.workspace.accountId ||
          found.data.project_id !== this.workspace.projectId)
      )
        throw new RecoverySessionEnded();
      const opened = this.opened;
      this.opened = undefined;
      if (opened && !found) throw new RecoveryConflict();
      const acknowledged = !!(
        found &&
        opened &&
        found.data.kind === 'local_draft' &&
        this.workspace.sourceKind === 'local_draft' &&
        found.data.metadata_version === opened.data.metadata_version &&
        found.data.name === opened.data.name &&
        found.data.runtime_id === opened.data.runtime_id &&
        found.data.entrypoint_file_id === opened.data.entrypoint_file_id &&
        recoveryMatches(this.workspace, found) &&
        found.data.files.length === opened.data.files.length &&
        found.data.files.every((file) =>
          opened.data.files.some(
            (previous) =>
              previous.metadata.id === file.metadata.id &&
              previous.state_sha256 === file.state_sha256 &&
              previous.metadata.path === file.metadata.path,
          ),
        )
      );
      if (acknowledged && recoveryStamp(this.workspace) === this.openedStamp)
        this.lastQueued = this.openedStamp;
      this.blocked = !!found && !acknowledged;
      this.publish({
        phase: found && !acknowledged ? 'found' : 'ready',
        found: acknowledged ? null : found,
        retain: scope.policy.retain,
        updatedAt: scope.record?.updated_at ?? 0,
      });
      if (!found || acknowledged) this.changed();
    } catch (error) {
      this.blocked = true;
      this.publish({ phase: 'error', error: message(error) });
    }
  }
  private eligible() {
    const structure = this.workspace.getSnapshot();
    return (
      !this.blocked &&
      !!this.epoch &&
      structure.writable &&
      structure.files.length > 0 &&
      structure.files.every((file) => file.loaded) &&
      (this.revision > 0 || structure.files.some((file) => file.dirty))
    );
  }
  private changed = () => {
    if (
      this.closed ||
      !this.eligible() ||
      recoveryStamp(this.workspace) === this.lastQueued
    )
      return;
    this.publish({ phase: 'pending' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.enqueue(), 300);
  };
  private enqueue() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.eligible()) {
      const structure = this.workspace.getSnapshot();
      if (
        this.workspace.canonical &&
        !this.blocked &&
        this.epoch &&
        this.revision === 0 &&
        this.lastQueued === '' &&
        this.snapshot.phase === 'pending' &&
        structure.writable &&
        structure.files.length > 0 &&
        structure.files.every((file) => file.loaded && !file.dirty)
      )
        this.publish({ phase: 'ready', updatedAt: 0 });
      return;
    }
    const stamp = recoveryStamp(this.workspace);
    if (stamp === this.lastQueued) return;
    this.lastQueued = stamp;
    // Copy immediately, then serialize validation/writes. Route teardown can flush this private copy.
    const decision = this.decision;
    const captured = this.capture(this.workspace, this.name()).then(
      (data) => ({ data }),
      (error: unknown) => ({ error }),
    );
    this.publish({ phase: 'saving' });
    this.tail = this.tail
      .then(async () => {
        const result = await captured;
        if (this.blocked || decision !== this.decision) return;
        if ('error' in result) throw result.error;
        const record = await this.store.save(
          this.workspace.accountId,
          this.workspace.projectId,
          this.epoch,
          this.revision,
          result.data,
        );
        if (decision !== this.decision) return;
        this.revision = record.revision;
        this.publish({
          phase: recoveryStamp(this.workspace) === stamp ? 'ready' : 'pending',
          updatedAt: record.updated_at,
          error: '',
        });
      })
      .catch((error: unknown) => {
        if (decision !== this.decision) return;
        this.blocked = true;
        this.publish({
          phase: error instanceof RecoveryConflict ? 'conflict' : 'error',
          error: message(error),
        });
      });
  }
  canRestore(): boolean {
    return (
      !!this.snapshot.found &&
      this.workspace.getSnapshot().writable &&
      (!this.workspace.canonical ||
        this.workspace.documents().every((file) => file.loaded)) &&
      recoveryMatches(this.workspace, this.snapshot.found)
    );
  }
  restore(): void {
    const found = this.snapshot.found;
    if (!found || !this.canRestore()) {
      this.publish({
        error:
          'File identities or generations have changed. Export this recovery as a separate copy.',
      });
      return;
    }
    try {
      this.decision++;
      if (this.workspace.canonical)
        this.workspace.mergeCanonicalRecovery(found);
      else this.workspace.restoreFiles(found.data.files);
      this.lastQueued =
        !this.workspace.canonical &&
        found.data.metadata_version === this.workspace.metadataRevision
          ? recoveryStamp(this.workspace)
          : '';
      this.blocked = false;
      this.publish({ phase: 'ready', found: null, error: '' });
      this.changed();
    } catch (error) {
      this.publish({ error: message(error) });
    }
  }
  retry(): void {
    if (!this.closed) void this.load();
  }
  async keepThisTab(): Promise<void> {
    if (!this.snapshot.found) return;
    this.decision++;
    try {
      await this.store.remove(
        this.workspace.accountId,
        this.workspace.projectId,
        this.epoch,
        this.revision,
      );
      if (this.closed) return;
      this.revision = 0;
      this.lastQueued = '';
      this.blocked = false;
      this.publish({ phase: 'ready', found: null, error: '', updatedAt: 0 });
      this.changed();
    } catch (error) {
      this.blocked = true;
      this.publish({ phase: 'error', error: message(error) });
    }
  }
  async setRetention(retain: boolean): Promise<void> {
    if (!this.epoch || this.closed || this.snapshot.policyPending) return;
    const previous = this.snapshot.retain;
    this.publish({ retain, policyPending: true });
    try {
      await this.store.retention(this.workspace.accountId, this.epoch, retain);
      this.publish({ policyPending: false });
    } catch (error) {
      this.publish({
        retain: previous,
        policyPending: false,
        error: message(error),
      });
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.enqueue();
    this.closed = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.listeners.clear();
  }
}
