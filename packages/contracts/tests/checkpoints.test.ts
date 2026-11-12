import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  CHECKPOINT_ERROR_CODES,
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_VERSION,
  MAX_CHECKPOINT_MESSAGE_BYTES,
  MAX_CHECKPOINT_STATE_BYTES,
  parseCheckpointRequest,
  parseCheckpointResponse,
  receiptCoversObservedState,
  type CheckpointError,
  type CheckpointReceipt,
  type CheckpointRequest,
  type ObservedDocumentState,
} from '@code-along/contracts/collaboration';

const OTHER_UUID = '10000000-0000-4000-8000-000000000099';
const observation: ObservedDocumentState = {
  document_id: '10000000-0000-4000-8000-000000000001',
  generation: 1,
  client_session_id: '10000000-0000-4000-8000-000000000002',
  observed_counter: 0,
};
const correlation = {
  protocol: CHECKPOINT_PROTOCOL,
  version: CHECKPOINT_VERSION,
  ...observation,
  checkpoint_id: '10000000-0000-4000-8000-000000000003',
} as const;

function request(patch: Partial<CheckpointRequest> = {}): CheckpointRequest {
  return {
    ...correlation,
    type: 'checkpoint.request',
    state_base64: 'AAA=', // Actual Yjs V1 full-state bytes of an empty document.
    ...patch,
  };
}

// Synthetic receipts only: these tests never claim a database commit occurred.
function receipt(patch: Partial<CheckpointReceipt> = {}): CheckpointReceipt {
  return {
    ...correlation,
    type: 'checkpoint.receipt',
    durable_revision: '1',
    state_sha256: 'a'.repeat(64),
    ...patch,
  };
}

function error(code: CheckpointError['code']): CheckpointError {
  return { ...correlation, type: 'checkpoint.error', code };
}

const invalid = { ok: false, error: 'invalid_message' } as const;

describe('checkpoint message validation', () => {
  it('accepts an empty-text document state and preserves immutable retry fields', () => {
    const doc = new Y.Doc();
    try {
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')).toBe(
        'AAA=',
      );
    } finally {
      doc.destroy();
    }
    const frame = JSON.stringify(request());
    const first = parseCheckpointRequest(frame);
    expect(first).toEqual({ ok: true, value: request() });
    expect(parseCheckpointRequest(frame)).toEqual(first);
    if (!first.ok) throw new Error('Expected a valid fixture');
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Reflect.set(first.value, 'observed_counter', 123)).toBe(false);
    expect(first.value.observed_counter).toBe(0);
  });

  it('accepts UUID v7 identifiers and safe counter boundaries', () => {
    const value = request({
      document_id: '01980000-0000-7000-8000-000000000001',
      generation: Number.MAX_SAFE_INTEGER,
      observed_counter: Number.MAX_SAFE_INTEGER,
    });
    expect(parseCheckpointRequest(JSON.stringify(value))).toEqual({
      ok: true,
      value,
    });
  });

  it.each(Object.keys(request()))('rejects a request missing %s', (field) => {
    const value: Record<string, unknown> = { ...request() };
    delete value[field];
    expect(parseCheckpointRequest(JSON.stringify(value))).toEqual(invalid);
  });

  it.each([
    ['protocol', 'another.protocol'],
    ['version', 2],
    ['version', '1'],
    ['type', 'synced'],
    ['document_id', 'not-a-uuid'],
    ['document_id', '10000000-0000-0000-8000-000000000001'],
    ['document_id', '10000000-0000-4000-0000-000000000001'],
    ['client_session_id', null],
    ['checkpoint_id', OTHER_UUID.toUpperCase().replace('099', '0AF')],
    ['generation', 0],
    ['generation', -1],
    ['generation', 1.5],
    ['generation', '1'],
    ['generation', Number.MAX_SAFE_INTEGER + 1],
    ['observed_counter', -1],
    ['observed_counter', 0.1],
    ['observed_counter', Number.MAX_SAFE_INTEGER + 1],
    ['observed_counter', '0'],
    ['observed_counter', null],
    ['state_base64', ['AAA=']],
  ])('rejects invalid %s value %# without coercion', (field, value) => {
    expect(
      parseCheckpointRequest(JSON.stringify({ ...request(), [field]: value })),
    ).toEqual(invalid);
  });

  it('rejects numeric overflow in raw JSON', () => {
    const frame = JSON.stringify(request()).replace(
      '"observed_counter":0',
      '"observed_counter":1e309',
    );
    expect(parseCheckpointRequest(frame)).toEqual(invalid);
  });

  it.each([
    '',
    'A',
    'AAA',
    'A===',
    '====',
    'AAA==',
    'AA-_',
    'AA A',
    'AAA=\n',
    'AB==',
    'AAB=',
  ])('rejects noncanonical base64 %#', (state_base64) => {
    expect(
      parseCheckpointRequest(JSON.stringify(request({ state_base64 }))),
    ).toEqual(invalid);
  });

  it.each(['AA==', 'AAA=', 'AAAA'])(
    'accepts canonical binary encoding %s',
    (state_base64) => {
      // Envelope syntax only: these are not all valid Yjs states.
      const value = request({ state_base64 });
      expect(parseCheckpointRequest(JSON.stringify(value))).toEqual({
        ok: true,
        value,
      });
    },
  );

  it.each(['user_id', 'role', 'saved', 'state_vector', 'password'])(
    'rejects unknown field %s without echoing its value',
    (field) => {
      const result = parseCheckpointRequest(
        JSON.stringify({ ...request(), [field]: 'PRIVATE_SOURCE' }),
      );
      expect(result).toEqual(invalid);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE');
    },
  );

  it('rejects prototype-shaped extra keys', () => {
    const frame = JSON.stringify(request()).replace(
      /}$/,
      ',"__proto__":{"polluted":true}}',
    );
    expect(parseCheckpointRequest(frame)).toEqual(invalid);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it.each(['null', '[]', 'true', '123', '"text"'])(
    'rejects a non-object JSON value %s',
    (frame) => {
      expect(parseCheckpointRequest(frame)).toEqual(invalid);
    },
  );

  it.each([undefined, null, 1, {}, [], new Uint8Array([0])])(
    'rejects non-string transport input %#',
    (frame) => {
      expect(parseCheckpointRequest(frame)).toEqual(invalid);
    },
  );

  it.each(['', ' ', '{', '{"version":NaN}'])(
    'reports malformed JSON %# generically',
    (frame) => {
      expect(parseCheckpointRequest(frame)).toEqual({
        ok: false,
        error: 'invalid_json',
      });
    },
  );

  it('rejects receipt/request messages on the wrong channel direction', () => {
    expect(parseCheckpointRequest(JSON.stringify(receipt()))).toEqual(invalid);
    expect(parseCheckpointResponse(JSON.stringify(request()))).toEqual(invalid);
    expect(
      parseCheckpointResponse(JSON.stringify({ type: 'synced', state: true })),
    ).toEqual(invalid);
  });
});

