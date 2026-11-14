import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@code-along/design-system';
import type { Hint } from './types.ts';

/** Staging is local reading state; the published text is already authorized. */
export function TaskHints({ hints }: { hints: readonly Hint[] }) {
  const [revealed, setRevealed] = useState(0);
  const root = useRef<HTMLElement>(null);
  const requested = useRef(false);
  useLayoutEffect(() => {
    if (!requested.current) return;
    requested.current = false;
    const summaries =
      root.current?.querySelectorAll<HTMLElement>('details > summary');
    summaries?.[revealed - 1]?.focus({ preventScroll: true });
  }, [revealed]);
  if (hints.length === 0) return null;
  return (
    <section ref={root} className="task-hints" aria-label="Task hints">
      {hints.slice(0, revealed).map((hint, index) => (
        <details className="task-disclosure" key={hint.id} open>
          <summary>
            Hint {index + 1}: {hint.title}
          </summary>
          <div className="assignment-prose">{hint.body}</div>
        </details>
      ))}
      <p className="muted" role="status">
        {revealed} of {hints.length} hints revealed.
      </p>
      <Button
        type="button"
        variant="secondary"
        disabled={revealed >= hints.length}
        onClick={() => {
          if (revealed >= hints.length) return;
          requested.current = true;
          setRevealed((count) => Math.min(hints.length, count + 1));
        }}
      >
        {revealed >= hints.length ? 'All hints revealed' : 'Reveal next hint'}
      </Button>
    </section>
  );
}
