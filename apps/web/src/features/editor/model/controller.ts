import { EditorState } from '@codemirror/state';

/** View-independent state: switching tabs must retain selection and extension state. */
export class EditorController {
  private saved: EditorState | null = null;
  private disposed = false;

  constructor(private readonly readSource: () => string | null) {}

  state(create: (source: string) => EditorState): EditorState {
    if (this.disposed)
      throw new Error('This editor document is no longer active.');
    const source = this.readSource();
    if (source === null)
      throw new Error('Load this file before opening its editor.');
    let state = this.saved;
    if (state === null) state = create(source);
    else if (state.doc.toString() !== source) {
      // An inactive file may have changed through recovery/undo. Y.Text stays canonical.
      state = state.update({
        changes: { from: 0, to: state.doc.length, insert: source },
      }).state;
    }
    if (state.doc.toString() !== source)
      throw new Error(
        'Editor configuration must preserve the exact source text.',
      );
    this.saved = state;
    return state;
  }

  remember(state: EditorState): void {
    if (!this.disposed) this.saved = state;
  }

  destroy(): void {
    this.saved = null;
    this.disposed = true;
  }
}
