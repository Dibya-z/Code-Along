import type { LearningUser } from './participation-types.ts';

const nameKey = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase('en');
export function matchingRosterNames(
  user: LearningUser,
  users: readonly LearningUser[],
): boolean {
  return (
    users.filter(
      (person) => nameKey(person.display_name) === nameKey(user.display_name),
    ).length > 1
  );
}
export function rosterMemberLabel(
  user: LearningUser,
  accountId: string,
  users: readonly LearningUser[],
): string {
  let label = `${user.display_name}${user.id === accountId ? ' (you)' : ''}`;
  if (!matchingRosterNames(user, users)) return label;
  const sameNames = users.filter(
    (person) => nameKey(person.display_name) === nameKey(user.display_name),
  );
  let length = 8;
  while (
    length < 32 &&
    new Set(
      sameNames.map((person) => person.id.replaceAll('-', '').slice(-length)),
    ).size !== sameNames.length
  )
    length++;
  label += ` · account ${user.id.replaceAll('-', '').slice(-length)}`;
  return label;
}
export function RosterReferences({
  users,
  accountId,
}: {
  users: readonly LearningUser[];
  accountId: string;
}) {
  const matching = users.filter((user) => matchingRosterNames(user, users));
  return matching.length ? (
    <details className="task-disclosure">
      <summary>Account references for matching names</summary>
      <p>These references distinguish accounts with the same displayed name.</p>
      <dl>
        {matching.map((user) => (
          <div key={user.id}>
            <dt>{rosterMemberLabel(user, accountId, users)}</dt>
            <dd>{user.id}</dd>
          </div>
        ))}
      </dl>
    </details>
  ) : null;
}
