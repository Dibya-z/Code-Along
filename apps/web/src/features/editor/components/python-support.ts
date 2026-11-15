import {
  autocompletion,
  clearSnippet,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
  ifNotIn,
  snippetKeymap,
} from '@codemirror/autocomplete';
import { python, pythonLanguage } from '@codemirror/lang-python';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--color-info)', fontWeight: '600' },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: 'var(--color-primary)',
  },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-warning)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--color-info)',
  },
  {
    tag: [tags.definition(tags.variableName), tags.className],
    color: 'var(--color-ink)',
    fontWeight: '600',
  },
  { tag: tags.operator, color: 'var(--color-info)' },
  { tag: tags.comment, color: 'var(--color-muted)', fontStyle: 'italic' },
  {
    tag: tags.invalid,
    color: 'var(--color-error)',
    textDecoration: 'underline',
  },
]);

/** Local Python language assistance; source and editing permissions stay with the document. */
export const pythonEditingSupport: Extension = [
  python(),
  pythonLanguage.data.of({
    autocomplete: ifNotIn(
      ['String', 'FormatString', 'Comment', 'PropertyName'],
      completeFromList(
        [
          'and',
          'as',
          'assert',
          'async',
          'await',
          'break',
          'case',
          'continue',
          'del',
          'elif',
          'else',
          'except',
          'finally',
          'global',
          'in',
          'is',
          'lambda',
          'match',
          'nonlocal',
          'not',
          'or',
          'pass',
          'raise',
          'return',
          'with',
          'yield',
        ].map((label) => ({ label, type: 'keyword' })),
      ),
    ),
  }),
  indentUnit.of('    '),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  keymap.of(closeBracketsKeymap),
  autocompletion({ maxRenderedOptions: 8 }),
  // Completion must not turn Tab into a keyboard trap, including inside snippets.
  snippetKeymap.of([{ key: 'Escape', run: clearSnippet }]),
  syntaxHighlighting(highlighting),
  EditorView.theme({
    '.cm-tooltip-autocomplete': {
      backgroundColor: 'var(--color-surface)',
      color: 'var(--color-ink)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-sm)',
      boxShadow: 'var(--shadow-panel)',
    },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-code)',
      maxWidth: 'min(28rem, calc(100vw - 2rem))',
    },
    '.cm-tooltip-autocomplete > ul > li': {
      minHeight: 'var(--target-min)',
      alignContent: 'center',
      padding: 'var(--space-2) var(--space-3)',
      boxSizing: 'border-box',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--color-primary)',
      color: 'var(--color-on-primary)',
    },
    '.cm-completionDetail': { opacity: '1' },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'var(--color-primary-soft)',
      outline: '1px solid var(--color-border)',
    },
    '&.cm-focused .cm-nonmatchingBracket': {
      color: 'var(--color-error)',
      textDecoration: 'underline',
    },
  }),
];
