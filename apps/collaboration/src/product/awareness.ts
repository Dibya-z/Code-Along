import * as Y from 'yjs';
import { record, exact, safeInteger, type Grant } from './admission.ts';

function relative(value: unknown, document: Y.Doc): Y.RelativePosition | null {
  if (
    !record(value) ||
    !Object.keys(value).every((key) =>
      ['type', 'tname', 'item', 'assoc'].includes(key),
    ) ||
    value['type'] != null ||
    value['tname'] !== 'source' ||
    ![-1, 0, 1].includes(value['assoc'] as number)
  )
    return null;
  const item = value['item'];
  if (
    item != null &&
    (!record(item) ||
      !exact(item, ['client', 'clock']) ||
      !safeInteger(item['client']) ||
      item['client'] > 0xffff_ffff ||
      !safeInteger(item['clock']))
  )
    return null;
  try {
    const position = Y.createRelativePositionFromJSON(value);
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      position,
      document,
    );
    return absolute?.type === document.getText('source') ? position : null;
  } catch {
    return null;
  }
}
/** No client-supplied identity, HTML, CSS or extension fields are broadcast. */
export function stampAwareness(
  states: Map<number, Record<string, unknown>>,
  removed: Set<number>,
  grant: Grant,
  document: Y.Doc,
): void {
  if (
    states.size + removed.size > 1 ||
    [...states.keys(), ...removed].some(
      (id) => id !== grant.awareness_client_id,
    )
  )
    throw new Error('awareness_rejected');
  for (const [id, state] of states) {
    if (!record(state)) throw new Error('awareness_rejected');
    let cursor: {
      anchor: Y.RelativePosition;
      head: Y.RelativePosition;
    } | null = null;
    if (state['cursor'] != null) {
      const value = state['cursor'];
      if (!record(value) || !exact(value, ['anchor', 'head']))
        throw new Error('awareness_rejected');
      const anchor = relative(value['anchor'], document),
        head = relative(value['head'], document);
      if (anchor && head) cursor = { anchor, head };
      // A cursor for an update not yet delivered is omitted until its next update.
    }
    const user = grant.user;
    states.set(id, {
      user: {
        id: user.id,
        display_name: user.display_name,
        name: user.display_name,
        color: user.color,
        colorLight: `${user.color}33`,
      },
      cursor,
    });
  }
}
