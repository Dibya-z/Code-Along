import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  captureProjectManifest,
  type ProjectRunManifest,
} from '@code-along/contracts/execution/project';
import {
  capturePracticeManifest,
  REVIEWED_HELPER_RELEASE,
  capturePublicChecksManifest,
} from '@code-along/contracts/execution/practice';
import type { SourceCandidate } from '../execution/source-actions.ts';
import { SubmissionModel } from './model.ts';
import {
  prepareSubmission,
  submissionRevision,
  validateReceipt,
  validateSubmissionDetail,
  validEvidence,
} from './validation.ts';
import type { SubmissionRequest } from './types.ts';
import { readSubmissionEntry } from './api.ts';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function candidate(
  source = '\uFEFFprint("π 🐍")\r\n',
): Promise<SourceCandidate> {
  return {
    captured: {
      sourceRevision: 1,
      manifest: await captureProjectManifest({
        project_id: id(1),
        source_kind: 'project',
        metadata_version: 7,
        entrypoint_file_id: id(2),
        runtime: CORE_RUNTIME,
        stdin_mode: 'interactive',
        files: [
          {
            file_id: id(2),
            document_id: id(3),
            generation: 1,
            path: 'main.py',
            source,
          },
        ],
      }),
    },
    task: {
      project_id: id(1),
      assignment_id: id(4),
      assignment_version_id: id(5),
      assignment_content_sha256: 'a'.repeat(64),
      runtime: CORE_RUNTIME,
      helper_release: REVIEWED_HELPER_RELEASE,
    },
    practice: null,
  };
}
async function receipt(choice: SourceCandidate, body: SubmissionRequest) {
  return {
    id: id(9),
    assignment_id: id(4),
    work_id: id(6),
    assignment_version_id: id(5),
    assignment_submission_number: 1,
    submitted_at: '2026-11-14T08:09:10.123456Z',
    author: { id: id(7), display_name: 'River' },
    participants: [{ id: id(7), display_name: 'River' }],
    client_request_id: body.client_request_id,
    source_manifest_sha256: body.manifest.sha256,
    artifact_manifest_sha256: (await submissionRevision(body.manifest)).sha256,
    artifact_scope: 'submission',
    provenance: 'client_submitted_snapshot',
    practice: body.practice,
    can_review: false,
    manifest: body.manifest,
    helper_release: REVIEWED_HELPER_RELEASE,
    published_version: {
      number: 1,
      title: 'Exact code',
      content_sha256: choice.task.assignment_content_sha256,
      submission_mode: 'individual',
    },
  };
}
describe('exact submission ownership and confirmation', () => {
  it('requires actual enum strings rather than arrays or objects in evidence and receipt policy', async () => {
    const selected = await candidate();
    const { body } = await prepareSubmission(selected);
    for (const status of [['succeeded'], { value: 'succeeded' }])
      expect(
        validEvidence(
          {
            kind: 'run',
            run_id: id(20),
            source_manifest_sha256: body.manifest.sha256,
            status,
          },
          body.manifest.sha256,
        ),
      ).toBe(false);
    for (const check_origin of [['published'], { value: 'published' }])
      expect(
        validEvidence(
          {
            kind: 'visible_checks',
            run_id: id(20),
            source_manifest_sha256: body.manifest.sha256,
            status: 'succeeded',
            practice_manifest_sha256: 'a'.repeat(64),
            published_checks_sha256: 'a'.repeat(64),
            checks_sha256: 'b'.repeat(64),
            check_origin,
          },
          body.manifest.sha256,
        ),
      ).toBe(false);
    const good = await receipt(selected, body);
    for (const submission_mode of [['individual'], { value: 'individual' }])
      await expect(
        validateSubmissionDetail(
          {
            ...good,
            published_version: { ...good.published_version, submission_mode },
          },
          id(4),
        ),
      ).rejects.toThrow();
    await expect(
      validateSubmissionDetail(
        {
          ...good,
          practice: {
            kind: 'run',
            run_id: id(20),
            source_manifest_sha256: body.manifest.sha256,
            status: ['succeeded'],
          },
        },
        id(4),
      ),
    ).rejects.toThrow();
  });
  it('stops a static read before private GET or ignores its data/error when the cached account changes before effect cleanup', async () => {
    const chosen = await candidate();
    const { body } = await prepareSubmission(chosen);
    const verified = await validateSubmissionDetail(
      await receipt(chosen, body),
      id(4),
    );
    let active = true;
    let releaseIdentity!: (value: { id: string }) => void;
    const detail = vi.fn(async () => verified);
    const identity = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          releaseIdentity = resolve;
        }),
    );
    const pending = readSubmissionEntry(
      id(7),
      id(4),
      id(9),
      new AbortController().signal,
      () => active,
      { identity, detail },
    );
    active = false;
    releaseIdentity({ id: id(7) });
    expect(await pending).toBeNull();
    expect(detail).not.toHaveBeenCalled();
    for (const reject of [false, true]) {
      active = true;
      let finish!: (value: typeof verified) => void,
        fail!: (value: Error) => void;
      const privateRead = vi.fn(
        () =>
          new Promise<typeof verified>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      const late = readSubmissionEntry(
        id(7),
        id(4),
        id(9),
        new AbortController().signal,
        () => active,
        { identity: async () => ({ id: id(7) }), detail: privateRead },
      );
      await Promise.resolve();
      expect(privateRead).toHaveBeenCalledTimes(1);
      active = false;
      if (reject) fail(new Error('Private read unavailable'));
      else finish(verified);
      expect(await late).toBeNull();
    }
    active = true;
    await expect(
      readSubmissionEntry(
        id(7),
        id(4),
        id(9),
        new AbortController().signal,
        () => active,
        { identity: async () => ({ id: id(8) }), detail },
      ),
    ).rejects.toThrow('Your account changed.');
    expect(detail).not.toHaveBeenCalled();
  });
  it('agrees with the shared independent source/artifact vectors and rejects wire-only non-submission domains', async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL(
          '../../../../../packages/contracts/fixtures/submission-manifests.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      cases: {
        name: string;
        submission_valid: boolean;
        manifest: ProjectRunManifest;
        raw_manifest_json?: string;
        artifact_manifest_sha256?: string;
        source_recipes?: Record<
          string,
          { prefix: string; unit: string; repeat: number; suffix: string }
        >;
      }[];
    };
    for (const item of corpus.cases) {
      const manifest: ProjectRunManifest = item.raw_manifest_json
        ? JSON.parse(item.raw_manifest_json)
        : {
            ...structuredClone(item.manifest),
            files: item.manifest.files.map((file) => {
              const recipe = item.source_recipes?.[file.path];
              return {
                ...file,
                source: recipe
                  ? recipe.prefix +
                    recipe.unit.repeat(recipe.repeat) +
                    recipe.suffix
                  : file.source,
              };
            }),
          };
      const original = await candidate();
      const selected: SourceCandidate = {
        ...original,
        captured: { sourceRevision: 1, manifest },
        task: {
          ...original.task,
          project_id: manifest.project_id,
          runtime: manifest.runtime,
        },
      };
      if (!item.submission_valid) {
        await expect(prepareSubmission(selected), item.name).rejects.toThrow();
        await expect(submissionRevision(manifest), item.name).rejects.toThrow();
      } else {
        const { body } = await prepareSubmission(selected);
        expect(body.manifest.sha256, item.name).toBe(manifest.sha256);
        const revision = await submissionRevision(
          body.manifest,
          item.artifact_manifest_sha256,
        );
        expect(revision.sha256, item.name).toBe(item.artifact_manifest_sha256);
        expect(
          revision.files.map((file) => file.source),
          item.name,
        ).toEqual(manifest.files.map((file) => file.source));
      }
    }
  });
  it('permits only one in-flight send and retains a malformed receipt request for an order-independent manual confirmation', async () => {
    const plain = await candidate();
    const selected: SourceCandidate = {
      ...plain,
      practice: {
        kind: 'run',
        run_id: id(20),
        source_manifest_sha256: plain.captured.manifest.sha256,
        status: 'succeeded',
      },
    };
    let release!: (value: { id: string }) => void;
    let immediate = false;
    const authorize = vi.fn(() =>
      immediate
        ? Promise.resolve({ id: id(7) })
        : new Promise<{ id: string }>((resolve) => {
            release = resolve;
          }),
    );
    const requests: SubmissionRequest[] = [];
    const model = new SubmissionModel(
      id(7),
      id(6),
      () => true,
      authorize,
      async (body) => {
        requests.push(body);
        const value = await receipt(selected, body);
        return requests.length === 1
          ? { ...value, artifact_scope: 'project' }
          : {
              ...value,
              practice: Object.fromEntries(
                Object.entries(value.practice!).reverse(),
              ),
            };
      },
    );
    await model.prepare(() => selected);
    const body = model.getSnapshot().body!;
    const sending = model.submit();
    await model.submit();
    model.clear();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(model.getSnapshot().body).toBe(body);
    release({ id: id(7) });
    await sending;
    expect(model.getSnapshot().phase).toBe('uncertain');
    expect(model.getSnapshot().body).toBe(body);
    immediate = true;
    await model.submit();
    expect(model.getSnapshot().phase).toBe('confirmed');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    model.destroy();
  });
  it('locks preparation synchronously and retains the same immutable source/body/nonce after uncertainty and later source changes', async () => {
    const selected = await candidate();
    let release!: (value: SourceCandidate) => void;
    const capture = vi.fn(
      () =>
        new Promise<SourceCandidate>((resolve) => {
          release = resolve;
        }),
    );
    const authorize = vi.fn(async () => ({ id: id(7) }));
    const requests: SubmissionRequest[] = [];
    let available = false;
    const model = new SubmissionModel(
      id(7),
      id(6),
      () => true,
      authorize,
      async (body) => {
        requests.push(body);
        if (!available) throw new Error('Uncertain reply');
        return receipt(selected, body);
      },
    );
    const pending = model.prepare(capture);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
    await model.prepare(capture);
    expect(capture).toHaveBeenCalledTimes(1);
    release(selected);
    await pending;
    const body = model.getSnapshot().body!;
    const exact = JSON.stringify(body);
    expect(body.practice).toBeNull();
    expect(Object.isFrozen(body.manifest.files[0])).toBe(true);
    await model.submit();
    expect(model.getSnapshot().phase).toBe('uncertain');
    // A newer source/run or denied Work snapshot is never consulted on retry.
    await model.prepare(() => candidate('print("H2")\n'));
    expect(JSON.stringify(model.getSnapshot().body)).toBe(exact);
    available = true;
    await model.submit();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(model.getSnapshot().phase).toBe('confirmed');
    expect(model.getSnapshot().receipt?.manifest.files[0]?.source).toBe(
      '\uFEFFprint("π 🐍")\r\n',
    );
    model.destroy();
  });
  it('ignores stale authentication and late successful responses after account/scope teardown', async () => {
    const chosen = await candidate();
    let active = true;
    let complete!: (value: unknown) => void;
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const model = new SubmissionModel(
      id(7),
      id(6),
      () => active,
      async () => ({ id: id(7) }),
      send,
    );
    await model.prepare(() => chosen);
    const body = model.getSnapshot().body!;
    const sending = model.submit();
    await Promise.resolve();
    active = false;
    complete(await receipt(chosen, body));
    await sending;
    expect(model.getSnapshot().phase).toBe('sending');
    model.destroy();
    const foreignSend = vi.fn();
    const foreign = new SubmissionModel(
      id(7),
      id(6),
      () => true,
      async () => ({ id: id(8) }),
      foreignSend,
    );
    await foreign.prepare(() => chosen);
    await foreign.submit();
    expect(foreignSend).not.toHaveBeenCalled();
    expect(foreign.getSnapshot().body).not.toBeNull();
    foreign.destroy();
  });
  it('does not confirm an unreadable or foreign receipt, including wrong artifact hash, actor, nonce, Work, version and scope', async () => {
    const selected = await candidate();
    const { body } = await prepareSubmission(selected);
    const good = await receipt(selected, body);
    for (const changed of [
      null,
      {},
      { ...good, author: { id: id(8), display_name: 'Other' } },
      { ...good, client_request_id: id(10) },
      { ...good, work_id: id(10) },
      { ...good, assignment_id: id(10) },
      { ...good, assignment_version_id: id(10) },
      { ...good, artifact_scope: 'project' },
      { ...good, artifact_manifest_sha256: good.source_manifest_sha256 },
      {
        ...good,
        manifest: {
          ...good.manifest,
          files: [{ ...good.manifest.files[0], source: 'changed' }],
        },
      },
      {
        ...good,
        published_version: {
          ...good.published_version,
          content_sha256: 'b'.repeat(64),
        },
      },
    ]) {
      await expect(
        validateReceipt(changed, id(7), id(6), selected, body),
      ).rejects.toThrow();
    }
    const result = await validateReceipt(good, id(7), id(6), selected, body);
    expect(result.detail.source_manifest_sha256).not.toBe(
      result.detail.artifact_manifest_sha256,
    );
    expect(result.revision.files[0]?.source).toBe(
      body.manifest.files[0]?.source,
    );
    expect(Object.isFrozen(result.detail.manifest)).toBe(true);
  });
  it('validates nullable untrusted five-status evidence and recomputes a check result aggregate without uploading check source', async () => {
    const original = await candidate();
    const checks = await capturePublicChecksManifest('assert True\n');
    const practice = await capturePracticeManifest({
      assignment_id: id(4),
      assignment_version_id: id(5),
      assignment_content_sha256: 'a'.repeat(64),
      source: original.captured.manifest,
      helper_release: REVIEWED_HELPER_RELEASE,
      published_checks_sha256: checks.sha256,
      checks_source: checks.source,
      check_origin: 'published',
    });
    for (const status of [
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'output_limit',
    ] as const) {
      expect(
        validEvidence(
          {
            kind: 'run',
            run_id: id(20),
            source_manifest_sha256: original.captured.manifest.sha256,
            status,
          },
          original.captured.manifest.sha256,
        ),
      ).toBe(true);
    }
    const selected: SourceCandidate = {
      ...original,
      practice: {
        kind: 'visible_checks',
        run_id: id(20),
        source_manifest_sha256: original.captured.manifest.sha256,
        status: 'succeeded',
        practice_manifest_sha256: practice.sha256,
        published_checks_sha256: checks.sha256,
        checks_sha256: checks.sha256,
        check_origin: 'published',
      },
    };
    const { body } = await prepareSubmission(selected);
    expect(JSON.stringify(body)).not.toContain('assert True');
    const good = await receipt(selected, body);
    await expect(
      validateReceipt(good, id(7), id(6), selected, body),
    ).resolves.toBeDefined();
    await expect(
      validateSubmissionDetail(
        {
          ...good,
          practice: {
            ...selected.practice,
            practice_manifest_sha256: '0'.repeat(64),
          },
        },
        id(4),
      ),
    ).rejects.toThrow();
    expect(
      validEvidence(
        {
          ...selected.practice,
          check_origin: 'published',
          checks_sha256: '0'.repeat(64),
        },
        body.manifest.sha256,
      ),
    ).toBe(false);
    expect(
      validEvidence(
        {
          kind: 'run',
          run_id: id(20),
          source_manifest_sha256: body.manifest.sha256,
          status: 'running',
        },
        body.manifest.sha256,
      ),
    ).toBe(false);
  });
  it('permits exact empty source and rejects local drafts, tampered Unicode/hash, helper/runtime mismatch and oversized decoded source', async () => {
    await expect(prepareSubmission(await candidate(''))).resolves.toBeDefined();
    const chosen = await candidate();
    for (const changed of [
      {
        ...chosen,
        captured: {
          ...chosen.captured,
          manifest: { ...chosen.captured.manifest, source_kind: 'local_draft' },
        },
      },
      {
        ...chosen,
        captured: {
          ...chosen.captured,
          manifest: { ...chosen.captured.manifest, sha256: '0'.repeat(64) },
        },
      },
      {
        ...chosen,
        task: {
          ...chosen.task,
          helper_release: {
            ...REVIEWED_HELPER_RELEASE,
            source_sha256: '0'.repeat(64),
          },
        },
      },
      {
        ...chosen,
        task: {
          ...chosen.task,
          runtime: { ...CORE_RUNTIME, python_version: 'other' },
        },
      },
      {
        ...chosen,
        captured: {
          ...chosen.captured,
          manifest: {
            ...chosen.captured.manifest,
            files: [
              {
                ...chosen.captured.manifest.files[0],
                source: 'x'.repeat(128 * 1024 + 1),
              },
            ],
          },
        },
      },
    ])
      await expect(
        prepareSubmission(changed as SourceCandidate),
      ).rejects.toThrow();
  });
});
