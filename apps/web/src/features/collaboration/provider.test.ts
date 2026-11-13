import { describe, expect, it, vi } from 'vitest';
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { EditorState } from '@codemirror/state';
import * as Y from 'yjs';
import { EditorDocument } from '../editor/model/document.ts';
import { CanonicalProvider } from './provider.ts';

const room = '00000000-0000-4000-8000-000000000001:1';
function number(value: number): number[] {
  const bytes = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(value ? byte | 128 : byte);
  } while (value);
  return bytes;
}
function frame(type: number, payload: number[], route = room): MessageEvent {
  const name = new TextEncoder().encode(route);
  const bytes = Uint8Array.from([
    ...number(name.length),
    ...name,
    type,
    ...payload,
  ]);
  return { data: bytes.buffer } as MessageEvent;
}
function stepTwo(state: Uint8Array, route = room): MessageEvent {
  return frame(0, [1, ...number(state.length), ...state], route);
}
function setup() {
  const file = new EditorDocument(
    {
      id: '00000000-0000-4000-8000-000000000002',
      document_id: room.split(':')[0]!,
      generation: 1,
      path: 'main.py',
      kind: 'python',
      initial_sha256: 'a'.repeat(64),
    },
    () => {},
    true,
  );
  file.seed('immutable starter baseline');
  const socket = new HocuspocusProviderWebsocket({
    url: 'wss://app.invalid/collab',
    autoConnect: false,
  });
  const generic = vi.fn(),
    rejected = vi.fn();
  const initialized = vi.fn(() => file.synchronizedFromServer());
  const provider = new CanonicalProvider(
    {
      websocketProvider: socket,
      document: file.doc,
      awareness: null,
      name: room,
      onSynced: generic,
    },
    initialized,
    rejected,
  );
  return {
    file,
    provider,
    generic,
    initialized,
    rejected,
    close: () => {
      provider.destroy();
      socket.destroy();
      file.destroy();
    },
  };
}
describe('actual Hocuspocus initial-state readiness', () => {
  it('ignores an early SyncStatus ack and opens only after a valid Step2 has actually applied', () => {
    const f = setup(),
      server = new Y.Doc();
    try {
      f.provider.onMessage(frame(8, [1]));
      expect(f.generic).toHaveBeenCalledWith({ state: true });
      expect(f.file.loaded).toBe(false);
      expect(f.file.text.toString()).toBe('');
      expect(() =>
        f.file.controller.state((source) =>
          EditorState.create({ doc: source }),
        ),
      ).toThrow('Load this file');
      server.getText('source').insert(0, 'canonical server source\r\n');
      f.provider.onMessage(stepTwo(Y.encodeStateAsUpdate(server)));
      expect(f.generic).toHaveBeenCalledOnce();
      expect(f.initialized).toHaveBeenCalledOnce();
      expect(f.file.loaded).toBe(true);
      expect(f.file.text.toString()).toBe('canonical server source\r\n');
      expect(f.rejected).not.toHaveBeenCalled();
    } finally {
      server.destroy();
      f.close();
    }
  });
  it('accepts an actual empty/deletion Step2 and waits again after close despite earlier SDK synced state', () => {
    const f = setup(),
      server = new Y.Doc();
    try {
      server.getText('source').insert(0, 'deleted');
      server.getText('source').delete(0, 7);
      f.provider.onMessage(stepTwo(Y.encodeStateAsUpdate(server)));
      expect(f.file.loaded).toBe(true);
      expect(f.file.text.toString()).toBe('');
      f.provider.onClose();
      f.provider.onMessage(frame(8, [1]));
      expect(f.initialized).toHaveBeenCalledOnce();
      f.provider.onMessage(stepTwo(Y.encodeStateAsUpdate(server)));
      expect(f.initialized).toHaveBeenCalledTimes(2);
      expect(f.rejected).not.toHaveBeenCalled();
    } finally {
      server.destroy();
      f.close();
    }
  });
  it('rejects malformed/truncated, wrong-route and schema-invalid Step2 without opening or changing the live document', () => {
    const f = setup(),
      invalid = new Y.Doc();
    try {
      invalid.getMap('wrong-root').set('value', 'not source');
      const empty = new Y.Doc();
      const valid = Y.encodeStateAsUpdate(empty);
      empty.destroy();
      for (const event of [
        stepTwo(Uint8Array.of(255)),
        frame(0, [1, 12, 0]),
        stepTwo(valid, `${room}x`),
        stepTwo(Y.encodeStateAsUpdate(invalid)),
      ]) {
        f.provider.onMessage(event);
        expect(f.file.loaded).toBe(false);
        expect(f.file.text.toString()).toBe('');
      }
      expect(f.initialized).not.toHaveBeenCalled();
      expect(f.rejected).toHaveBeenCalledTimes(4);
    } finally {
      invalid.destroy();
      f.close();
    }
  });
});
