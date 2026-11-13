import { describe, expect, it } from 'vitest';
import { RUNNER_PROTOCOL } from '../execution/runner.ts';
import { CORE_RUNTIME } from '../execution/profiles.ts';
import { captureProjectManifest } from '../execution/project-manifest.ts';
import {
  parseProductCommand,
  parseProductEvent,
  parseProductReady,
  validBatchInput,
} from '../execution/product-runner.ts';
const nonce = '00000000-0000-4000-8000-000000000001',
  runId = '00000000-0000-4000-8000-000000000002';
const envelope = {
  protocol: RUNNER_PROTOCOL,
  version: 2,
  session_nonce: nonce,
  run_id: runId,
};
describe('product runner v2 capability messages', () => {
  it('accepts only the declared credential-free command fields and version/nonce/run scope', async () => {
    const manifest = await captureProjectManifest({
      project_id: runId,
      source_kind: 'project',
      metadata_version: 1,
      entrypoint_file_id: nonce,
      runtime: CORE_RUNTIME,
      stdin_mode: 'batch',
      files: [
        {
          file_id: nonce,
          document_id: runId,
          generation: 1,
          path: 'main.py',
          source: 'print(42)',
        },
      ],
    });
    const command = { ...envelope, type: 'run', manifest, stdin: ['a'] };
    expect(parseProductCommand(command, nonce)).toEqual(command);
    for (const bad of [
      { ...command, csrf: 'secret' },
      { ...command, version: 1 },
      { ...command, session_nonce: runId },
      { ...command, run_id: 'invalid' },
      {
        ...command,
        manifest: {
          ...manifest,
          runtime: { ...CORE_RUNTIME, engine_version: 'latest' },
        },
      },
    ])
      expect(parseProductCommand(bad, nonce)).toBeNull();
    expect(
      parseProductCommand({ ...envelope, type: 'cancel' }, nonce)?.type,
    ).toBe('cancel');
    expect(
      parseProductCommand({ ...envelope, type: 'stdin', text: null }, nonce)
        ?.type,
    ).toBe('stdin');
    expect(
      parseProductCommand(
        { ...envelope, type: 'fetch', url: '/api/v1/me/' },
        nonce,
      ),
    ).toBeNull();
  });
  it('bounds input by exact UTF-8 size, line count and aggregate bytes', () => {
    expect(validBatchInput(['', '雪'])).toBe(true);
    expect(validBatchInput(['\ud800'])).toBe(false);
    expect(validBatchInput(['雪'.repeat(2000)])).toBe(false);
    expect(validBatchInput(Array(101).fill(''))).toBe(false);
    expect(validBatchInput(Array(17).fill('a'.repeat(4096)))).toBe(false);
  });
  it('requires a measured isolation/interactive capability and exact ready fields', () => {
    const ready = {
      protocol: RUNNER_PROTOCOL,
      version: 2,
      type: 'ready',
      session_nonce: nonce,
      interactive: true,
      cross_origin_isolated: true,
    };
    expect(parseProductReady(ready, nonce)).toEqual(ready);
    for (const bad of [
      { ...ready, cross_origin_isolated: false },
      { ...ready, version: 1 },
      { ...ready, auth: true },
      { ...ready, interactive: 'true' },
    ])
      expect(parseProductReady(bad, nonce)).toBeNull();
  });
  it('validates chunk sequencing fields, terminal identity and closed operation vocabulary', () => {
    const output = {
      ...envelope,
      type: 'output',
      stream: 'stdout',
      text: '雪',
      sequence: 0,
    };
    expect(parseProductEvent(output, nonce)).toEqual(output);
    for (const bad of [
      { ...output, sequence: -1 },
      { ...output, sequence: '0' },
      { ...output, text: 'x'.repeat(8193) },
      { ...output, stream: 'html' },
      { ...output, type: 'api_command' },
      { ...output, version: 1 },
    ])
      expect(parseProductEvent(bad, nonce)).toBeNull();
    const terminal = {
      ...envelope,
      type: 'terminal',
      status: 'succeeded',
      manifest_sha256: 'a'.repeat(64),
      runtime_id: CORE_RUNTIME.runtime_id,
    };
    expect(parseProductEvent(terminal, nonce)).toEqual(terminal);
    expect(
      parseProductEvent({ ...terminal, status: ['succeeded'] }, nonce),
    ).toBeNull();
    expect(
      parseProductEvent({ ...terminal, runtime_id: 'unknown' }, nonce),
    ).toBeNull();
  });
});
