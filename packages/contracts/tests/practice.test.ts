import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CHAT_BLANK_CODEPOINTS } from '../events/index.ts';
import {
  RUNNER_PROTOCOL,
  captureRunManifest,
  parseRunnerCommand,
  parseRunnerEvent,
  sha256,
  sourceBytes,
  verifyRunManifest,
} from '../execution/runner.ts';
import { CORE_RUNTIME, SCIENTIFIC_RUNTIME } from '../execution/profiles.ts';
import {
  captureProjectManifest,
  verifyProjectManifest,
  type ProjectSnapshot,
} from '../execution/project-manifest.ts';
import {
  parseProductCommand,
  parseProductEvent,
} from '../execution/product-runner.ts';
import {
  PRACTICE_CHECK_BYTES,
  PRACTICE_PROTOCOL,
  PRACTICE_VERSION,
  REVIEWED_HELPER_RELEASE,
  capturePracticeManifest,
  capturePublicChecksManifest,
  isPracticeManifest,
  isPublicChecksManifest,
  parsePracticeCommand,
  parsePracticeEvent,
  parsePracticeReady,
  verifyPracticeManifest,
  verifyPublicChecksManifest,
  type PracticeManifest,
  type PracticeSnapshot,
} from '../execution/practice.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nonce = id(1),
  runId = id(2);
const checksSource = 'import main\r\nassert "雪🙂" != ""\r\n';
const envelope = {
  protocol: PRACTICE_PROTOCOL,
  version: PRACTICE_VERSION,
  session_nonce: nonce,
  run_id: runId,
};
function source() {
  return {
    project_id: id(10),
    source_kind: 'project' as const,
    metadata_version: 1,
    entrypoint_file_id: id(11),
    runtime: { ...CORE_RUNTIME },
    stdin_mode: 'batch' as const,
    files: [
      {
        file_id: id(11),
        document_id: id(12),
        generation: 1,
        path: 'main.py',
        source: 'print("café 🙂")\r\n',
      },
    ],
  } satisfies ProjectSnapshot;
}
async function snapshot() {
  return {
    assignment_id: id(20),
    assignment_version_id: id(21),
    assignment_content_sha256: 'a'.repeat(64),
    source: source(),
    helper_release: {
      release_id: String(REVIEWED_HELPER_RELEASE.release_id),
      source_sha256: String(REVIEWED_HELPER_RELEASE.source_sha256),
    },
    published_checks_sha256: (await capturePublicChecksManifest(checksSource))
      .sha256,
    checks_source: checksSource,
    check_origin: 'published' as const,
  } satisfies PracticeSnapshot;
}
function mutable(manifest: PracticeManifest) {
  return {
    ...manifest,
    source: {
      ...manifest.source,
      runtime: { ...manifest.source.runtime },
      files: manifest.source.files.map((file) => ({ ...file })),
    },
    helper_release: { ...manifest.helper_release },
    checks: { ...manifest.checks },
  };
}

