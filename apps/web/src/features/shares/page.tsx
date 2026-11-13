import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, Notice } from '@code-along/design-system';
import { ApiError } from '../../api/client.ts';
import { useIdentity } from '../auth/session.ts';
import { documentTicket } from '../collaboration/api.ts';
import { EditorWorkbench } from '../editor/workbench.tsx';
import { revisionArchive } from '../history/manifest.ts';
import { RevisionViewer } from '../history/viewer.tsx';
import { createLocalDraft } from '../project-tools/local-draft.ts';
import { shareApi, shareToken, type ResolvedShare } from './api.ts';

export function SharedPage() {
  const identity = useIdentity();
  const location = useLocation();
  const token = shareToken(location.hash);
  const scope = useMemo(() => crypto.randomUUID(), [token]);
  if (!token)
    return (
      <div className="page narrow">
        <h1>Shared link unavailable.</h1>
        <p>
          Open the complete link supplied by its owner, including the part after
          #.
        </p>
        <Link to="/">Return to Code Along</Link>
      </div>
    );
  if (identity.isPending)
    return (
      <div className="page">
        <Notice>Checking your session…</Notice>
      </div>
    );
  return (
    <SharedSource
      key={`${identity.data?.id ?? 'anonymous'}:${scope}`}
      token={token}
      accountId={identity.data?.id ?? null}
    />
  );
}

/** Tokens and resolved source live only in this route instance, never in query keys or device recovery. */
function SharedSource({
  token,
  accountId,
}: {
  token: string;
  accountId: string | null;
}) {
  const [resolved, setResolved] = useState<ResolvedShare | null>(null);
  const current = useRef<ResolvedShare | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [checking, setChecking] = useState(false),
    [error, setError] = useState(''),
    [denied, setDenied] = useState(false);
  const [selected, setSelected] = useState(''),
    [copying, setCopying] = useState(false),
    [copyError, setCopyError] = useState('');
  const navigate = useNavigate();
  const check = useCallback(async () => {
    if (
      current.current &&
      Date.parse(current.current.expires_at) <= Date.now()
    ) {
      setDenied(true);
      setError(
        'This shared link has expired. Export code already open in this tab before leaving.',
      );
    }
    if (active.current) return;
    const abort = new AbortController();
    active.current = abort;
    setChecking(true);
    try {
      const value = await shareApi.resolve(token, abort.signal);
      if (!mounted.current || abort.signal.aborted) return;
      const before = current.current;
      if (
        before &&
        (before.kind !== value.kind ||
          before.share_id !== value.share_id ||
          (before.kind === 'live' &&
            value.kind === 'live' &&
            before.project.id !== value.project.id))
      )
        throw new Error(
          'The shared link changed identity. Reopen the original link.',
        );
      current.current = value;
      setResolved(value);
      setError('');
      setDenied(false);
    } catch (failure) {
      if (!mounted.current || abort.signal.aborted) return;
      setDenied(true);
      setError(
        failure instanceof ApiError &&
          failure.status === 403 &&
          !current.current &&
          !accountId
          ? 'This link is unavailable or requires a verified signed-in account. Sign in, then reopen this complete link. Live source also requires active workspace membership.'
          : failure instanceof ApiError && [403, 404].includes(failure.status)
            ? 'This shared link is unavailable, expired, revoked or intended for another account. Export any code already open in this tab.'
            : 'The shared link could not be checked. Editing is paused. Keep this tab open and export any available code before retrying.',
      );
    } finally {
      if (active.current === abort) {
        active.current = null;
        if (mounted.current) setChecking(false);
      }
    }
  }, [token, accountId]);
  useEffect(() => {
    mounted.current = true;
    void check();
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void check();
    }, 15000);
    const focus = () => {
      void check();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
    };
  }, [check]);
  useEffect(() => {
    if (!resolved) return;
    const expire = () => {
      setDenied(true);
      setError(
        'This shared link has expired. Export code already open in this tab before leaving.',
      );
    };
    const remaining = Date.parse(resolved.expires_at) - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [resolved]);
  const ticket = useMemo(
    () =>
      ((projectId, file, scope, sessionId, signal) =>
        documentTicket(
          projectId,
          file,
          scope,
          sessionId,
          signal,
          token,
        )) satisfies typeof documentTicket,
    [token],
  );
  const capability = useMemo(
    () =>
      resolved?.kind === 'live'
        ? {
            kind: 'live_share' as const,
            shareId: resolved.share_id,
            baselines: resolved.files.items,
            ticket,
          }
        : undefined,
    [resolved, ticket],
  );
  const live = resolved?.kind === 'live' ? resolved : null;
  const selectedId = live?.files.items.some((file) => file.id === selected)
    ? selected
    : (live?.project.entrypoint_file_id ?? '');
  return (
    <div className="page">
      <Link to="/">← Code Along</Link>
      <div className="section-head content-section">
        <div>
          <p className="eyebrow">
            SHARED SOURCE ·{' '}
            {resolved?.kind === 'live' ? 'LIVE ROOM' : 'FROZEN SNAPSHOT'}
          </p>
          <h1>
            {live?.project.name ??
              (resolved?.kind === 'snapshot'
                ? resolved.revision.name
                : 'Open shared source')}
          </h1>
        </div>
        <Button
          variant="secondary"
          busy={checking}
          onClick={() => {
            void check();
          }}
        >
          Recheck shared link
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!resolved && checking && <Notice>Resolving shared source…</Notice>}
      {!accountId && denied && (
        <p>
          <Link className="button secondary" to="/login">
            Sign in
          </Link>
        </p>
      )}
      {live && accountId && capability && (
        <>
          <p className="muted">
            Live source ·{' '}
            {live.scope === 'write' ? 'Read and write source' : 'Read only'} ·
            Expires {new Date(live.expires_at).toLocaleString()}. This link
            grants no project management or history access.
          </p>
          <EditorWorkbench
            accountId={accountId}
            project={live.project}
            files={live.files.items}
            count={live.files.count}
            selectedId={selectedId}
            onSelect={setSelected}
            paused={denied}
            capability={capability}
          />
        </>
      )}
      {resolved?.kind === 'snapshot' && (
        <>
          <p className="muted">
            This frozen revision is read only. Opening it does not connect to a
            live room or run Python.
          </p>
          {copyError && <Notice tone="error">{copyError}</Notice>}
          <RevisionViewer
            manifest={resolved.revision.manifest}
            name={resolved.revision.name}
            actions={
              accountId ? (
                <Button
                  variant="secondary"
                  busy={copying}
                  onClick={() => {
                    setCopying(true);
                    void createLocalDraft(
                      accountId,
                      revisionArchive(
                        resolved.revision.manifest,
                        resolved.revision.name,
                      ),
                    )
                      .then((id) => {
                        void navigate(`/drafts/${id}`);
                      })
                      .catch(() =>
                        setCopyError(
                          'The local copy could not be stored. Export the frozen source instead.',
                        ),
                      )
                      .finally(() => setCopying(false));
                  }}
                >
                  Open local copy
                </Button>
              ) : (
                <Link to="/login" className="button secondary">
                  Sign in to open a local copy
                </Link>
              )
            }
          />
        </>
      )}
    </div>
  );
}
