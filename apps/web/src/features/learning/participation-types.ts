import type { components } from '@code-along/api-client';
export type Participation = components['schemas']['Participation'];
export type LearningUser = Participation['user'];
export type ParticipationState = Participation['state'];
export type AssignmentTeam = components['schemas']['Team'];
export type AssignmentWork = components['schemas']['Work'];
export type ParticipationAction = 'accept' | 'decline' | 'withdraw';
export type WorkRequest = Readonly<components['schemas']['WorkCreateRequest']>;
