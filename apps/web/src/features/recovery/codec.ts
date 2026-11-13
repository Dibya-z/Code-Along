import * as Y from 'yjs';
import { MAX_CHECKPOINT_STATE_BYTES } from '@code-along/contracts/collaboration';
import {
  isRunnerId,
  RUN_LIMITS,
  sha256,
  sourceBytes,
} from '@code-along/contracts/execution';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import { runtimeProfile } from '@code-along/contracts/execution/profiles';
import type { FileMetadata } from '../editor/model/document.ts';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
export const RECOVERY_LIMITS = Object.freeze({
  binaryBytes: 8 * 1024 * 1024,
  accountBytes: 32 * 1024 * 1024,
  records: 32,
});
export interface RecoveryFile {
  readonly metadata: FileMetadata;
  readonly initial_source: string;
  readonly state: Uint8Array;
  readonly state_sha256: string;
  readonly source_sha256: string;
}
export interface RecoveryData {
  readonly version: 1;
  readonly origin: 'm2-local' | 'm3-canonical';
  readonly account_id: string;
  readonly project_id: string;
  readonly kind: 'project' | 'local_draft';
  readonly name: string;
  readonly metadata_version: number;
  readonly entrypoint_file_id: string;
  readonly runtime_id: string;
  readonly files: readonly RecoveryFile[];
}
export interface ValidatedRecovery {
  readonly data: RecoveryData;
  readonly sources: ReadonlyMap<string, string>;
  readonly bytes: number;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  return (
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}
function invalid(): never {
  throw new Error(
    'Local recovery could not be validated. The stored copy has been preserved.',
  );
}
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateRecoveryBinary(state: Uint8Array): string {
  if (
    !(state instanceof Uint8Array) ||
    !(state.buffer instanceof ArrayBuffer) ||
    state.length < 1 ||
    state.length > MAX_CHECKPOINT_STATE_BYTES
  )
    invalid();
  const doc = new Y.Doc();
  try {
    const decoded = Y.decodeUpdate(state);
    if (decoded.structs.length > 16_384) invalid();
    let span = 0;
    for (const item of decoded.structs) {
      span += item.length;
      if (
        !Number.isSafeInteger(item.length) ||
        item.length < 1 ||
        span > 8 * MAX_CHECKPOINT_STATE_BYTES
      )
        invalid();
      if (item instanceof Y.GC) continue;
      if (
        !(item instanceof Y.Item) ||
        !(
          item.content instanceof Y.ContentString ||
          item.content instanceof Y.ContentDeleted
        ) ||
        (typeof item.parent === 'string' && item.parent !== 'source') ||
        item.parentSub !== null
      )
        invalid();
    }
    Y.applyUpdate(doc, state);
    if (
      doc.store.pendingStructs !== null ||
      doc.store.pendingDs !== null ||
      [...doc.share.keys()].some((key) => key !== 'source')
    )
      invalid();
    const text = doc.getText('source');
    if (
      Object.keys(text.getAttributes()).length ||
      sourceBytes(text.toString()).length > RUN_LIMITS.fileBytes
    )
      invalid();
    return text.toString();
  } catch {
    return invalid();
  } finally {
    doc.destroy();
  }
}
/** Local bytes never become server state/receipts. Validate before replacing any live document. */
export async function validateRecovery(
  value: unknown,
): Promise<ValidatedRecovery> {
  if (
    !object(value) ||
    !exact(value, [
      'version',
      'origin',
      'account_id',
      'project_id',
      'kind',
      'name',
      'metadata_version',
      'entrypoint_file_id',
      'runtime_id',
      'files',
    ]) ||
    value['version'] !== 1 ||
    !['m2-local', 'm3-canonical'].includes(String(value['origin'])) ||
    (value['origin'] === 'm3-canonical' && value['kind'] !== 'project') ||
    !isRunnerId(value['account_id']) ||
    !isRunnerId(value['project_id']) ||
    !isRunnerId(value['entrypoint_file_id']) ||
    !['project', 'local_draft'].includes(String(value['kind'])) ||
    typeof value['name'] !== 'string' ||
    !value['name'].trim() ||
    value['name'].length > 120 ||
    !Number.isSafeInteger(value['metadata_version']) ||
    Number(value['metadata_version']) < 1 ||
    !runtimeProfile(value['runtime_id']) ||
    !Array.isArray(value['files']) ||
    value['files'].length < 1 ||
    value['files'].length > RUN_LIMITS.files
  )
    invalid();
  const files: RecoveryFile[] = [],
    ids = new Set<string>(),
    documents = new Set<string>(),
    sources = new Map<string, string>();
  let binaryBytes = 0,
    bytes = 1024;
  for (const entry of value['files']) {
    if (
      !object(entry) ||
      !exact(entry, [
        'metadata',
        'initial_source',
        'state',
        'state_sha256',
        'source_sha256',
      ]) ||
      !object(entry['metadata'])
    )
      invalid();
    const meta = entry['metadata'];
    if (
      !exact(meta, [
        'id',
        'document_id',
        'generation',
        'path',
        'kind',
        'initial_sha256',
      ]) ||
      !isRunnerId(meta['id']) ||
      !isRunnerId(meta['document_id']) ||
      !Number.isSafeInteger(meta['generation']) ||
      Number(meta['generation']) < 1 ||
      typeof meta['path'] !== 'string' ||
      meta['kind'] !== 'python' ||
      !digest(meta['initial_sha256']) ||
      ids.has(meta['id']) ||
      documents.has(meta['document_id']) ||
      typeof entry['initial_source'] !== 'string' ||
      !digest(entry['state_sha256']) ||
      !digest(entry['source_sha256'])
    )
      invalid();
    const raw = entry['state'];
    if (
      !(raw instanceof Uint8Array) ||
      !(raw.buffer instanceof ArrayBuffer) ||
      raw.length < 1 ||
      raw.length > MAX_CHECKPOINT_STATE_BYTES
    )
      invalid();
    binaryBytes += raw.length;
    if (binaryBytes > RECOVERY_LIMITS.binaryBytes) invalid();
    const state = Uint8Array.from(raw),
      baseline = sourceBytes(entry['initial_source']);
    if (
      baseline.length > RUN_LIMITS.fileBytes ||
      (await sha256(baseline)) !== meta['initial_sha256'] ||
      (await sha256(state)) !== entry['state_sha256']
    )
      invalid();
    const source = validateRecoveryBinary(state);
    if ((await sha256(sourceBytes(source))) !== entry['source_sha256'])
      invalid();
    ids.add(meta['id']);
    documents.add(meta['document_id']);
    sources.set(meta['id'], source);
    const metadata: FileMetadata = Object.freeze({
      id: meta['id'],
      document_id: meta['document_id'],
      generation: Number(meta['generation']),
      path: meta['path'],
      kind: 'python',
      initial_sha256: meta['initial_sha256'],
    });
    files.push(
      Object.freeze({
        metadata,
        initial_source: entry['initial_source'],
        state,
        state_sha256: entry['state_sha256'],
        source_sha256: entry['source_sha256'],
      }),
    );
    bytes += state.length + baseline.length + 1024;
  }
  validatePythonPaths(files.map((file) => file.metadata.path));
  if (!ids.has(value['entrypoint_file_id'])) invalid();
  const data = Object.freeze({
    version: 1 as const,
    origin: value['origin'] as RecoveryData['origin'],
    account_id: value['account_id'],
    project_id: value['project_id'],
    kind: value['kind'] as RecoveryData['kind'],
    name: value['name'],
    metadata_version: Number(value['metadata_version']),
    entrypoint_file_id: value['entrypoint_file_id'],
    runtime_id: String(value['runtime_id']),
    files: Object.freeze(files),
  });
  return Object.freeze({ data, sources, bytes });
}
export function recoveryStamp(workspace: EditorWorkspace): string {
  return `${workspace.sourceRevision}:${workspace.metadataRevision}`;
}
export async function captureRecovery(
  workspace: EditorWorkspace,
  name: string,
): Promise<ValidatedRecovery> {
  const input = workspace.snapshotInput();
  // Capture all binary states/baselines synchronously before hashing any copied value.
  const copied = input.files.map((file) => {
    const document = workspace.file(file.file_id)!;
    return {
      metadata: { ...document.metadata },
      initial_source: document.initialSource,
      state: Y.encodeStateAsUpdate(document.doc),
      source: file.source,
    };
  });
  const files = await Promise.all(
    copied.map(async ({ source, ...file }) => ({
      ...file,
      state_sha256: await sha256(file.state),
      source_sha256: await sha256(sourceBytes(source)),
    })),
  );
  return validateRecovery({
    version: 1,
    origin: workspace.canonical ? 'm3-canonical' : 'm2-local',
    account_id: workspace.accountId,
    project_id: workspace.projectId,
    kind: input.source_kind,
    name,
    metadata_version: input.metadata_version,
    entrypoint_file_id: input.entrypoint_file_id,
    runtime_id: input.runtime.runtime_id,
    files,
  });
}
export function recoveryMatches(
  workspace: EditorWorkspace,
  recovery: ValidatedRecovery,
): boolean {
  const data = recovery.data,
    current = workspace.documents();
  return (
    data.account_id === workspace.accountId &&
    data.origin === (workspace.canonical ? 'm3-canonical' : 'm2-local') &&
    data.project_id === workspace.projectId &&
    current.length === data.files.length &&
    data.files.every((file) => {
      const live = workspace.file(file.metadata.id)?.metadata;
      return (
        live?.document_id === file.metadata.document_id &&
        live.generation === file.metadata.generation &&
        live.initial_sha256 === file.metadata.initial_sha256
      );
    })
  );
}
