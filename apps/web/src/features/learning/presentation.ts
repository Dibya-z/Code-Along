const publicationTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Display only: retain the original timestamp for integrity and dateTime. */
export function formatPublicationTime(timestamp: string): string {
  return `${publicationTime.format(new Date(timestamp))} UTC`;
}
