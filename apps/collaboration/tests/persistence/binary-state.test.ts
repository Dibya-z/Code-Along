import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import {
  MAX_SOURCE_BYTES,
  CheckpointStoreError,
  mergeBinaryState,
  stateHash,
  validateInitialState,
  validateSource,
} from '../../src/persistence/binary-state.ts';

function state(text: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.getText('source').insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

describe('binary source state validation', () => {
  it('preserves a literal leading UTF-8 BOM through plain validation and immutable binary seeding', () => {
    const source = '\ufeff# exact BOM source 🐍\r\nprint("kept")\r\n';
    expect(() => validateSource(source)).not.toThrow();
    const encoded = state(source);
    const before = Uint8Array.from(encoded);
    const loaded = new Y.Doc();
    try {
      const validated = validateInitialState(encoded);
      Y.applyUpdate(loaded, validated);
      expect(loaded.getText('source').toString()).toBe(source);
      expect(Buffer.from(loaded.getText('source').toString(), 'utf8')).toEqual(
        Buffer.from(source, 'utf8'),
      );
      expect(validated).toEqual(Buffer.from(encoded));
      expect(encoded).toEqual(before);
      expect(stateHash(validated)).toBe(
        createHash('sha256').update(before).digest('hex'),
      );
    } finally {
      loaded.destroy();
    }
  });

  it('merges a new BOM-prefixed Yjs ContentString in the middle without changing binary encoding or bytes', () => {
    const initial = state('# left|right\r\n');
    const editing = new Y.Doc(),
      expected = new Y.Doc(),
      loaded = new Y.Doc();
    try {
      Y.applyUpdate(editing, initial);
      const vector = Y.encodeStateVector(editing);
      const insertion = '\ufeffmiddle 🐍\r\n';
      editing.getText('source').insert(6, insertion);
      const update = Y.encodeStateAsUpdate(editing, vector);
      expect(
        Y.decodeUpdate(update).structs.some(
          (struct) =>
            struct instanceof Y.Item &&
            struct.content instanceof Y.ContentString &&
            struct.content.str === insertion,
        ),
      ).toBe(true);
      const initialCopy = Uint8Array.from(initial),
        updateCopy = Uint8Array.from(update);
      Y.applyUpdate(expected, initial);
      Y.applyUpdate(expected, update);
      const canonical = Y.encodeStateAsUpdate(expected);
      const merged = mergeBinaryState(initial, update);
      Y.applyUpdate(loaded, merged);
      expect(loaded.getText('source').toString()).toBe(
        '# left\ufeffmiddle 🐍\r\n|right\r\n',
      );
      expect(merged).toEqual(Buffer.from(canonical));
      expect(stateHash(merged)).toBe(
        createHash('sha256').update(canonical).digest('hex'),
      );
      expect(initial).toEqual(initialCopy);
      expect(update).toEqual(updateCopy);
    } finally {
      editing.destroy();
      expected.destroy();
      loaded.destroy();
    }
  });

  it('counts all three BOM bytes at the exact 128 KiB source boundary', () => {
    const exact = '\ufeff' + 'a'.repeat(MAX_SOURCE_BYTES - 3);
    const oversized = exact + 'a';
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_SOURCE_BYTES);
    expect(() => validateSource(exact)).not.toThrow();
    expect(() => validateInitialState(state(exact))).not.toThrow();
    expect(() => validateSource(oversized)).toThrowError(
      new CheckpointStoreError('resource_limit'),
    );
    expect(() => validateInitialState(state(oversized))).toThrowError(
      new CheckpointStoreError('resource_limit'),
    );
  });

  it('rejects an oversized BOM-prefixed ContentString even when a later deletion would hide it', () => {
    const doc = new Y.Doc();
    try {
      doc.getText('source').insert(0, 'left|right');
      doc.getText('source').insert(4, '\ufeff' + 'a'.repeat(MAX_SOURCE_BYTES));
      const stale = Y.encodeStateAsUpdate(doc);
      expect(
        Y.decodeUpdate(stale).structs.some(
          (struct) =>
            struct instanceof Y.Item &&
            struct.content instanceof Y.ContentString &&
            struct.content.str.startsWith('\ufeff') &&
            Buffer.byteLength(struct.content.str, 'utf8') ===
              MAX_SOURCE_BYTES + 3,
        ),
      ).toBe(true);
      doc.getText('source').delete(0, doc.getText('source').length);
      const deleted = Y.encodeStateAsUpdate(doc);
      expect(doc.getText('source').toString()).toBe('');
      expect(() => mergeBinaryState(deleted, stale)).toThrowError(
        new CheckpointStoreError('resource_limit'),
      );
    } finally {
      doc.destroy();
    }
  });

  it('still rejects NUL, unpaired surrogates and malformed UTF-8 beside a BOM', () => {
    for (const source of ['\ufeff\0', '\ufeff\ud800', '\ufeff\udc00'])
      expect(() => validateSource(source)).toThrowError(
        new CheckpointStoreError('invalid_state'),
      );
    const source = '\ufeff# BOM validation payload\n';
    const malformed = Buffer.from(state(source));
    const offset = malformed.indexOf(Buffer.from(source, 'utf8'));
    expect(offset).toBeGreaterThanOrEqual(0);
    malformed[offset + 2] = 255;
    expect(() => validateInitialState(malformed)).toThrowError(
      new CheckpointStoreError('invalid_state'),
    );
  });

  it('accepts empty and Unicode plain source', () => {
    for (const value of ['', 'print("hello")', '# π 🐍']) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, validateInitialState(state(value)));
        expect(doc.getText('source').toString()).toBe(value);
      } finally {
        doc.destroy();
      }
    }
  });

  it('does not mutate a supplied update and preserves deletion against stale state', () => {
    const doc = new Y.Doc();
    try {
      doc.getText('source').insert(0, 'old');
      const before = Y.encodeStateAsUpdate(doc);
      const copy = Uint8Array.from(before);
      doc.getText('source').delete(0, 3);
      const deleted = Y.encodeStateAsUpdate(doc);
      const merged = mergeBinaryState(deleted, before);
      const loaded = new Y.Doc();
      try {
        Y.applyUpdate(loaded, merged);
        expect(loaded.getText('source').toString()).toBe('');
        expect(before).toEqual(copy);
      } finally {
        loaded.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  it.each([new Uint8Array(), new Uint8Array([255]), new Uint8Array([1, 2, 3])])(
    'rejects malformed binary %# with a safe error',
    (binary) => {
      expect(() => validateInitialState(binary)).toThrowError(
        new CheckpointStoreError('invalid_state'),
      );
    },
  );

  it.each(['map', 'format', 'embed', 'other-root'])(
    'rejects %s structures',
    (kind) => {
      const doc = new Y.Doc();
      try {
        if (kind === 'map')
          doc.getMap('source').set('hidden', 'PRIVATE_SOURCE');
        if (kind === 'format')
          doc.getText('source').insert(0, 'code', { bold: true });
        if (kind === 'embed')
          doc.getText('source').insertEmbed(0, { image: 'x' });
        if (kind === 'other-root') doc.getText('other').insert(0, 'x');
        expect(() =>
          validateInitialState(Y.encodeStateAsUpdate(doc)),
        ).toThrowError(new CheckpointStoreError('invalid_state'));
      } finally {
        doc.destroy();
      }
    },
  );

  it('rejects unresolved causal fragments', () => {
    const doc = new Y.Doc();
    try {
      doc.getText('source').insert(0, 'base');
      const vector = Y.encodeStateVector(doc);
      doc.getText('source').insert(4, 'later');
      expect(() =>
        validateInitialState(Y.encodeStateAsUpdate(doc, vector)),
      ).toThrowError(new CheckpointStoreError('invalid_state'));
    } finally {
      doc.destroy();
    }
  });

  it('enforces logical UTF-8 size separately from binary size', () => {
    expect(() =>
      validateInitialState(state('a'.repeat(MAX_SOURCE_BYTES))),
    ).not.toThrow();
    expect(() =>
      validateInitialState(
        state('€'.repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1)),
      ),
    ).toThrowError(new CheckpointStoreError('resource_limit'));
  });
});

it('rejects NUL, unpaired Unicode and malformed UTF-8 before peer application', () => {
  expect(() => validateSource('\ud800')).toThrowError(
    new CheckpointStoreError('invalid_state'),
  );
  expect(() => validateInitialState(state('secret\0source'))).toThrowError(
    new CheckpointStoreError('invalid_state'),
  );
  const invalid = Uint8Array.from(state('x'));
  invalid[invalid.indexOf(120)] = 255;
  expect(() => validateInitialState(invalid)).toThrowError(
    new CheckpointStoreError('invalid_state'),
  );
});
