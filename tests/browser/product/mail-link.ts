/** Django's private file backend can append several messages to one file. */
export function privateMailLink(
  spool: string,
  recipient: string,
  kind: 'verify' | 'reset',
): string | undefined {
  const messages = spool.replace(/\r\n/g, '\n').split(/\n-{79}\n/);
  for (const message of messages.reverse()) {
    const headers = message.slice(0, message.indexOf('\n\n'));
    if (!headers.split('\n').includes(`To: ${recipient}`)) continue;
    const found = message.match(
      new RegExp(`https://127\\.0\\.0\\.1:18443/auth/${kind}\\?key=[^\\s]+`),
    );
    if (found) return found[0];
  }
  return undefined;
}
