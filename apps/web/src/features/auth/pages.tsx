import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Field, Notice } from '@code-along/design-system';
import {
  authenticate,
  authErrors,
  replaceSession,
  safeDestination,
} from './session.ts';
type Kind = 'login' | 'signup' | 'forgot' | 'reset' | 'verify';
const content = {
  login: {
    title: 'Welcome back.',
    intro: 'Pick up where you left off.',
    action: 'Sign in',
  },
  signup: {
    title: 'A good place to begin.',
    intro:
      'Create your Code Along account. We’ll send a link to verify your email.',
    action: 'Create account',
  },
  forgot: {
    title: 'Reset your password.',
    intro: 'Enter your email and we’ll send a reset link if an account exists.',
    action: 'Send reset link',
  },
  reset: {
    title: 'Choose a new password.',
    intro: 'Use a password you haven’t used for this account before.',
    action: 'Set new password',
  },
  verify: {
    title: 'Verify your email.',
    intro: 'Confirm your email address to join your learning workspace.',
    action: 'Verify email',
  },
};
export function AccountPage({ kind }: { kind: Kind }) {
  const [params] = useSearchParams();
  const key = params.get('key') ?? '';
  const next = safeDestination(params.get('next'));
  const nextQuery = `?next=${encodeURIComponent(next)}`;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure('');
    setFields({});
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    try {
      if (kind === 'login') {
        const result = await authenticate('login', { email, password });
        if (result.meta?.is_authenticated) {
          await replaceSession(next);
          return;
        }
        setMessage(
          'Check your email for a verification link before signing in.',
        );
      } else if (kind === 'signup') {
        await authenticate('signup', {
          email,
          password,
          display_name: String(form.get('display_name') ?? ''),
        });
        setMessage(
          'Check your email. Follow the verification link, then sign in to continue.',
        );
      } else if (kind === 'forgot') {
        await authenticate('password/request', { email });
        setMessage(
          'If an account exists for that email, a reset link is on its way.',
        );
      } else if (kind === 'reset') {
        await authenticate('password/reset', { key, password });
        setMessage('Your password has been changed. You can now sign in.');
        window.history.replaceState(null, '', '/auth/reset');
      } else {
        await authenticate('email/verify', { key });
        setMessage('Your email is verified. You can now sign in.');
        window.history.replaceState(null, '', '/auth/verify');
      }
    } catch (error) {
      const detail = authErrors(error);
      setFailure(detail.message);
      setFields(detail.fields);
    } finally {
      setBusy(false);
    }
  }
  const invalidKey =
    (kind === 'verify' || kind === 'reset') && !key && !message;
  return (
    <div className="page narrow auth-layout">
      <div>
        <p className="eyebrow">YOUR CODE ALONG ACCOUNT</p>
        <h1>{kind === 'login' ? 'Sign in' : content[kind].title}</h1>
        <p className="lead">{content[kind].intro}</p>
      </div>
      {failure && <Notice tone="error">{failure}</Notice>}
      {message ? (
        <>
          <Notice tone="success">{message}</Notice>
          <Link className="button" to={`/login${nextQuery}`}>
            Go to sign in
          </Link>
        </>
      ) : invalidKey ? (
        <>
          <Notice tone="error">
            This link is missing its verification key. Open the complete link
            from your email.
          </Notice>
          {kind === 'reset' ? (
            <Link to="/auth/forgot">Request a password reset</Link>
          ) : (
            <Link to={`/login${nextQuery}`}>Return to sign in</Link>
          )}
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="form-stack">
          {kind === 'signup' && (
            <Field
              label="Display name"
              name="display_name"
              autoComplete="nickname"
              maxLength={80}
              required
              error={fields['display_name']}
              hint="The name your group will see."
            />
          )}
          {['login', 'signup', 'forgot'].includes(kind) && (
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              error={fields['email']}
            />
          )}
          {['login', 'signup', 'reset'].includes(kind) && (
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete={
                kind === 'login' ? 'current-password' : 'new-password'
              }
              required
              minLength={kind === 'login' ? 1 : 8}
              maxLength={256}
              error={fields['password']}
              hint={
                kind === 'login'
                  ? undefined
                  : 'Use at least 8 characters. Avoid common or personal words.'
              }
            />
          )}
          <Button type="submit" busy={busy}>
            {busy ? 'Please wait…' : content[kind].action}
          </Button>
        </form>
      )}
      {kind === 'login' && (
        <div className="form-stack">
          <Link to="/auth/forgot">Forgot your password?</Link>
          <p className="muted">
            New here?{' '}
            <Link to={`/auth/signup${nextQuery}`}>Create an account</Link>
          </p>
        </div>
      )}
      {kind === 'signup' && (
        <p className="muted">
          Already have an account?{' '}
          <Link to={`/login${nextQuery}`}>Sign in</Link>
        </p>
      )}
    </div>
  );
}
export function AccountActions() {
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await authenticate('session', undefined, 'DELETE');
      await replaceSession('/');
    } catch (error) {
      setFailure(authErrors(error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="actions">
      {failure && <span role="alert">{failure}</span>}
      <Button variant="secondary" busy={busy} onClick={() => void logout()}>
        Sign out
      </Button>
    </div>
  );
}
