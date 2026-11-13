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
}: {
  workspace: EditorWorkspace;
  paused: boolean;
  toolbar?: HTMLElement | null;
  onRun?: () => void;
}) {
  const [resource] = useState(() => ({
    model: new ExecutionController(
      workspace,
      (event, fault) => new IframeRunnerBridge(event, fault),
    ),
    leases: 0,
  }));
  const model = resource.model;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const structure = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
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
  const profile = runtimeProfile(selectedRuntime || defaultRuntime?.runtime_id);
  const reviewed = profile && available.includes(profile);
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
  const controls = (
    <div className="execution-toolbar">
      <span className="execution-title">Python</span>
      <div className="actions">
        <Button
          disabled={busy || !complete || paused || !reviewed}
          onClick={() => {
            onRun?.();
            const lines = input ? input.replace(/\n$/, '').split('\n') : [];
            void model.run(
              mode === 'batch' ? lines : [],
              profile?.identity,
              mode,
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
      <h2 className="console-heading">Console</h2>
      <p className="execution-status" role="status">
        {snapshot.phase === 'idle' && !complete
          ? 'Loading project files…'
          : snapshot.phase === 'idle' && catalogue.isPending
            ? 'Checking runtimes…'
            : labels[snapshot.phase]}
      </p>
      {manifest && (
        <p className="execution-provenance">
          Source <code>{manifest.sha256.slice(0, 12)}</code> · Metadata v
          {manifest.metadata_version} · Python {manifest.runtime.python_version}
          {' · '}
          {runtimeProfile(manifest.runtime.runtime_id)?.name}
          {' · Profile '}
          <code>{manifest.runtime.manifest_sha256.slice(0, 8)}</code>
          {snapshot.earlierSource && <strong> · Earlier source</strong>}
        </p>
      )}
      {manifest && (
        <details className="captured-source">
          <summary>View captured source</summary>
          <p>
            This exact source produced this result. Editing here does not change
            the capture.
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
      <details className="run-settings" open>
        <summary>Run options</summary>
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
