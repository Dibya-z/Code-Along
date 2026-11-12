import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  captureRunManifest,
  verifyRunManifest,
  isRunManifest,
  parseRunnerCommand,
  parseRunnerReady,
  parseRunnerEvent,
  RUNTIME_ID,
  RUNNER_PROTOCOL,
} from '../execution/runner.ts';
const file = () => ({
  document_id: randomUUID(),
  generation: 1,
  path: 'main.py',
  source: 'print("hello")\n',
});
it('freezes source before asynchronous hashing and verifies canonical hashes', async () => {
  const f = file(),
    source = f.source;
  const pending = captureRunManifest([f], 'main.py', 1);
  f.source = 'changed';
  const m = await pending;
  expect(m.files[0]?.source).toBe(source);
  expect(Object.isFrozen(m.files)).toBe(true);
  expect(await verifyRunManifest(m)).toBe(true);
  expect(
    await verifyRunManifest({
      ...m,
      files: [{ ...m.files[0]!, source: 'tampered' }],
    }),
  ).toBe(false);
});
it('uses deterministic paths/order and includes generation, input and runtime identity', async () => {
  const a = file(),
    b = { ...file(), path: 'helper.py' };
  const first = await captureRunManifest([a, b], 'main.py', 1),
    second = await captureRunManifest([b, a], 'main.py', 1);
  expect(first.sha256).toBe(second.sha256);
  expect(first.runtime_id).toBe(RUNTIME_ID);
  expect((await captureRunManifest([a, b], 'main.py', 2)).sha256).not.toBe(
    first.sha256,
  );
  expect(
    (await captureRunManifest([a, b], 'main.py', 1, 'interactive')).sha256,
  ).not.toBe(first.sha256);
});
it.each([
  '../main.py',
  '/main.py',
  'x//main.py',
  'x/../main.py',
  'x/..py',
  'x\\main.py',
  'main.js',
  'a%2f.py',
])('rejects unsafe path %s', async (path) => {
  await expect(
    captureRunManifest([{ ...file(), path }], path, 1),
  ).rejects.toThrow('invalid_manifest');
});
it.each(['\ud800', 'x\0', 'a'.repeat(128 * 1024 + 1)])(
  'rejects invalid/oversized source',
  async (source) => {
    await expect(
      captureRunManifest([{ ...file(), source }], 'main.py', 1),
    ).rejects.toThrow('invalid_manifest');
  },
);
it('rejects duplicate paths, IDs, empty/incomplete captures and unknown manifest fields', async () => {
  const f = file();
  for (const files of [[], [f, f], [f, { ...file(), path: 'main.py' }]])
    await expect(captureRunManifest(files, 'main.py', 1)).rejects.toThrow();
  const m = await captureRunManifest([f], 'main.py', 1);
  expect(isRunManifest({ ...m, token: 'forbidden' })).toBe(false);
});
it('accepts only versioned nonce-bound declared commands', async () => {
  const session_nonce = randomUUID();
  const frame = {
    protocol: RUNNER_PROTOCOL,
    version: 1,
    session_nonce,
    run_id: randomUUID(),
    type: 'run',
    manifest: await captureRunManifest([file()], 'main.py', 1),
    stdin: [],
  };
  expect(parseRunnerCommand(frame, session_nonce)).not.toBeNull();
  for (const bad of [
    { ...frame, token: 'bad' },
    { ...frame, session_nonce: randomUUID() },
    { ...frame, type: 'fetch' },
    { ...frame, stdin: ['x'.repeat(4097)] },
  ])
    expect(parseRunnerCommand(bad, session_nonce)).toBeNull();
});

it('validates capability/events and rejects privileged or malformed replies', () => {
  const session_nonce = randomUUID(),
    run_id = randomUUID();
  const base = { protocol: RUNNER_PROTOCOL, version: 1, session_nonce };
  expect(
    parseRunnerReady(
      {
        ...base,
        type: 'ready',
        interactive: true,
        cross_origin_isolated: true,
      },
      session_nonce,
    ),
  ).not.toBeNull();
  expect(
    parseRunnerReady(
      {
        ...base,
        type: 'ready',
        interactive: true,
        cross_origin_isolated: false,
      },
      session_nonce,
    ),
  ).toBeNull();
  const output = {
    ...base,
    run_id,
    type: 'output',
    stream: 'stdout',
    sequence: 0,
    text: '<script>untrusted</script>',
  };
  expect(parseRunnerEvent(output, session_nonce)).not.toBeNull();
  for (const patch of [
    { token: 'forbidden' },
    { sequence: -1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { text: 'x'.repeat(8193) },
    { stream: 'html' },
    { session_nonce: randomUUID() },
  ])
    expect(parseRunnerEvent({ ...output, ...patch }, session_nonce)).toBeNull();
});
