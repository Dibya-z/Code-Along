import {
  parseLearningHead,
  subscribeLearning,
} from '@code-along/contracts/learning-events';
import { api } from '../../api/client.ts';
import { productApi } from '../../api/product.ts';
import type { LearningObserverIO, LearningScope } from './observer.ts';
import type { components } from '@code-along/api-client';

export function learningObserverIO(
  scope: LearningScope,
  current: () => boolean,
  refresh: LearningObserverIO['refresh'],
): LearningObserverIO {
  return {
    async authorize(signal) {
      if (!current() || signal.aborted)
        throw new Error('Reopen this assignment to check learning access.');
      const actor = await productApi.me(signal);
      if (!current() || signal.aborted || actor.id !== scope.accountId)
        throw new Error('Your account changed. Reopen this assignment.');
    },
    async head(signal) {
      if (!current() || signal.aborted)
        throw new Error('Learning access changed.');
      const result = parseLearningHead(
        await api<unknown>(
          `/api/v1/assignments/${scope.assignmentId}/learning-head/?audience=${scope.audience}`,
          { signal },
        ),
      );
      if (!current() || signal.aborted)
        throw new Error('Learning access changed.');
      if (
        !result.ok ||
        result.value.assignment_id !== scope.assignmentId ||
        result.value.audience !== scope.audience
      )
        throw new Error('Learning updates could not be verified.');
      const checked: components['schemas']['LearningHeadOutput'] = result.value;
      return checked.head_generation;
    },
    refresh,
    connect(after, events) {
      const socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events/learning`,
      );
      let live = true;
      socket.onopen = () => {
        if (live && current()) {
          socket.send(
            subscribeLearning(scope.assignmentId, scope.audience, after),
          );
          events.open();
        } else socket.close();
      };
      socket.onmessage = (event) => {
        if (live && current()) events.frame(event.data);
      };
      socket.onclose = (event) => {
        if (live && current()) events.close(event.code);
      };
      return () => {
        live = false;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
      };
    },
  };
}
