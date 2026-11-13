import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import {
  Hocuspocus,
  type Connection,
  type WebSocketLike,
} from '@hocuspocus/server';
import { WebSocketServer, WebSocket } from 'ws';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
  PRESENCE_PROTOCOL,
  PRESENCE_VERSION,
  type PresenceIdentity,
} from '@code-along/contracts/collaboration/presence';
import {
  parseCheckpointRequest,
  type CheckpointRequest,
} from '@code-along/contracts/collaboration';
import {
  CheckpointStoreError,
  mergeBinaryState,
  stateHash,
  validateSource,
} from '../persistence/binary-state.ts';
import type {
  CheckpointStore,
  WriteGuard,
} from '../persistence/checkpoint-store.ts';
import {
  AdmissionError,
  isToken,
  roomScope,
  sessionCookie,
  type AdmissionClient,
  type Lease,
} from './admission.ts';
import { stampAwareness } from './awareness.ts';
import { IngressBudget, LIMITS } from './limits.ts';
import { handleControl } from './control.ts';

export interface ProductContext {
  lease: Lease;
  transport: Transport;
}
interface Transport {
  readonly id: string;
  readonly socket: WebSocket;
  readonly cookie: string;
  readonly origin: string;
  readonly budget: IngressBudget;
  readonly leases: Map<string, Lease>;
  readonly authBytes: Map<string, number>;
  readonly addresses: Map<string, string>;
  closed: boolean;
  pendingBytes: number;
  pendingMessages: number;
}
export interface ProductServerOptions {
  store: Pick<
    CheckpointStore,
    'initialize' | 'load' | 'saveState' | 'saveCheckpoint'
  >;
  admission: AdmissionClient;
  appOrigin: string;
  sessionCookieName: string;
  controlSecret: string;
  host?: string;
  port?: number;
  debounce?: number;
  /** Injectable monotonic clock for deterministic lease tests. */
  now?: () => number;
}
function rejected(
  code = 4403,
  reason = 'unauthorized',
): { code: number; reason: string } {
  return { code, reason };
}
export function seedState(source: string, digest: string): Uint8Array {
  validateSource(source);
  if (stateHash(Buffer.from(source, 'utf8')) !== digest)
    throw new CheckpointStoreError('invalid_state');
  const doc = new Y.Doc();
  try {
    doc.getText('source').insert(0, source);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
interface Frame {
  name: string;
  address: string;
  opcode: number;
}
function strictString(decoder: decoding.Decoder): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    decoding.readVarUint8Array(decoder),
  );
}
/** Parse before Hocuspocus allocates document queues; reject trailing/unknown data. */
export function inspectFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength > LIMITS.frameBytes)
    throw rejected(1013, 'resource_limit');
  const decoder = decoding.createDecoder(bytes);
  const address = strictString(decoder),
    parts = address.split('\0'),
    name = parts[0]!;
  if (
    parts.length > 2 ||
    (parts[1] !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(parts[1]))
  )
    throw rejected();
  roomScope(name);
  const opcode = decoding.readVarUint(decoder);
  if (opcode === 0 || opcode === 4) {
    const type = decoding.readVarUint(decoder);
    if (![0, 1, 2].includes(type)) throw rejected();
    decoding.readVarUint8Array(decoder);
  } else if (opcode === 1) {
    if (decoding.readVarUint8Array(decoder).byteLength > LIMITS.awarenessBytes)
      throw rejected(1013, 'resource_limit');
  } else if (opcode === 2) {
    if (decoding.readVarUint(decoder) !== 0 || !isToken(strictString(decoder)))
      throw rejected();
    if (
      decoding.hasContent(decoder) &&
      !/^[0-9A-Za-z.+_-]{1,40}$/.test(strictString(decoder))
    )
      throw rejected();
  } else if (opcode === 5) {
    if (!parseCheckpointRequest(strictString(decoder)).ok) throw rejected();
  } else if (![3, 7].includes(opcode)) throw rejected();
  if (decoding.hasContent(decoder)) throw rejected();
  return { name, address, opcode };
}
export function createProductServer(options: ProductServerOptions) {
  const app = new URL(options.appOrigin);
  if (
    !['https:', 'http:'].includes(app.protocol) ||
    app.origin !== options.appOrigin ||
    !/^[\x21-\x7e]{32,256}$/.test(options.controlSecret)
  )
    throw new Error('invalid_collaboration_configuration');
  const now = options.now ?? (() => performance.now());
  const transports = new Set<Transport>();
  const owners = new Map<string, Lease>();
  const leases = new Map<string, ProductContext>();
  const blocked = new Set<string>();
  const loading = new Set<string>();
  const pins = new Map<string, number>();
  const roomEpochs = new Map<string, number>();
  const checkpointBusy = new Set<string>();
  const persistence = new Set<Promise<unknown>>();
  let draining = false;
  let pendingBytes = 0,
    pendingMessages = 0;
  function reserveIngress(transport: Transport, bytes: number): void {
    if (pendingBytes + bytes > 32 * 1024 * 1024 || pendingMessages + 1 > 1024)
      throw rejected(1013, 'resource_limit');
    transport.budget.reserve(bytes, now());
    transport.pendingBytes += bytes;
    transport.pendingMessages++;
    pendingBytes += bytes;
    pendingMessages++;
  }
  function releaseIngress(transport: Transport, bytes: number): void {
    const releasing = Math.min(transport.pendingBytes, bytes);
    if (releasing === 0) return;
    transport.budget.release(releasing);
    transport.pendingBytes -= releasing;
    transport.pendingMessages = Math.max(0, transport.pendingMessages - 1);
    pendingBytes -= releasing;
    pendingMessages = Math.max(0, pendingMessages - 1);
  }
  function releaseIngressAll(transport: Transport): void {
    pendingBytes -= transport.pendingBytes;
    pendingMessages -= transport.pendingMessages;
    transport.pendingBytes = 0;
    transport.pendingMessages = 0;
  }
  const track = <T>(work: Promise<T>): Promise<T> => {
    persistence.add(work);
    void work.finally(() => persistence.delete(work)).catch(() => undefined);
    return work;
  };
  function closeTransport(transport: Transport, code: number, reason: string) {
    if (transport.closed) return;
    transport.closed = true;
    releaseIngressAll(transport);
    for (const lease of transport.leases.values())
      release(lease, { code, reason });
    transport.socket.close(code, reason);
  }
  function release(lease: Lease, event = rejected(4403, 'unauthorized')) {
    lease.active = false;
    const key = `${lease.document_name}:${lease.grant.awareness_client_id}`;
    if (owners.get(key) === lease) owners.delete(key);
    leases.delete(lease.grant.lease_id);
    const room = hocuspocus.documents.get(lease.document_name);
    if (room) {
      // Hocuspocus removes the connection-owned awareness on disconnect.
      for (const connection of room.connections.keys())
        if (connection.context.lease === lease) connection.close(event);
    }
  }
  function guard(lease: Lease, write = false): WriteGuard {
    return () => {
      if (
        !lease.active ||
        now() >= lease.deadline ||
        leases.get(lease.grant.lease_id)?.lease !== lease
      )
        throw new CheckpointStoreError('unauthorized');
      if (write && lease.grant.scope !== 'write')
        throw new CheckpointStoreError('unauthorized');
    };
  }
  function requireLive(
    context: ProductContext,
    name: string,
    write = false,
  ): void {
    try {
      if (context.lease.document_name !== name || context.transport.closed)
        throw new Error();
      guard(context.lease, write)();
    } catch {
      closeTransport(context.transport, 4401, 'lease_expired');
      throw rejected(4401, 'lease_expired');
    }
  }
  function failRoom(name: string): void {
    blocked.add(name);
    for (const context of [...leases.values()])
      if (context.lease.document_name === name)
        closeTransport(context.transport, 1013, 'storage_unavailable');
  }
  function admittedRequest(
    connection: Connection<ProductContext>,
    name: string,
    payload: string,
  ): CheckpointRequest {
    requireLive(connection.context, name);
    const parsed = parseCheckpointRequest(payload),
      grant = connection.context.lease.grant;
    if (
      !parsed.ok ||
      parsed.value.document_id !== grant.document.id ||
      parsed.value.generation !== grant.document.generation ||
      parsed.value.client_session_id !== grant.client_session_id
    )
      throw rejected();
    return parsed.value;
  }
  const hocuspocus = new Hocuspocus<ProductContext>({
    quiet: true,
    timeout: 15_000,
    debounce: options.debounce ?? 350,
    maxDebounce: 2000,
    unloadImmediately: false,
    maxPendingDocuments: LIMITS.documentsPerSocket,
    maxUnauthenticatedQueueSize: LIMITS.socketPendingBytes,
    maxUnauthenticatedQueueMessages: LIMITS.socketPendingMessages,
    async onAuthenticate({ token, documentName, context, connectionConfig }) {
      const transport = context.transport;
      try {
        if (transport.closed || transport.leases.has(documentName))
          throw rejected();
        roomScope(documentName);
        if (
          !hocuspocus.documents.has(documentName) &&
          !loading.has(documentName) &&
          hocuspocus.documents.size + loading.size >= LIMITS.rooms
        )
          throw rejected(1013, 'resource_limit');
        const room = hocuspocus.documents.get(documentName);
        const pending = [...leases.values()].filter(
          (value) => value.lease.document_name === documentName,
        ).length;
        if (
          (room?.getConnectionsCount() ?? 0) >= LIMITS.connectionsPerRoom ||
          pending >= LIMITS.connectionsPerRoom
        )
          throw rejected(1013, 'resource_limit');
        const connection_id = randomUUID();
        const result = await options.admission.consume({
          ticket: token,
          document_name: documentName,
          connection_id,
          transport_id: transport.id,
          origin: transport.origin,
          cookie: transport.cookie,
        });
        if (transport.closed || now() >= result.started + result.grant.ttl_ms)
          throw rejected(4401, 'lease_expired');
        const grant = result.grant;
        if (
          [...leases.values()].filter(
            (value) => value.lease.document_name === documentName,
          ).length >= LIMITS.connectionsPerRoom ||
          (!hocuspocus.documents.has(documentName) &&
            !loading.has(documentName) &&
            new Set([
              ...hocuspocus.documents.keys(),
              ...loading,
              ...[...leases.values()].map((value) => value.lease.document_name),
            ]).size >= LIMITS.rooms)
        )
          throw rejected(1013, 'resource_limit');
        // AdmissionClient implementations are trusted service adapters, but names stay bound here too.
        if (
          `${grant.document.id}:${grant.document.generation}` !== documentName
        )
          throw rejected();
        const ownerKey = `${documentName}:${grant.awareness_client_id}`;
        if (owners.get(ownerKey)?.active)
          throw rejected(1013, 'resource_limit');
        const lease: Lease = {
          grant,
          connection_id,
          transport_id: transport.id,
          document_name: documentName,
          deadline: result.started + grant.ttl_ms,
          renewAt: result.started + Math.min(10_000, grant.ttl_ms / 3),
          active: true,
        };
        const authorized = { transport, lease };
        owners.set(ownerKey, lease);
        transport.leases.set(documentName, lease);
        leases.set(grant.lease_id, authorized);
        connectionConfig.readOnly = grant.scope !== 'write';
        return authorized;
      } catch (error) {
        const unavailable =
          error instanceof AdmissionError &&
          ['unavailable', 'resource_limit'].includes(error.code);
        closeTransport(
          transport,
          unavailable ? 1013 : 4403,
          unavailable ? 'admission_unavailable' : 'unauthorized',
        );
        throw rejected(
          unavailable ? 1013 : 4403,
          unavailable ? 'admission_unavailable' : 'unauthorized',
        );
      } finally {
        const bytes = transport.authBytes.get(documentName);
        if (bytes !== undefined) {
          releaseIngress(transport, bytes);
          transport.authBytes.delete(documentName);
        }
      }
    },
    async onLoadDocument({ documentName, document, context }) {
      loading.add(documentName);
      try {
        requireLive(context, documentName);
        const d = context.lease.grant.document;
        const stored = await track(
          options.store.initialize(
            {
              document_id: d.id,
              generation: d.generation,
              project_id: context.lease.grant.project_id,
              file_id: d.file_id,
              initial_sha256: d.initial_sha256,
            },
            seedState(d.initial_source, d.initial_sha256),
            guard(context.lease),
          ),
        );
        requireLive(context, documentName);
        Y.applyUpdate(document, stored.binary, {
          source: 'local',
          skipStoreHooks: true,
        });
        blocked.delete(documentName);
      } catch {
        closeTransport(context.transport, 1013, 'storage_unavailable');
        throw rejected(1013, 'storage_unavailable');
      } finally {
        loading.delete(documentName);
      }
    },
    async afterLoadDocument({ documentName }) {
      roomEpochs.set(documentName, (roomEpochs.get(documentName) ?? 0) + 1);
    },
    async beforeUnloadDocument({ documentName }) {
      if (pins.has(documentName)) throw { reason: 'capture_in_progress' };
    },
    async connected({ context, documentName, connection }) {
      requireLive(context, documentName);
      const grant = context.lease.grant;
      const identity: PresenceIdentity = {
        protocol: PRESENCE_PROTOCOL,
        version: PRESENCE_VERSION,
        type: 'presence.identity',
        document_id: grant.document.id,
        generation: grant.document.generation,
        client_session_id: grant.client_session_id,
        awareness_client_id: grant.awareness_client_id,
        user: {
          id: grant.user.id,
          display_name: grant.user.display_name,
          color: grant.user.color as PresenceIdentity['user']['color'],
        },
      };
      connection.sendStateless(JSON.stringify(identity));
    },
    async onTokenSync({ context }) {
      closeTransport(context.transport, 4403, 'unauthorized');
    },
    async beforeHandleMessage({ connection, documentName, update }) {
      requireLive(connection.context, documentName);
      try {
        inspectFrame(update);
      } catch {
        closeTransport(connection.context.transport, 4403, 'invalid_message');
        throw rejected();
      }
    },
    async afterHandleMessage({ context, update }) {
      releaseIngress(context.transport, update.byteLength);
    },
    async beforeSync({ connection, documentName, document, type, payload }) {
      requireLive(connection.context, documentName);
      if (type === 0) return;
      if (connection.context.lease.grant.scope !== 'write') return;
      if (blocked.has(documentName)) {
        closeTransport(
          connection.context.transport,
          1013,
          'storage_unavailable',
        );
        throw rejected(1013, 'storage_unavailable');
      }
      try {
        guard(connection.context.lease, true)();
        mergeBinaryState(Y.encodeStateAsUpdate(document), payload);
      } catch {
        closeTransport(connection.context.transport, 4403, 'invalid_state');
        throw rejected(4403, 'invalid_state');
      }
    },
    async beforeHandleAwareness({
      context,
      connection,
      documentName,
      document,
      states,
      removedClients,
    }) {
      if (!context || !connection) throw rejected();
      requireLive(context, documentName);
      try {
        stampAwareness(states, removedClients, context.lease.grant, document);
      } catch {
        closeTransport(context.transport, 4403, 'invalid_awareness');
        throw rejected(4403, 'invalid_awareness');
      }
    },
    async onStateless({ connection: raw, documentName, document, payload }) {
      // MessageReceiver intentionally does not await this hook. Contain all failures.
      const connection = raw as Connection<ProductContext>;
      let request: CheckpointRequest;
      try {
        request = admittedRequest(connection, documentName, payload);
      } catch {
        return;
      }
      const context = connection.context,
        lease = context.lease;
      const respond = (code: string) => {
        try {
          requireLive(context, documentName);
        } catch {
          return;
        }
        const { state_base64: _state, ...envelope } = request;
        void _state;
        connection.sendStateless(
          JSON.stringify({ ...envelope, type: 'checkpoint.error', code }),
        );
      };
      if (lease.grant.scope !== 'write') {
        respond('read_only');
        return;
      }
      if (blocked.has(documentName)) {
        respond('storage_unavailable');
        return;
      }
      if (checkpointBusy.has(lease.connection_id)) {
        respond('resource_limit');
        return;
      }
      checkpointBusy.add(lease.connection_id);
      try {
        requireLive(context, documentName, true);
        const receipt = await track(
          options.store.saveCheckpoint(
            JSON.stringify(request),
            guard(lease, true),
          ),
        );
        requireLive(context, documentName, true);
        const stored = await options.store.load(request, guard(lease));
        requireLive(context, documentName, true);
        Y.applyUpdate(document, stored.binary, {
          source: 'local',
          skipStoreHooks: true,
        });
        connection.sendStateless(JSON.stringify(receipt));
      } catch (error) {
        const code =
          error instanceof CheckpointStoreError
            ? error.code
            : 'storage_unavailable';
        respond(code);
        if (code === 'storage_unavailable' || code === 'resource_limit')
          failRoom(documentName);
      } finally {
        checkpointBusy.delete(lease.connection_id);
      }
    },
    async onStoreDocument({ documentName, document, lastContext }) {
      try {
        if (!lastContext?.lease || blocked.has(documentName)) return;
        await track(
          options.store.saveState(
            roomScope(documentName),
            Y.encodeStateAsUpdate(document),
            guard(lastContext.lease, true),
          ),
        );
      } catch (error) {
        if (
          !(error instanceof CheckpointStoreError) ||
          error.code !== 'unauthorized'
        )
          failRoom(documentName);
      }
    },
    async onDisconnect({ context, documentName }) {
      if (!context?.lease) return;
      release(context.lease);
      if (context.transport.leases.get(documentName) === context.lease)
        context.transport.leases.delete(documentName);
      context.transport.addresses.delete(documentName);
    },
    async afterUnloadDocument({ documentName }) {
      blocked.delete(documentName);
      if (!pins.has(documentName)) roomEpochs.delete(documentName);
    },
  });
  const httpServer = createServer((request, response) => {
    void handleHttp(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
  });
  httpServer.requestTimeout = 5000;
  httpServer.headersTimeout = 5000;
  httpServer.maxHeadersCount = 32;
  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: LIMITS.frameBytes,
    perMessageDeflate: false,
    maxFragments: 64,
    maxBufferedChunks: 64,
  });
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      if (
        draining ||
        request.url !== '/collab' ||
        request.method !== 'GET' ||
        request.headers.origin !== options.appOrigin ||
        transports.size >= LIMITS.connections
      )
        throw rejected();
      if (
        request.rawHeaders
          .filter((_, i) => i % 2 === 0)
          .filter((name) => name.toLowerCase() === 'origin').length !== 1
      )
        throw rejected();
      const cookie = sessionCookie(
        request.headers.cookie ?? null,
        options.sessionCookieName,
      );
      websocketServer.handleUpgrade(request, socket, head, (ws) =>
        attach(ws, cookie),
      );
    } catch {
      socket.write(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
    }
  });
  function attach(socket: WebSocket, cookie: string) {
    const transport: Transport = {
      id: randomUUID(),
      socket,
      cookie,
      origin: options.appOrigin,
      budget: new IngressBudget(),
      leases: new Map(),
      authBytes: new Map(),
      addresses: new Map(),
      closed: false,
      pendingBytes: 0,
      pendingMessages: 0,
    };
    transports.add(transport);
    const wrapper: WebSocketLike = {
      get readyState() {
        return socket.readyState;
      },
      close: (code, reason) =>
        closeTransport(transport, code ?? 1000, reason ?? 'closed'),
      send(data) {
        if (transport.closed) return;
        try {
          if (!(data instanceof Uint8Array)) throw new Error();
          const decoder = decoding.createDecoder(data),
            address = decoding.readVarString(decoder),
            name = address.split('\0')[0]!,
            opcode = decoding.readVarUint(decoder);
          const lease = transport.leases.get(name);
          if (
            opcode !== 2 &&
            (!lease || !lease.active || now() >= lease.deadline)
          ) {
            closeTransport(transport, 4401, 'lease_expired');
            return;
          }
          if (
            socket.bufferedAmount + data.byteLength >
            LIMITS.socketPendingBytes
          ) {
            closeTransport(transport, 1013, 'resource_limit');
            return;
          }
          socket.send(data);
        } catch {
          closeTransport(transport, 4403, 'invalid_message');
        }
      },
    };
    const client = hocuspocus.handleConnection(
      wrapper,
      new Request(new URL('/collab', app), {
        headers: { origin: options.appOrigin, cookie },
      }),
      { transport } as ProductContext,
    );
    socket.on('pong', () => client.touch());
    socket.on('message', (raw, isBinary) => {
      if (transport.closed) return;
      try {
        if (!isBinary) throw rejected();
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw as ArrayBuffer);
        const frame = inspectFrame(bytes);
        reserveIngress(transport, bytes.byteLength);
        if (!transport.addresses.has(frame.name)) {
          if (
            transport.addresses.size >= LIMITS.documentsPerSocket ||
            frame.opcode !== 2
          )
            throw rejected();
          transport.addresses.set(frame.name, frame.address);
          transport.authBytes.set(frame.name, bytes.byteLength);
        } else if (
          frame.opcode === 2 ||
          transport.addresses.get(frame.name) !== frame.address
        )
          throw rejected();
        client.handleMessage(bytes);
      } catch {
        closeTransport(transport, 1013, 'invalid_or_excessive_message');
      }
    });
    socket.on('close', () => {
      transport.closed = true;
      releaseIngressAll(transport);
      for (const lease of transport.leases.values()) release(lease);
      transports.delete(transport);
      client.handleClose();
    });
    socket.on('error', () =>
      closeTransport(transport, 1011, 'transport_error'),
    );
  }
  const renewing = new Set<string>();
  const interval = setInterval(() => {
    for (const context of [...leases.values()]) {
      const lease = context.lease;
      if (!lease.active) continue;
      if (now() >= lease.deadline) {
        closeTransport(context.transport, 4401, 'lease_expired');
        continue;
      }
      if (now() < lease.renewAt || renewing.has(lease.connection_id)) continue;
      renewing.add(lease.connection_id);
      void options.admission
        .renew(lease)
        .then(({ grant, started }) => {
          if (!lease.active || context.transport.closed) return;
          if (now() >= lease.deadline || now() >= started + grant.ttl_ms) {
            closeTransport(context.transport, 4401, 'lease_expired');
            return;
          }
          if (
            grant.lease_id !== lease.grant.lease_id ||
            grant.lease_token !== lease.grant.lease_token ||
            grant.scope !== lease.grant.scope ||
            grant.client_session_id !== lease.grant.client_session_id ||
            grant.awareness_client_id !== lease.grant.awareness_client_id ||
            grant.project_id !== lease.grant.project_id ||
            grant.workspace_id !== lease.grant.workspace_id ||
            grant.user.id !== lease.grant.user.id ||
            JSON.stringify(grant.document) !==
              JSON.stringify(lease.grant.document)
          ) {
            closeTransport(context.transport, 4403, 'unauthorized');
            return;
          }
          lease.grant = grant;
          lease.deadline = started + grant.ttl_ms;
          lease.renewAt = started + Math.min(10_000, grant.ttl_ms / 3);
        })
        .catch((error) => {
          if (!lease.active) return;
          if (
            error instanceof AdmissionError &&
            !['unavailable', 'resource_limit'].includes(error.code)
          )
            closeTransport(context.transport, 4403, 'unauthorized');
          else lease.renewAt = now() + 1000;
        })
        .finally(() => renewing.delete(lease.connection_id));
    }
  }, 100);
  interval.unref();
  let controls = 0;
  async function handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(draining ? 503 : 200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({ status: draining ? 'stopping' : 'ok' }));
      return;
    }
    const supplied = request.headers.authorization,
      expected = `Bearer ${options.controlSecret}`;
    if (
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (
      request.method !== 'POST' ||
      !['/internal/v1/captures/', '/internal/v1/invalidations/'].includes(
        request.url ?? '',
      )
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (draining || controls >= 2) {
      response.writeHead(503);
      response.end();
      return;
    }
    controls++;
    try {
      await handleControl(request, response, {
        store: options.store,
        hocuspocus,
        pinRooms(names) {
          const initial = new Map(
            names.map((name) => [
              name,
              {
                document: hocuspocus.documents.get(name),
                epoch: roomEpochs.get(name) ?? 0,
              },
            ]),
          );
          for (const name of names) pins.set(name, (pins.get(name) ?? 0) + 1);
          let released = false;
          return {
            verify(name, document) {
              const first = initial.get(name);
              if (
                !first ||
                (first.document && document !== first.document) ||
                (!document && (roomEpochs.get(name) ?? 0) !== first.epoch)
              )
                throw new Error('capture_changed');
            },
            release() {
              if (released) return;
              released = true;
              for (const name of names) {
                const count = (pins.get(name) ?? 1) - 1;
                if (count > 0) pins.set(name, count);
                else {
                  pins.delete(name);
                  if (!hocuspocus.documents.has(name)) roomEpochs.delete(name);
                  const room = hocuspocus.documents.get(name);
                  if (room)
                    void hocuspocus.unloadDocument(room).catch(() => undefined);
                }
              }
            },
          };
        },
        invalidate(ids) {
          for (const id of ids) {
            const context = leases.get(id);
            if (context)
              closeTransport(context.transport, 4403, 'unauthorized');
          }
        },
      });
    } finally {
      controls--;
    }
  }
  let destroying: Promise<void> | undefined;
  return {
    httpServer,
    hocuspocus,
    get address(): AddressInfo {
      return httpServer.address() as AddressInfo;
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(
          options.port ?? 1234,
          options.host ?? '127.0.0.1',
          () => {
            httpServer.off('error', reject);
            resolve();
          },
        );
      });
    },
    destroy(): Promise<void> {
      return (destroying ??= (async () => {
        draining = true;
        hocuspocus.flushPendingStores();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Promise.allSettled([...persistence]);
        clearInterval(interval);
        for (const transport of transports)
          closeTransport(transport, 1001, 'server_stopping');
        for (const socket of websocketServer.clients) socket.terminate();
        await new Promise<void>((resolve) =>
          websocketServer.close(() => resolve()),
        );
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await hocuspocus.hooks('onDestroy', { instance: hocuspocus });
      })());
    },
  };
}
