import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Response,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { components } from '../../../packages/api-client/src/schema.d.ts';
import { register, openRunOptions } from './helpers.ts';
import {
  practiceFixture,
  pane,
  disclosure,
  get,
  readySource,
  replaceSource,
  saved,
} from './practice-fixture.ts';
import {
  parseLearningCommand,
  parseLearningFrame,
} from '@code-along/contracts/learning-events';

type Security = { Origin: string; 'X-CSRFToken': string };
type Detail = components['schemas']['SubmissionDetail'];
type Progress = components['schemas']['OwnProgress'];
type Fixture = Awaited<ReturnType<typeof practiceFixture>>;
async function security(page: Page): Promise<Security> {
  const reply = await page.request.get('/api/v1/csrf/');
  expect(reply.status()).toBe(200);
  return {
    Origin: new URL(page.url()).origin,
    'X-CSRFToken': ((await reply.json()) as { csrfToken: string }).csrfToken,
  };
}
async function write<T>(
  page: Page,
  path: string,
  data: unknown,
  headers: Security,
  status = 201,
  method: 'post' | 'patch' = 'post',
): Promise<T> {
  const reply = await page.request[method](path, { headers, data });
  expect(reply.status(), `${method.toUpperCase()} ${path}`).toBe(status);
  return reply.json() as Promise<T>;
}
async function closeAll(
  primary: unknown,
  tasks: Promise<unknown>[],
  earlier?: unknown,
) {
  const cleanup = await Promise.allSettled(tasks);
  if (primary !== undefined) return;
  if (earlier !== undefined) throw earlier;
  const failed = cleanup.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
const progressPath = (f: Fixture, version = f.version.id) =>
  `/api/v1/assignments/${f.assignmentId}/progress/?assignment_version_id=${version}`;
const headPath = (f: Fixture) =>
  `/api/v1/assignments/${f.assignmentId}/learning-head/?audience=participant`;
const submissionURL = (f: Fixture, detail: Detail) =>
  `/assignments/${f.assignmentId}/submissions/${detail.id}`;
const feedbackPath = (f: Fixture, detail: Detail) =>
  `/api/v1/assignments/${f.assignmentId}/submissions/${detail.id}/feedback/`;
async function chooseCurrent(f: Fixture) {
  await pane(f.learner, 'Task');
  await disclosure(f.learner, 'Submit code');
  await f.learner
    .getByRole('button', { name: 'Choose current code', exact: true })
    .click();
  await expect(
    f.learner.getByRole('button', { name: 'Submit chosen code', exact: true }),
  ).toBeEnabled();
}
async function submitCurrent(f: Fixture): Promise<Detail> {
  await chooseCurrent(f);
  const pending = f.learner.waitForResponse(
    (r) =>
      new URL(r.url()).pathname ===
        `/api/v1/assignments/${f.assignmentId}/works/${f.workId}/submissions/` &&
      r.request().method() === 'POST',
  );
  await f.learner
    .getByRole('button', { name: 'Submit chosen code', exact: true })
    .click();
  const reply = await pending;
  expect(reply.status()).toBe(201);
  const detail = (await reply.json()) as Detail;
  await expect(
    f.learner.getByRole('status').filter({
      hasText: `Submission ${detail.assignment_submission_number} confirmed.`,
    }),
  ).toBeVisible();
  return detail;
}
async function assess(
  f: Fixture,
  detail: Detail,
  headers: Security,
  comments: string,
) {
  const path = feedbackPath(f, detail),
    draft = await get<components['schemas']['FeedbackDraft']>(
      f.owner,
      `${path}draft/`,
    );
  const saved = await write<components['schemas']['FeedbackDraft']>(
    f.owner,
    `${path}draft/`,
    {
      expected_revision: draft.revision,
      comments,
      assessment_status: 'complete',
    },
    headers,
    200,
    'patch',
  );
  return write<components['schemas']['FeedbackPublication']>(
    f.owner,
    `${path}publications/`,
    { expected_revision: saved.revision, client_request_id: randomUUID() },
    headers,
  );
}
async function openStaticProgress(f: Fixture, detail: Detail) {
  await f.learner.goto(submissionURL(f, detail));
  await expect(
    f.learner.getByRole('heading', {
      name: 'Instructor feedback',
      exact: true,
    }),
  ).toBeVisible();
  await disclosure(f.learner, 'Your progress for this version');
  const progress = f.learner.getByRole('region', {
    name: 'Your learning progress',
    exact: true,
  });
  await expect(progress).toBeVisible();
  return progress;
}
async function publicationB(f: Fixture, headers: Security, dueAt?: string) {
  const path = `/api/v1/assignments/${f.assignmentId}/`,
    draft = await get<components['schemas']['AssignmentDraft']>(
      f.owner,
      `${path}draft/`,
    );
  const next = await write<components['schemas']['AssignmentDraft']>(
    f.owner,
    `${path}draft/`,
    {
      expected_revision: draft.revision,
      instructions: 'Published B keeps A work and source independent.',
      ...(dueAt ? { due_at: dueAt } : {}),
    },
    headers,
    200,
    'patch',
  );
  return write<components['schemas']['AssignmentVersionSummary']>(
    f.owner,
    `${path}versions/`,
    { expected_revision: next.revision, client_request_id: randomUUID() },
    headers,
  );
}
async function archiveChoice(page: Page) {
  await disclosure(page, 'Preview chosen code');
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export chosen source', exact: true })
    .click();
  const file = await (await download).path();
  expect(file).not.toBeNull();
  return JSON.parse(await readFile(file!, 'utf8')) as {
    files: { path: string; source: string }[];
  };
}

test('learning HTTP heads repair final dropped markers and newer H2 stays submitted after an older H1 correction', async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  let primary: unknown;
  try {
    await readySource(f.learner);
    const first = await submitCurrent(f),
      headers = await security(page);
    const wire = { connections: 0, subscribed: 0, dropped: 0, invalid: 0 };
    await f.learner.routeWebSocket('**/events/learning', (route) => {
      wire.connections++;
      const server = route.connectToServer();
      route.onMessage((message) => {
        if (!parseLearningCommand(message).ok) wire.invalid++;
        server.send(message);
      });
      server.onMessage((message) => {
        const parsed = parseLearningFrame(message);
        if (!parsed.ok) {
          wire.invalid++;
          route.send(message);
          return;
        }
        if (parsed.value.type === 'subscribed') {
          wire.subscribed++;
          route.send(message);
        } else wire.dropped++;
      });
    });
    // Fully retire the earlier live Work before measuring this fresh static entry.
    await f.learner.goto('about:blank');
    const traffic = { source: 0, work: 0, workers: 0 };
    const request = (r: import('@playwright/test').Request) => {
      const path = new URL(r.url()).pathname;
      if (
        path.startsWith('/api/v1/projects/') ||
        /^\/api\/v1\/workspaces\/[^/]+\/projects\//.test(path)
      )
        traffic.source++;
      if (/^\/api\/v1\/assignments\/[^/]+\/works\//.test(path)) traffic.work++;
    };
    const worker = () => {
      traffic.workers++;
    };
    f.learner.on('request', request);
    f.learner.on('worker', worker);
    let progress = await openStaticProgress(f, first);
    await expect(
      progress.getByText('Submitted', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => wire.subscribed).toBe(1);
    expect(wire.connections).toBe(1);
    await assess(f, first, headers, 'Manual review of frozen H1.');
    await expect(
      progress.getByText('Marked complete by an instructor', { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      f.learner.getByRole('article', {
        name: 'Published feedback 1',
        exact: true,
      }),
    ).toContainText('Manual review of frozen H1.');
    expect(wire.dropped).toBeGreaterThan(0);
    expect(wire.invalid).toBe(0);
    expect(traffic).toEqual({ source: 0, work: 0, workers: 0 });
    await f.learner.setViewportSize({ width: 1440, height: 900 });
    await f.learner.screenshot({
      path: info.outputPath('learning-progress-1440.png'),
      fullPage: true,
      animations: 'disabled',
    });
    f.learner.off('request', request);
    f.learner.off('worker', worker);
    await f.learner.goto(`/assignments/${f.assignmentId}/works/${f.workId}`);
    await expect(
      f.learner.locator('.editor-workbench[data-guide="true"]'),
    ).toBeVisible();
    await pane(f.learner, 'Code');
    await expect(
      f.learner.getByLabel('Python source for main.py', { exact: true }),
    ).toBeEditable({ timeout: 20000 });
    const desktopFiles = f.learner
      .locator('.workbench-context-switch')
      .getByRole('button', { name: 'Files', exact: true });
    if (await desktopFiles.isVisible()) await desktopFiles.click();
    await replaceSource(
      f.learner,
      'learner.py',
      '\uFEFFdef answer():\n    return 99\n',
    );
    await saved(f.learner);
    const second = await submitCurrent(f);
    expect(second.id).not.toBe(first.id);
    expect(second.source_manifest_sha256).not.toBe(
      first.source_manifest_sha256,
    );
    let quota: { observedAt: number; seconds: number } | null = null;
    const observeQuota = (response: Response) => {
      if (
        response.status() !== 429 ||
        !new URL(response.url()).pathname.startsWith(
          `/api/v1/assignments/${f.assignmentId}/`,
        )
      )
        return;
      const seconds = Number(response.headers()['retry-after']);
      if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 60)
        quota = { observedAt: Date.now(), seconds };
    };
    f.learner.on('response', observeQuota);
    try {
      progress = await openStaticProgress(f, second);
      try {
        await expect(
          progress.getByText('Submitted', { exact: true }),
        ).toBeVisible();
      } catch (error) {
        // This one long journey can reach the real per-account quota. Recover
        // only an actually observed fresh 429, preserving all other failures.
        const observed = quota as {
          observedAt: number;
          seconds: number;
        } | null;
        if (!observed || Date.now() - observed.observedAt > 10000) throw error;
        const remaining = Math.max(
          0,
          observed.observedAt + observed.seconds * 1000 - Date.now(),
        );
        info.annotations.push({
          type: 'observed-quota',
          description: `H2 static read: respected Retry-After ${observed.seconds}s before explicit refresh`,
        });
        await f.learner.waitForTimeout(remaining + 2000);
        const recheck = f.learner.getByRole('button', {
          name: 'Recheck learning updates',
          exact: true,
        });
        if (await recheck.isVisible()) await recheck.click();
        await expect(
          progress.getByText('Submitted', { exact: true }),
        ).toBeVisible();
      }
    } finally {
      f.learner.off('response', observeQuota);
    }
    await assess(
      f,
      first,
      headers,
      'Correction still refers only to older H1.',
    );
    // This request must start after the correction committed, not during bootstrap.
    const expectedProgressURL = new URL(progressPath(f), f.learner.url()).href;
    const refreshed = f.learner.waitForRequest(
      (r) => r.url() === expectedProgressURL && r.method() === 'GET',
    );
    await f.learner.bringToFront();
    await f.learner.evaluate(() => window.dispatchEvent(new Event('focus')));
    let refreshedResponse = await (await refreshed).response();
    expect(refreshedResponse).not.toBeNull();
    if (refreshedResponse!.status() === 429) {
      // This is one safe-read checkpoint, not a mutation retry. Honor only
      // the actual response's bounded delay; any other status still fails.
      const observedAt = Date.now();
      const rawDelay = refreshedResponse!.headers()['retry-after'] ?? '';
      const seconds = /^[0-9]{1,2}$/.test(rawDelay) ? Number(rawDelay) : 0;
      expect(
        seconds,
        'Actual progress 429 must supply Retry-After 1..60s',
      ).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(60);
      info.annotations.push({
        type: 'observed-quota',
        description: `Post-correction progress: respected Retry-After ${seconds}s before one explicit read-only refresh`,
      });
      await f.learner.waitForTimeout(
        Math.max(0, observedAt + seconds * 1000 - Date.now()) + 2000,
      );
      const replacement = f.learner.waitForRequest(
        (r) => r.url() === expectedProgressURL && r.method() === 'GET',
      );
      await progress
        .getByRole('button', { name: 'Refresh my progress', exact: true })
        .click();
      refreshedResponse = await (await replacement).response();
      expect(refreshedResponse).not.toBeNull();
    }
    expect(refreshedResponse!.status()).toBe(200);
    const refreshedProgress = (await refreshedResponse!.json()) as Progress;
    expect(refreshedProgress.latest_submission?.id).toBe(second.id);
    expect(refreshedProgress.latest_assessment).toBeNull();
    expect(refreshedProgress.state).toBe('submitted');

    await expect(
      progress.getByText('Submitted', { exact: true }),
    ).toBeVisible();
    await expect(
      f.learner.getByText(
        'No feedback has been published for this submission.',
        { exact: true },
      ),
    ).toBeVisible();
    await f.learner.setViewportSize({ width: 390, height: 844 });
    await f.learner
      .locator('html')
      .evaluate((e) => e.setAttribute('data-theme', 'dark'));
    await f.learner.screenshot({
      path: info.outputPath('learning-progress-390-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      await f.learner.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } catch (error) {
    primary = error;
    const state = await f.learner
      .evaluate(() => ({
        route: /^\/assignments\/[^/]+\/works\//.test(location.pathname)
          ? 'work'
          : /^\/assignments\/[^/]+\/submissions\//.test(location.pathname)
            ? 'submission'
            : 'other',
        workbench: Boolean(document.querySelector('.editor-workbench')),
        editors: document.querySelectorAll('[aria-label^="Python source for"]')
          .length,
        explorer: Boolean(
          document.querySelector('nav[aria-label="Project file explorer"]'),
        ),
        filesPressed:
          document
            .querySelector('.workbench-context-switch button:last-child')
            ?.getAttribute('aria-pressed') ?? null,
      }))
      .catch(() => ({ route: 'closed' }));
    await writeFile(
      info.outputPath('learning-original-failure-state.json'),
      JSON.stringify(state, null, 2),
    );
    await f.learner
      .screenshot({
        path: info.outputPath('learning-original-failure.png'),
        fullPage: true,
        animations: 'disabled',
        timeout: 3000,
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});

test('learning refresh keeps a waiting Worker input chosen H and a private teacher draft while publication B leaves A alive', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  let primary: unknown;
  try {
    const headers = await security(page);
    await page.goto(`/assignments/${f.assignmentId}#draft`);
    await expect(
      page.getByLabel('Instructions', { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Instructions', { exact: true })
      .fill('Unsaved teacher instructions stay in this tab.');
    let privateReads = 0;
    page.on('request', (r) => {
      if (
        new URL(r.url()).pathname ===
          `/api/v1/assignments/${f.assignmentId}/draft/` &&
        r.method() === 'GET'
      )
        privateReads++;
    });
    await replaceSource(f.learner, 'main.py', 'print(input("Name: "))');
    await saved(f.learner);
    await chooseCurrent(f);
    const chosen = await archiveChoice(f.learner);
    await pane(f.learner, 'Output');
    await openRunOptions(f.learner);
    await f.learner.getByLabel('Python input mode').selectOption('interactive');
    await f.learner
      .getByRole('button', { name: 'Run code', exact: true })
      .click();
    await pane(f.learner, 'Output');
    await expect(f.learner.locator('.execution-status')).toHaveText(
      'Waiting for input',
      { timeout: 40000 },
    );
    await f.learner
      .getByLabel('Input for Python', { exact: true })
      .fill('Retained input draft');
    const iframe = await f.learner
      .locator('iframe[title="Isolated Python runtime"]')
      .elementHandle();
    expect(iframe).not.toBeNull();
    const observed = f.learner.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/assignments/${f.assignmentId}/` &&
        response.status() === 200 &&
        ((await response.json()) as components['schemas']['AssignmentSummary'])
          .current_version?.number === 2,
    );
    const teacherObserved = page.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname ===
          `/api/v1/assignments/${f.assignmentId}/` &&
        response.status() === 200 &&
        ((await response.json()) as components['schemas']['AssignmentSummary'])
          .current_version?.number === 2,
    );
    const b = await publicationB(f, headers);
    expect(b.number).toBe(2);
    await observed;
    await teacherObserved;
    await expect
      .poll(
        async () =>
          (
            await get<components['schemas']['AssignmentSummary']>(
              f.learner,
              `/api/v1/assignments/${f.assignmentId}/`,
            )
          ).current_version?.id,
      )
      .toBe(b.id);
    await expect(f.learner.locator('.execution-status')).toHaveText(
      'Waiting for input',
    );
    await expect(
      f.learner.getByLabel('Input for Python', { exact: true }),
    ).toHaveValue('Retained input draft');
    expect(await iframe!.evaluate((e) => e.isConnected)).toBe(true);
    await expect(
      f.learner.locator('iframe[title="Isolated Python runtime"]'),
    ).toHaveCount(1);
    await f.learner
      .getByRole('button', { name: 'Stop run', exact: true })
      .click();
    await expect(f.learner.locator('.execution-status')).toHaveText(
      'Run stopped',
    );
    await pane(f.learner, 'Task');
    await expect(
      f.learner.getByRole('article', { name: 'Pinned work task', exact: true }),
    ).toContainText('Published version 1.');
    await disclosure(f.learner, 'Submit code');
    expect((await archiveChoice(f.learner)).files).toEqual(chosen.files);
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Unsaved teacher instructions stay in this tab.',
    );
    expect(privateReads).toBe(0);
    await disclosure(f.learner, 'Your progress');
    await expect(
      f.learner.getByRole('heading', {
        name: 'Your progress · version 1',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await get<Progress>(f.learner, progressPath(f))).assignment_version_id,
    ).toBe(f.version.id);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const stop = f.learner.getByRole('button', {
      name: 'Stop run',
      exact: true,
    });
    let stopError: unknown;
    try {
      if ((await stop.isVisible()) && (await stop.isEnabled()))
        await stop.click({ timeout: 2000 });
    } catch (error) {
      stopError = error;
    }
    await closeAll(primary, [f.close()], stopError);
  }
});

test('a learner without an offer stays HTTP-only until focus repair and only their own audience can subscribe', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  let primary: unknown;
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      ignoreHTTPSErrors: true,
    });
    const actor = await context.newPage(),
      email = `learn-head-${randomUUID().slice(0, 8)}@example.test`;
    await register(actor, email, 'Sage');
    const headers = await security(page),
      assignment = await get<components['schemas']['AssignmentSummary']>(
        page,
        `/api/v1/assignments/${f.assignmentId}/`,
      );
    const invitation = await write<{ invite_url: string }>(
      page,
      `/api/v1/workspaces/${assignment.workspace_id}/invitations/`,
      { recipient_email: email, role: 'learner', expires_hours: 72 },
      headers,
    );
    await actor.goto(invitation.invite_url);
    await actor
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(actor).toHaveURL(
      new RegExp(`/workspaces/${assignment.workspace_id}$`),
    );
    const user = await get<{ id: string }>(actor, '/api/v1/me/');
    let heads = 0,
      sockets = 0,
      subscribed = 0,
      invalidFrames = 0,
      source = 0;
    actor.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.endsWith('/learning-head/')) heads++;
      if (path.startsWith('/api/v1/projects/')) source++;
    });
    actor.on('websocket', (s) => {
      if (new URL(s.url()).pathname !== '/events/learning') return;
      sockets++;
      s.on('framereceived', ({ payload }) => {
        const parsed = parseLearningFrame(payload);
        if (
          !parsed.ok ||
          parsed.value.assignment_id !== f.assignmentId ||
          parsed.value.audience !== 'participant'
        )
          invalidFrames++;
        else if (parsed.value.type === 'subscribed') subscribed++;
      });
    });
    await actor.goto(`/assignments/${f.assignmentId}#my-work`);
    const progress = actor.getByRole('region', {
      name: 'Your learning progress',
      exact: true,
    });
    await expect(progress).toContainText('No participation offer');
    await expect(
      actor.getByText(
        'No participation offer is available for this account. Ask a workspace teacher if you should take part.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    expect(heads).toBe(0);
    expect(sockets).toBe(0);
    await write(
      page,
      `/api/v1/assignments/${f.assignmentId}/participations/`,
      { recipient_id: user.id },
      headers,
    );
    await actor.bringToFront();
    await actor.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      actor.getByRole('button', { name: 'Accept participation', exact: true }),
    ).toBeEnabled();
    await expect.poll(() => sockets).toBe(1);
    await expect.poll(() => subscribed).toBe(1);
    expect(invalidFrames).toBe(0);
    expect(heads).toBeGreaterThan(0);
    expect(source).toBe(0);
    expect(
      (await get<Progress>(actor, progressPath(f))).eligibility_state,
    ).toBe('invited');
    expect(
      (
        await actor.request.get(
          `/api/v1/assignments/${f.assignmentId}/progress/learners/?assignment_version_id=${f.version.id}`,
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await actor.request.get(
          `/api/v1/assignments/${f.assignmentId}/learning-head/?audience=participant&user_id=${scopeUUID}`,
        )
      ).status(),
    ).toBe(400);
    const denied = await actor.evaluate(
      async (assignmentId) =>
        new Promise<{ code: number; frames: number }>((resolve) => {
          const socket = new WebSocket(
            `wss://${location.host}/events/learning`,
          );
          let frames = 0;
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                protocol: 'code-along.learning-events',
                version: 1,
                type: 'subscribe',
                scope: 'assignment',
                assignment_id: assignmentId,
                audience: 'teaching',
                after_generation: null,
              }),
            );
          socket.onmessage = () => frames++;
          socket.onclose = (event) => resolve({ code: event.code, frames });
        }),
      f.assignmentId,
    );
    expect(denied).toEqual({ code: 4403, frames: 0 });
    await page.goto(`/assignments/${f.assignmentId}#progress`);
    await expect(
      page.getByRole('heading', { name: 'Learner progress', exact: true }),
    ).toBeVisible();
    const selection = page.getByLabel('Progress for published version');
    await expect(selection).toHaveValue(f.version.id);
    await publicationB(f, headers);
    await page
      .getByRole('button', { name: 'Refresh assignment', exact: true })
      .click();
    await expect(selection).toHaveValue(f.version.id);
    await expect(selection.locator('option:checked')).toContainText(
      'Version 1',
    );
    const rows = await get<components['schemas']['LearnerProgressPage']>(
      page,
      `/api/v1/assignments/${f.assignmentId}/progress/learners/?assignment_version_id=${f.version.id}&offset=0&limit=20`,
    );
    expect(rows.items.length).toBeGreaterThan(0);
    expect(
      rows.items.every(
        (row) => !('can_submit' in row) && !('project_id' in row),
      ),
    ).toBe(true);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await closeAll(primary, [...(context ? [context.close()] : []), f.close()]);
  }
});
const scopeUUID = '99999999-9999-4999-8999-999999999999';

test('a real version deadline refreshes current submission availability without changing the durable learning head', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const f = await practiceFixture(page, browser, browserName);
  let primary: unknown;
  try {
    const headers = await security(page),
      due = new Date(Date.now() + 25000).toISOString(),
      version = await publicationB(f, headers, due);
    const own = await get<components['schemas']['Participation']>(
      f.learner,
      `/api/v1/assignments/${f.assignmentId}/participation/`,
    );
    const work = await write<components['schemas']['Work']>(
      f.learner,
      `/api/v1/assignments/${f.assignmentId}/works/`,
      {
        client_request_id: randomUUID(),
        assignment_version_id: version.id,
        expected_participation_revision: own.revision,
        expected_team_roster_revision: null,
        project_name: 'Deadline practice B',
        sharing: 'private',
      },
      await security(f.learner),
    );
    await f.learner.goto(
      `/assignments/${f.assignmentId}/works/${work.id}#task`,
    );
    await expect(
      f.learner.getByRole('article', { name: 'Pinned work task', exact: true }),
    ).toBeVisible();
    await disclosure(f.learner, 'Your progress');
    const progress = f.learner.getByRole('region', {
      name: 'Your learning progress',
      exact: true,
    });
    await expect(progress).toContainText(
      'New submissions are currently available.',
    );
    const before = await get<components['schemas']['LearningHeadOutput']>(
      f.learner,
      headPath(f),
    );
    await expect(progress).toContainText(
      'A new submission is not currently available.',
      { timeout: 40000 },
    );
    const after = await get<components['schemas']['LearningHeadOutput']>(
      f.learner,
      headPath(f),
    );
    expect(after.head_generation).toBe(before.head_generation);
    const actual = await get<Progress>(f.learner, progressPath(f, version.id));
    expect(actual.can_submit).toBe(false);
    expect(actual.state).toBe('in_progress');
    expect(actual.eligibility_state).toBe('eligible');
    await pane(f.learner, 'Code');
    await expect(
      f.learner.getByLabel('Python source for main.py', { exact: true }),
    ).toBeEditable();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});
