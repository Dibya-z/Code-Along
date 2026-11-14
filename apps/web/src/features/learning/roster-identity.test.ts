import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  matchingRosterNames,
  rosterMemberLabel,
  RosterReferences,
} from './roster-identity.tsx';
import type { LearningUser } from './participation-types.ts';

const actor = '10000000-0000-4000-8000-0000deadbeef';
const peer = '10000000-0000-4000-9000-0000deadbeef';
const other = '10000000-0000-4000-8000-111111111111';

describe('exact roster account presentation', () => {
  it('marks only the current actor and keeps ordinary distinct names free of ID clutter', () => {
    const users: LearningUser[] = [
      { id: actor, display_name: 'River' },
      { id: peer, display_name: 'Mira' },
    ];
    expect(rosterMemberLabel(users[0]!, actor, users)).toBe('River (you)');
    expect(rosterMemberLabel(users[1]!, actor, users)).toBe('Mira');
    expect(RosterReferences({ users, accountId: actor })).toBeNull();
  });
  it('expands a colliding eight-hex account suffix until same-name accounts are unambiguous', () => {
    const users: LearningUser[] = [
      { id: actor, display_name: 'River' },
      { id: peer, display_name: 'River' },
    ];
    expect(rosterMemberLabel(users[0]!, actor, users)).toBe(
      'River (you) · account 80000000deadbeef',
    );
    expect(rosterMemberLabel(users[1]!, actor, users)).toBe(
      'River · account 90000000deadbeef',
    );
    expect(matchingRosterNames(users[0]!, users)).toBe(true);
  });
  it('uses the short minimum reference for normalized matching names while preserving their original labels', () => {
    const users: LearningUser[] = [
      { id: actor, display_name: 'Ｒｉｖｅｒ' },
      { id: other, display_name: 'river' },
    ];
    expect(rosterMemberLabel(users[0]!, actor, users)).toBe(
      'Ｒｉｖｅｒ (you) · account deadbeef',
    );
    expect(rosterMemberLabel(users[1]!, actor, users)).toBe(
      'river · account 11111111',
    );
    expect(users.map((user) => user.display_name)).toEqual([
      'Ｒｉｖｅｒ',
      'river',
    ]);
  });
  it('recognizes canonical accent equivalents without normalizing displayed bytes', () => {
    const users: LearningUser[] = [
      { id: actor, display_name: 'Café' },
      { id: other, display_name: 'Cafe\u0301' },
    ];
    expect(matchingRosterNames(users[0]!, users)).toBe(true);
    expect(rosterMemberLabel(users[0]!, peer, users)).toBe(
      'Café · account deadbeef',
    );
    expect(rosterMemberLabel(users[1]!, peer, users)).toBe(
      'Cafe\u0301 · account 11111111',
    );
  });
  it('puts full references only in an explicit disclosure and renders labels as plain text', () => {
    const users: LearningUser[] = [
      { id: actor, display_name: '<b>River</b>' },
      { id: peer, display_name: '<b>River</b>' },
      { id: other, display_name: 'Mira' },
    ];
    const markup = renderToStaticMarkup(
      RosterReferences({ users, accountId: actor }),
    );
    expect(markup).toContain('<details');
    expect(markup).toContain(
      '<summary>Account references for matching names</summary>',
    );
    expect(markup).toContain(actor);
    expect(markup).toContain(peer);
    expect(markup).not.toContain(other);
    expect(markup).toContain('&lt;b&gt;River&lt;/b&gt;');
    expect(markup).not.toContain('<b>River</b>');
  });
});
