import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@code-along/design-system';
import { CONSOLE_LIMITS, type ConsoleLine } from './console-buffer.ts';
export function ConsoleView({
  lines,
  busy,
  onClear,
}: {
  lines: readonly ConsoleLine[];
  busy: boolean;
  onClear: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<number | null>(null);
  const [copyState, setCopyState] = useState('');
  const offset =
    start === null
      ? Math.max(0, lines.length - CONSOLE_LIMITS.pageLines)
      : Math.min(start, Math.max(0, lines.length - 1));
  useLayoutEffect(() => {
    if (start === null && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lines, start]);
  return (
    <>
      <div className="console-controls">
        <Button variant="secondary" disabled={!lines.length} onClick={onClear}>
          Clear output
        </Button>
        <Button
          variant="secondary"
          disabled={!lines.length}
          onClick={() => {
            if (!navigator.clipboard) {
              setCopyState('Copy unavailable. Select the output to copy.');
              return;
            }
            void navigator.clipboard
              .writeText(lines.map((line) => line.text).join('\n'))
              .then(
                () => setCopyState('Output copied.'),
                () =>
                  setCopyState('Copy unavailable. Select the output to copy.'),
              );
          }}
        >
          Copy output
        </Button>
        <span role="status">{copyState}</span>
      </div>
      {lines.length > CONSOLE_LIMITS.pageLines && (
        <div className="console-controls" aria-label="Output pages">
          <Button
            variant="secondary"
            disabled={offset === 0}
            onClick={() =>
              setStart(Math.max(0, offset - CONSOLE_LIMITS.pageLines))
            }
          >
            Earlier output
          </Button>
          <Button
            variant="secondary"
            disabled={offset + CONSOLE_LIMITS.pageLines >= lines.length}
            onClick={() =>
              setStart(
                Math.min(lines.length - 1, offset + CONSOLE_LIMITS.pageLines),
              )
            }
          >
            Later output
          </Button>
          <span>
            Rows {offset + 1}–
            {Math.min(lines.length, offset + CONSOLE_LIMITS.pageLines)} of{' '}
            {lines.length}
          </span>
        </div>
      )}
      <div
        className="execution-output"
        aria-label="Python output"
        role="region"
        tabIndex={0}
        ref={viewport}
        onScroll={(event) => {
          const target = event.currentTarget;
          if (
            target.scrollHeight - target.clientHeight - target.scrollTop > 24 &&
            start === null
          )
            setStart(offset);
        }}
      >
        {lines.length ? (
          lines.slice(offset, offset + CONSOLE_LIMITS.pageLines).map((line) => (
            <div key={line.id} className={`console-line ${line.stream}`}>
              <span
                className="console-stream"
                aria-label={
                  line.stream === 'stderr'
                    ? 'Standard error'
                    : 'Standard output'
                }
              >
                {line.stream === 'stderr' ? 'err' : 'out'}
              </span>
              <span>{line.text || '\u200b'}</span>
            </div>
          ))
        ) : (
          <span className="muted">
            {busy
              ? 'Output will appear here.'
              : 'Run the project entrypoint to see its output.'}
          </span>
        )}
      </div>
      {start !== null && (
        <div className="console-controls">
          <span>Following paused while you read.</span>
          <Button variant="secondary" onClick={() => setStart(null)}>
            Follow latest output
          </Button>
        </div>
      )}
    </>
  );
}
