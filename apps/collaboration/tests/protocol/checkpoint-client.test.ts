import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { CheckpointClient } from '../../src/protocol/checkpoint-client.ts';

it('captures immutable bytes and counts remote and delete-only updates', () => {
  const doc = new Y.Doc(),
    peer = new Y.Doc();
  const client = new CheckpointClient(doc, {
    document_id: randomUUID(),
    generation: 1,
    client_session_id: randomUUID(),
  });
  const p = client.capture(randomUUID());
  expect(() => client.capture(randomUUID())).toThrow('checkpoint_in_flight');
  peer.getText('source').insert(0, 'x');
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  expect(client.retry()).toBe(p);
  const receipt = {
    ...p,
    type: 'checkpoint.receipt',
    state_base64: undefined,
    durable_revision: '1',
    state_sha256: 'a'.repeat(64),
  };
  expect(client.receive(JSON.stringify(receipt))).not.toBeNull();
  expect(client.saved).toBe(false);
  const next = client.capture(randomUUID());
  expect(next.observed_counter).toBe(1);
  client.receive(
    JSON.stringify({
      ...next,
      state_base64: undefined,
      type: 'checkpoint.receipt',
      durable_revision: '2',
      state_sha256: 'a'.repeat(64),
    }),
  );
  expect(client.saved).toBe(true);
  doc.getText('source').delete(0, 1);
  expect(client.saved).toBe(false);
  client.destroy();
  doc.destroy();
  peer.destroy();
});
it('ignores malformed and uncorrelated replies and keeps exact retry state', () => {
  const doc = new Y.Doc();
  const c = new CheckpointClient(doc, {
    document_id: randomUUID(),
    generation: 1,
    client_session_id: randomUUID(),
  });
  const p = c.capture(randomUUID());
  expect(c.receive('invalid')).toBeNull();
  expect(
    c.receive(
      JSON.stringify({
        ...p,
        state_base64: undefined,
        type: 'checkpoint.receipt',
        checkpoint_id: randomUUID(),
        durable_revision: '1',
        state_sha256: 'a'.repeat(64),
      }),
    ),
  ).toBeNull();
  expect(c.retry()).toBe(p);
  expect(c.saved).toBe(false);
  c.destroy();
  doc.destroy();
});
