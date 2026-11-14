import { describe, expect, it } from 'vitest';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  REVISION_HELPERS,
  type RevisionManifest,
} from '../history/manifest.ts';
import { ApiError } from '../../api/client.ts';
import { capacityMessage } from './api.ts';
import {
  draftErrors,
  nonblank,
  safeLabel,
  verifyAssignmentVersion,
  verifyPublicChecks,
  verifyStarter,
} from './validation.ts';
import type { AssignmentVersion, DraftFields } from './types.ts';

const id = '10000000-0000-4000-8000-000000000001';
const fields: DraftFields = {
  title: 'A small exercise',
  instructions: '',
  hints: [],
  public_checks_source: null,
  starter_revision_id: null,
  submission_mode: 'individual',
  max_attempts: 10,
  max_team_size: 1,
  due_at: null,
};
const hash = (value: unknown) => sha256(sourceBytes(JSON.stringify(value)));
async function fixture(): Promise<AssignmentVersion> {
  const version: AssignmentVersion = {
    id,
    assignment_id: id,
    workspace_id: id,
    number: 1,
    title: 'Unicode π',
    instructions: '  Keep CRLF\r\nand exact café / café\n',
    hints: [{ id, title: 'First clue', body: '  Look here\r\n' }],
    published_at: '2026-11-14T12:30:00Z',
    publisher: { id, display_name: 'Teacher' },
    starter: { revision_id: id, manifest_sha256: 'a'.repeat(64) },
    runtime: { ...CORE_RUNTIME },
    helper_release: { ...REVISION_HELPERS },
    public_checks: null,
    submission_policy: {
      mode: 'individual',
      max_attempts: 3,
      max_team_size: 1,
      due_at: '2027-02-01T12:30:01.123456Z',
      late_policy: 'reject',
    },
    content_sha256: '',
  };
  const r = version.runtime,
    h = version.helper_release,
    p = version.submission_policy;
  version.content_sha256 = await hash([
    'code-along.assignment-version',
    1,
    id,
    1,
    version.title,
    version.instructions,
    version.hints.map((hint) => [hint.id, hint.title, hint.body]),
    id,
    'a'.repeat(64),
    r.runtime_id,
    r.manifest_sha256,
    r.engine,
    r.engine_version,
    r.python_version,
    h.release_id,
    h.source_sha256,
    null,
    p.mode,
    p.max_attempts,
    p.max_team_size,
    p.due_at,
    'reject',
  ]);
  return version;
}
describe('assignment integrity and authoring bounds', () => {
  it('shares the explicit blank set and preserves meaningful surrounding bytes', () => {
    expect(nonblank('\ufeff\u0085\u001c \r\n')).toBe(false);
    expect(nonblank('\ufeff π \r\n')).toBe(true);
    expect(safeLabel('🐍'.repeat(120), 120)).toBe(true);
    expect(safeLabel('Title\u202e', 120)).toBe(false);
    expect(draftErrors({ ...fields, instructions: '🐍'.repeat(8192) })).toEqual(
      [],
    );
    expect(
      draftErrors({ ...fields, instructions: '🐍'.repeat(8192) + 'x' }),
    ).toHaveLength(1);
    expect(draftErrors({ ...fields, instructions: '\ud800' })).toHaveLength(1);
  });
  it('bounds stable hint identities, byte totals and submission policy', () => {
    const hint = { id, title: 'Hint', body: 'x'.repeat(4096) };
    expect(draftErrors({ ...fields, hints: [hint, { ...hint }] })).toHaveLength(
      1,
    );
    expect(
      draftErrors({ ...fields, submission_mode: 'team', max_team_size: 1 }),
    ).toHaveLength(1);
    expect(draftErrors({ ...fields, max_attempts: 101 })).toHaveLength(1);
    expect(
      draftErrors({ ...fields, public_checks_source: '\ufeff' }),
    ).toHaveLength(1);
  });
  it('verifies exact assignment content, scoped identities and check provenance before display', async () => {
    const version = await fixture();
    expect(await verifyAssignmentVersion(version, id, id)).toBe(version);
    expect(version.submission_policy.due_at).toBe(
      '2027-02-01T12:30:01.123456Z',
    );
    await expect(
      verifyAssignmentVersion(
        { ...version, instructions: version.instructions.trim() },
        id,
        id,
      ),
    ).rejects.toThrow('digest');
    await expect(
      verifyAssignmentVersion(
        version,
        '20000000-0000-4000-8000-000000000002',
        id,
      ),
    ).rejects.toThrow('verified');
    await expect(
      verifyAssignmentVersion(
        {
          ...version,
          runtime: { ...version.runtime, manifest_sha256: 'b'.repeat(64) },
        },
        id,
        id,
      ),
    ).rejects.toThrow('verified');
  });
  it('verifies exact public check UTF-8 and rejects a changed source/extra field', async () => {
    const source = '# π🐍\r\nassert "café" != "café"\n';
    const source_sha256 = await sha256(sourceBytes(source));
    const sha = await hash([
      'code-along.public-checks',
      1,
      'python',
      source_sha256,
      source,
    ]);
    expect(source_sha256).toBe(
      '62ce43716734183b149ca52d3cc86a1a1d12186f4d713a2fdaeb829d73610112',
    );
    expect(sha).toBe(
      'a59661852e585a6785cb4a9a541cdf8babf509e46011d98aa22a8234bfa2b47f',
    );
    const checks = {
      protocol: 'code-along.public-checks' as const,
      version: 1,
      language: 'python' as const,
      source,
      source_sha256,
      sha256: sha,
    };
    await expect(verifyPublicChecks(checks)).resolves.toBeUndefined();
    await expect(
      verifyPublicChecks({ ...checks, source: source.replace('\r\n', '\n') }),
    ).rejects.toThrow();
    await expect(
      verifyPublicChecks(Object.assign({}, checks, { extra: true })),
    ).rejects.toThrow();
  });
  it('compares reviewed starter identity independently of JSON key ordering', async () => {
    const version = await fixture();
    const r = version.runtime;
    const manifest = {
      sha256: version.starter.manifest_sha256,
      runtime: {
        python_version: r.python_version,
        engine_version: r.engine_version,
        engine: r.engine,
        manifest_sha256: r.manifest_sha256,
        runtime_id: r.runtime_id,
      },
      helper_release: REVISION_HELPERS,
    } as RevisionManifest;
    expect(verifyStarter(version, manifest)).toBe(manifest);
    expect(() =>
      verifyStarter(version, { ...manifest, sha256: 'b'.repeat(64) }),
    ).toThrow('does not match');
  });
  it('distinguishes permanent capacity from stale CAS and transient request quota', () => {
    expect(
      capacityMessage(
        new ApiError(409, {
          code: 'assignment_version_capacity',
          detail: 'Capacity',
        }),
      ),
    ).toContain('50 published');
    expect(
      capacityMessage(new ApiError(409, { detail: 'Stale revision' })),
    ).toBeNull();
    expect(
      capacityMessage(new ApiError(429, { code: 'assignment_capacity' })),
    ).toBeNull();
  });
});
