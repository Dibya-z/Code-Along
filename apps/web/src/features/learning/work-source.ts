import type { AssignmentWork } from './participation-types.ts';

/** Learning eligibility never substitutes for current ordinary source authority. */
export function workSourceAccess(
  work: AssignmentWork | undefined,
  openedProjectId: string | null,
): { projectId: string | null; authorized: boolean } {
  const projectedId = work?.project?.id ?? null;
  return {
    projectId: openedProjectId ?? projectedId,
    authorized:
      projectedId !== null &&
      (openedProjectId === null || projectedId === openedProjectId),
  };
}
