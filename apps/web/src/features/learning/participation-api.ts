import { api, ApiError } from '../../api/client.ts';
import type { Page } from './types.ts';
import type {
  AssignmentTeam,
  AssignmentWork,
  Participation,
  ParticipationAction,
  WorkRequest,
} from './participation-types.ts';
import { verifyWork } from './work-model.ts';
import type { components } from '@code-along/api-client';

const base = (assignmentId: string) => `/api/v1/assignments/${assignmentId}/`;
const read = (signal?: AbortSignal) => (signal ? { signal } : {});
export const participationApi = {
  versionSummaries: (id: string, signal?: AbortSignal) =>
    api<components['schemas']['AssignmentVersionPage']>(
      `${base(id)}versions/?offset=0&limit=100`,
      read(signal),
    ),
  async own(id: string, signal?: AbortSignal): Promise<Participation | null> {
    try {
      return await api<Participation>(
        `${base(id)}participation/`,
        read(signal),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  roster: (id: string, offset = 0, signal?: AbortSignal) =>
    api<Page<Participation>>(
      `${base(id)}participations/?offset=${offset}&limit=20`,
      read(signal),
    ),
  rosterAll: (id: string, signal?: AbortSignal) =>
    api<components['schemas']['ParticipationPage']>(
      `${base(id)}participations/?offset=0&limit=100`,
      read(signal),
    ),
  offer: (id: string, recipient_id: string, expected_revision?: number) =>
    api<Participation>(`${base(id)}participations/`, {
      method: 'POST',
      body: {
        recipient_id,
        ...(expected_revision === undefined ? {} : { expected_revision }),
      } satisfies components['schemas']['ParticipationOfferRequest'],
    }),
  self: (id: string, action: ParticipationAction, expected_revision: number) =>
    api<Participation>(`${base(id)}participation/${action}/`, {
      method: 'POST',
      body: { expected_revision },
    }),
  revoke: (id: string, participationId: string, expected_revision: number) =>
    api<Participation>(`${base(id)}participations/${participationId}/revoke/`, {
      method: 'POST',
      body: { expected_revision },
    }),
  teams: (id: string, offset = 0, versionId?: string, signal?: AbortSignal) =>
    api<Page<AssignmentTeam>>(
      `${base(id)}teams/?offset=${offset}&limit=20${versionId ? `&assignment_version_id=${versionId}` : ''}`,
      read(signal),
    ),
  team: (
    id: string,
    teamId: string,
    versionId?: string,
    signal?: AbortSignal,
  ) =>
    api<AssignmentTeam>(
      `${base(id)}teams/${teamId}/${versionId ? `?assignment_version_id=${versionId}` : ''}`,
      read(signal),
    ),
  createTeam: (id: string, name: string) =>
    api<AssignmentTeam>(`${base(id)}teams/`, {
      method: 'POST',
      body: { name },
    }),
  updateTeam: (
    id: string,
    teamId: string,
    request: components['schemas']['TeamPatchRequest'],
  ) =>
    api<AssignmentTeam>(`${base(id)}teams/${teamId}/`, {
      method: 'PATCH',
      body: request,
    }),
  offerTeam: (
    id: string,
    teamId: string,
    request: components['schemas']['TeamMemberOfferRequest'],
  ) =>
    api<AssignmentTeam>(`${base(id)}teams/${teamId}/members/`, {
      method: 'POST',
      body: request,
    }),
  removeTeam: (
    id: string,
    teamId: string,
    participationId: string,
    expected_team_revision: number,
    expected_participation_revision: number,
  ) =>
    api<unknown>(
      `${base(id)}teams/${teamId}/members/${participationId}/?expected_team_revision=${expected_team_revision}&expected_participation_revision=${expected_participation_revision}`,
      { method: 'DELETE' },
    ),
  approve: (
    id: string,
    teamId: string,
    request: components['schemas']['TeamApprovalRequest'],
  ) =>
    api<AssignmentTeam>(`${base(id)}teams/${teamId}/approval/`, {
      method: 'POST',
      body: request,
    }),
  consent: (id: string, request: components['schemas']['TeamConsentRequest']) =>
    api<Participation>(`${base(id)}participation/team-consent/`, {
      method: 'POST',
      body: request,
    }),
  async works(
    id: string,
    mine: boolean,
    retired: boolean,
    offset = 0,
    signal?: AbortSignal,
  ) {
    const page = await api<Page<AssignmentWork>>(
      `${base(id)}works/?mine=${mine}&include_retired=${retired}&offset=${offset}&limit=20`,
      read(signal),
    );
    return { ...page, items: page.items.map((work) => verifyWork(work, id)) };
  },
  async work(id: string, workId: string, signal?: AbortSignal) {
    return verifyWork(
      await api<AssignmentWork>(`${base(id)}works/${workId}/`, read(signal)),
      id,
      workId,
    );
  },
  async createWork(id: string, request: WorkRequest) {
    const work = verifyWork(
      await api<AssignmentWork>(`${base(id)}works/`, {
        method: 'POST',
        body: request,
      }),
      id,
    );
    if (work.assignment_version_id !== request.assignment_version_id)
      throw new Error(
        'The work receipt does not match the requested pinned version. No source project was opened.',
      );
    return work;
  },
};
