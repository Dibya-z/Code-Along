import { Server, type Connection } from '@hocuspocus/server';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
  MAX_CHECKPOINT_MESSAGE_BYTES,
  parseCheckpointRequest,
  type CheckpointRequest,
} from '@code-along/contracts/collaboration';
import {
  CheckpointStore,
  type DocumentScope,
} from '../persistence/checkpoint-store.ts';
import {
  CheckpointStoreError,
  mergeBinaryState,
} from '../persistence/binary-state.ts';

export interface Admission extends DocumentScope {
  readonly client_session_id: string;
  readonly writable: boolean;
}
export interface ProofServerOptions {
  store: CheckpointStore;
  admit: (token: string, name: string) => Promise<Admission>;
  /** Explicit test/measurement control. Production must use a measured interval. */
  debounce?: number;
}

const empty = new Y.Doc();
const emptyState = Y.encodeStateAsUpdate(empty);
empty.destroy();

/** Loopback compatibility proof. Not a deployable service or admission API. */
export function createProofServer(
  options: ProofServerOptions,
): Server<Admission> {
  const blocked = new Set<string>();
  const busy = new Set<string>();
  const fail = () => {
    throw new Error('collaboration_rejected');
  };
  function scope(name: string): DocumentScope {
    const parts = name.split(':');
    const generation = Number(parts[1]);
    if (
      parts.length !== 2 ||
      !/^[0-9a-f-]{36}$/.test(parts[0] ?? '') ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      return fail();
    return { document_id: parts[0]!, generation };
  }
  function belongs(grant: Admission, name: string): boolean {
    return name === `${grant.document_id}:${grant.generation}`;
  }
  function admittedRequest(
    connection: Connection<Admission>,
    name: string,
    frame: string,
  ): CheckpointRequest {
    const parsed = parseCheckpointRequest(frame);
    if (!parsed.ok || !belongs(connection.context, name)) return fail();
    const r = parsed.value;
    if (
      r.document_id !== connection.context.document_id ||
      r.generation !== connection.context.generation ||
      r.client_session_id !== connection.context.client_session_id
    )
      return fail();
    return r;
  }
  const server = new Server<Admission>({
    address: '127.0.0.1',
    port: 0,
    stopOnSignals: false,
    quiet: true,
    debounce: options.debounce ?? 40,
    maxDebounce: options.debounce ?? 100,
    websocketOptions: {
      maxPayload: MAX_CHECKPOINT_MESSAGE_BYTES + 4096,
      perMessageDeflate: false,
    },
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const grant = await options.admit(token, documentName);
      if (!belongs(grant, documentName)) return fail();
      connectionConfig.readOnly = !grant.writable;
      return grant;
    },
    async onLoadDocument({ documentName, document }) {
      const stored = await options.store.initialize(
        scope(documentName),
        emptyState,
      );
      Y.applyUpdate(document, stored.binary);
      blocked.delete(documentName);
    },
    async beforeHandleMessage({ documentName, connection, update }) {
      if (!belongs(connection.context, documentName)) return fail();
      try {
        if (update.byteLength > MAX_CHECKPOINT_MESSAGE_BYTES + 4096)
          return fail();
        // Hocuspocus supplies the complete frame (including routing name).
        const decoder = decoding.createDecoder(update);
        decoding.readVarString(decoder);
        const opcode = decoding.readVarUint(decoder);
        if (![0, 1, 3, 5, 7, 8].includes(opcode)) return fail();
        if (opcode === 5)
          admittedRequest(
            connection,
            documentName,
            decoding.readVarString(decoder),
          );
      } catch {
        return fail();
      }
    },
    async beforeSync({ documentName, document, connection, type, payload }) {
      if (type === 0) return;
      if (!connection.context.writable) return; // Built-in readonly path checks/acks without applying.
      if (blocked.has(documentName)) return fail();
      mergeBinaryState(Y.encodeStateAsUpdate(document), payload);
    },
    async onStateless({ connection, documentName, document, payload }) {
      // This hook is not awaited by MessageReceiver; contain every failure here.
      let request: CheckpointRequest;
      try {
        request = admittedRequest(connection, documentName, payload);
      } catch {
        return;
      }
      const respondError = (code: string) => {
        const { state_base64: _state, ...envelope } = request;
        void _state;
        connection.sendStateless(
          JSON.stringify({ ...envelope, type: 'checkpoint.error', code }),
        );
      };
      if (!connection.context.writable) {
        respondError('read_only');
        return;
      }
      if (blocked.has(documentName)) {
        respondError('storage_unavailable');
        return;
      }
      if (busy.has(connection.socketId)) {
        respondError('resource_limit');
        return;
      }
      busy.add(connection.socketId);
      try {
        const receipt = await options.store.saveCheckpoint(
          JSON.stringify(request),
        );
        // Integrate the canonical state, including offline checkpoint edits,
        // without re-inserting plaintext or replacing the live document.
        const stored = await options.store.load(request);
        Y.applyUpdate(document, stored.binary);
        connection.sendStateless(JSON.stringify(receipt));
      } catch (error) {
        const code =
          error instanceof CheckpointStoreError
            ? error.code
            : 'storage_unavailable';
        if (code === 'storage_unavailable' || code === 'resource_limit')
          blocked.add(documentName);
        respondError(code);
      } finally {
        busy.delete(connection.socketId);
      }
    },
    async onStoreDocument({ documentName, document }) {
      try {
        await options.store.saveState(
          scope(documentName),
          Y.encodeStateAsUpdate(document),
        );
      } catch {
        blocked.add(documentName); /* No receipt; next write fails closed. */
      }
    },
  });
  return server;
}
