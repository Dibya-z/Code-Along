import { useLayoutEffect, useState } from 'react';
import { Icon } from './icon.tsx';

type Appearance = 'light' | 'dark';
const preferenceKey = 'code-along.appearance';
function initialAppearance(): Appearance {
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // A blocked preference store must not prevent using the workbench.
  }
  return document.documentElement.dataset['theme'] === 'dark'
    ? 'dark'
    : 'light';
}

export function AppearanceToggle() {
  const [appearance, setAppearance] = useState(initialAppearance);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setAppearance(root.dataset['theme'] === 'dark' ? 'dark' : 'light');
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset['theme'] = appearance;
  }, [appearance]);
  function toggle() {
    const next =
      document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset['theme'] = next;
    setAppearance(next);
    try {
      localStorage.setItem(preferenceKey, next);
    } catch {
      // Appearance still works for this tab when persistence is unavailable.
    }
  }
  const label = `Switch to ${appearance === 'dark' ? 'light' : 'dark'} theme`;
  return (
    <button
      type="button"
      className="appearance-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      <Icon name={appearance === 'dark' ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
