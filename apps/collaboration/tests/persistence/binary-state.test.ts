import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_SOURCE_BYTES,
  CheckpointStoreError,
  mergeBinaryState,
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
