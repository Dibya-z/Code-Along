import { InvitationPage } from '../features/invitations/pages.tsx';
import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  Link,
  NavLink,
  useLocation,
} from 'react-router';
import { AccountPage, AccountActions } from '../features/auth/pages.tsx';
import { useIdentity, replaceSession } from '../features/auth/session.ts';
import { listenForLocalLogout } from '../features/recovery/session-events.ts';
import { Notice } from '@code-along/design-system';
import {
  WorkspacesPage,
  WorkspacePage,
} from '../features/workspaces/pages.tsx';
const ProjectPage = lazy(() =>
  import('../features/projects/page.tsx').then((module) => ({
    default: module.ProjectPage,
  })),
);
const AssignmentPage = lazy(() =>
  import('../features/learning/page.tsx').then((module) => ({
    default: module.AssignmentPage,
  })),
);
const SharedPage = lazy(() =>
  import('../features/shares/page.tsx').then((module) => ({
    default: module.SharedPage,
  })),
);
const LocalDraftsPage = lazy(() =>
  import('../features/project-tools/hub.tsx').then((module) => ({
    default: module.LocalDraftsPage,
  })),
);
const LocalDraftPage = lazy(() =>
  import('../features/project-tools/draft-page.tsx').then((module) => ({
    default: module.LocalDraftPage,
  })),
);
function Shell() {
  const location = useLocation();
  const identity = useIdentity();
  const actor = identity.data?.id;
  const workspaceActive =
    /^\/(workspaces|projects|assignments)(\/|$)/.test(location.pathname) ||
    (location.pathname === '/' && Boolean(actor));
  useEffect(
    () =>
      actor
        ? listenForLocalLogout(actor, () => {
            void replaceSession('/', false);
          })
        : undefined,
    [actor],
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="wordmark" to="/">
          code along
          <span className="brand-mark" aria-hidden="true">
            ↗
          </span>
        </Link>
        <p className="rail-label">YOUR WORKBENCH</p>
        <nav aria-label="Main navigation">
          <Link
            to="/workspaces"
            className={workspaceActive ? 'active' : undefined}
            aria-current={workspaceActive ? 'page' : undefined}
          >
            Workspaces
          </Link>
          <NavLink to="/drafts">Local drafts</NavLink>
        </nav>
        <div className="rail-footer">
          <span className="status-dot" aria-hidden="true" />
          Learn. Build. Together.
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <span className="topbar-context">Python workbench</span>
          {identity.data ? (
            <div className="actions">
              <span>{identity.data.display_name}</span>
              <AccountActions />
            </div>
          ) : (
            <Link className="button secondary" to="/login">
              Sign in
            </Link>
          )}
        </header>
        <main id="main" tabIndex={-1} key={location.pathname}>
          <Outlet />
        </main>
        <footer className="app-footer">
          Code Along <span>A little progress, together.</span>
        </footer>
      </div>
    </div>
  );
}
function Home() {
  const identity = useIdentity();
  if (identity.data) return <WorkspacesPage />;
  return (
    <div className="page">
      {new URLSearchParams(location.search).get('local-recovery') ===
        'unavailable' && (
        <Notice tone="error">
          You are signed out. Local drafts could not be cleared. Clear this
          site’s browser data before leaving a shared computer.
        </Notice>
      )}
      <p className="eyebrow">A PLACE TO WORK TOGETHER</p>
      <h1>Your workspaces</h1>
      <p className="lead">
        Bring your people and your Python. Keep each learning group and its
        projects in one place.
      </p>
      <div className="empty-state">
        <span className="empty-mark" aria-hidden="true">
          [ ]
        </span>
        <h2>Make room for your next idea.</h2>
        <p>
          Sign in to create a workspace or join a group you have been invited
          to.
        </p>
        <Link className="button" to="/login">
          Sign in to Code Along
        </Link>
      </div>
      <div className="page-note">
        <strong>A workspace is your group's home.</strong>
        <p>
          Projects stay private to the people you choose to share them with.
        </p>
      </div>
    </div>
  );
}
function Missing() {
  return (
    <div className="page narrow">
      <p className="eyebrow">PAGE UNAVAILABLE</p>
      <h1>Let's get you back.</h1>
      <p>This page could not be found.</p>
      <Link className="button" to="/workspaces">
        Go to workspaces
      </Link>
    </div>
  );
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main className="page narrow">
        <h1>Something went wrong.</h1>
        <p>Your request could not be displayed. Reload to try again.</p>
        <a className="button" href="/">
          Reload Code Along
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}
const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <Missing />,
    children: [
      { index: true, element: <Home /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      {
        path: 'drafts',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Loading local drafts…
              </div>
            }
          >
            <LocalDraftsPage />
          </Suspense>
        ),
      },
      {
        path: 'drafts/:draftId',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Opening local draft…
              </div>
            }
          >
            <LocalDraftPage />
          </Suspense>
        ),
      },
      { path: 'workspaces/:workspaceId', element: <WorkspacePage /> },
      {
        path: 'assignments/:assignmentId',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Loading assignment…
              </div>
            }
          >
            <AssignmentPage />
          </Suspense>
        ),
      },
      { path: 'invitations/:token', element: <InvitationPage /> },
      {
        path: 'shares',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Opening shared source…
              </div>
            }
          >
            <SharedPage />
          </Suspense>
        ),
      },
      {
        path: 'projects/:projectId',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Loading workbench…
              </div>
            }
          >
            <ProjectPage />
          </Suspense>
        ),
      },
      { path: 'login', element: <AccountPage key="login" kind="login" /> },
      {
        path: 'auth/signup',
        element: <AccountPage key="signup" kind="signup" />,
      },
      {
        path: 'auth/forgot',
        element: <AccountPage key="forgot" kind="forgot" />,
      },
      { path: 'auth/reset', element: <AccountPage key="reset" kind="reset" /> },
      {
        path: 'auth/verify',
        element: <AccountPage key="verify" kind="verify" />,
      },
      { path: '*', element: <Missing /> },
    ],
  },
]);
export function App() {
  return (
    <Boundary>
      <RouterProvider router={router} />
    </Boundary>
  );
}