describe('exact visible-check and practice manifests', () => {
  it('preserves a leading UTF-8 BOM in exact bytes and legacy/project/practice hashes', async () => {
    const text = '\ufeffprint(42)\n';
    const bytes = sourceBytes(text);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes).toEqual(new TextEncoder().encode(text));
    const legacyFiles = [
      { document_id: id(12), generation: 1, path: 'main.py', source: text },
    ];
    const legacy = await captureRunManifest(legacyFiles, 'main.py', 1);
    const plainLegacy = await captureRunManifest(
      [{ ...legacyFiles[0]!, source: text.slice(1) }],
      'main.py',
      1,
    );
    expect(legacy.files[0]!.source).toBe(text);
    expect(legacy.files[0]!.sha256).toBe(
      await sha256(new TextEncoder().encode(text)),
    );
    expect(legacy.sha256).not.toBe(plainLegacy.sha256);
    expect(await verifyRunManifest(legacy)).toBe(true);
    const projectInput = source();
    projectInput.files[0]!.source = text;
    const project = await captureProjectManifest(projectInput);
    expect(project.files[0]!.source).toBe(text);
    expect(project.files[0]!.sha256).toBe(legacy.files[0]!.sha256);
    expect(await verifyProjectManifest(project)).toBe(true);
    const checks = await capturePublicChecksManifest('\ufeffassert True\n');
    expect(checks.source.startsWith('\ufeff')).toBe(true);
    expect(await verifyPublicChecksManifest(checks)).toBe(true);
    const input = await snapshot();
    input.source = projectInput;
    input.checks_source = checks.source;
    input.published_checks_sha256 = checks.sha256;
    const practice = await capturePracticeManifest(input);
    expect(practice.source.sha256).toBe(project.sha256);
    expect(practice.source.files[0]!.source).toBe(text);
    expect(practice.checks.source).toBe(checks.source);
    expect(await verifyPracticeManifest(practice)).toBe(true);
    const withoutBom = await capturePublicChecksManifest(
      checks.source.slice(1),
    );
    const changedChecks = await capturePracticeManifest({
      ...input,
      checks_source: withoutBom.source,
      published_checks_sha256: withoutBom.sha256,
    });
    expect(changedChecks.source.sha256).toBe(practice.source.sha256);
    expect(changedChecks.sha256).not.toBe(practice.sha256);
  });

  it('matches independent Python compact UTF-8 golden digests without changing source v2', async () => {
    // Python hashlib + json.dumps(ensure_ascii=False,separators=(',',':')) golden values.
    const manifest = await capturePracticeManifest(await snapshot());
    expect(manifest.source.sha256).toBe(
      'f4aba78e51ca4cea1ce07439e367c3dac622faa8eb120bbe9366a417db7d1dd2',
    );
    expect(manifest.source.files[0]!.sha256).toBe(
      '4cac9612f9a26553d7addc6a8d12fa1a6fd232a19d668fd3d8076d58141ebaf0',
    );
    expect(manifest.checks.source_sha256).toBe(
      'c31a9bfca1112cf91bf2a82e1c9525e557868a12fe5f386de7a4e59d922f743b',
    );
    expect(manifest.checks.sha256).toBe(
      'ad4c0b094c94a314c96fb71dfdf04ff70b957c154f2af6a812fe26c0a75cb8bc',
    );
    expect(manifest.sha256).toBe(
      '68348d2526cd74da49216fd2e13e256d3ee85218a8c942dc01509a03b303f939',
    );
    expect(manifest.source).toEqual(await captureProjectManifest(source()));
    expect(await verifyPracticeManifest(manifest)).toBe(true);
    expect(await verifyPublicChecksManifest(manifest.checks)).toBe(true);
  });

  it('captures source, effective checks, context and helper in one synchronous turn before hashing', async () => {
    const input = await snapshot();
    const pending = capturePracticeManifest(input);
    input.source.files[0]!.source = 'print("later H2")';
    input.source.files[0]!.generation = 2;
    input.source.metadata_version = 3;
    input.source.runtime.python_version = 'later';
    input.source.files.pop();
    input.checks_source = 'assert False # later copy';
    input.assignment_version_id = id(99);
    input.helper_release.source_sha256 = '0'.repeat(64);
    input.published_checks_sha256 = 'b'.repeat(64);
    const captured = await pending;
    expect(captured.source.files[0]!.source).toBe('print("café 🙂")\r\n');
    expect(captured.source.files[0]!.generation).toBe(1);
    expect(captured.source.metadata_version).toBe(1);
    expect(captured.source.runtime).toEqual(CORE_RUNTIME);
    expect(captured.checks.source).toBe(checksSource);
    expect(captured.assignment_version_id).toBe(id(21));
    expect(captured.helper_release).toEqual(REVIEWED_HELPER_RELEASE);
    expect(captured.published_checks_sha256).toBe(captured.checks.sha256);
    expect(
      [
        captured,
        captured.source,
        captured.source.files,
        captured.source.files[0],
        captured.source.runtime,
        captured.checks,
        captured.helper_release,
      ].every(Object.isFrozen),
    ).toBe(true);
    expect(await verifyPracticeManifest(captured)).toBe(true);
  });

  it('keeps all twenty learner files and the original entrypoint while checks remain a separate string', async () => {
    const input = await snapshot();
    input.source.files = Array.from({ length: 20 }, (_, n) => ({
      file_id: id(11 + n),
      document_id: id(101 + n),
      generation: 1,
      path: `file${String(n).padStart(2, '0')}.py`,
      source: `value = ${n}\n`,
    }));
    const manifest = await capturePracticeManifest(input);
    expect(manifest.source.files).toHaveLength(20);
    expect(manifest.source.entrypoint_file_id).toBe(
      input.source.entrypoint_file_id,
    );
    expect(
      manifest.source.files.some(
        (file) => file.source === manifest.checks.source,
      ),
    ).toBe(false);
    expect(manifest.checks.source).toBe(checksSource);
    expect(await verifyPracticeManifest(manifest)).toBe(true);
  });

  it('binds the effective practice copy while retaining the exact published checks and source identity', async () => {
    const input = await snapshot();
    const original = await capturePracticeManifest(input);
    const copy = await capturePracticeManifest({
      ...input,
      check_origin: 'local_practice',
      checks_source: 'import main\nassert "edited copy"\n',
    });
    expect(copy.source.sha256).toBe(original.source.sha256);
    expect(copy.published_checks_sha256).toBe(original.checks.sha256);
    expect(copy.checks.sha256).not.toBe(original.checks.sha256);
    expect(copy.sha256).not.toBe(original.sha256);
    expect(await verifyPracticeManifest(copy)).toBe(true);
    await expect(
      capturePracticeManifest({ ...input, checks_source: copy.checks.source }),
    ).rejects.toThrow('published visible checks');
    expect(
      (
        await capturePracticeManifest({
          ...input,
          check_origin: 'local_practice',
        })
      ).check_origin,
    ).toBe('local_practice');
  });

  it('hashes pinned assignment/version/content and source stdin/runtime identities separately', async () => {
    const input = await snapshot();
    const base = await capturePracticeManifest(input);
    for (const changes of [
      { assignment_id: id(30) },
      { assignment_version_id: id(31) },
      { assignment_content_sha256: 'b'.repeat(64) },
      { source: { ...input.source, stdin_mode: 'interactive' as const } },
      { source: { ...input.source, runtime: SCIENTIFIC_RUNTIME } },
    ])
      expect(
        (await capturePracticeManifest({ ...input, ...changes })).sha256,
      ).not.toBe(base.sha256);
  });

  it('preserves exact UTF-8, CRLF, trailing newlines and combining forms without normalization', async () => {
    const sources = [
      '# café\r\n',
      '# café\n',
      '# café\n\n',
      '# café\n',
      '# 雪🙂\u2028\u2029\\\t\u0001\n',
    ];
    const manifests = await Promise.all(
      sources.map(capturePublicChecksManifest),
    );
    expect(manifests.map((manifest) => manifest.source)).toEqual(sources);
    expect(new Set(manifests.map((manifest) => manifest.sha256)).size).toBe(
      sources.length,
    );
    expect(
      await Promise.all(manifests.map(verifyPublicChecksManifest)),
    ).toEqual(sources.map(() => true));
  });

  it('enforces the shared nonblank and exact UTF-8 16 KiB check bound', async () => {
    const boundary = '雪'.repeat(5461) + '#';
    expect(sourceBytes(boundary)).toHaveLength(PRACTICE_CHECK_BYTES);
    expect((await capturePublicChecksManifest(boundary)).source).toBe(boundary);
    for (const invalid of [
      '',
      String.fromCodePoint(...CHAT_BLANK_CODEPOINTS),
      `${boundary}x`,
      '#\0',
      '#\ud800',
      '#\udc00',
    ])
      await expect(capturePublicChecksManifest(invalid)).rejects.toThrow(
        'nonblank visible checks',
      );
  });

  it('rejects unknown fields, coerced identity values and unknown runtime/helper before admission', async () => {
    const manifest = await capturePracticeManifest(await snapshot());
    for (const invalid of [
      { ...manifest, score: 100 },
      { ...manifest, version: '1' },
      { ...manifest, version: true },
      { ...manifest, assignment_id: 'not-a-uuid' },
      { ...manifest, check_origin: ['published'] },
      {
        ...manifest,
        helper_release: { ...manifest.helper_release, release_id: 'latest' },
      },
      {
        ...manifest,
        helper_release: {
          ...manifest.helper_release,
          source_sha256: '0'.repeat(64),
        },
      },
      {
        ...manifest,
        helper_release: { ...manifest.helper_release, privilege: true },
      },
      {
        ...manifest,
        source: {
          ...manifest.source,
          runtime: { ...manifest.source.runtime, python_version: 'latest' },
        },
      },
      { ...manifest, checks: { ...manifest.checks, language: 'javascript' } },
      { ...manifest, checks: { ...manifest.checks, ignored: true } },
    ]) {
      expect(isPracticeManifest(invalid)).toBe(false);
      expect(await verifyPracticeManifest(invalid)).toBe(false);
    }
    expect(
      isPublicChecksManifest({
        ...manifest.checks,
        source_sha256: ['a'.repeat(64)],
      }),
    ).toBe(false);
  });

  it('rejects crypto tampering in source, checks and each bound version identity', async () => {
    const manifest = await capturePracticeManifest(await snapshot());
    for (const invalid of [
      { ...manifest, sha256: '0'.repeat(64) },
      { ...manifest, assignment_version_id: id(999) },
      { ...manifest, assignment_content_sha256: 'b'.repeat(64) },
      {
        ...manifest,
        source: {
          ...manifest.source,
          files: manifest.source.files.map((file) => ({
            ...file,
            source: file.source.replace('\r\n', '\n'),
          })),
        },
      },
      { ...manifest, source: { ...manifest.source, sha256: '0'.repeat(64) } },
      { ...manifest, checks: { ...manifest.checks, source: 'assert False' } },
      {
        ...manifest,
        checks: { ...manifest.checks, source_sha256: '0'.repeat(64) },
      },
      { ...manifest, checks: { ...manifest.checks, sha256: '0'.repeat(64) } },
    ])
      expect(await verifyPracticeManifest(invalid)).toBe(false);
  });

  it('rejects callers mutating a pending verification candidate rather than approving a later object', async () => {
    const candidate = mutable(await capturePracticeManifest(await snapshot()));
    const pending = verifyPracticeManifest(candidate);
    candidate.source.files[0]!.source = 'print("H2 while verification waits")';
    candidate.assignment_content_sha256 = 'b'.repeat(64);
    expect(await pending).toBe(false);
    const checks = { ...(await capturePublicChecksManifest(checksSource)) };
    const checksPending = verifyPublicChecksManifest(checks);
    checks.source = 'assert False';
    expect(await checksPending).toBe(false);
  });

  it('matches the actual reviewed helper bytes instead of accepting a release label alone', async () => {
    const bytes = await readFile(
      new URL('../../../apps/runner-web/src/code_along.py', import.meta.url),
    );
    expect(await sha256(bytes)).toBe(REVIEWED_HELPER_RELEASE.source_sha256);
    expect(REVIEWED_HELPER_RELEASE.release_id).toBe(
      'code-along-python-helpers-v1',
    );
    expect(Object.isFrozen(REVIEWED_HELPER_RELEASE)).toBe(true);
  });
});

