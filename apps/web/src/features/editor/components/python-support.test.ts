import { describe, expect, it, vi } from 'vitest';
import {
  CompletionContext,
  deleteBracketPair,
  insertBracket,
  snippetKeymap,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { getIndentation } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { pythonEditingSupport } from './python-support.ts';

function stateFor(doc: string, readonly = false) {
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      EditorState.lineSeparator.of('\n'),
      EditorState.readOnly.of(readonly),
      pythonEditingSupport,
    ],
  });
}

async function suggestions(doc: string) {
  const state = stateFor(doc);
  const context = new CompletionContext(state, doc.length, true);
  const results = await Promise.all(
    state
      .languageDataAt<CompletionSource>('autocomplete', doc.length)
      .map((source) => source(context)),
  );
  return results.flatMap((result) => result?.options ?? []);
}

describe('Python editing assistance', () => {
  it('offers built-in functions, keywords and Python snippets', async () => {
    const options = await suggestions('pri');
    expect(options).toContainEqual(
      expect.objectContaining({ label: 'print', type: 'function' }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({ label: 'return', type: 'keyword' }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({ label: 'def', apply: expect.any(Function) }),
    );
  });

  it('offers actual same-file function, parameter and variable names', async () => {
    const options = await suggestions(
      'student_name = "Ada"\ndef greet(person):\n    greeting = person\n    gre',
    );
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'student_name', type: 'variable' }),
        expect.objectContaining({ label: 'greet', type: 'function' }),
        expect.objectContaining({ label: 'person', type: 'variable' }),
        expect.objectContaining({ label: 'greeting', type: 'variable' }),
      ]),
    );
  });

  it.each(['# explain pri', 'message = "pri'])(
    'does not suggest Python names inside comments or strings: %s',
    async (doc) => {
      expect(await suggestions(doc)).toEqual([]);
    },
  );

  it('indents Python suites by four spaces without changing source bytes', () => {
    const doc = 'def greet(name):\n    if name:\n        return name\n';
    const state = stateFor(doc);
    expect(getIndentation(state, state.doc.line(2).from)).toBe(4);
    expect(getIndentation(state, state.doc.line(3).from)).toBe(8);
    expect(state.doc.toString()).toBe(doc);
    const exact = '\uFEFFname = "雪"\r\nprint(name)\r\n';
    expect(stateFor(exact).doc.toString()).toBe(exact);
  });

  it('closes an opening bracket and steps over its existing closing bracket', () => {
    const open = insertBracket(stateFor('print'), '(');
    expect(open).not.toBeNull();
    expect(open!.state.doc.toString()).toBe('print()');
    expect(open!.state.selection.main.head).toBe(6);
    const close = insertBracket(open!.state, ')');
    expect(close).not.toBeNull();
    expect(close!.state.doc.toString()).toBe('print()');
    expect(close!.state.selection.main.head).toBe(7);
  });

  it('deletes an empty bracket pair while preserving read-only documents', () => {
    const open = insertBracket(stateFor('print'), '(')!;
    const dispatch = vi.fn();
    expect(deleteBracketPair({ state: open.state, dispatch })).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![0].state.doc.toString()).toBe('print');
    dispatch.mockClear();
    const readonly = stateFor('print()', true).update({
      selection: { anchor: 6 },
    }).state;
    expect(deleteBracketPair({ state: readonly, dispatch })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(readonly.doc.toString()).toBe('print()');
  });

  it('opens suggestions with Ctrl-Space while keeping Tab available for focus', () => {
    const state = stateFor('pri');
    const bindings = [
      ...state.facet(keymap).flat(),
      ...state.facet(snippetKeymap),
    ];
    expect(bindings).toContainEqual(
      expect.objectContaining({ key: 'Ctrl-Space', run: expect.any(Function) }),
    );
    expect(
      bindings.some(({ key }) => key === 'Tab' || key === 'Shift-Tab'),
    ).toBe(false);
  });
});