describe('checkpoint resource limits', () => {
  it('accepts the decoded-state boundary and rejects overflow with the same encoded length', () => {
    const atLimit = Buffer.alloc(MAX_CHECKPOINT_STATE_BYTES).toString('base64');
    const overLimit = Buffer.alloc(MAX_CHECKPOINT_STATE_BYTES + 1).toString(
      'base64',
    );
    expect(overLimit.length).toBe(atLimit.length);
    expect(
      parseCheckpointRequest(JSON.stringify(request({ state_base64: atLimit })))
        .ok,
    ).toBe(true);
    expect(
      parseCheckpointRequest(
        JSON.stringify(request({ state_base64: overLimit })),
      ),
    ).toEqual(invalid);
  });

  it('accepts the exact JSON-byte boundary and rejects one additional byte', () => {
    const body = JSON.stringify(request());
    const frame = body + ' '.repeat(MAX_CHECKPOINT_MESSAGE_BYTES - body.length);
    expect(parseCheckpointRequest(frame).ok).toBe(true);
    expect(parseCheckpointRequest(frame + ' ')).toEqual({
      ok: false,
      error: 'message_too_large',
    });
  });

  it('counts UTF-8 bytes rather than only JavaScript code units before parsing', () => {
    const frame = JSON.stringify({
      source: '€'.repeat(Math.ceil(MAX_CHECKPOINT_MESSAGE_BYTES / 3)),
    });
    expect(frame.length).toBeLessThan(MAX_CHECKPOINT_MESSAGE_BYTES);
    expect(parseCheckpointRequest(frame)).toEqual({
      ok: false,
      error: 'message_too_large',
    });
    expect(parseCheckpointResponse(frame)).toEqual({
      ok: false,
      error: 'message_too_large',
    });
  });
});

