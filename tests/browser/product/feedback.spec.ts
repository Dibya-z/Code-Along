import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { components } from '../../../packages/api-client/src/schema.d.ts';
import {
  watchStaticLearning,
  assertStaticLearning,
} from './static-learning-proof.ts';
import { register } from './helpers.ts';
import {
  disclosure,
  get,
  pane,
  practiceFixture,
  readySource,
  replaceSource,
  saved,
} from './practice-fixture.ts';

type Detail = components['schemas']['SubmissionDetail'];
type Publication = components['schemas']['FeedbackPublication'];
type Draft = components['schemas']['FeedbackDraft'];
type Security = { Origin: string; 'X-CSRFToken': string };
const COMMENTS =
  '\uFEFF  <b>Try a smaller example 🐍</b>\nCompare café with café.  ';
async function security(page: Page): Promise<Security> {
  const response = await page.request.get('/api/v1/csrf/');
  expect(response.status()).toBe(200);
  return {
    Origin: new URL(page.url()).origin,
    'X-CSRFToken': ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}
async function write<T>(
  page: Page,
  path: string,
  data: unknown,
  headers: Security,
  status = 201,
  method: 'post' | 'patch' | 'put' = 'post',
): Promise<T> {
  const response = await page.request[method](path, { data, headers });
  expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(status);
  return (status === 204 ? undefined : await response.json()) as T;
}
const base = (assignment: string, submission: string) =>
  `/api/v1/assignments/${assignment}/submissions/${submission}/feedback/`;
const view = (assignment: string, submission: string) =>
  `/assignments/${assignment}/submissions/${submission}`;
async function submitted(page: Page, browser: Browser, browserName: string) {
  const f = await practiceFixture(page, browser, browserName);
  try {
    await readySource(f.learner);
    await pane(f.learner, 'Task');
    await disclosure(f.learner, 'Submit code');
    await f.learner
      .getByRole('button', { name: 'Choose current code', exact: true })
      .click();
    const response = f.learner.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          `/api/v1/assignments/${f.assignmentId}/works/${f.workId}/submissions/` &&
        r.request().method() === 'POST',
    );
    await f.learner
      .getByRole('button', { name: 'Submit chosen code', exact: true })
      .click();
    const reply = await response;
    expect(reply.status()).toBe(201);
    const detail = (await reply.json()) as Detail;
    await expect(
      f.learner.getByRole('status').filter({
        hasText: `Submission ${detail.assignment_submission_number} confirmed.`,
      }),
    ).toBeVisible();
    const assignment = await get<components['schemas']['AssignmentSummary']>(
      page,
      `/api/v1/assignments/${f.assignmentId}/`,
    );
    return {
      ...f,
      detail,
      workspaceId: assignment.workspace_id,
      security: await security(page),
      feedbackPath: base(f.assignmentId, detail.id),
      url: view(f.assignmentId, detail.id),
    };
  } catch (error) {
    await f.close().catch(() => {});
    throw error;
  }
}
async function sourceOnly(
  page: Page,
  url: string,
  audience: 'participant' | 'teaching',
  run: () => Promise<void>,
) {
  const proof = await watchStaticLearning(page, {
    assignmentId: new URL(url, page.url()).pathname.split('/')[2]!,
    audience,
  });
  try {
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Instructor feedback', exact: true }),
    ).toBeVisible();
    await run();
    await assertStaticLearning(proof);
    await expect(page.locator('.editor-workbench')).toHaveCount(0);
    await expect(
      page.locator('iframe[title="Isolated Python runtime"]'),
    ).toHaveCount(0);
  } finally {
    proof.dispose();
  }
}
async function review(page: Page) {
  await disclosure(page, 'Review this submission');
  await expect(
    page.getByLabel('Feedback comments', { exact: true }),
  ).toBeVisible();
}
async function saveDraft(
  page: Page,
  path: string,
  comments: string,
  status: '' | 'reviewed' | 'needs_changes' | 'complete',
) {
  await page.getByLabel('Feedback comments', { exact: true }).fill(comments);
  await page
    .getByLabel('Manual assessment', { exact: true })
    .selectOption(status);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `${path}draft/` &&
      r.request().method() === 'PATCH',
  );
  await page
    .getByRole('button', { name: 'Save feedback draft', exact: true })
    .click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  const draft = (await saved.json()) as Draft;
  expect(draft.comments).toBe(comments);
  expect(draft.assessment_status).toBe(status || null);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Saved draft revision ${draft.revision}.` }),
  ).toBeVisible();
  return draft;
}
async function publish(
  page: Page,
  path: string,
  button = 'Publish saved feedback',
  status = 201,
  keyboard = false,
) {
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `${path}publications/` &&
      r.request().method() === 'POST',
  );
  const action = page.getByRole('button', { name: button, exact: true });
  if (keyboard) await action.press('Enter');
  else await action.click();
  const reply = await response;
  expect(reply.status()).toBe(status);
  const value = (await reply.json()) as Publication;
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Feedback publication ${value.number} confirmed.` }),
  ).toBeVisible();
  return value;
}

