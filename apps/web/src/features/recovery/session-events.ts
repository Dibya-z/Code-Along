const ending = new Set<string>();
const instance = crypto.randomUUID();
const channelName = 'code-along-session';
function broadcast(message: object): void {
  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(channelName);
      channel.postMessage(message);
    }
  } catch {
    /* A blocked messaging facility must not prevent server sign-out. */
  } finally {
    channel?.close();
  }
  try {
    localStorage.setItem(channelName, JSON.stringify(message));
    localStorage.removeItem(channelName);
  } catch {
    /* Cross-tab storage events are optional. */
  }
}
export function announceSessionChange(): void {
  broadcast({ type: 'session_changed', instance });
}
export function markSessionEnding(account: string): void {
  ending.add(account);
}
export function recoveryAllowed(account: string): boolean {
  return !ending.has(account);
}
export function announceLocalLogout(account: string): void {
  markSessionEnding(account);
  broadcast({ type: 'logout', account, instance });
}
export function listenForLocalLogout(
  account: string,
  onLogout: () => void,
): () => void {
  let handled = false;
  const receive = (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('type' in value) ||
      !('instance' in value) ||
      typeof value.instance !== 'string' ||
      value.instance === instance ||
      handled
    )
      return;
    if (
      value.type !== 'session_changed' &&
      !(
        value.type === 'logout' &&
        'account' in value &&
        value.account === account
      )
    )
      return;
    handled = true;
    markSessionEnding(account);
    onLogout();
  };
  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== 'undefined')
      channel = new BroadcastChannel(channelName);
  } catch {
    /* Storage events and epoch checks remain available independently. */
  }
  if (channel)
    channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
  const storage = (event: StorageEvent) => {
    if (event.key === channelName && event.newValue) {
      try {
        receive(JSON.parse(event.newValue));
      } catch {
        /* Ignore unrelated/malformed local events. */
      }
    }
  };
  window.addEventListener('storage', storage);
  return () => {
    channel?.close();
    window.removeEventListener('storage', storage);
  };
}
