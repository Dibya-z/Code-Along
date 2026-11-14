import {
  isChatMessage,
  parseChatPage,
  parseEventPage,
  type ChatMessage,
} from '@code-along/contracts/events';
import { api, ApiError } from '../../api/client.ts';
import { getIdentity } from '../auth/session.ts';
import type { Project } from '../projects/types.ts';
import type { components } from '@code-along/api-client';

export type ChatRequest = Readonly<components['schemas']['MessageBodyRequest']>;
export function discussionApi(accountId: string, projectId: string) {
  const base = `/api/v1/projects/${projectId}/`;
  return {
    async authorize(signal: AbortSignal) {
      const identity = await getIdentity(signal);
      if (identity?.id !== accountId) throw new ApiError(401, null);
      const project = await api<Project>(base, { signal });
      return {
        accountId: identity.id,
        canPost:
          ['owner', 'editor'].includes(project.role) &&
          !project.archived &&
          !project.workspace_archived,
      };
    },
    async latest(signal: AbortSignal) {
      return parseChatPage(
        await api<components['schemas']['ChatPage']>(
          `${base}chat/messages/?limit=50`,
          { signal },
        ),
        projectId,
      );
    },
    async older(before: string, signal: AbortSignal) {
      return parseChatPage(
        await api<components['schemas']['ChatPage']>(
          `${base}chat/messages/?before=${before}&limit=50`,
          {
            signal,
          },
        ),
        projectId,
      );
    },
    async events(after: string, signal: AbortSignal) {
      return parseEventPage(
        await api<components['schemas']['EventPage']>(
          `${base}events/?after=${after}&limit=100`,
          {
            signal,
          },
        ),
        projectId,
      );
    },
    async post(body: ChatRequest, signal: AbortSignal): Promise<ChatMessage> {
      const message = await api<components['schemas']['ChatMessageOutput']>(
        `${base}chat/messages/`,
        {
          method: 'POST',
          body,
          signal,
        },
      );
      if (
        !isChatMessage(message) ||
        message.project_id !== projectId ||
        message.author.id !== accountId ||
        message.client_message_id !== body.client_message_id ||
        message.deleted ||
        message.body !== body.body
      )
        throw new Error(
          'The message response could not be verified. Recheck discussion before retrying.',
        );
      return message;
    },
  };
}
export type DiscussionApi = ReturnType<typeof discussionApi>;
