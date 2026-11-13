import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import {
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { tags } from '@lezer/highlight';
import {
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap,
} from 'y-codemirror.next';
import { RUN_LIMITS, sourceBytes } from '@code-along/contracts/execution';
import type { EditorDocument } from '../model/document.ts';

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--color-info)', fontWeight: '600' },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: 'var(--color-primary)',
  },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-warning)' },
  { tag: tags.comment, color: 'var(--color-muted)', fontStyle: 'italic' },
  {
    tag: tags.invalid,
    color: 'var(--color-error)',
    textDecoration: 'underline',
  },
]);

export function CodeEditor({
  file,
  writable,
  onNotice,
  followClientId,
  onStopFollowing,
}: {
  file: EditorDocument;
  writable: boolean;
  onNotice: (message: string) => void;
  followClientId: number | null;
  onStopFollowing: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const following = useRef({ clientId: followClientId, stop: onStopFollowing });
  following.current = { clientId: followClientId, stop: onStopFollowing };
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const path = file.metadata.path;
  const attributes = () =>
    EditorView.contentAttributes.of({
      'aria-label': `Python source for ${path}`,
      'aria-describedby': 'editor-keyboard-help',
      'aria-readonly': String(!writable),
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    });
  const permissions = () => [
    EditorState.readOnly.of(!writable),
    EditorView.editable.of(writable),
    keymap.of(writable ? yUndoManagerKeymap : []),
    EditorState.transactionFilter.of((transaction) => {
      if (!transaction.docChanged || transaction.annotation(ySyncAnnotation))
        return transaction;
      if (!writable) return [];
      try {
        if (
          sourceBytes(transaction.newDoc.toString()).length >
          RUN_LIMITS.fileBytes
        )
          throw new Error('size');
      } catch {
        notice.current(
          'That edit was not applied. Use valid Unicode without NUL characters and keep this file within 128 KiB.',
        );
        return [];
      }
      notice.current('');
      return transaction;
    }),
  ];
  useLayoutEffect(() => {
    if (!parent.current) return;
    const state = file.controller.state((source) =>
      EditorState.create({
        doc: source,
        extensions: [
          EditorState.lineSeparator.of('\n'),
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          indentOnInput(),
          python(),
          syntaxHighlighting(highlighting),
          keymap.of([
            {
              key: 'Escape',
              run: () => {
                if (following.current.clientId === null) return false;
                following.current.stop();
                return true;
              },
            },
          ]),
          keymap.of(defaultKeymap),
          file.controller.permissions.of(permissions()),
          file.controller.attributes.of(attributes()),
          yCollab(file.text, file.awareness, { undoManager: file.undo }),
          file.controller.updates.of([]),
        ],
      }),
    );
    const editor = new EditorView({ state, parent: parent.current });
    view.current = editor;
    const selected = state.selection.main.head;
    const line = state.doc.lineAt(selected);
    setPosition({ line: line.number, column: selected - line.from + 1 });
    // Cached EditorState must never retain an unmounted component's listener.
    editor.dispatch({
      effects: file.controller.updates.reconfigure(
        EditorView.updateListener.of((update) => {
          file.controller.remember(update.state);
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const currentLine = update.state.doc.lineAt(head);
            setPosition({
              line: currentLine.number,
              column: head - currentLine.from + 1,
            });
          }
        }),
      ),
    });
    const frame = requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = file.controller.scrollPosition.top;
      editor.scrollDOM.scrollLeft = file.controller.scrollPosition.left;
    });
    return () => {
      cancelAnimationFrame(frame);
      file.controller.remember(editor.state);
      file.controller.rememberScroll(
        editor.scrollDOM.scrollTop,
        editor.scrollDOM.scrollLeft,
      );
      file.undo.stopCapturing();
      editor.destroy();
      view.current = null;
    };
  }, [file]);
  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: [
        file.controller.permissions.reconfigure(permissions()),
        file.controller.attributes.reconfigure(attributes()),
      ],
    });
  }, [file, writable, path]);
  useEffect(() => {
    const awareness = file.awareness;
    if (followClientId === null || !awareness) return;
    let frame = 0;
    const scroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const editor = view.current;
        const cursor = awareness.getStates().get(followClientId)?.['cursor'];
        if (!editor || !cursor?.head) return;
        try {
          const position = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(cursor.head),
            file.doc,
          );
          if (
            position?.type === file.text &&
            position.index >= 0 &&
            position.index <= editor.state.doc.length
          )
            editor.dispatch({
              effects: EditorView.scrollIntoView(position.index, {
                y: 'center',
              }),
            });
        } catch {
          /* Invalid/stale relative positions cannot move this view. */
        }
      });
    };
    awareness.on('change', scroll);
    file.doc.on('update', scroll);
    scroll();
    return () => {
      cancelAnimationFrame(frame);
      awareness.off('change', scroll);
      file.doc.off('update', scroll);
    };
  }, [file, followClientId]);
  return (
    <>
      <div className="python-editor" ref={parent} />
      <div className="editor-status">
        <span>Python</span>
        <span>
          Ln {position.line}, Col {position.column}
        </span>
        <span>{writable ? 'Editable' : 'Read only'}</span>
      </div>
    </>
  );
}
