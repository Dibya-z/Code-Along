import { Link } from 'react-router';
import { Icon } from './icon.tsx';

/** An honest product entry, with an explicitly illustrative Python example. */
export function Welcome() {
  return (
    <div className="welcome-page">
      <div className="welcome-intro">
        <p className="welcome-kicker">
          <span /> A shared Python workspace
        </p>
        <h1>
          Write Python.
          <br />
          <span>Learn together.</span>
        </h1>
        <p className="welcome-lead">
          Bring your group into one workspace. Write and run Python together,
          then share your work for instructor feedback.
        </p>
        <div className="welcome-actions">
          <Link className="button" to="/auth/signup">
            Create your account <Icon name="arrow-right" size={18} />
          </Link>
          <Link className="welcome-signin" to="/login">
            Open your workspace <Icon name="arrow-right" size={17} />
          </Link>
        </div>
        <p className="welcome-footnote">
          Projects stay private to the people you choose.
        </p>
      </div>
      <div className="welcome-visual">
        <div className="welcome-example">
          <div className="welcome-example-heading">
            <span>
              <Icon name="file" size={17} /> hello.py
            </span>
            <span>Python example</span>
          </div>
          <pre aria-label="Illustrative Python source">
            <code>
              <span className="example-line">
                <span className="example-keyword">def</span>{' '}
                <span className="example-function">learn_together</span>(ideas):
              </span>
              <span className="example-line">
                {'    '}
                <span className="example-keyword">for</span> idea{' '}
                <span className="example-keyword">in</span> ideas:
              </span>
              <span className="example-line">
                {'        '}
                <span className="example-function">print</span>(
                <span className="example-string">
                  f"Let’s build {'{idea}'}!"
                </span>
                )
              </span>
              <span className="example-line"> </span>
              <span className="example-line">
                learn_together([
                <span className="example-string">"something useful"</span>])
              </span>
            </code>
          </pre>
          <div className="welcome-example-note">
            <Icon name="code" size={18} />
            <span>Python core · Browser execution</span>
          </div>
        </div>
        <div className="welcome-annotation">
          <span className="welcome-annotation-mark">
            <Icon name="users" />
          </span>
          <div>
            <strong>Built for learning, with others.</strong>
            <p>An open question is a good place to start.</p>
          </div>
        </div>
      </div>
      <dl className="welcome-capabilities">
        <div>
          <Icon name="users" />
          <dt>Build side by side</dt>
          <dd>Shared code, live cursors and project discussion.</dd>
        </div>
        <div>
          <Icon name="terminal" />
          <dt>Try your next idea</dt>
          <dd>Run Python in an isolated browser workspace.</dd>
        </div>
        <div>
          <Icon name="book" />
          <dt>Make learning visible</dt>
          <dd>Assignments, submitted code and instructor feedback.</dd>
        </div>
      </dl>
    </div>
  );
}
