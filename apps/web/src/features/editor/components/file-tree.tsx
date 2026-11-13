import type { FileSummary } from '../model/workspace.ts';

interface Folder {
  folders: Map<string, Folder>;
  files: FileSummary[];
}
function tree(files: readonly FileSummary[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    let folder = root;
    for (const part of parts) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  return root;
}
export function FileTree({
  files,
  selectedId,
  entrypoint,
  onSelect,
}: {
  files: readonly FileSummary[];
  selectedId: string;
  entrypoint: string;
  onSelect: (id: string) => void;
}) {
  function branch(folder: Folder, prefix = '') {
    return (
      <ul className="editor-file-tree">
        {[...folder.folders].map(([name, child]) => (
          <li key={name}>
            <details open>
              <summary>{name}/</summary>
              {branch(child, `${prefix}${name}/`)}
            </details>
          </li>
        ))}
        {folder.files.map((file) => (
          <li key={file.id}>
            <button
              type="button"
              id={`editor-file-${file.id}`}
              className="editor-file"
              aria-label={file.path}
              aria-pressed={selectedId === file.id}
              onClick={() => onSelect(file.id)}
            >
              <span className="file-kind" aria-hidden="true">
                py
              </span>
              <span className="file-name">
                {file.path.slice(prefix.length)}
              </span>
              {file.id === entrypoint && (
                <span className="file-entry" title="Project entrypoint">
                  entry
                </span>
              )}
              {file.dirty && (
                <span
                  className="file-draft"
                  title="Changed in this tab"
                  aria-label="Local draft"
                >
                  ●
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return <nav aria-label="Project file explorer">{branch(tree(files))}</nav>;
}
