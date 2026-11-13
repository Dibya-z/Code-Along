import * as Y from 'yjs';
import { RUN_LIMITS, sourceBytes } from '@code-along/contracts/execution';
import type { ProjectFile } from '../../projects/types.ts';
import { EditorController } from './controller.ts';

const SEED = Symbol('immutable-starter');
export const LOCAL_EDIT = Symbol('local-editor-change');
export type FileMetadata = Omit<ProjectFile, 'initial_source'>;
function metadataValue(value: FileMetadata): Readonly<FileMetadata> {
  return Object.freeze({
    id: value.id,
    document_id: value.document_id,
    generation: value.generation,
    path: value.path,
    kind: value.kind,
    initial_sha256: value.initial_sha256,
  });
}

/** One canonical source model per server document/generation; never React/DOM text. */
export class EditorDocument {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText('source');
  readonly undo = new Y.UndoManager(this.text, {
    trackedOrigins: new Set([LOCAL_EDIT]),
  });
  readonly controller = new EditorController(() =>
    this.loaded && !this.disposed ? this.text.toString() : null,
  );
  private value: Readonly<FileMetadata>;
  private baseline = '';
  loaded = false;
  disposed = false;
  revision = 0;

  constructor(
    metadata: FileMetadata,
    private readonly changed: (file: EditorDocument, seeded: boolean) => void,
  ) {
    this.value = metadataValue(metadata);
    this.text.observe(this.observe);
  }

  get metadata(): Readonly<FileMetadata> {
    return this.value;
  }
  get dirty(): boolean {
    return this.loaded && this.text.toString() !== this.baseline;
  }

  private observe = (
    _event: Y.YTextEvent,
    transaction: Y.Transaction,
  ): void => {
    if (this.disposed || transaction.origin === SEED) return;
    this.revision++;
    this.changed(this, false);
  };

  updateMetadata(metadata: FileMetadata): void {
    this.value = metadataValue(metadata);
  }

  seed(source: string): void {
    if (this.disposed || this.loaded) return;
    if (this.text.length !== 0)
      throw new Error('This document already contains source.');
    this.baseline = source;
    this.loaded = true;
    this.doc.transact(() => this.text.insert(0, source), SEED);
    this.revision++;
    this.changed(this, true);
  }

  replace(source: string): void {
    if (!this.loaded || this.disposed)
      throw new Error('This file is not ready for editing.');
    if (sourceBytes(source).length > RUN_LIMITS.fileBytes)
      throw new Error(
        'A Python file supports at most 128 KiB of UTF-8 source.',
      );
    if (source === this.text.toString()) return;
    this.undo.stopCapturing();
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, source);
    }, LOCAL_EDIT);
    this.undo.stopCapturing();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.destroy();
    this.text.unobserve(this.observe);
    this.undo.destroy();
    this.doc.destroy();
  }
}
