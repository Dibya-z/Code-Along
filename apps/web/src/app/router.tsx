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
import { Icon } from '../ui/icon.tsx';
import { ProductBrand } from '../ui/brand.tsx';
import { AppearanceToggle } from '../ui/appearance.tsx';
import { Welcome } from '../ui/welcome.tsx';
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
const AssignmentWorkPage = lazy(() =>
  import('../features/learning/work-page.tsx').then((module) => ({
    default: module.AssignmentWorkPage,
  })),
);
const SubmissionPage = lazy(() =>
  import('../features/submissions/page.tsx').then((module) => ({
    default: module.SubmissionPage,
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
  const accountRoute =
    location.pathname === '/login' || location.pathname.startsWith('/auth/');
  const entryRoute = accountRoute || (location.pathname === '/' && !actor);
  const workspaceActive =
    /^\/(workspaces|projects|assignments)(\/|$)/.test(location.pathname) ||
    (location.pathname === '/' && Boolean(actor));
  const workbenchRoute =
    /^\/projects\//.test(location.pathname) ||
    /^\/drafts\//.test(location.pathname) ||
    /\/works\//.test(location.pathname);
  const context = location.pathname.startsWith('/drafts')
    ? 'Local drafts'
    : location.pathname.includes('/submissions/')
      ? 'Submitted code'
      : location.pathname.includes('/works/')
        ? 'Learning workspace'
        : location.pathname.startsWith('/assignments')
          ? 'Assignments'
          : location.pathname.startsWith('/projects')
            ? 'Project workspace'
            : 'Workspaces';
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
    <div
      className={`app-shell${entryRoute ? ' entry-shell' : ''}${workbenchRoute ? ' workbench-shell' : ''}`}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {!entryRoute && (
        <aside className="sidebar">
          <Link className="wordmark" to="/" aria-label="Code Along home">
            <ProductBrand />
          </Link>
          <p className="rail-label">WORKSPACE</p>
          <nav aria-label="Main navigation">
            <Link
              to="/workspaces"
              className={workspaceActive ? 'active' : undefined}
              aria-current={workspaceActive ? 'page' : undefined}
            >
              <Icon name="workspace" size={18} />
              <span>Workspaces</span>
            </Link>
            <NavLink to="/drafts">
              <Icon name="code" size={18} />
              <span>Local drafts</span>
            </NavLink>
          </nav>
          <div className="rail-note">
            <Icon name="book" size={20} />
            <p>
              A little progress,
              <br />
              <strong>together.</strong>
            </p>
          </div>
          <div className="rail-footer">
            <span className="rail-footer-symbol" aria-hidden="true">
              {'</>'}
            </span>
            <span>Your Python learning space</span>
          </div>
        </aside>
      )}
      <div className="app-body">
        <header className={`topbar${entryRoute ? ' entry-header' : ''}`}>
          {entryRoute ? (
            <Link
              className="entry-wordmark"
              to="/"
              aria-label="Code Along home"
            >
              <ProductBrand />
            </Link>
          ) : (
            <div className="topbar-context">
              <Icon
                name={
                  context === 'Local drafts'
                    ? 'code'
                    : context === 'Project workspace'
                      ? 'folder'
                      : context === 'Workspaces'
                        ? 'workspace'
                        : 'book'
                }
                size={17}
              />
              <span>{context}</span>
            </div>
          )}
          <div className="header-actions">
            <AppearanceToggle />
            {identity.data ? (
              <>
                <span className="account-identity">
                  <span className="account-avatar" aria-hidden="true">
                    {(
                      Array.from(identity.data.display_name.trim())[0] ?? '·'
                    ).toUpperCase()}
                  </span>
                  <span className="account-name">
                    {identity.data.display_name}
                  </span>
                </span>
                <AccountActions />
              </>
            ) : !accountRoute ? (
              <>
                <Link className="header-signin" to="/login">
                  Sign in
                </Link>
                <Link className="button" to="/auth/signup">
                  Create account
                </Link>
              </>
            ) : (
              <span className="entry-header-note">
                A shared space for learning Python.
              </span>
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1} key={location.pathname}>
          <Outlet />
        </main>
        {!workbenchRoute && (
          <footer className="app-footer">
            <span>Code Along</span>
            <span>Code with others. Learn from each other.</span>
          </footer>
        )}
      </div>
    </div>
  );
}
function Home() {
  const identity = useIdentity();
  const location = useLocation();
  if (identity.data) return <WorkspacesPage />;
  if (identity.isPending)
    return (
      <div className="welcome-loading" role="status">
        Opening Code Along…
      </div>
    );
  return (
    <>
      {new URLSearchParams(location.search).get('local-recovery') ===
        'unavailable' && (
        <div className="entry-notice">
          <Notice tone="error">
            You are signed out. Local drafts could not be cleared. Clear this
            site’s browser data before leaving a shared computer.
          </Notice>
        </div>
      )}
      <Welcome />
    </>
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
      {
        path: 'assignments/:assignmentId/submissions/:submissionId',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Opening submitted code…
              </div>
            }
          >
            <SubmissionPage />
          </Suspense>
        ),
      },
      {
        path: 'assignments/:assignmentId/works/:workId',
        element: (
          <Suspense
            fallback={
              <div className="page" role="status">
                Opening assignment work…
              </div>
            }
          >
            <AssignmentWorkPage />
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