describe('checkpoint response validation', () => {
  it('keeps the exported error vocabulary immutable', () => {
    expect(Object.isFrozen(CHECKPOINT_ERROR_CODES)).toBe(true);
    expect(Reflect.set(CHECKPOINT_ERROR_CODES, '0', 'custom_error')).toBe(
      false,
    );
  });

  it.each(['1', '9007199254740993', '9223372036854775807'])(
    'preserves a valid PostgreSQL revision as a decimal string: %s',
    (durable_revision) => {
      const value = receipt({ durable_revision });
      expect(parseCheckpointResponse(JSON.stringify(value))).toEqual({
        ok: true,
        value,
      });
    },
  );

  it.each([
    0,
    1,
    '0',
    '-1',
    '+1',
    '01',
    '1.0',
    '1e3',
    ' 1',
    '9223372036854775808',
    '10000000000000000000',
  ])('rejects invalid or lossy durable revision %#', (durable_revision) => {
    expect(
      parseCheckpointResponse(
        JSON.stringify({ ...receipt(), durable_revision }),
      ),
    ).toEqual(invalid);
  });

  it.each(['A'.repeat(64), 'f'.repeat(63), 'g'.repeat(64), '', null])(
    'rejects invalid committed-state digest %#',
    (state_sha256) => {
      expect(
        parseCheckpointResponse(JSON.stringify({ ...receipt(), state_sha256 })),
      ).toEqual(invalid);
    },
  );

  it.each(Object.keys(receipt()))('requires receipt field %s', (field) => {
    const value: Record<string, unknown> = { ...receipt() };
    delete value[field];
    expect(parseCheckpointResponse(JSON.stringify(value))).toEqual(invalid);
  });

  it.each(CHECKPOINT_ERROR_CODES)(
    'accepts a scoped %s error that cannot mark Saved',
    (code) => {
      const value = error(code);
      expect(parseCheckpointResponse(JSON.stringify(value))).toEqual({
        ok: true,
        value,
      });
      expect(receiptCoversObservedState(value, request(), observation)).toBe(
        false,
      );
    },
  );

  it('rejects unsupported error codes and server error/source leakage fields', () => {
    expect(
      parseCheckpointResponse(
        JSON.stringify({ ...error('invalid_state'), code: 'custom_error' }),
      ),
    ).toEqual(invalid);
    expect(
      parseCheckpointResponse(
        JSON.stringify({
          ...error('storage_unavailable'),
          message: 'SQL_AND_SOURCE',
        }),
      ),
    ).toEqual(invalid);
    expect(
      parseCheckpointResponse(JSON.stringify({ ...receipt(), saved: true })),
    ).toEqual(invalid);
  });
});

describe('receipt coverage of the current observed document', () => {
  it('covers an exactly correlated, unchanged observation', () => {
    expect(receiptCoversObservedState(receipt(), request(), observation)).toBe(
      true,
    );
  });

  it.each([
    ['document_id', OTHER_UUID],
    ['generation', 2],
    ['client_session_id', OTHER_UUID],
    ['checkpoint_id', OTHER_UUID],
    ['observed_counter', 1],
  ])('does not accept a receipt with another %s', (field, value) => {
    const other = { ...receipt(), [field]: value };
    expect(receiptCoversObservedState(other, request(), observation)).toBe(
      false,
    );
  });

  it.each([
    ['document_id', OTHER_UUID],
    ['generation', 2],
    ['client_session_id', OTHER_UUID],
    ['observed_counter', 1],
  ])('does not mark a changed current %s Saved', (field, value) => {
    expect(
      receiptCoversObservedState(receipt(), request(), {
        ...observation,
        [field]: value,
      }),
    ).toBe(false);
  });

  it('keeps later edits pending when an earlier receipt arrives', () => {
    const next = request({ checkpoint_id: OTHER_UUID, observed_counter: 1 });
    const current = { ...observation, observed_counter: 1 };
    expect(receiptCoversObservedState(receipt(), request(), current)).toBe(
      false,
    );
    expect(receiptCoversObservedState(receipt(), next, current)).toBe(false);
    expect(
      receiptCoversObservedState(
        receipt({ checkpoint_id: OTHER_UUID, observed_counter: 1 }),
        next,
        current,
      ),
    ).toBe(true);
  });

  it('invalidates a saved candidate on actual Yjs deletion-only updates, even with an unchanged state vector', () => {
    const doc = new Y.Doc();
    let counter = 0;
    doc.on('update', () => {
      counter += 1;
    });
    try {
      const text = doc.getText('source');
      text.insert(0, 'print(42)');
      const pending = request({
        observed_counter: counter,
        state_base64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
          'base64',
        ),
      });
      const acknowledged = receipt({ observed_counter: counter });
      expect(
        receiptCoversObservedState(acknowledged, pending, {
          ...observation,
          observed_counter: counter,
        }),
      ).toBe(true);
      const vectorBefore = Y.encodeStateVector(doc);
      text.delete(0, text.length);
      expect(text.toString()).toBe('');
      expect(Y.encodeStateVector(doc)).toEqual(vectorBefore);
      expect(counter).toBe(pending.observed_counter + 1);
      expect(
        receiptCoversObservedState(acknowledged, pending, {
          ...observation,
          observed_counter: counter,
        }),
      ).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('invalidates a saved candidate when a remote Yjs update is observed', () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();
    let counter = 0;
    local.on('update', () => {
      counter += 1;
    });
    try {
      const pending = request();
      remote.getText('source').insert(0, '# collaborator edit');
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote), 'remote');
      expect(counter).toBe(1);
      expect(
        receiptCoversObservedState(receipt(), pending, {
          ...observation,
          observed_counter: counter,
        }),
      ).toBe(false);
    } finally {
      local.destroy();
      remote.destroy();
    }
  });
});
