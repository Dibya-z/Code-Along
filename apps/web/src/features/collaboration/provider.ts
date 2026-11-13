import {
  HocuspocusProvider,
  MessageType,
  type onMessageParameters,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import { MAX_CHECKPOINT_STATE_BYTES } from '@code-along/contracts/collaboration';
import { validateRecoveryBinary } from '../recovery/codec.ts';

function normalizedState(state: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** Hocuspocus also emits synced for update acknowledgments. Only applied Step2 opens a file. */
export class CanonicalProvider extends HocuspocusProvider {
  private epoch = 0;
  constructor(
    configuration: ConstructorParameters<typeof HocuspocusProvider>[0] & {
      onMessage?: never;
    },
    private readonly initialized: () => void,
    private readonly rejected: () => void,
  ) {
    super(configuration);
  }

  override onMessage(event: MessageEvent): void {
    const epoch = this.epoch;
    const observed: { state?: Uint8Array } = {};
    // The public message event supplies a fresh frame reader, separate from the
    // receiver's decoder. Inspect it only during this synchronous super call.
    const inspect = ({ message }: onMessageParameters): void => {
      if (message.readVarString() !== this.effectiveName)
        throw new Error('invalid_sync_route');
      if (
        message.readVarUint() !== MessageType.Sync ||
        message.readVarUint() !== 1
      )
        return;
      const state = message.readVarUint8Array();
      if (state.length < 1 || state.length > MAX_CHECKPOINT_STATE_BYTES)
        throw new Error('invalid_sync_state');
      // y-protocols catches apply errors internally. Reject malformed input and
      // preflight the complete candidate before the real receiver sees it.
      Y.decodeUpdate(state);
      const merged = Y.mergeUpdates([
        Y.encodeStateAsUpdate(this.document),
        state,
      ]);
      validateRecoveryBinary(merged);
      observed.state = normalizedState(merged);
    };
    this.on('message', inspect);
    try {
      super.onMessage(event);
      if (observed.state && epoch === this.epoch) {
        const current = Y.encodeStateAsUpdate(this.document);
        validateRecoveryBinary(current);
        const applied = normalizedState(current);
        if (
          applied.length !== observed.state.length ||
          applied.some((byte, index) => byte !== observed.state![index])
        )
          throw new Error('sync_state_not_applied');
        this.initialized();
      }
    } catch {
      this.rejected();
    } finally {
      this.off('message', inspect);
    }
  }
  override onClose(): void {
    this.epoch++;
    super.onClose();
  }
  override detach(): void {
    this.epoch++;
    super.detach();
  }
}
