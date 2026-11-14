import { useLayoutEffect, useRef, useState } from 'react';
import type { DiscussionSnapshot } from './controller.ts';

/** View-local reading position; hydration and prepended history never manufacture unread messages. */
export function useDiscussionReading(
  snapshot: DiscussionSnapshot,
  accountId: string,
) {
  const log = useRef<HTMLOListElement>(null);
  const [unread, setUnread] = useState(0);
  const view = useRef({
    initialized: false,
    max: 0n,
    ids: new Set<string>(),
    unread: new Set<string>(),
    local: new Set<string>(),
    nearBottom: true,
    pin: false,
    anchor: null as { id: string; offset: number } | null,
  });
  const clear = () => {
    view.current.unread.clear();
    setUnread(0);
  };
  const scroll = () => {
    const element = log.current;
    if (!element) return;
    view.current.nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
    if (view.current.nearBottom) clear();
  };
  useLayoutEffect(() => {
    const element = log.current,
      state = view.current;
    if (!element) return;
    const newest = snapshot.messages.at(-1)?.sequence ?? '0';
    if (!snapshot.ready) {
      state.ids = new Set(snapshot.messages.map((message) => message.id));
      state.max = BigInt(newest);
      return;
    }
    if (!state.initialized) {
      state.initialized = true;
      state.nearBottom = true;
      state.pin = true;
    }
    const added = snapshot.messages.filter(
      (message) =>
        !state.ids.has(message.id) && BigInt(message.sequence) > state.max,
    );
    if (state.anchor && !state.pin) {
      const target = [
        ...element.querySelectorAll<HTMLElement>('li[data-message-id]'),
      ].find((item) => item.dataset['messageId'] === state.anchor?.id);
      if (target)
        element.scrollTop +=
          target.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          state.anchor.offset;
    }
    if (state.nearBottom || state.pin) {
      element.scrollTop = element.scrollHeight;
      state.nearBottom = true;
      state.unread.clear();
    } else
      for (const message of added)
        if (!(
          message.author.id === accountId &&
          state.local.has(message.client_message_id)
        ))
          state.unread.add(message.id);
    state.pin = false;
    if (!snapshot.loadingOlder) state.anchor = null;
    state.ids = new Set(snapshot.messages.map((message) => message.id));
    state.max = BigInt(newest) > state.max ? BigInt(newest) : state.max;
    if (unread !== state.unread.size) setUnread(state.unread.size);
  });
  return {
    log,
    unread,
    onScroll: scroll,
    beforeOlder() {
      const element = log.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top;
      const target = [
        ...element.querySelectorAll<HTMLElement>('li[data-message-id]'),
      ].find((item) => item.getBoundingClientRect().bottom > top);
      if (target?.dataset['messageId'])
        view.current.anchor = {
          id: target.dataset['messageId'],
          offset: target.getBoundingClientRect().top - top,
        };
      view.current.nearBottom = false;
    },
    ownSend(nonce: string | undefined) {
      if (nonce) view.current.local.add(nonce);
      view.current.pin = true;
    },
    jump() {
      const element = log.current;
      if (!element) return;
      view.current.nearBottom = true;
      view.current.anchor = null;
      element.scrollTop = element.scrollHeight;
      element.focus({ preventScroll: true });
      clear();
    },
  };
}
