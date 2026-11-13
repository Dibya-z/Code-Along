import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { sha256, sourceBytes } from '@code-along/contracts/execution';
import { clearCsrf } from '../../api/client.ts';
import { sourceWritable } from '../projects/types.ts';
import { EditorWorkspace } from '../editor/model/workspace.ts';
import { documentTicket } from '../collaboration/api.ts';
import {
  safeShareUrl,
  shareApi,
  shareToken,
  validateResolvedShare,
} from './api.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const source = '# exact 🐍\r\n';
  return {
    kind: 'live',
    share_id: id(1),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    scope: 'write',
    project: {
      id: id(2),
      name: 'Shared Python',
      entrypoint_file_id: id(3),
      metadata_version: 1,
      runtime_id: CORE_RUNTIME.runtime_id,
      archived: false,
      workspace_archived: false,
      access: { kind: 'live_share', scope: 'write' },
    },
    files: {
      count: 1,
      items: [
        {
          id: id(3),
          document_id: id(4),
          generation: 1,
          path: 'main.py',
          kind: 'python',
          initial_source: source,
          initial_sha256: await sha256(sourceBytes(source)),
        },
      ],
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  clearCsrf();
});
describe('explicit live-share source capability', () => {
  it('has source-only access without synthesizing an owner/editor project role', async () => {
    const resolved = await validateResolvedShare(await fixture());
    expect(resolved.kind).toBe('live');
    if (resolved.kind !== 'live') throw new Error('Expected live fixture');
    expect(resolved.project).not.toHaveProperty('role');
    expect(resolved.project).not.toHaveProperty('workspace_id');
    expect(sourceWritable(resolved.project)).toBe(true);
    expect(
      sourceWritable({
        ...resolved.project,
        access: { kind: 'live_share', scope: 'read' },
      }),
    ).toBe(false);
    expect(sourceWritable({ ...resolved.project, archived: true })).toBe(false);
    const workspace = new EditorWorkspace(
      id(5),
      resolved.project.id,
      'project',
      true,
    );
    workspace.reconcile(
      resolved.project,
      resolved.files.items,
      resolved.files.count,
    );
    await workspace.loadSource(resolved.files.items[0]!);
    // The dedicated REST baseline proves identity/integrity, never seeds a canonical room.
    expect(workspace.file(id(3))!.text.toString()).toBe('');
    expect(workspace.file(id(3))!.loaded).toBe(false);
    workspace.destroy();
  });
  it('rejects extra authority, inconsistent scope, expired links, incomplete or forged baselines', async () => {
    const value = await fixture();
    for (const invalid of [
      { ...value, expires_at: new Date(0).toISOString() },
      { ...value, scope: 'owner' },
      { ...value, project: { ...value.project, role: 'editor' } },
      {
        ...value,
        project: {
          ...value.project,
          access: { kind: 'live_share', scope: 'read' },
        },
      },
      { ...value, files: { ...value.files, count: 2 } },
      {
        ...value,
        files: {
          count: 1,
          items: [{ ...value.files.items[0], initial_source: 'forged' }],
        },
      },
      {
        ...value,
        files: {
          count: 1,
          items: [{ ...value.files.items[0], path: '../main.py' }],
        },
      },
      { ...value, project: { ...value.project, entrypoint_file_id: id(99) } },
    ])
      await expect(validateResolvedShare(invalid)).rejects.toThrow();
  });
  it('sends the capability only in dedicated resolve and ticket bodies, never request URLs', async () => {
    const value = await fixture(),
      token = 'x'.repeat(43);
    const fetch = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path === '/api/v1/csrf/'
              ? { csrfToken: 'csrf' }
              : path === '/api/v1/shares/resolve/'
                ? value
                : {
                    ticket: 'ticket',
                    document_name: `${id(4)}:1`,
                    expires_at: value.expires_at,
                  },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const resolved = await shareApi.resolve(token);
    if (resolved.kind !== 'live') throw new Error('Expected live fixture');
    const workspace = new EditorWorkspace(id(5), id(2), 'project', true);
    workspace.reconcile(resolved.project, resolved.files.items);
    await documentTicket(
      id(2),
      workspace.file(id(3))!,
      'write',
      id(6),
      new AbortController().signal,
      token,
    );
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/csrf/',
      '/api/v1/shares/resolve/',
      `/api/v1/projects/${id(2)}/documents/${id(4)}/ticket/`,
    ]);
    expect(fetch.mock.calls.every(([path]) => !path.includes(token))).toBe(
      true,
    );
    const options = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(options[1]![1].body))).toEqual({ token });
    expect(JSON.parse(String(options[2]![1].body))).toMatchObject({
      share_token: token,
      scope: 'write',
      client_session_id: id(6),
    });
    expect(JSON.stringify(workspace.getSnapshot())).not.toContain(token);
    workspace.destroy();
  });
  it('keeps shared capabilities in exact same-origin fragments', () => {
    const origin = 'https://app.example',
      token = 'x'.repeat(43);
    expect(shareToken(`#${token}`)).toBe(token);
    expect(safeShareUrl(`/shares#${token}`, origin)).toBe(
      `${origin}/shares#${token}`,
    );
    for (const link of [
      `https://other.example/shares#${token}`,
      `/shares?token=${token}`,
      `/projects/${id(2)}#${token}`,
      '/shares#short',
      `/shares#${token}%0a`,
    ])
      expect(() => safeShareUrl(link, origin)).toThrow();
  });
});
