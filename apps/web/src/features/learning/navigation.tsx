import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';

/** Hash changes keep forms mounted. Only deliberate navigation moves focus. */
export function TaskNavigation({
  label,
  sections,
  active,
}: {
  label: string;
  sections: readonly { id: string; label: string }[];
  active: string;
}) {
  const location = useLocation();
  const requested = useRef(false);
  const previous = useRef(active);
  const sectionFocus = useRef<{ section: string; target: HTMLElement } | null>(
    null,
  );
  useEffect(() => {
    const capture = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const section = event.target.closest<HTMLElement>('.learning-view');
      if (section?.id)
        sectionFocus.current = { section: section.id, target: event.target };
    };
    document.addEventListener('focusin', capture);
    return () => document.removeEventListener('focusin', capture);
  }, []);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const previousFocus = sectionFocus.current;
    const departingFocus =
      previousFocus &&
      previousFocus.section !== active &&
      (focused === document.body || previousFocus.target.closest('[hidden]'));
    if (requested.current || (previous.current !== active && departingFocus))
      document.getElementById(active)?.focus();
    requested.current = false;
    previous.current = active;
  }, [active, location.key]);
  return (
    <nav className="project-section-nav" aria-label={label}>
      {sections.map((section) => (
        <Link
          key={section.id}
          to={`#${section.id}`}
          aria-current={active === section.id ? 'page' : undefined}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.shiftKey
            )
              return;
            if (active === section.id) {
              event.preventDefault();
              requested.current = false;
              document.getElementById(active)?.focus();
            } else requested.current = true;
          }}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