describe('strict practice wire v1, independent from legacy runner protocols', () => {
  it('admits only bounded run/input/cancel commands with exact credential-free fields', async () => {
    const manifest = await capturePracticeManifest(await snapshot());
    const command = { ...envelope, type: 'run', manifest, stdin: ['雪', ''] };
    expect(parsePracticeCommand(command, nonce)).toEqual(command);
    expect(
      parsePracticeCommand({ ...envelope, type: 'cancel' }, nonce)?.type,
    ).toBe('cancel');
    expect(
      parsePracticeCommand({ ...envelope, type: 'stdin', text: null }, nonce)
        ?.type,
    ).toBe('stdin');
    for (const bad of [
      { ...command, csrf: 'not-allowed' },
      { ...command, score: 100 },
      { ...command, version: 2 },
      { ...command, protocol: RUNNER_PROTOCOL },
      { ...command, session_nonce: runId },
      { ...command, run_id: 'invalid' },
      { ...command, stdin: ['雪'.repeat(2000)] },
      { ...command, stdin: Array(101).fill('') },
      { ...envelope, type: 'stdin', text: '\ud800' },
      { ...envelope, type: 'cancel', token: 'not-allowed' },
      { ...envelope, type: 'grade', result: 'pass' },
    ])
      expect(parsePracticeCommand(bad, nonce)).toBeNull();
  });

  it('requires the exact ready capability and measured isolation for interactive input', () => {
    const ready = {
      protocol: PRACTICE_PROTOCOL,
      version: PRACTICE_VERSION,
      type: 'ready',
      session_nonce: nonce,
      interactive: true,
      cross_origin_isolated: true,
    };
    expect(parsePracticeReady(ready, nonce)).toEqual(ready);
    expect(
      parsePracticeReady(
        { ...ready, interactive: false, cross_origin_isolated: false },
        nonce,
      ),
    ).not.toBeNull();
    for (const bad of [
      { ...ready, cross_origin_isolated: false },
      { ...ready, session_nonce: runId },
      { ...ready, version: 2 },
      { ...ready, auth: true },
      { ...ready, interactive: 'true' },
    ])
      expect(parsePracticeReady(bad, nonce)).toBeNull();
  });

  it('bounds output/state/plot vocabulary and validates every declared terminal identity field', () => {
    const output = {
      ...envelope,
      type: 'output',
      stream: 'stdout',
      text: '雪',
      sequence: 0,
    };
    expect(parsePracticeEvent(output, nonce)).toEqual(output);
    for (const bad of [
      { ...output, sequence: -1 },
      { ...output, sequence: '0' },
      { ...output, text: 'x'.repeat(8193) },
      { ...output, stream: 'html' },
      { ...output, api_command: 'fetch' },
      { ...envelope, type: 'state', state: ['running'] },
    ])
      expect(parsePracticeEvent(bad, nonce)).toBeNull();
    const terminal = {
      ...envelope,
      type: 'terminal',
      status: 'succeeded',
      source_manifest_sha256: 'a'.repeat(64),
      practice_manifest_sha256: 'b'.repeat(64),
      checks_sha256: 'c'.repeat(64),
      helper_release_sha256: REVIEWED_HELPER_RELEASE.source_sha256,
      runtime_id: CORE_RUNTIME.runtime_id,
    };
    expect(parsePracticeEvent(terminal, nonce)).toEqual(terminal);
    for (const field of [
      'source_manifest_sha256',
      'practice_manifest_sha256',
      'checks_sha256',
      'helper_release_sha256',
    ])
      for (const value of ['invalid', ['a'.repeat(64)], null])
        expect(
          parsePracticeEvent({ ...terminal, [field]: value }, nonce),
        ).toBeNull();
    for (const bad of [
      { ...terminal, status: ['succeeded'] },
      { ...terminal, score: 100 },
      { ...terminal, runtime_id: 'latest' },
      { ...terminal, manifest_sha256: 'a'.repeat(64) },
    ])
      expect(parsePracticeEvent(bad, nonce)).toBeNull();
    // Correctly shaped hashes still require correlation to the app's retained capture.
    expect(
      parsePracticeEvent({ ...terminal, checks_sha256: 'd'.repeat(64) }, nonce),
    ).not.toBeNull();
  });

  it('does not weaken either legacy wire to accept practice commands or terminal fields', async () => {
    const manifest = await capturePracticeManifest(await snapshot());
    const run = { ...envelope, type: 'run', manifest, stdin: [] };
    expect(parseRunnerCommand(run, nonce)).toBeNull();
    expect(parseProductCommand(run, nonce)).toBeNull();
    expect(
      parseProductCommand(
        { ...run, protocol: RUNNER_PROTOCOL, version: 2 },
        nonce,
      ),
    ).toBeNull();
    const terminal = {
      ...envelope,
      type: 'terminal',
      status: 'succeeded',
      source_manifest_sha256: manifest.source.sha256,
      practice_manifest_sha256: manifest.sha256,
      checks_sha256: manifest.checks.sha256,
      helper_release_sha256: manifest.helper_release.source_sha256,
      runtime_id: manifest.source.runtime.runtime_id,
    };
    expect(parseRunnerEvent(terminal, nonce)).toBeNull();
    expect(parseProductEvent(terminal, nonce)).toBeNull();
    expect(
      parseProductEvent(
        { ...terminal, protocol: RUNNER_PROTOCOL, version: 2 },
        nonce,
      ),
    ).toBeNull();
  });
});
