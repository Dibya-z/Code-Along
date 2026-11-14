import { describe, expect, it } from 'vitest';
import {
  LEARNING_PROTOCOL,
  learningGeneration,
  parseLearningCommand,
  parseLearningFrame,
  parseLearningHead,
  subscribeLearning,
} from './index.ts';
const id = '11111111-1111-4111-8111-111111111111';
const envelope = {
  protocol: LEARNING_PROTOCOL,
  version: 1,
  scope: 'assignment',
  assignment_id: id,
  audience: 'participant',
};
const subscribed = {
  ...envelope,
  type: 'subscribed',
  head_generation: '0',
  refresh_required: true,
};
describe('strict coalesced learning wire', () => {
  it('requires absolute canonical endings across command, frame and HTTP head', () => {
    const command = JSON.parse(
      subscribeLearning(id, 'participant', '0'),
    ) as object;
    for (const ending of ['\n', '\r', '\r\n']) {
      for (const patch of [
        { assignment_id: id + ending },
        { head_generation: '1' + ending },
      ]) {
        expect(
          parseLearningFrame(JSON.stringify({ ...subscribed, ...patch })).ok,
        ).toBe(false);
        expect(
          parseLearningHead({ ...envelope, head_generation: '1', ...patch }).ok,
        ).toBe(false);
      }
      expect(
        parseLearningCommand(
          JSON.stringify({ ...command, assignment_id: id + ending }),
        ).ok,
      ).toBe(false);
      expect(
        parseLearningCommand(
          JSON.stringify({ ...command, after_generation: '1' + ending }),
        ).ok,
      ).toBe(false);
    }
  });
  it('round-trips only the scoped audience subscription with nullable canonical generation', () => {
    for (const audience of ['teaching', 'participant'] as const)
      for (const after of [null, '0', '1', '9223372036854775807'])
        expect(
          parseLearningCommand(subscribeLearning(id, audience, after)).ok,
        ).toBe(true);
    const result = parseLearningFrame(JSON.stringify(subscribed));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });
  it('accepts numeric JSON version one consistently, rejects coercions and all unknown domain payloads', () => {
    expect(
      parseLearningFrame(
        JSON.stringify(subscribed).replace('"version":1', '"version":1e0'),
      ).ok,
    ).toBe(true);
    for (const patch of [
      { version: true },
      { version: '1' },
      { version: 2 },
      { type: ['head'] },
      { audience: ['participant'] },
      { user_id: id },
      { stream_id: id },
      { comments: 'secret' },
      { events: [] },
      { scope: 'project' },
      { refresh_required: 1 },
    ])
      expect(
        parseLearningFrame(JSON.stringify({ ...subscribed, ...patch })).ok,
      ).toBe(false);
  });
  it('rejects noncanonical UUIDs and signed/unsafe/non-ASCII generations without Number conversion', () => {
    for (const generation of [
      '01',
      '-1',
      '+1',
      '1.0',
      '1e0',
      ' 1',
      '１',
      '9223372036854775808',
      '',
      1,
      true,
      null,
    ])
      expect(learningGeneration(generation)).toBe(false);
    for (const assignment_id of [
      id.toUpperCase().replace('1111-', 'AAAA-'),
      id.replace('-4111-', '-0111-'),
      id.replace('-8111-', '-7111-'),
      ` ${id}`,
      'bad',
    ])
      expect(
        parseLearningFrame(JSON.stringify({ ...subscribed, assignment_id })).ok,
      ).toBe(false);
    expect(learningGeneration('9007199254740993')).toBe(true);
  });
  it('distinguishes HTTP head and exact frame variants without replay or zero changed generations', () => {
    expect(parseLearningHead({ ...envelope, head_generation: '0' }).ok).toBe(
      true,
    );
    expect(parseLearningHead(subscribed).ok).toBe(false);
    for (const type of ['head', 'learning.changed']) {
      expect(
        parseLearningFrame(
          JSON.stringify({ ...envelope, type, head_generation: '1' }),
        ).ok,
      ).toBe(true);
      expect(
        parseLearningFrame(
          JSON.stringify({
            ...envelope,
            type,
            head_generation: '1',
            refresh_required: false,
          }),
        ).ok,
      ).toBe(false);
    }
    expect(
      parseLearningFrame(
        JSON.stringify({
          ...envelope,
          type: 'learning.changed',
          head_generation: '0',
        }),
      ).ok,
    ).toBe(false);
  });
  it('rejects duplicate escaped keys, invalid JSON, binary and actual UTF-8 byte overflow', () => {
    const raw = JSON.stringify(subscribed);
    for (const duplicate of [
      raw.replace('{', '{"version":2,'),
      raw.replace('{', '{"\\u0061udience":"teaching",'),
    ])
      expect(parseLearningFrame(duplicate)).toEqual({
        ok: false,
        error: 'invalid_json',
      });
    expect(parseLearningFrame('[')).toEqual({
      ok: false,
      error: 'invalid_json',
    });
    expect(parseLearningFrame(new Uint8Array())).toEqual({
      ok: false,
      error: 'invalid_message',
    });
    expect(parseLearningFrame(raw + ' '.repeat(4096))).toEqual({
      ok: false,
      error: 'message_too_large',
    });
    expect(
      parseLearningCommand(
        subscribeLearning(id, 'teaching', null) + ' '.repeat(1024),
      ),
    ).toEqual({ ok: false, error: 'message_too_large' });
    expect(
      parseLearningFrame(
        JSON.stringify({ ...subscribed, extra: '🐍'.repeat(1100) }),
      ),
    ).toEqual({ ok: false, error: 'message_too_large' });
  });
  it('does not accept another protocol, extra selectors or a foreign subscription command as a frame', () => {
    const raw = JSON.parse(
      subscribeLearning(id, 'participant', null),
    ) as object;
    expect(parseLearningFrame(JSON.stringify(raw)).ok).toBe(false);
    for (const patch of [
      { user_id: id },
      { after_generation: 1 },
      { protocol: 'code-along.events' },
      { type: 'head' },
    ])
      expect(
        parseLearningCommand(JSON.stringify({ ...raw, ...patch })).ok,
      ).toBe(false);
  });
});
