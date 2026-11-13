import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { CheckpointRequest } from '@code-along/contracts/collaboration';
import { DocumentCheckpoint } from './checkpoint.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function receipt(
  request: CheckpointRequest,
  extra: Record<string, unknown> = {},
) {
  const { state_base64: _state, ...envelope } = request;
  void _state;
  return JSON.stringify({
    ...envelope,
    type: 'checkpoint.receipt',
    durable_revision: '9007199254740993',
    state_sha256: 'a'.repeat(64),
    ...extra,
  });
}
function setup() {
  const doc = new Y.Doc(),
    send = vi.fn(),
    rejected = vi.fn();
  const model = new DocumentCheckpoint(
    doc,
    { document_id: id(1), generation: 1, client_session_id: id(2) },
    send,
    rejected,
  );
  return {
    doc,
    model,
    send,
    rejected,
    close: () => {
      model.destroy();
      doc.destroy();
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('durable document checkpoint observation', () => {
  it('does not equate sync with Saved and can checkpoint an empty canonical document', () => {
    const f = setup();
    f.model.connection(true, true);
    expect(f.model.getSnapshot().phase).toBe('pending');
    f.model.save();
    expect(f.model.request?.state_base64).toBeTruthy();
    expect(f.model.getSnapshot().phase).toBe('saving');
    f.model.receive(receipt(f.model.request!));
    expect(f.model.getSnapshot()).toEqual({
      phase: 'saved',
      error: '',
      revision: '9007199254740993',
    });
    f.close();
  });
  it('counts remote and deletion-only updates even if the state vector is unchanged', () => {
    const f = setup(),
      remote = new Y.Doc();
    remote.getText('source').insert(0, 'x');
    Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(remote));
    expect(f.model.observedCounter).toBe(1);
    f.model.connection(true, true);
    f.model.save();
    f.model.receive(receipt(f.model.request!));
    const vector = Y.encodeStateVector(f.doc);
    f.doc.getText('source').delete(0, 1);
    expect(Y.encodeStateVector(f.doc)).toEqual(vector);
    expect(f.model.observedCounter).toBe(2);
    expect(f.model.getSnapshot().phase).toBe('pending');
    remote.destroy();
    f.close();
  });
  it('rejects wrong correlation and keeps current edits pending after an older receipt', () => {
    const f = setup();
    f.model.connection(true, true);
    f.model.save();
    const pending = f.model.request!;
    for (const mutation of [
      { document_id: id(3) },
      { generation: 2 },
      { client_session_id: id(4) },
      { checkpoint_id: id(5) },
      { observed_counter: 100 },
    ]) {
      expect(f.model.receive(receipt(pending, mutation))).toBe(false);
      expect(f.model.request).toBe(pending);
    }
    expect(f.model.receive('{bad')).toBe(false);
    f.doc.getText('source').insert(0, 'new edit');
    f.model.receive(receipt(pending));
    expect(f.model.getSnapshot().phase).toBe('pending');
    f.model.save();
    expect(f.model.request?.checkpoint_id).not.toBe(pending.checkpoint_id);
    expect(f.model.request?.observed_counter).toBe(1);
    f.close();
  });
  it('retries exactly the immutable capture on timeout despite subsequent edits', () => {
    const f = setup();
    f.model.connection(true, true);
    f.model.save();
    const pending = f.model.request!;
    expect(Object.isFrozen(pending)).toBe(true);
    f.doc.getText('source').insert(0, 'later');
    vi.advanceTimersByTime(5000);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]![0]).toBe(f.send.mock.calls[0]![0]);
    expect(f.model.request).toBe(pending);
    f.close();
  });
  it('preserves lost-response retry identity across disconnect and fresh admission', () => {
    const f = setup();
    f.model.connection(true, true);
    f.model.save();
    const pending = f.model.request!;
    f.model.connection(false, false);
    expect(f.model.receive(receipt(pending))).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(f.send).toHaveBeenCalledOnce();
    f.model.connection(true, true);
    f.model.save();
    expect(f.model.request).toBe(pending);
    expect(f.send.mock.calls[1]![0]).toBe(f.send.mock.calls[0]![0]);
    f.model.receive(receipt(pending));
    expect(f.model.getSnapshot().phase).toBe('saved');
    f.model.connection(false, false);
    expect(f.model.getSnapshot().phase).not.toBe('saved');
    f.close();
  });
  it('keeps storage failure pending and never labels an error or read-only connection Saved', () => {
    const f = setup();
    f.model.connection(true, true);
    f.model.save();
    const pending = f.model.request!;
    const { state_base64: _state, ...envelope } = pending;
    void _state;
    f.model.receive(
      JSON.stringify({
        ...envelope,
        type: 'checkpoint.error',
        code: 'storage_unavailable',
      }),
    );
    expect(f.model.getSnapshot().phase).toBe('error');
    expect(f.model.request).toBe(pending);
    vi.advanceTimersByTime(5000);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.rejected).toHaveBeenCalledWith('storage_unavailable');
    f.model.connection(true, false);
    f.model.save();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.model.getSnapshot().phase).toBe('read_only');
    f.close();
  });
  it('stops retries after generation rejection and releases timers/listeners on disposal', () => {
    const f = setup();
    f.model.connection(true, true);
    f.model.save();
    const { state_base64: _state, ...envelope } = f.model.request!;
    void _state;
    f.model.receive(
      JSON.stringify({
        ...envelope,
        type: 'checkpoint.error',
        code: 'generation_mismatch',
      }),
    );
    vi.advanceTimersByTime(60000);
    f.model.save();
    expect(f.send).toHaveBeenCalledOnce();
    const count = f.model.observedCounter;
    f.model.destroy();
    f.doc.getText('source').insert(0, 'preserved text');
    expect(f.model.observedCounter).toBe(count);
    expect(f.model.request).toBe(null);
    f.doc.destroy();
  });
  it('keeps save state stable when unrelated metadata rechecks connection readiness', () => {
    const f = setup();
    f.model.connection(true, true);
    f.model.save();
    f.model.receive(receipt(f.model.request!));
    f.model.connection(true, true);
    vi.advanceTimersByTime(20000);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.model.getSnapshot().phase).toBe('saved');
    f.close();
  });
});
