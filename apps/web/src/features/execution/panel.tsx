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
}: {
  workspace: EditorWorkspace;
  paused: boolean;
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
  return (
    <section className="execution-panel" aria-label="Python execution">
      <div className="execution-toolbar">
        <h2>Python console</h2>
        <div className="actions">
          <Button
            disabled={busy || !complete || paused || !reviewed}
            onClick={() => {
              const lines = input ? input.replace(/\n$/, '').split('\n') : [];
              void model.run(lines, profile?.identity);
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
      <p className="execution-status" role="status">
        {snapshot.phase === 'idle' && !complete
          ? 'Loading project files…'
          : snapshot.phase === 'idle' && catalogue.isPending
            ? 'Checking runtimes…'
            : labels[snapshot.phase]}
      </p>
      <label className="execution-input">
        Python environment
        <select
          value={selectedRuntime}
          onChange={(event) => setSelectedRuntime(event.target.value)}
          disabled={busy}
        >
          <option value="">
            Project default (
            {runtimeProfile(defaultRuntime?.runtime_id)?.name ?? 'unavailable'})
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
      {snapshot.error && (
        <Notice tone="error">
          {snapshot.error}
          <RuntimeHelp />
        </Notice>
      )}
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
      <pre className="execution-output" aria-label="Python output" tabIndex={0}>
        {snapshot.output.length ? (
          snapshot.output.map((chunk, index) => (
            <span
              key={index}
              className={chunk.stream}
              aria-label={
                chunk.stream === 'stderr' ? 'Python error' : undefined
              }
            >
              {chunk.text}
            </span>
          ))
        ) : (
          <span className="muted">
            {busy
              ? 'Output will appear here.'
              : 'Run the project entrypoint to see its output.'}
          </span>
        )}
      </pre>
      <p className="execution-scope">
        Local practice · Fresh Python state each run · 30-second limit
      </p>
    </section>
  );
}
