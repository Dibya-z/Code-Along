import { Component, type ReactNode } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  Link,
  NavLink,
  useLocation,
} from 'react-router';
import { Notice } from '@code-along/design-system';
function Shell() {
  const location = useLocation();
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
          <NavLink to="/workspaces">Workspaces</NavLink>
        </nav>
        <div className="rail-footer">
          <span className="status-dot" aria-hidden="true" />
          Learn. Build. Together.
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <span>Python, with company.</span>
          <Link className="button secondary" to="/login">
            Sign in
          </Link>
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
  return (
    <div className="page">
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
function LoginPending() {
  return (
    <div className="page narrow">
      <Link to="/">← Your workspaces</Link>
      <h1>Sign in</h1>
      <Notice>Account access is being prepared.</Notice>
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
      { path: 'workspaces', element: <Home /> },
      { path: 'login', element: <LoginPending /> },
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