test('manual feedback stays private until publish and corrections keep frozen H and earlier plaintext feedback', async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(150000);
  const f = await submitted(page, browser, browserName);
  let primary: unknown;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await replaceSource(
      f.learner,
      'learner.py',
      '\uFEFFdef answer():\n    return 99\n',
    );
    await saved(f.learner);
    let drafts = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === `${f.feedbackPath}draft/`) drafts++;
    });
    await sourceOnly(page, f.url, 'teaching', async () => {
      await expect(
        page.getByText('No feedback has been published for this submission.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(drafts).toBe(0);
      const download = page.waitForEvent('download');
      await page
        .getByRole('button', { name: 'Export submission source', exact: true })
        .click();
      const file = await (await download).path();
      expect(file).not.toBeNull();
      const frozen = JSON.parse(await readFile(file!, 'utf8')) as {
        files: { path: string; source: string }[];
      };
      expect(frozen.files).toEqual(
        f.detail.manifest.files.map(({ path, source }) => ({ path, source })),
      );
      await review(page);
      expect(drafts).toBe(1);
      await saveDraft(page, f.feedbackPath, COMMENTS, 'needs_changes');
      expect(
        (await get<{ latest: Publication | null }>(f.learner, f.feedbackPath))
          .latest,
      ).toBeNull();
      expect(await get(f.learner, `${f.feedbackPath}publications/`)).toEqual({
        items: [],
        count: 0,
      });
      expect(
        (await f.learner.request.get(`${f.feedbackPath}draft/`)).status(),
      ).toBe(403);
      const publishAction = page.getByRole('button', {
        name: 'Publish saved feedback',
        exact: true,
      });
      await publishAction.focus();
      const tab =
        browserName === 'webkit' && process.platform === 'darwin'
          ? 'Alt+Tab'
          : 'Tab';
      await page.keyboard.press(`Shift+${tab}`);
      await page.keyboard.press(tab);
      expect(
        (await publishAction.boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
      expect(
        await publishAction.evaluate(
          (element) => getComputedStyle(element).outlineWidth,
        ),
      ).toBe('2px');
      await expect(
        page.getByRole('button', {
          name: 'Publish saved feedback',
          exact: true,
        }),
      ).toBeFocused();
      await page.screenshot({
        path: info.outputPath('feedback-1440-draft.png'),
        fullPage: true,
        animations: 'disabled',
      });
      const first = await publish(
        page,
        f.feedbackPath,
        'Publish saved feedback',
        201,
        true,
      );
      expect(first.comments).toBe(COMMENTS);
      expect(first.assessment_kind).toBe('manual');
      await expect(
        page
          .getByRole('article', { name: 'Published feedback 1', exact: true })
          .locator('.feedback-plaintext'),
      ).toHaveJSProperty('textContent', COMMENTS);
      await page
        .getByRole('button', {
          name: 'Reload saved feedback draft',
          exact: true,
        })
        .click();
      await expect(
        page.getByRole('button', { name: 'Prepare a correction', exact: true }),
      ).toBeEnabled();
      await page
        .getByRole('button', { name: 'Prepare a correction', exact: true })
        .click();
      await saveDraft(page, f.feedbackPath, '', 'complete');
      const second = await publish(page, f.feedbackPath);
      expect(second.number).toBe(2);
      expect(second.comments).toBe('');
      await disclosure(page, 'Published feedback history');
      await expect(
        page
          .getByRole('article', { name: 'Published feedback 1', exact: true })
          .locator('.feedback-plaintext'),
      ).toHaveJSProperty('textContent', COMMENTS);
    });
    let learnerDrafts = 0;
    f.learner.on('request', (r) => {
      if (new URL(r.url()).pathname === `${f.feedbackPath}draft/`)
        learnerDrafts++;
    });
    await sourceOnly(f.learner, f.url, 'participant', async () => {
      await expect(
        f.learner.getByRole('article', {
          name: 'Published feedback 2',
          exact: true,
        }),
      ).toContainText('Complete');
      await expect(
        f.learner
          .locator('summary')
          .filter({ hasText: /^Review this submission$/ }),
      ).toHaveCount(0);
      await disclosure(f.learner, 'Published feedback history');
      const comments = f.learner
        .getByRole('article', { name: 'Published feedback 1', exact: true })
        .locator('.feedback-plaintext');
      await expect(comments).toHaveJSProperty('textContent', COMMENTS);
      await expect(comments.locator('b')).toHaveCount(0);
      expect(learnerDrafts).toBe(0);
      for (const capture of [
        { width: 390, height: 844, theme: 'light', name: 'feedback-390-light' },
        { width: 320, height: 800, theme: 'light', name: 'feedback-320-light' },
        { width: 390, height: 844, theme: 'dark', name: 'feedback-390-dark' },
      ]) {
        await f.learner.setViewportSize({
          width: capture.width,
          height: capture.height,
        });
        await f.learner
          .locator('html')
          .evaluate(
            (element, theme) => element.setAttribute('data-theme', theme),
            capture.theme,
          );
        await f.learner.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        const presentation = () =>
          f.learner
            .getByRole('button', {
              name: 'Refresh published feedback',
              exact: true,
            })
            .evaluate((element) => ({
              background: getComputedStyle(element).backgroundColor,
              foreground: getComputedStyle(element).color,
              surfaceToken: getComputedStyle(element)
                .getPropertyValue('--color-surface')
                .trim(),
              animations: element.getAnimations().map((animation) => ({
                type: animation.constructor.name,
                playState: animation.playState,
                currentTime: animation.currentTime,
              })),
            }));
        const before = await presentation();
        await f.learner.screenshot({
          path: info.outputPath(`${capture.name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        await writeFile(
          info.outputPath(`${capture.name}-presentation.json`),
          JSON.stringify(
            { theme: capture.theme, before, after: await presentation() },
            null,
            2,
          ),
        );
        expect(
          await f.learner.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});

test('co-teacher CAS conflicts preserve unsaved feedback and a role loss cannot save the retained draft', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await submitted(page, browser, browserName);
  let primary: unknown;
  const other = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const teacher = await other.newPage(),
      email = `fb-co-${randomUUID().slice(0, 10)}@example.test`;
    await register(teacher, email, 'Sage');
    const invitation = await write<{ invite_url: string }>(
      page,
      `/api/v1/workspaces/${f.workspaceId}/invitations/`,
      { recipient_email: email, role: 'instructor', expires_hours: 72 },
      f.security,
    );
    await teacher.goto(invitation.invite_url);
    await teacher
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(teacher).toHaveURL(
      new RegExp(`/workspaces/${f.workspaceId}$`),
    );
    const actor = await get<{ id: string }>(teacher, '/api/v1/me/');
    await page.goto(f.url);
    await teacher.goto(f.url);
    await review(page);
    await review(teacher);
    await saveDraft(page, f.feedbackPath, 'Saved by Mira', 'reviewed');
    await teacher
      .getByLabel('Feedback comments', { exact: true })
      .fill('Unsaved by Sage 🐍');
    await teacher
      .getByLabel('Manual assessment', { exact: true })
      .selectOption('needs_changes');
    const conflict = teacher.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `${f.feedbackPath}draft/` &&
        r.request().method() === 'PATCH',
    );
    await teacher
      .getByRole('button', { name: 'Save feedback draft', exact: true })
      .click();
    expect((await conflict).status()).toBe(409);
    await expect(
      teacher.getByLabel('Feedback comments', { exact: true }),
    ).toHaveValue('Unsaved by Sage 🐍');
    await expect(
      teacher.getByRole('button', { name: 'Save feedback draft', exact: true }),
    ).toBeDisabled();
    await teacher
      .getByRole('button', { name: 'Reload saved feedback draft', exact: true })
      .click();
    await expect(
      teacher.getByLabel('Feedback comments', { exact: true }),
    ).toHaveValue('Saved by Mira');
    await teacher
      .getByLabel('Feedback comments', { exact: true })
      .fill('Kept after role loss');
    await write(
      f.learner,
      `/api/v1/projects/${f.projectId}/grants/${actor.id}/`,
      { role: 'viewer' },
      await security(f.learner),
      204,
      'put',
    );
    await write(
      page,
      `/api/v1/workspaces/${f.workspaceId}/members/${actor.id}/`,
      { role: 'learner' },
      f.security,
      204,
      'patch',
    );
    const denied = teacher.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `${f.feedbackPath}draft/` &&
        r.request().method() === 'PATCH',
    );
    await teacher
      .getByRole('button', { name: 'Save feedback draft', exact: true })
      .click();
    expect((await denied).status()).toBe(403);
    await expect(
      teacher.getByLabel('Feedback comments', { exact: true }),
    ).toHaveValue('Kept after role loss');
    expect((await get<Draft>(page, `${f.feedbackPath}draft/`)).comments).toBe(
      'Saved by Mira',
    );
    expect((await teacher.request.get(f.feedbackPath)).status()).toBe(404);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await other.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});

test('lost feedback reply retains the original publication after newer edits, correction and archive', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await submitted(page, browser, browserName);
  let primary: unknown;
  try {
    await page.goto(f.url);
    await review(page);
    await saveDraft(
      page,
      f.feedbackPath,
      'Original saved feedback',
      'reviewed',
    );
    const bodies: unknown[] = [];
    let lost = false;
    let interceptedPost: import('@playwright/test').Request | null = null;
    let resolveLoss!: () => void, rejectLoss!: (error: unknown) => void;
    const didLoseReply = new Promise<void>((resolve, reject) => {
      resolveLoss = resolve;
      rejectLoss = reject;
    });
    await page.route(`**${f.feedbackPath}publications/`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON() as unknown);
      if (!lost) {
        lost = true;
        interceptedPost = route.request();
        try {
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          await response.json();
          await route.abort('failed');
          resolveLoss();
        } catch (error) {
          rejectLoss(error);
          await route.abort('failed').catch(() => undefined);
        }
        return;
      }
      return route.continue();
    });
    const failedPost = page.waitForEvent('requestfailed', {
      predicate: (request) => request === interceptedPost,
    });
    await Promise.all([
      page
        .getByRole('button', { name: 'Publish saved feedback', exact: true })
        .click(),
      didLoseReply,
      failedPost,
    ]);
    await expect(
      page.getByRole('button', {
        name: 'Retry original feedback publication',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Reload saved feedback draft', exact: true })
      .click();
    const changed = await saveDraft(
      page,
      f.feedbackPath,
      'Newer saved correction',
      'needs_changes',
    );
    const later = await write<Publication>(
      page,
      `${f.feedbackPath}publications/`,
      { expected_revision: changed.revision, client_request_id: randomUUID() },
      f.security,
    );
    expect(later.number).toBe(2);
    const assignmentDraft = await get<{ revision: number }>(
      page,
      `/api/v1/assignments/${f.assignmentId}/draft/`,
    );
    await write(
      page,
      `/api/v1/assignments/${f.assignmentId}/`,
      { expected_revision: assignmentDraft.revision, archived: true },
      f.security,
      200,
      'patch',
    );
    const first = await publish(
      page,
      f.feedbackPath,
      'Retry original feedback publication',
      200,
    );
    expect(first.number).toBe(1);
    expect(first.comments).toBe('Original saved feedback');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(
      (await get<{ latest: Publication }>(f.learner, f.feedbackPath)).latest.id,
    ).toBe(later.id);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});

test('a teacher frozen as a participant reads published feedback but never requests their own review draft', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await submitted(page, browser, browserName);
  let primary: unknown;
  try {
    await page.goto(f.url);
    await review(page);
    await saveDraft(
      page,
      f.feedbackPath,
      'Private instructor notes',
      'reviewed',
    );
    const actor = await get<{ id: string }>(f.learner, '/api/v1/me/');
    await write(
      page,
      `/api/v1/workspaces/${f.workspaceId}/members/${actor.id}/`,
      { role: 'instructor' },
      f.security,
      204,
      'patch',
    );
    let draftRequests = 0;
    f.learner.on('request', (r) => {
      if (new URL(r.url()).pathname === `${f.feedbackPath}draft/`)
        draftRequests++;
    });
    await sourceOnly(f.learner, f.url, 'participant', async () => {
      await expect(
        f.learner.getByText(
          'No feedback has been published for this submission.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        f.learner
          .locator('summary')
          .filter({ hasText: /^Review this submission$/ }),
      ).toHaveCount(0);
      expect(draftRequests).toBe(0);
      await expect(
        f.learner.getByText('Private instructor notes', { exact: true }),
      ).toHaveCount(0);
    });
    expect(
      (await f.learner.request.get(`${f.feedbackPath}draft/`)).status(),
    ).toBe(403);
    await publish(page, f.feedbackPath);
    await f.learner
      .getByRole('button', { name: 'Refresh published feedback', exact: true })
      .click();
    await expect(
      f.learner.getByRole('article', {
        name: 'Published feedback 1',
        exact: true,
      }),
    ).toContainText('Private instructor notes');
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});

test('an invalid direct feedback receipt stays unconfirmed even when latest matches until the original retry is verified', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await submitted(page, browser, browserName);
  let primary: unknown;
  try {
    await page.goto(f.url);
    await review(page);
    await saveDraft(page, f.feedbackPath, 'Exact saved review', 'reviewed');
    let corrupt = true;
    const bodies: unknown[] = [];
    let interceptedPost: import('@playwright/test').Request | null = null;
    let resolveCorruption!: () => void,
      rejectCorruption!: (error: unknown) => void;
    const didCorruptReply = new Promise<void>((resolve, reject) => {
      resolveCorruption = resolve;
      rejectCorruption = reject;
    });
    await page.route(`**${f.feedbackPath}publications/`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON() as unknown);
      if (corrupt) {
        corrupt = false;
        interceptedPost = route.request();
        try {
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          const value = (await response.json()) as Publication;
          await route.fulfill({
            response,
            json: { ...value, content_sha256: '0'.repeat(64) },
          });
          resolveCorruption();
        } catch (error) {
          rejectCorruption(error);
          await route.abort('failed').catch(() => undefined);
        }
        return;
      }
      return route.continue();
    });
    const finishedPost = page.waitForEvent('requestfinished', {
      predicate: (request) => request === interceptedPost,
    });
    await Promise.all([
      page
        .getByRole('button', { name: 'Publish saved feedback', exact: true })
        .click(),
      didCorruptReply,
      finishedPost,
    ]);
    await expect(
      page.getByRole('button', {
        name: 'Retry original feedback publication',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Refresh published feedback', exact: true })
      .click();
    await expect(
      page.getByRole('article', { name: 'Published feedback 1', exact: true }),
    ).toContainText('Exact saved review');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Feedback publication 1 confirmed.' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: 'Retry original feedback publication',
        exact: true,
      }),
    ).toBeEnabled();
    expect(bodies).toHaveLength(1);
    await publish(
      page,
      f.feedbackPath,
      'Retry original feedback publication',
      200,
    );
    expect(bodies[1]).toEqual(bodies[0]);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (!primary) throw error;
    });
  }
});
