import { Compartment, EditorState } from '@codemirror/state';

/** View-independent state: switching tabs must retain selection and extension state. */
export class EditorController {
  readonly permissions = new Compartment();
  readonly attributes = new Compartment();
  readonly updates = new Compartment();
  private saved: EditorState | null = null;
  private disposed = false;
  scrollPosition: Readonly<{ top: number; left: number }> = Object.freeze({
    top: 0,
    left: 0,
  });

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

  rememberScroll(top: number, left: number): void {
    if (!this.disposed) this.scrollPosition = Object.freeze({ top, left });
  }

  destroy(): void {
    this.saved = null;
    this.disposed = true;
  }
}
