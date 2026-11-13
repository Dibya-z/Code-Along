import {
  isRunnerId,
  RUN_LIMITS,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import type { components } from '@code-along/api-client';
import * as Y from 'yjs';
import type { EditorProject } from '../../projects/types.ts';
import {
  validateRecoveryBinary,
  type ValidatedRecovery,
} from '../../recovery/codec.ts';
import type { ProjectSnapshot } from '@code-along/contracts/execution/project';
import {
  reviewedRuntime,
  runtimeProfile,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import { EditorDocument, type FileMetadata } from './document.ts';

export type FileSource = components['schemas']['FileSource'];
export interface FileSummary extends FileMetadata {
  readonly loaded: boolean;
  readonly dirty: boolean;
}
export interface WorkspaceSummary {
  readonly revision: number;
  readonly files: readonly FileSummary[];
  readonly entrypoint: string;
  readonly writable: boolean;
}

/** Account/project-scoped local workbench. Server durability/provider admission belong to M3. */
export class EditorWorkspace {
  private records = new Map<string, EditorDocument>();
  private listeners = new Set<() => void>();
  private destroyed = false;
  private metadataVersion = 0;
  private runtimeId = '';
  private restoring = false;
  private summary: WorkspaceSummary = Object.freeze({
    revision: 0,
    files: [],
    entrypoint: '',
    writable: false,
  });
  sourceRevision = 0;
  get metadataRevision(): number {
    return this.metadataVersion;
  }

  constructor(
    readonly accountId: string,
    readonly projectId: string,
    readonly sourceKind: ProjectSnapshot['source_kind'] = 'project',
    readonly canonical = false,
  ) {
    if (!isRunnerId(accountId) || !isRunnerId(projectId))
      throw new Error('Invalid workbench identity.');
  }

  getSnapshot = (): WorkspaceSummary => this.summary;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  file(id: string): EditorDocument | undefined {
    return this.records.get(id);
  }
  documents(): readonly EditorDocument[] {
    return [...this.records.values()];
  }

  private publish(changed: boolean): void {
    if (changed)
      this.summary = Object.freeze({
        ...this.summary,
        revision: this.summary.revision + 1,
        files: Object.freeze(
          [...this.records.values()].map((file) =>
            Object.freeze({
              ...file.metadata,
              loaded: file.loaded,
              dirty: file.dirty,
            }),
          ),
        ),
      });
    for (const listener of this.listeners) listener();
  }

  private sourceChanged = (
    file: EditorDocument,
    seeded: boolean,
    source = true,
  ): void => {
    if (this.restoring) return;
    if (source) this.sourceRevision++;
    const summary = this.summary.files.find(
      (item) => item.id === file.metadata.id,
    );
    // Keystrokes notify source consumers, but keep structural React snapshots stable.
    this.publish(seeded || summary?.dirty !== file.dirty);
  };

  reconcile<T extends EditorProject>(
    project: T,
    files: readonly FileMetadata[],
    count = files.length,
  ): boolean {
    if (this.destroyed) throw new Error('This workbench is closed.');
    if (project.id !== this.projectId)
      throw new Error('Project identity does not match this workbench.');
    if (
      !Number.isSafeInteger(project.metadata_version) ||
      project.metadata_version < 1
    )
      throw new Error('Invalid project version.');
    if (project.metadata_version < this.metadataVersion) return false;
    if (files.length !== count || count < 1 || count > RUN_LIMITS.files)
      throw new Error('Load the complete project file list before editing.');
    const ids = new Set<string>(),
      documents = new Set<string>();
    for (const file of files) {
      if (
        !isRunnerId(file.id) ||
        !isRunnerId(file.document_id) ||
        !Number.isSafeInteger(file.generation) ||
        file.generation < 1 ||
        ids.has(file.id) ||
        documents.has(file.document_id)
      )
        throw new Error('Invalid or duplicate file identity.');
      ids.add(file.id);
      documents.add(file.document_id);
      const previous = this.records.get(file.id);
      if (
        previous?.metadata.document_id === file.document_id &&
        previous.metadata.generation === file.generation &&
        previous.metadata.initial_sha256 !== file.initial_sha256
      )
        throw new Error(
          'Immutable starter identity changed; refresh project metadata.',
        );
    }
    if (!ids.has(project.entrypoint_file_id))
      throw new Error('Project entrypoint is missing from its file list.');
    const next = new Map<string, EditorDocument>();
    for (const file of [...files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      const previous = this.records.get(file.id);
      const retained =
        previous &&
        previous.metadata.document_id === file.document_id &&
        previous.metadata.generation === file.generation;
      const document = retained
        ? previous
        : new EditorDocument(file, this.sourceChanged, this.canonical);
      document.updateMetadata(file);
      next.set(file.id, document);
    }
    for (const [id, file] of this.records)
      if (next.get(id) !== file) file.destroy();
    this.records = next;
    this.metadataVersion = project.metadata_version;
    this.runtimeId = project.runtime_id;
    this.summary = {
      ...this.summary,
      entrypoint: project.entrypoint_file_id,
      writable:
        project.role !== 'viewer' &&
        !project.archived &&
        !project.workspace_archived,
    };
    this.publish(true);
    return true;
  }

  async loadSource(value: FileSource): Promise<boolean> {
    const file = this.records.get(value.id);
    if (!file || file.disposed || file.loaded || this.destroyed) return false;
    if (
      value.document_id !== file.metadata.document_id ||
      value.generation !== file.metadata.generation ||
      value.initial_sha256 !== file.metadata.initial_sha256
    )
      return false;
    const bytes = sourceBytes(value.initial_source);
    if (
      bytes.length > RUN_LIMITS.fileBytes ||
      (await sha256(bytes)) !== value.initial_sha256
    )
      throw new Error('Starter source failed its size or integrity check.');
    // A response/hash can finish after deletion, generation replacement or another load.
    if (
      this.destroyed ||
      this.records.get(value.id) !== file ||
      file.loaded ||
      file.disposed
    )
      return false;
    file.seed(value.initial_source);
    return true;
  }

  replaceSource(id: string, source: string): void {
    if (this.destroyed || !this.summary.writable)
      throw new Error('This project is read-only.');
    const file = this.records.get(id);
    if (!file) throw new Error('This file is no longer in the project.');
    file.replace(source);
  }

  /** A reviewed full-state recovery replaces empty local models, never merges duplicate starter seeds. */
  restoreFiles(
    files: readonly {
      metadata: FileMetadata;
      state: Uint8Array;
      initial_source: string;
    }[],
  ): void {
    if (this.canonical)
      throw new Error(
        'Legacy local history must be opened as a separate local draft.',
      );
    if (
      this.destroyed ||
      !this.summary.writable ||
      files.length !== this.records.size ||
      new Set(files.map((file) => file.metadata.id)).size !== files.length
    )
      throw new Error(
        'This recovery does not match the writable project. Export it as a separate copy.',
      );
    for (const file of files) {
      const current = this.records.get(file.metadata.id)?.metadata;
      if (
        !current ||
        current.document_id !== file.metadata.document_id ||
        current.generation !== file.metadata.generation ||
        current.initial_sha256 !== file.metadata.initial_sha256
      )
        throw new Error(
          'File identities or generations have changed. Export this recovery as a separate copy.',
        );
    }
    const next = new Map<string, EditorDocument>();
    this.restoring = true;
    try {
      for (const old of this.records.values()) {
        const file = files.find(
          (item) => item.metadata.id === old.metadata.id,
        )!;
        const restored = new EditorDocument(old.metadata, this.sourceChanged);
        next.set(old.metadata.id, restored);
        restored.restore(file.state, file.initial_source);
      }
    } catch (error) {
      for (const file of next.values()) file.destroy();
      throw error;
    } finally {
      this.restoring = false;
    }
    for (const file of this.records.values()) file.destroy();
    this.records = next;
    this.sourceRevision++;
    this.publish(true);
  }

  /** Merge only reviewed canonical history belonging to the same server generations. */
  mergeCanonicalRecovery(recovery: ValidatedRecovery): void {
    const { data } = recovery,
      files = data.files;
    if (
      !this.canonical ||
      data.origin !== 'm3-canonical' ||
      data.account_id !== this.accountId ||
      data.project_id !== this.projectId ||
      !this.summary.writable ||
      files.length !== this.records.size ||
      new Set(files.map((file) => file.metadata.id)).size !== files.length ||
      files.some((file) => {
        const live = this.records.get(file.metadata.id);
        return (
          !live?.loaded ||
          live.metadata.document_id !== file.metadata.document_id ||
          live.metadata.generation !== file.metadata.generation ||
          live.metadata.initial_sha256 !== file.metadata.initial_sha256
        );
      })
    )
      throw new Error(
        'These server generations changed. Open the recovery as a separate local draft.',
      );
    const merged = files.map((file) => {
      const document = this.records.get(file.metadata.id)!;
      const state = Y.mergeUpdates([
        Y.encodeStateAsUpdate(document.doc),
        file.state,
      ]);
      validateRecoveryBinary(state);
      return { document, state };
    });
    // No live document changes until every merged schema/source/binary budget passed.
    for (const { document, state } of merged)
      Y.applyUpdate(document.doc, state);
  }

  snapshotInput(
    stdinMode: ProjectSnapshot['stdin_mode'] = 'batch',
    runtime?: RuntimeIdentity,
  ): ProjectSnapshot {
    if (this.destroyed || this.metadataVersion < 1)
      throw new Error('Open a complete project before running.');
    const selectedRuntime = runtime ?? this.defaultRuntime();
    if (!reviewedRuntime(selectedRuntime))
      throw new Error('Choose a reviewed Python runtime before running.');
    const documents = this.documents();
    if (documents.some((file) => !file.loaded || file.disposed))
      throw new Error(
        'Wait for every project file to finish loading before running.',
      );
    return {
      project_id: this.projectId,
      source_kind: this.sourceKind,
      metadata_version: this.metadataVersion,
      entrypoint_file_id: this.summary.entrypoint,
      runtime: selectedRuntime,
      stdin_mode: stdinMode,
      files: documents.map((file) => ({
        file_id: file.metadata.id,
        document_id: file.metadata.document_id,
        generation: file.metadata.generation,
        path: file.metadata.path,
        source: file.text.toString(),
      })),
    };
  }

  matchesSnapshot(
    snapshot: Pick<
      ProjectSnapshot,
      'project_id' | 'metadata_version' | 'runtime'
    >,
    sourceRevision: number,
  ): boolean {
    return (
      !this.destroyed &&
      snapshot.project_id === this.projectId &&
      snapshot.metadata_version === this.metadataVersion &&
      sourceRevision === this.sourceRevision
    );
  }

  defaultRuntime(): RuntimeIdentity | undefined {
    return runtimeProfile(this.runtimeId)?.identity;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const file of this.records.values()) file.destroy();
    this.records.clear();
    this.listeners.clear();
  }
}
