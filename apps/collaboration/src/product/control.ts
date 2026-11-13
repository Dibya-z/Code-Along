import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  reviewedRuntime,
  type RuntimeIdentity,
} from '@code-along/contracts/execution/profiles';
import { validatePythonPaths } from '@code-along/contracts/execution/project';
import type { CheckpointStore } from '../persistence/checkpoint-store.ts';
import { stateHash, validateSource } from '../persistence/binary-state.ts';
import { exact, record, safeInteger, uuid, DIGEST } from './admission.ts';
import { LIMITS } from './limits.ts';
import { seedState, type ProductContext } from './product-server.ts';

export const HELPER_RELEASE = Object.freeze({
  release_id: 'code-along-python-helpers-v1',
  source_sha256:
    '4b1ccdc64d339bad3c96154b465214f94e414b8b230cd50e59a478ca7fce51b1',
});
interface CaptureFile {
  file_id: string;
  document_id: string;
  generation: number;
  path: string;
  initial_source: string;
  initial_sha256: string;
}
interface Capture {
  version: 1;
  capture_id: string;
  project_id: string;
  metadata_version: number;
  entrypoint_file_id: string;
  runtime: RuntimeIdentity;
  helper_release: typeof HELPER_RELEASE;
  files: CaptureFile[];
}
interface CapturedFile {
  file_id: string;
  document_id: string;
  generation: number;
  path: string;
  source: string;
  sha256: string;
}
export interface RevisionManifest {
  protocol: 'code-along.revision';
  version: 1;
  project_id: string;
  metadata_version: number;
  entrypoint_file_id: string;
  runtime: RuntimeIdentity;
  helper_release: typeof HELPER_RELEASE;
  files: CapturedFile[];
  sha256: string;
}
export function parseCapture(value: unknown): Capture {
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'capture_id',
      'project_id',
      'metadata_version',
      'entrypoint_file_id',
      'runtime',
      'helper_release',
      'files',
    ]) ||
    value['version'] !== 1 ||
    !uuid(value['capture_id']) ||
    !uuid(value['project_id']) ||
    !safeInteger(value['metadata_version'], 1) ||
    !uuid(value['entrypoint_file_id']) ||
    !reviewedRuntime(value['runtime']) ||
    !record(value['helper_release']) ||
    !exact(value['helper_release'], ['release_id', 'source_sha256']) ||
    value['helper_release']['release_id'] !== HELPER_RELEASE.release_id ||
    value['helper_release']['source_sha256'] !== HELPER_RELEASE.source_sha256 ||
    !Array.isArray(value['files']) ||
    value['files'].length < 1 ||
    value['files'].length > 20
  )
    throw new Error('invalid_capture');
  const ids = new Set<string>(),
    documents = new Set<string>();
  let total = 0;
  for (const file of value['files']) {
    if (
      !record(file) ||
      !exact(file, [
        'file_id',
        'document_id',
        'generation',
        'path',
        'initial_source',
        'initial_sha256',
      ]) ||
      !uuid(file['file_id']) ||
      !uuid(file['document_id']) ||
      !safeInteger(file['generation'], 1) ||
      typeof file['path'] !== 'string' ||
      typeof file['initial_source'] !== 'string' ||
      typeof file['initial_sha256'] !== 'string' ||
      !DIGEST.test(file['initial_sha256']) ||
      ids.has(file['file_id']) ||
      documents.has(file['document_id'])
    )
      throw new Error('invalid_capture');
    validateSource(file['initial_source']);
    if (
      stateHash(Buffer.from(file['initial_source'], 'utf8')) !==
      file['initial_sha256']
    )
      throw new Error('invalid_capture');
    total += Buffer.byteLength(file['initial_source'], 'utf8');
    ids.add(file['file_id']);
    documents.add(file['document_id']);
  }
  if (total > 1024 * 1024 || !ids.has(value['entrypoint_file_id']))
    throw new Error('invalid_capture');
  validatePythonPaths(value['files'].map((file) => (file as CaptureFile).path));
  return value as unknown as Capture;
}
export function revisionHash(
  manifest: Omit<RevisionManifest, 'sha256'>,
): string {
  const r = manifest.runtime,
    h = manifest.helper_release;
  return stateHash(
    Buffer.from(
      JSON.stringify([
        'code-along.revision',
        1,
        manifest.project_id,
        manifest.metadata_version,
        manifest.entrypoint_file_id,
        r.runtime_id,
        r.manifest_sha256,
        r.engine,
        r.engine_version,
        r.python_version,
        h.release_id,
        h.source_sha256,
        manifest.files.map((f) => [
          f.file_id,
          f.document_id,
          f.generation,
          f.path,
          f.sha256,
          f.source,
        ]),
      ]),
      'utf8',
    ),
  );
}
export interface ControlOptions {
  store: Pick<CheckpointStore, 'initialize'>;
  hocuspocus: Hocuspocus<ProductContext>;
  invalidate: (ids: string[]) => void;
  pinRooms?: (names: string[]) => {
    release: () => void;
    verify: (name: string, document: Y.Doc | undefined) => void;
  };
}
export async function captureRevision(
  input: unknown,
  options: ControlOptions,
): Promise<{ version: 1; capture_id: string; manifest: RevisionManifest }> {
  const request = parseCapture(input),
    cold = new Map<string, Y.Doc>();
  const pin = options.pinRooms?.(
    request.files.map((file) => `${file.document_id}:${file.generation}`),
  );
  try {
    // Cold loads are serial and bounded; never replace or seed an existing live room.
    for (const file of request.files) {
      const name = `${file.document_id}:${file.generation}`;
      if (options.hocuspocus.documents.has(name)) continue;
      const stored = await options.store.initialize(
        {
          document_id: file.document_id,
          generation: file.generation,
          project_id: request.project_id,
          file_id: file.file_id,
          initial_sha256: file.initial_sha256,
        },
        seedState(file.initial_source, file.initial_sha256),
      );
      const doc = new Y.Doc();
      Y.applyUpdate(doc, stored.binary);
      cold.set(name, doc);
    }
    // There are no awaits from here through the complete source copy and digest.
    // Prefer any room which became live while another document was cold-loading.
    let total = 0;
    const files = request.files
      .map((file) => {
        const name = `${file.document_id}:${file.generation}`,
          doc = options.hocuspocus.documents.get(name) ?? cold.get(name);
        pin?.verify(name, options.hocuspocus.documents.get(name));
        if (!doc) throw new Error('capture_unavailable');
        const source = doc.getText('source').toString();
        validateSource(source);
        total += Buffer.byteLength(source, 'utf8');
        return {
          file_id: file.file_id,
          document_id: file.document_id,
          generation: file.generation,
          path: file.path,
          source,
          sha256: stateHash(Buffer.from(source, 'utf8')),
        };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (total > 1024 * 1024) throw new Error('capture_limit');
    const manifest = {
      protocol: 'code-along.revision' as const,
      version: 1 as const,
      project_id: request.project_id,
      metadata_version: request.metadata_version,
      entrypoint_file_id: request.entrypoint_file_id,
      runtime: request.runtime,
      helper_release: HELPER_RELEASE,
      files,
    };
    return {
      version: 1,
      capture_id: request.capture_id,
      manifest: { ...manifest, sha256: revisionHash(manifest) },
    };
  } finally {
    for (const doc of cold.values()) doc.destroy();
    pin?.release();
  }
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > LIMITS.controlBytes) throw new Error('control_limit');
    chunks.push(bytes);
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
export async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlOptions,
): Promise<void> {
  try {
    if (request.headers['content-type'] !== 'application/json')
      throw new Error('invalid_control');
    const value = await readBody(request);
    let result: unknown;
    if (request.url === '/internal/v1/invalidations/') {
      if (
        !record(value) ||
        !exact(value, ['version', 'event_id', 'lease_ids', 'reason']) ||
        value['version'] !== 1 ||
        !uuid(value['event_id']) ||
        value['reason'] !== 'authorization_changed' ||
        !Array.isArray(value['lease_ids']) ||
        value['lease_ids'].length > 128 ||
        !value['lease_ids'].every(uuid)
      )
        throw new Error('invalid_control');
      options.invalidate(value['lease_ids']);
      result = { version: 1, status: 'ok' };
    } else result = await captureRevision(value, options);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: 1, error: 'unavailable' }));
  }
}
