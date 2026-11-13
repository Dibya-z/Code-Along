import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { stampAwareness } from '../../src/product/awareness.ts';
import { grant } from './fixtures.ts';

describe('admitted awareness', () => {
  it('stamps authenticated identity and retains valid source-relative cursors', () => {
    const doc = new Y.Doc(),
      g = grant();
    try {
      const text = doc.getText('source');
      text.insert(0, 'hello');
      const position = Y.createRelativePositionFromTypeIndex(text, 2);
      const states = new Map([
        [
          g.awareness_client_id,
          {
            user: { id: 'spoof', name: 'spoof', color: 'url(secret)' },
            cursor: { anchor: position, head: position },
            html: 'private',
          },
        ],
      ]);
      stampAwareness(states, new Set(), g, doc);
      expect(states.get(g.awareness_client_id)).toEqual({
        user: {
          id: g.user.id,
          display_name: 'River',
          name: 'River',
          color: '#2563eb',
          colorLight: '#2563eb33',
        },
        cursor: { anchor: position, head: position },
      });
    } finally {
      doc.destroy();
    }
  });
  it('rejects claiming/removing any other client and drops foreign/unknown positions', () => {
    const doc = new Y.Doc(),
      g = grant();
    try {
      expect(() =>
        stampAwareness(new Map([[999, {}]]), new Set(), g, doc),
      ).toThrow();
      expect(() => stampAwareness(new Map(), new Set([999]), g, doc)).toThrow();
      const other = doc.getText('other');
      other.insert(0, 'x');
      const p = Y.createRelativePositionFromTypeIndex(other, 0);
      const states = new Map([
        [g.awareness_client_id, { cursor: { anchor: p, head: p } }],
      ]);
      stampAwareness(states, new Set(), g, doc);
      expect(states.get(g.awareness_client_id)?.cursor).toBeNull();
    } finally {
      doc.destroy();
    }
  });
});
