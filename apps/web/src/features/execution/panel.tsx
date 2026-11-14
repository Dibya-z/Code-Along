import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  RUNTIME_PROFILES,
  runtimeProfile,
} from '@code-along/contracts/execution/profiles';
import { productApi } from '../../api/product.ts';
import { Button, Notice } from '@code-along/design-system';
import type { EditorWorkspace } from '../editor/model/workspace.ts';
import { ExecutionController, running, type RunPhase } from './controller.ts';
import { configuredRunnerOrigin, IframeRunnerBridge } from './bridge.ts';
import './styles.css';
import { ConsoleView } from './console-view.tsx';
import { PlotGallery } from './plot-gallery.tsx';
import { createPortal } from 'react-dom';
import {
  checksCopyError,
  workExecutionConflict,
  type WorkExecutionContext,
  type WorkPracticeInput,
} from './practice.ts';
export interface PracticeAction {
  readonly input: WorkPracticeInput;
  readonly target: HTMLElement | null;
}
const labels: Record<RunPhase, string> = {
  idle: 'Ready to run',
  capturing: 'Capturing project…',
  initializing: 'Starting Python…',
  running: 'Running',
  waiting_for_input: 'Waiting for input',
  succeeded: 'Run finished',
  failed: 'Run failed',
  cancelled: 'Run stopped',
  timed_out: 'Time limit reached',
  output_limit: 'Output limit reached',
};
function RuntimeHelp() {
  let origin: string;
  try {
    origin = configuredRunnerOrigin();
  } catch {
    return null;
  }
  return (
    <p>
      <a href={origin} target="_blank" rel="noreferrer">
        Open Python runtime
      </a>{' '}
      to check its connection. On local development HTTPS, each site may need a
      browser certificate exception.
    </p>
  );
}
export function ExecutionPanel({
  workspace,
  paused,
  toolbar,
  onRun,
  task,
  practice,
  conflict,
}: {
  workspace: EditorWorkspace;
  paused: boolean;
  toolbar?: HTMLElement | null;
  onRun?: () => void;
  task?: WorkExecutionContext;
  practice?: PracticeAction;
  conflict?: string | null;
}) {
  const [resource] = useState(() => ({
    model: new ExecutionController(
      workspace,
      (event, fault, kind) => new IframeRunnerBridge(event, fault, kind),
    ),
    leases: 0,
  }));
  const model = resource.model;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const structure = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'batch' | 'interactive'>('batch');
  const [line, setLine] = useState('');
  const [inputError, setInputError] = useState('');
  const [selectedRuntime, setSelectedRuntime] = useState('');
  const catalogue = useQuery({
    queryKey: ['runtime-profiles', workspace.accountId],
    queryFn: productApi.runtimeProfiles,
  });
  const available = RUNTIME_PROFILES.filter((profile) =>
    catalogue.data?.items.some(
      (item) =>
        item.runtime_id === profile.identity.runtime_id &&
        item.manifest_sha256 === profile.identity.manifest_sha256,
    ),
  );
  const defaultRuntime = workspace.defaultRuntime();
  const profile = runtimeProfile(
    task?.runtime.runtime_id || selectedRuntime || defaultRuntime?.runtime_id,
  );
  const reviewed = profile && available.includes(profile);
  const taskConflict =
    conflict || (task ? workExecutionConflict(workspace, task) : null);
  const checkError = practice
    ? checksCopyError(practice.input.checks_source)
    : null;
  useEffect(() => {
    resource.leases++;
    return () => {
      resource.leases--;
      queueMicrotask(() => {
        if (resource.leases === 0) resource.model.destroy();
      });
    };
  }, [resource]);
  const busy = running(snapshot.phase),
    complete =
      structure.files.length > 0 &&
      structure.files.every((file) => file.loaded);
  const manifest = snapshot.captured?.manifest;
  const earlierChecks =
    snapshot.practice &&
    practice &&
    (snapshot.practice.checks.source !== practice.input.checks_source ||
      snapshot.practice.check_origin !== practice.input.check_origin);
  const inputLines = () =>
    mode === 'batch' && input ? input.replace(/\n$/, '').split('\n') : [];
  const controls = (
    <div className="execution-toolbar">
      <span className="execution-title">Python</span>
      <div className="actions">
        <Button
          disabled={busy || !complete || !reviewed || Boolean(taskConflict)}
          onClick={() => {
            onRun?.();
            void model.run(
              inputLines(),
              task?.runtime ?? profile?.identity,
              mode,
              task,
            );
          }}
        >
          Run code
        </Button>
        <Button
          variant="secondary"
          disabled={!busy}
          onClick={() => model.stop()}
        >
          Stop run
        </Button>
      </div>
    </div>
  );
  return (
    <section className="execution-panel" aria-label="Python execution">
      {toolbar ? createPortal(controls, toolbar) : controls}
      {practice?.target &&
        createPortal(
          <div className="practice-action">
            <Button
              type="button"
              disabled={
                busy ||
                !complete ||
                !reviewed ||
                Boolean(taskConflict || checkError)
              }
              onClick={() => {
                if (
                  busy ||
                  !complete ||
                  !reviewed ||
                  taskConflict ||
                  checkError
                )
                  return;
                onRun?.();
                void model.runChecks(practice.input, inputLines(), mode);
              }}
            >
              Run visible checks
            </Button>
            <p className="muted">
              Uses this task’s published Python environment and your current
              code. Local practice only; this is not a grade.
            </p>
            {checkError && <p role="alert">{checkError}</p>}
            {taskConflict && <p role="alert">{taskConflict}</p>}
          </div>,
          practice.target,
        )}
      <h2 className="console-heading">Console</h2>
      <p className="execution-status" role="status">
        {snapshot.phase === 'idle' && !complete
          ? 'Loading project files…'
          : snapshot.phase === 'idle' && catalogue.isPending
            ? 'Checking runtimes…'
            : snapshot.kind === 'practice' && snapshot.phase === 'succeeded'
              ? 'Checks finished'
              : snapshot.kind === 'practice' && snapshot.phase === 'failed'
                ? 'Checks failed'
                : labels[snapshot.phase]}
      </p>
      {(!online || paused) && (
        <Notice>
          {!online && 'You are offline. '}Local practice uses the complete code
          already in this tab. A previously loaded Python environment may work
          offline; Stop, navigation or missing cached assets can require a
          connection again. Server access still needs verification.
        </Notice>
      )}
      {taskConflict && <Notice tone="error">{taskConflict}</Notice>}
      {(manifest || snapshot.kind === 'practice') && (
        <p className="execution-provenance">
          {snapshot.kind === 'practice' && (
            <span className="practice-scope">
              Untrusted practice · No grade or submission.
            </span>
          )}
          {manifest && (
            <>
              {manifest.source_kind === 'local_draft' && 'Local draft · '}
              {runtimeProfile(manifest.runtime.runtime_id)?.name}
              {' · Python '}
              {manifest.runtime.python_version}
              {snapshot.practice && (
                <strong>
                  {' · '}
                  {snapshot.practice.check_origin === 'published'
                    ? 'Published checks'
                    : 'Practice copy'}
                </strong>
              )}
              {snapshot.earlierSource && <strong> · Earlier source</strong>}
              {earlierChecks && <strong> · Earlier checks</strong>}
            </>
          )}
        </p>
      )}
      {snapshot.error && (
        <Notice tone="error">
          {snapshot.error}
          <RuntimeHelp />
        </Notice>
      )}
      {mode === 'interactive' && (
        <form
          className="interactive-input"
          onSubmit={(event) => {
            event.preventDefault();
            if (model.input(line)) {
              setLine('');
              setInputError('');
            } else
              setInputError(
                'Use at most 4 KiB of valid UTF-8 input, while Python is waiting.',
              );
          }}
        >
          <label>
            Input for Python
            <input
              value={line}
              disabled={snapshot.phase !== 'waiting_for_input'}
              onChange={(event) => setLine(event.target.value)}
            />
          </label>
          <div className="actions">
            <Button
              type="submit"
              disabled={snapshot.phase !== 'waiting_for_input'}
            >
              Send input
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={snapshot.phase !== 'waiting_for_input'}
              onClick={() => model.input(null)}
            >
              Send end of input
            </Button>
          </div>
          {inputError && <p role="alert">{inputError}</p>}
        </form>
      )}
      <ConsoleView
        key={`console:${snapshot.runId}`}
        lines={snapshot.output}
        busy={busy}
        onClear={() => model.clearOutput()}
      />
      <PlotGallery key={`plots:${snapshot.runId}`} plots={snapshot.plots} />
      {manifest && (
        <details className="captured-source">
          <summary>View captured source</summary>
          <p>
            This exact source produced this result. Editing here does not change
            the capture.
          </p>
          <p>
            Source SHA-256 <code>{manifest.sha256}</code> · Metadata v
            {manifest.metadata_version} · Runtime{' '}
            <code>{manifest.runtime.runtime_id}</code>
            {' · Profile SHA-256 '}
            <code>{manifest.runtime.manifest_sha256}</code>
          </p>
          {manifest.files.map((file) => (
            <details key={file.file_id}>
              <summary>{file.path}</summary>
              <p>
                Document {file.document_id} · Generation {file.generation} ·
                SHA-256 <code>{file.sha256}</code>
              </p>
              <pre tabIndex={0}>{file.source}</pre>
            </details>
          ))}
        </details>
      )}
      {snapshot.practice && (
        <details className="captured-checks">
          <summary>View captured checks</summary>
          <p>
            This exact check text produced this practice result. Editing the
            practice copy keeps this capture unchanged.
          </p>
          <pre tabIndex={0} aria-label="Captured visible Python checks">
            <code>{snapshot.practice.checks.source}</code>
          </pre>
        </details>
      )}
      {snapshot.task && (
        <details className="practice-provenance">
          <summary>Task and runtime provenance</summary>
          <dl>
            <dt>Assignment version</dt>
            <dd>{snapshot.task.assignment_version_id}</dd>
            <dt>Published content SHA-256</dt>
            <dd>
              <code>{snapshot.task.assignment_content_sha256}</code>
            </dd>
            <dt>Helper release</dt>
            <dd>{snapshot.task.helper_release.release_id}</dd>
            <dt>Helper SHA-256</dt>
            <dd>
              <code>{snapshot.task.helper_release.source_sha256}</code>
            </dd>
            {snapshot.practice && (
              <>
                <dt>Practice manifest SHA-256</dt>
                <dd>
                  <code>{snapshot.practice.sha256}</code>
                </dd>
                <dt>Published checks SHA-256</dt>
                <dd>
                  <code>{snapshot.practice.published_checks_sha256}</code>
                </dd>
                <dt>Effective checks SHA-256</dt>
                <dd>
                  <code>{snapshot.practice.checks.sha256}</code>
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
      <details className="run-settings">
        <summary>Run options</summary>
        {task ? (
          <div className="execution-input">
            <span>Task environment</span>
            <p>{profile?.name ?? 'Published environment unavailable'}</p>
            <span className="muted">
              Code and visible checks use the environment in this work’s
              published task.
            </span>
          </div>
        ) : (
          <label className="execution-input">
            Python environment
            <select
              value={selectedRuntime}
              onChange={(event) => setSelectedRuntime(event.target.value)}
              disabled={busy}
            >
              <option value="">
                Project default (
                {runtimeProfile(defaultRuntime?.runtime_id)?.name ??
                  'unavailable'}
                )
              </option>
              {available.map((option) => (
                <option
                  key={option.identity.runtime_id}
                  value={option.identity.runtime_id}
                >
                  {option.name}
                </option>
              ))}
            </select>
            <span className="muted">
              {profile?.description} This choice applies to your local run.
            </span>
          </label>
        )}
        {catalogue.error && (
          <Notice tone="error">
            The reviewed runtime catalogue could not be checked.{' '}
            <Button
              variant="secondary"
              onClick={() => {
                void catalogue.refetch();
              }}
            >
              Retry runtime list
            </Button>
          </Notice>
        )}
        <label className="execution-input">
          Python input mode
          <select
            aria-label="Python input mode"
            value={mode}
            disabled={busy}
            onChange={(event) =>
              setMode(event.target.value as 'batch' | 'interactive')
            }
          >
            <option value="batch">Input before Run</option>
            <option value="interactive">Interactive input</option>
          </select>
          <span className="muted">
            Interactive input requires browser isolation. The 30-second limit
            includes waiting for input.
          </span>
        </label>
        {mode === 'batch' && (
          <label className="execution-input" htmlFor="batch-stdin">
            Input before Run
            <span className="muted">One line for each input() call.</span>
            <textarea
              id="batch-stdin"
              rows={3}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
      </details>
      <p className="execution-scope">
        Local practice · Fresh Python state each run · 30-second limit
      </p>
    </section>
  );
}
