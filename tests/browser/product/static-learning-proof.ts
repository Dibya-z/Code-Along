import {
  expect,
  type Page,
  type Request,
  type WebSocket,
} from '@playwright/test';
import {
  parseLearningCommand,
  parseLearningFrame,
  type LearningAudience,
} from '@code-along/contracts/learning-events';

/** Static artifacts may observe their private learning scope, never open live Source or an execution context. */
export async function watchStaticLearning(
  page: Page,
  expected: { assignmentId: string; audience: LearningAudience },
) {
  const origin = new URL(page.url());
  // Retire any previous live Work observer before measuring the entire new static mount.
  await page.goto('about:blank');
  const counts = {
    source: 0,
    work: 0,
    runner: 0,
    workers: 0,
    forbiddenSockets: 0,
    learningOpened: 0,
    invalidFrames: 0,
    subscriptions: 0,
    acknowledgements: 0,
  };
  const active = new Set<WebSocket>();
  const cleanups: (() => void)[] = [];
  const request = (value: Request) => {
    const url = new URL(value.url());
    if (
      url.pathname.startsWith('/api/v1/projects/') ||
      /^\/api\/v1\/workspaces\/[^/]+\/projects(?:\/|$)/.test(url.pathname)
    )
      counts.source++;
    if (/^\/api\/v1\/assignments\/[^/]+\/works\//.test(url.pathname))
      counts.work++;
    if (url.host !== origin.host && url.hostname === 'localhost')
      counts.runner++;
  };
  const worker = () => {
    counts.workers++;
  };
  const socket = (value: WebSocket) => {
    const url = new URL(value.url());
    if (
      url.protocol !== (origin.protocol === 'https:' ? 'wss:' : 'ws:') ||
      url.host !== origin.host ||
      url.pathname !== '/events/learning' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      counts.forbiddenSockets++;
      return;
    }
    counts.learningOpened++;
    active.add(value);
    const close = () => active.delete(value);
    const sent = ({ payload }: { payload: string | Buffer }) => {
      const parsed = parseLearningCommand(payload);
      if (
        parsed.ok &&
        parsed.value.assignment_id === expected.assignmentId &&
        parsed.value.audience === expected.audience
      )
        counts.subscriptions++;
      else counts.invalidFrames++;
    };
    const received = ({ payload }: { payload: string | Buffer }) => {
      const parsed = parseLearningFrame(payload);
      if (
        !parsed.ok ||
        parsed.value.assignment_id !== expected.assignmentId ||
        parsed.value.audience !== expected.audience
      )
        counts.invalidFrames++;
      else if (parsed.value.type === 'subscribed') counts.acknowledgements++;
    };
    value.on('close', close);
    value.on('framesent', sent);
    value.on('framereceived', received);
    cleanups.push(() => {
      value.off('close', close);
      value.off('framesent', sent);
      value.off('framereceived', received);
    });
  };
  page.on('request', request);
  page.on('worker', worker);
  page.on('websocket', socket);
  return {
    counts,
    active,
    dispose() {
      page.off('request', request);
      page.off('worker', worker);
      page.off('websocket', socket);
      for (const cleanup of cleanups) cleanup();
    },
  };
}
export async function assertStaticLearning(
  proof: Awaited<ReturnType<typeof watchStaticLearning>>,
) {
  await expect.poll(() => proof.active.size).toBe(1);
  expect(proof.counts.learningOpened).toBeGreaterThanOrEqual(1);
  expect(proof.counts.subscriptions).toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => proof.counts.acknowledgements)
    .toBeGreaterThanOrEqual(1);
  expect({
    source: proof.counts.source,
    work: proof.counts.work,
    runner: proof.counts.runner,
    workers: proof.counts.workers,
    forbiddenSockets: proof.counts.forbiddenSockets,
    invalidFrames: proof.counts.invalidFrames,
  }).toEqual({
    source: 0,
    work: 0,
    runner: 0,
    workers: 0,
    forbiddenSockets: 0,
    invalidFrames: 0,
  });
}
