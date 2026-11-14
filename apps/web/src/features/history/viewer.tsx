import { useState, type ReactNode } from 'react';
import { Button } from '@code-along/design-system';
import { runtimeProfile } from '@code-along/contracts/execution/profiles';
import {
  downloadArchive,
  downloadSourceFile,
} from '../project-tools/archive.ts';
import { revisionArchive, type RevisionManifest } from './manifest.ts';
import './styles.css';

export function RevisionViewer({
  manifest,
  name,
  actions,
}: {
  manifest: RevisionManifest;
  name: string;
  actions?: ReactNode;
}) {
  const [selected, setSelected] = useState(manifest.entrypoint_file_id);
  const active =
    manifest.files.find((file) => file.file_id === selected) ??
    manifest.files[0]!;
  return (
    <section className="revision-viewer" aria-label={`Frozen source: ${name}`}>
      <div className="section-head">
        <div>
          <h3>{name}</h3>
          <p className="muted">
            Immutable shared-room capture · {manifest.files.length}{' '}
            {manifest.files.length === 1 ? 'file' : 'files'}
          </p>
        </div>
        <span className="badge">Read only</span>
      </div>
      <div className="revision-layout">
        <nav aria-label="Revision files" className="file-list">
          {manifest.files.map((file) => (
            <Button
              type="button"
              key={file.file_id}
              variant="secondary"
              aria-pressed={active.file_id === file.file_id}
              onClick={() => setSelected(file.file_id)}
            >
              {file.path}
              {file.file_id === manifest.entrypoint_file_id
                ? ' · entrypoint'
                : ''}
            </Button>
          ))}
        </nav>
        <div className="revision-source">
          <h4>{active.path}</h4>
          <pre
            tabIndex={0}
            aria-label={`Frozen Python source for ${active.path}`}
          >
            <code>{active.source}</code>
          </pre>
          {active.source === '' && <p className="muted">This file is empty.</p>}
        </div>
      </div>
      <p className="muted">
        {runtimeProfile(manifest.runtime.runtime_id)?.name ?? 'Python'} · Python{' '}
        {manifest.runtime.python_version}.
      </p>
      <details className="revision-provenance">
        <summary>Source and runtime provenance</summary>
        <dl>
          <dt>Capture</dt>
          <dd>
            Shared room at the server capture point. Later room edits do not
            change this revision.
          </dd>
          <dt>Metadata version</dt>
          <dd>{manifest.metadata_version}</dd>
          <dt>Manifest SHA-256</dt>
          <dd>{manifest.sha256}</dd>
          <dt>Runtime ID</dt>
          <dd>{manifest.runtime.runtime_id}</dd>
          <dt>Engine</dt>
          <dd>
            {manifest.runtime.engine} {manifest.runtime.engine_version}
          </dd>
          <dt>Runtime manifest SHA-256</dt>
          <dd>{manifest.runtime.manifest_sha256}</dd>
          <dt>Helper release</dt>
          <dd>{manifest.helper_release.release_id}</dd>
          <dt>Helper source SHA-256</dt>
          <dd>{manifest.helper_release.source_sha256}</dd>
          <dt>{active.path} SHA-256</dt>
          <dd>{active.sha256}</dd>
        </dl>
      </details>
      <div className="actions content-section">
        <Button
          type="button"
          variant="secondary"
          onClick={() => downloadArchive(revisionArchive(manifest, name))}
        >
          Export revision source
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => downloadSourceFile(active.path, active.source)}
        >
          Download frozen file
        </Button>
        {actions}
      </div>
    </section>
  );
}
