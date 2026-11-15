export type IconName =
  | 'workspace'
  | 'folder'
  | 'file'
  | 'code'
  | 'users'
  | 'book'
  | 'plus'
  | 'arrow-right'
  | 'arrow-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'shield'
  | 'clock'
  | 'check'
  | 'sun'
  | 'moon'
  | 'terminal'
  | 'play'
  | 'history'
  | 'settings'
  | 'message'
  | 'log-out';

const paths: Record<IconName, string> = {
  workspace: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  folder: 'M3 7V5h6l2 2h10v12H3V7Z',
  file: 'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7.87a4 4 0 0 1 0 7.75',
  book: 'M12 6c-3-2-6-2-9-1v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V6Z',
  plus: 'M12 5v14M5 12h14',
  'arrow-right': 'M4 12h16m-6-6 6 6-6 6',
  'arrow-left': 'M20 12H4m6-6-6 6 6 6',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-down': 'm5 9 7 7 7-7',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  clock: 'M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  check: 'm5 12 4 4L19 6',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5m-2 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
  moon: 'M20.5 14A8.5 8.5 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z',
  terminal: 'm6 7 5 5-5 5m8 0h4M3 3h18v18H3V3Z',
  play: 'm8 4 12 8-12 8V4Z',
  history: 'M3 4v6h6m-5-1a9 9 0 1 1-1 7m9-9v5l3 2',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-5h4l1 3 3-1 2 3-2 3 2 3-2 3-3-1-1 3h-4l-1-3-3 1-2-3 2-3-2-3 2-3 3 1 1-3Z',
  message:
    'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  'log-out': 'M9 4H4v16h5m6-13 5 5-5 5m-7-5h12',
};

/** Original, consistent interface symbols; visible text provides their names. */
export function Icon({
  name,
  className,
  size = 20,
}: {
  name: IconName;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className ? `ui-icon ${className}` : 'ui-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
