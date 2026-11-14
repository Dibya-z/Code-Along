import { useId, useState } from 'react';
import { Button, Notice } from '@code-along/design-system';
import { PRACTICE_CHECK_BYTES } from '@code-along/contracts/execution/practice';
import { sourceBytes } from '@code-along/contracts/execution';
import type { PublicChecks } from './types.ts';

export interface CheckCopyState {
  readonly copy: string | null;
  readonly usingCopy: boolean;
}
export interface TaskPracticeControls {
  readonly state: CheckCopyState;
  readonly onChange: (state: CheckCopyState) => void;
  readonly onTarget: (target: HTMLDivElement | null) => void;
}
export function TaskPractice({
  checks,
  controls,
}: {
  checks: PublicChecks;
  controls?: TaskPracticeControls;
}) {
  const [error, setError] = useState('');
  const copyId = useId();
  const state = controls?.state;
  const copy = state?.copy ?? checks.source;
  const modified = copy !== checks.source;
  return (
    <details className="task-disclosure task-practice">
      <summary>Visible checks</summary>
      <p>
        These checks are inspectable Python for local practice. They do not
        produce a trusted grade.
      </p>
      <details className="task-disclosure" open={!state?.usingCopy}>
        <summary>Published checks</summary>
        <pre
          className="learning-source"
          tabIndex={0}
          aria-label="Published visible Python checks"
        >
          <code>{checks.source}</code>
        </pre>
      </details>
      {controls && state && (
        <>
          <div className="actions">
            {!state.usingCopy ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setError('');
                  controls.onChange({
                    copy: state.copy ?? checks.source,
                    usingCopy: true,
                  });
                }}
              >
                {state.copy === null
                  ? 'Make a practice copy'
                  : 'Use practice copy'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setError('');
                  controls.onChange({ ...state, usingCopy: false });
                }}
              >
                Use published checks
              </Button>
            )}
          </div>
          {state.usingCopy && (
            <div className="practice-copy">
              <label htmlFor={copyId}>
                Practice check copy{modified ? ' · Modified' : ' · Unchanged'}
              </label>
              <textarea
                id={copyId}
                aria-describedby={`${copyId}-help`}
                maxLength={PRACTICE_CHECK_BYTES}
                spellCheck={false}
                value={copy}
                onChange={(event) => {
                  const candidate = event.target.value;
                  try {
                    if (sourceBytes(candidate).length > PRACTICE_CHECK_BYTES) {
                      setError(
                        'Keep the practice copy within 16 KiB of UTF-8 text.',
                      );
                      return;
                    }
                  } catch {
                    setError('Use valid Unicode text without NUL characters.');
                    return;
                  }
                  setError('');
                  controls.onChange({ copy: candidate, usingCopy: true });
                }}
              />
              <p id={`${copyId}-help`} className="muted">
                {sourceBytes(copy).length} / {PRACTICE_CHECK_BYTES} UTF-8 bytes.
                This copy stays in this tab; it is not a project file and is
                lost on reload.
              </p>
            </div>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div ref={controls.onTarget} className="task-practice-action" />
        </>
      )}
    </details>
  );
}
