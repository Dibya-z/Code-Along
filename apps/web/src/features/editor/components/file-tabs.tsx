import type { FileSummary } from '../model/workspace.ts';
export function FileTabs({
  files,
  selectedId,
  onSelect,
  onClose,
}: {
  files: readonly FileSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  function move(index: number) {
    const file = files[(index + files.length) % files.length];
    if (!file) return;
    onSelect(file.id);
    document.getElementById(`editor-tab-${file.id}`)?.focus();
  }
  return (
    <div className="editor-tabs" role="tablist" aria-label="Open Python files">
      {files.map((file, index) => (
        <div key={file.id} role="presentation" className="editor-tab-wrap">
          <button
            role="tab"
            type="button"
            id={`editor-tab-${file.id}`}
            aria-controls="editor-source-panel"
            aria-selected={file.id === selectedId}
            tabIndex={file.id === selectedId ? 0 : -1}
            className="editor-tab"
            onClick={() => onSelect(file.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(index + 1);
              }
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(index - 1);
              }
              if (event.key === 'Home') {
                event.preventDefault();
                move(0);
              }
              if (event.key === 'End') {
                event.preventDefault();
                move(files.length - 1);
              }
              if (event.key === 'Delete') {
                event.preventDefault();
                onClose(file.id);
              }
            }}
          >
            {file.path}
            <span className="file-draft" aria-hidden="true">
              {file.dirty ? '●' : ''}
            </span>
          </button>
          <button
            type="button"
            className="editor-tab-close"
            tabIndex={-1}
            aria-label={`Close ${file.path} tab`}
            onClick={() => onClose(file.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
