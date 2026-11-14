import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { components } from '../../../packages/api-client/src/schema.d.ts';
import { register } from './helpers.ts';
import {
  practiceFixture,
  readySource,
  runChecks,
  pane,
  replaceSource,
  saved,
  exported,
  LEARNER_SOURCE,
  get,
  disclosure,
} from './practice-fixture.ts';

type Detail = components['schemas']['SubmissionDetail'];
type Body = components['schemas']['SubmissionCreateRequest'];
type Security = { Origin: string; 'X-CSRFToken': string };
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
  method: 'post' | 'patch' | 'put' | 'delete' = 'post',
): Promise<T> {
  const response = await page.request[method](path, {
    headers,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(status);
  return (status === 204 ? undefined : await response.json()) as T;
}
const collection = (assignment: string, work: string) =>
  `/api/v1/assignments/${assignment}/works/${work}/submissions/`;
async function submitPanel(page: Page) {
  await pane(page, 'Task');
  await disclosure(page, 'Submit code');
}
async function choose(page: Page, kind: 'current' | 'run') {
  await submitPanel(page);
  const action = page.getByRole('button', {
    name:
      kind === 'current' ? 'Choose current code' : 'Choose code from this run',
    exact: true,
  });
  if (kind === 'run') await action.press('Enter');
  else await action.click();
  await expect(
    page.getByRole('button', { name: 'Submit chosen code', exact: true }),
  ).toBeEnabled();
}
async function submit(page: Page, path: string, status = 201): Promise<Detail> {
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === path &&
      value.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Submit chosen code', exact: true })
    .click();
  const value = await response;
  expect(value.status()).toBe(status);
  const detail = (await value.json()) as Detail;
  await expect(
    page.getByRole('status').filter({
      hasText: `Submission ${detail.assignment_submission_number} confirmed.`,
    }),
  ).toBeVisible();
  return detail;
}
async function archive(page: Page, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  return JSON.parse(await readFile(path!, 'utf8')) as {
    files: { path: string; source: string }[];
  };
}
async function staticSource(page: Page, assignmentId: string, detail: Detail) {
  const traffic: { source: number; work: number; sockets: number } = {
    source: 0,
    work: 0,
    sockets: 0,
  };
  const request = (value: import('@playwright/test').Request) => {
    const path = new URL(value.url()).pathname;
    if (path.startsWith('/api/v1/projects/')) traffic.source++;
    if (/^\/api\/v1\/assignments\/[^/]+\/works\//.test(path)) traffic.work++;
  };
  const socket = () => {
    traffic.sockets++;
  };
  page.on('request', request);
  page.on('websocket', socket);
  try {
    await page.goto(`/assignments/${assignmentId}/submissions/${detail.id}`);
    await expect(
      page.getByRole('heading', {
        name: `Submission ${detail.assignment_submission_number}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('.editor-workbench')).toHaveCount(0);
    await expect(
      page.locator('iframe[title="Isolated Python runtime"]'),
    ).toHaveCount(0);
    const frozen = await archive(page, 'Export submission source');
    expect(frozen.files).toEqual(
      detail.manifest.files.map(({ path, source }) => ({ path, source })),
    );
    expect(traffic).toEqual({ source: 0, work: 0, sockets: 0 });
  } finally {
    page.off('request', request);
    page.off('websocket', socket);
  }
}

test('submitting code from a checked run freezes H after peer H2 and opens a private source-only receipt', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  try {
    await readySource(f.learner);
    await runChecks(f.learner);
    await expect(f.learner.locator('.execution-status')).toHaveText(
      'Checks finished',
      { timeout: 40000 },
    );
    await f.grantTeacherSource();
    const h2 = '\uFEFFdef answer():\n    return 99\n';
    await replaceSource(page, 'learner.py', h2);
    await saved(f.learner);
    expect(
      (await exported(f.learner)).files.find(
        (file) => file.path === 'learner.py',
      )?.source,
    ).toBe(h2);
    await choose(f.learner, 'run');
    await expect(
      f.learner.getByText(
        'Chosen code includes an untrusted visible-check result: succeeded.',
        { exact: true },
      ),
    ).toBeVisible();
    await f.learner
      .getByRole('button', { name: 'Run code', exact: true })
      .click();
    await expect(f.learner.locator('.execution-status')).toHaveText(
      'Run finished',
      { timeout: 40000 },
    );
    await submitPanel(f.learner);
    await expect(
      f.learner.getByText(
        'Chosen code includes an untrusted visible-check result: succeeded.',
        { exact: true },
      ),
    ).toBeVisible();
    await disclosure(f.learner, 'Preview chosen code');
    const chosen = await archive(f.learner, 'Export chosen source');
    expect(
      chosen.files.find((file) => file.path === 'learner.py')?.source,
    ).toBe(LEARNER_SOURCE);
    const receipt = await submit(
      f.learner,
      collection(f.assignmentId, f.workId),
    );
    expect(receipt.practice?.kind).toBe('visible_checks');
    expect(
      receipt.manifest.files.find((file) => file.path === 'learner.py')?.source,
    ).toBe(LEARNER_SOURCE);
    expect(receipt.source_manifest_sha256).not.toBe(
      receipt.artifact_manifest_sha256,
    );
    await f.learner
      .getByRole('button', { name: 'Choose different code', exact: true })
      .click();
    await choose(f.learner, 'current');
    await disclosure(f.learner, 'Preview chosen code');
    expect(
      (await archive(f.learner, 'Export chosen source')).files.find(
        (file) => file.path === 'learner.py',
      )?.source,
    ).toBe(h2);
    await f.learner.setViewportSize({ width: 390, height: 844 });
    await f.learner
      .locator('html')
      .evaluate((element) => element.setAttribute('data-theme', 'dark'));
    const confirm = f.learner.getByRole('button', {
      name: 'Submit chosen code',
      exact: true,
    });
    await confirm.focus();
    const allControls =
      browserName === 'webkit' && process.platform === 'darwin';
    await confirm.press(allControls ? 'Alt+Tab' : 'Tab');
    await f.learner.keyboard.press(allControls ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(confirm).toBeFocused();
    const focus = await confirm.evaluate((element) => {
      const style = getComputedStyle(element),
        box = element.getBoundingClientRect();
      return {
        outline: style.outlineWidth,
        width: box.width,
        height: box.height,
        unobstructed:
          document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest('button') === element,
      };
    });
    expect(focus.outline).toBe('2px');
    expect(focus.width).toBeGreaterThanOrEqual(44);
    expect(focus.height).toBeGreaterThanOrEqual(44);
    expect(focus.unobstructed).toBe(true);
    expect(
      await f.learner.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await f.learner.screenshot({
      path: test.info().outputPath('submission-390-dark-choice.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const current = await submit(
      f.learner,
      collection(f.assignmentId, f.workId),
    );
    expect(current.practice).toBeNull();
    expect(
      current.manifest.files.find((file) => file.path === 'learner.py')?.source,
    ).toBe(h2);
    expect(current.source_manifest_sha256).not.toBe(
      receipt.source_manifest_sha256,
    );
    await staticSource(f.learner, f.assignmentId, receipt);
    await staticSource(page, f.assignmentId, receipt);
    for (const view of [
      { width: 1440, height: 900, theme: 'light' },
      { width: 390, height: 844, theme: 'light' },
      { width: 320, height: 800, theme: 'dark' },
    ]) {
      await page.setViewportSize(view);
      await page
        .locator('html')
        .evaluate(
          (element, theme) => element.setAttribute('data-theme', theme),
          view.theme,
        );
      await page.evaluate(async () => {
        await document.fonts.ready;
        window.scrollTo(0, 0);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`submission-${view.width}-${view.theme}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  } finally {
    await f.close();
  }
});

test('current code attaches no run claim and a lost committed reply retains the same request after source and read checks fail', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  const learner = f.learner;
  try {
    await readySource(learner);
    await f.grantTeacherSource();
    await choose(learner, 'current');
    await expect(
      learner.getByText(
        'Chosen code has no confirmed runtime result attached.',
        { exact: true },
      ),
    ).toBeVisible();
    const requests: Body[] = [];
    let committed!: Detail;
    let resolveCommit!: () => void;
    const didCommit = new Promise<void>((resolve) => {
      resolveCommit = resolve;
    });
    const path = collection(f.assignmentId, f.workId);
    await learner.route(`**${path}`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      requests.push(route.request().postDataJSON() as Body);
      if (requests.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        committed = (await response.json()) as Detail;
        await route.abort('failed');
        resolveCommit();
      } else await route.continue();
    });
    await learner
      .getByRole('button', { name: 'Submit chosen code', exact: true })
      .click();
    await didCommit;
    await expect(
      learner.getByRole('button', {
        name: 'Retry same submission',
        exact: true,
      }),
    ).toBeEnabled();
    expect(requests[0]!.practice).toBeNull();
    const teacher = await get<{ id: string }>(page, '/api/v1/me/');
    const actor = await get<{ id: string }>(learner, '/api/v1/me/');
    const learnerSecurity = await security(learner),
      teacherSecurity = await security(page);
    const project = await get<components['schemas']['ProjectOutput']>(
      learner,
      `/api/v1/projects/${f.projectId}/`,
    );
    await write(
      learner,
      `/api/v1/projects/${f.projectId}/ownership/`,
      { new_owner_id: teacher.id, expected_version: project.metadata_version },
      learnerSecurity,
      200,
    );
    await write(
      page,
      `/api/v1/projects/${f.projectId}/grants/${actor.id}/`,
      undefined,
      teacherSecurity,
      204,
      'delete',
    );
    for (const failedPath of [
      `/api/v1/assignments/${f.assignmentId}/works/${f.workId}/`,
      `/api/v1/assignments/${f.assignmentId}/versions/${f.version.id}/`,
    ])
      await learner.route(`**${failedPath}`, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Unavailable' }),
        }),
      );
    await learner
      .getByRole('button', { name: 'Refresh work access', exact: true })
      .click();
    await expect(
      learner.getByText(
        'Work access could not be checked. Your open code remains available for export; editing is paused until access is checked again.',
        { exact: true },
      ),
    ).toBeVisible();
    await submitPanel(learner);
    await disclosure(learner, 'Preview chosen code');
    expect((await archive(learner, 'Export chosen source')).files).toEqual(
      committed.manifest.files.map(({ path, source }) => ({ path, source })),
    );
    const retry = learner.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === path &&
        value.request().method() === 'POST',
    );
    await learner
      .getByRole('button', { name: 'Retry same submission', exact: true })
      .click();
    expect((await retry).status()).toBe(200);
    await expect(
      learner
        .getByRole('status')
        .filter({ hasText: 'Submission 1 confirmed.' }),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await staticSource(learner, f.assignmentId, committed);
    expect(
      (await learner.request.get(`/api/v1/projects/${f.projectId}/`)).status(),
    ).toBe(404);
  } finally {
    await f.close();
  }
});

test('an eligible team viewer can submit exact shared code without an editor grant', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(180000);
  const f = await practiceFixture(page, browser, browserName);
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const sage = await context.newPage(),
      email = `sub-team-${browserName}-${randomUUID().slice(0, 8)}@example.test`;
    await register(sage, email, 'Sage');
    const teacherSecurity = await security(page),
      riverSecurity = await security(f.learner),
      sageSecurity = await security(sage);
    const invite = await write<{ invite_url: string }>(
      page,
      `/api/v1/workspaces/${f.version.workspace_id}/invitations/`,
      { recipient_email: email, role: 'learner', expires_hours: 72 },
      teacherSecurity,
    );
    await sage.goto(invite.invite_url);
    await sage
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(sage).toHaveURL(
      new RegExp(`/workspaces/${f.version.workspace_id}$`),
    );
    const sageId = (await get<{ id: string }>(sage, '/api/v1/me/')).id,
      riverId = (await get<{ id: string }>(f.learner, '/api/v1/me/')).id;
    const assignment = await write<components['schemas']['AssignmentSummary']>(
      page,
      `/api/v1/workspaces/${f.version.workspace_id}/assignments/`,
      { title: 'Shared submission' },
      teacherSecurity,
    );
    const base = `/api/v1/assignments/${assignment.id}/`;
    const draft = await write<components['schemas']['AssignmentDraft']>(
      page,
      `${base}draft/`,
      {
        expected_revision: 1,
        instructions: 'Submit your shared code.',
        starter_revision_id: f.version.starter.revision_id,
        submission_mode: 'team',
        max_team_size: 2,
        max_attempts: 4,
      },
      teacherSecurity,
      200,
      'patch',
    );
    const version = await write<
      components['schemas']['AssignmentVersionSummary']
    >(
      page,
      `${base}versions/`,
      { expected_revision: draft.revision, client_request_id: randomUUID() },
      teacherSecurity,
    );
    let team = await write<components['schemas']['Team']>(
      page,
      `${base}teams/`,
      { name: 'River and Sage' },
      teacherSecurity,
    );
    const actors = [
      { page: f.learner, id: riverId, headers: riverSecurity },
      { page: sage, id: sageId, headers: sageSecurity },
    ];
    for (const actor of actors) {
      const offer = await write<components['schemas']['Participation']>(
        page,
        `${base}participations/`,
        { recipient_id: actor.id },
        teacherSecurity,
      );
      const accepted = await write<components['schemas']['Participation']>(
        actor.page,
        `${base}participation/accept/`,
        { expected_revision: offer.revision },
        actor.headers,
        200,
      );
      team = await write<components['schemas']['Team']>(
        page,
        `${base}teams/${team.id}/members/`,
        {
          participation_id: accepted.id,
          expected_team_revision: team.revision,
          expected_participation_revision: accepted.revision,
        },
        teacherSecurity,
        200,
      );
    }
    for (const actor of actors) {
      const own = await get<components['schemas']['Participation']>(
        actor.page,
        `${base}participation/`,
      );
      await write(
        actor.page,
        `${base}participation/team-consent/`,
        {
          expected_revision: own.revision,
          team_id: team.id,
          roster_revision: team.roster_revision,
        },
        actor.headers,
        200,
      );
    }
    team = await get<components['schemas']['Team']>(
      page,
      `${base}teams/${team.id}/`,
    );
    team = await write<components['schemas']['Team']>(
      page,
      `${base}teams/${team.id}/approval/`,
      {
        expected_revision: team.revision,
        roster_revision: team.roster_revision,
      },
      teacherSecurity,
      200,
    );
    const own = await get<components['schemas']['Participation']>(
      f.learner,
      `${base}participation/`,
    );
    const work = await write<components['schemas']['Work']>(
      f.learner,
      `${base}works/`,
      {
        client_request_id: randomUUID(),
        assignment_version_id: version.id,
        expected_participation_revision: own.revision,
        expected_team_roster_revision: team.roster_revision,
        project_name: 'Shared code to submit',
        sharing: 'approved_team_editors',
      },
      riverSecurity,
    );
    expect(work.project).not.toBeNull();
    await write(
      f.learner,
      `/api/v1/projects/${work.project!.id}/grants/${sageId}/`,
      { role: 'viewer' },
      riverSecurity,
      204,
      'put',
    );
    await sage.goto(`/assignments/${assignment.id}/works/${work.id}`);
    await expect(
      sage.getByLabel('Python source for main.py', { exact: true }),
    ).toBeVisible();
    await expect(
      sage.getByLabel('Python source for main.py', { exact: true }),
    ).not.toBeEditable();
    await expect(sage.locator('.collaboration-status')).toContainText(
      'Read only',
      { timeout: 20000 },
    );
    await choose(sage, 'current');
    const detail = await submit(sage, collection(assignment.id, work.id));
    expect(detail.author.id).toBe(sageId);
    expect(detail.participants.map((person) => person.id).sort()).toEqual(
      [riverId, sageId].sort(),
    );
    expect(detail.practice).toBeNull();
    await staticSource(sage, assignment.id, detail);
    const response = await sage.request.patch(
      `/api/v1/projects/${work.project!.id}/`,
      {
        headers: sageSecurity,
        data: {
          name: 'Denied edit',
          expected_version: detail.manifest.metadata_version,
        },
      },
    );
    expect(response.status()).toBe(403);
  } finally {
    await context.close();
    await f.close();
  }
});

test('a structural conflict keeps the exact chosen export until an explicit new source choice', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const f = await practiceFixture(page, browser, browserName);
  const learner = f.learner;
  try {
    await readySource(learner);
    await choose(learner, 'current');
    await disclosure(learner, 'Preview chosen code');
    const before = await archive(learner, 'Export chosen source');
    const project = await get<components['schemas']['ProjectOutput']>(
      learner,
      `/api/v1/projects/${f.projectId}/`,
    );
    const files = await get<{ items: { id: string; path: string }[] }>(
      learner,
      `/api/v1/projects/${f.projectId}/files/`,
    );
    const helper = files.items.find((file) => file.path === 'learner.py')!;
    await write(
      learner,
      `/api/v1/projects/${f.projectId}/files/${helper.id}/`,
      { path: 'solution.py', expected_version: project.metadata_version },
      await security(learner),
      200,
      'patch',
    );
    const path = collection(f.assignmentId, f.workId),
      response = learner.waitForResponse(
        (value) =>
          new URL(value.url()).pathname === path &&
          value.request().method() === 'POST',
      );
    await learner
      .getByRole('button', { name: 'Submit chosen code', exact: true })
      .click();
    const rejected = await response;
    expect(rejected.status()).toBe(409);
    expect(((await rejected.json()) as { code: string }).code).toBe(
      'submission_structure_changed',
    );
    expect((await archive(learner, 'Export chosen source')).files).toEqual(
      before.files,
    );
    await learner
      .getByRole('button', { name: 'Refresh work access', exact: true })
      .click();
    await saved(learner);
    await submitPanel(learner);
    await learner
      .getByRole('button', { name: 'Choose different code', exact: true })
      .click();
    await choose(learner, 'current');
    const detail = await submit(learner, path);
    expect(detail.practice).toBeNull();
    expect(
      detail.manifest.files.some((file) => file.path === 'solution.py'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('old version A remains submittable after B while source-only members cannot read or submit its private artifact', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  const learner = f.learner;
  const outsider = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const teacherSecurity = await security(page);
    const draft = await get<components['schemas']['AssignmentDraft']>(
      page,
      `/api/v1/assignments/${f.assignmentId}/draft/`,
    );
    const changed = await write<components['schemas']['AssignmentDraft']>(
      page,
      `/api/v1/assignments/${f.assignmentId}/draft/`,
      { expected_revision: draft.revision, title: 'Published B' },
      teacherSecurity,
      200,
      'patch',
    );
    await write(
      page,
      `/api/v1/assignments/${f.assignmentId}/versions/`,
      { expected_revision: changed.revision, client_request_id: randomUUID() },
      teacherSecurity,
    );
    await readySource(learner);
    await choose(learner, 'current');
    const detail = await submit(learner, collection(f.assignmentId, f.workId));
    expect(detail.assignment_version_id).toBe(f.version.id);
    expect(detail.published_version.number).toBe(1);
    const other = await outsider.newPage(),
      email = `sub-view-${browserName}-${randomUUID().slice(0, 8)}@example.test`;
    await register(other, email, 'Source viewer');
    const invite = await write<{ invite_url: string }>(
      page,
      `/api/v1/workspaces/${f.version.workspace_id}/invitations/`,
      { recipient_email: email, role: 'learner', expires_hours: 72 },
      teacherSecurity,
    );
    await other.goto(invite.invite_url);
    await other
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(other).toHaveURL(
      new RegExp(`/workspaces/${f.version.workspace_id}$`),
    );
    const otherId = (await get<{ id: string }>(other, '/api/v1/me/')).id;
    await write(
      learner,
      `/api/v1/projects/${f.projectId}/grants/${otherId}/`,
      { role: 'viewer' },
      await security(learner),
      204,
      'put',
    );
    expect(
      (await other.request.get(`/api/v1/projects/${f.projectId}/`)).status(),
    ).toBe(200);
    expect(
      (await other.request.get(collection(f.assignmentId, f.workId))).status(),
    ).toBe(404);
    expect(
      (
        await other.request.get(
          `/api/v1/assignments/${f.assignmentId}/submissions/${detail.id}/`,
        )
      ).status(),
    ).toBe(404);
    const denied = await other.request.post(
      collection(f.assignmentId, f.workId),
      {
        headers: await security(other),
        data: {
          client_request_id: randomUUID(),
          manifest: detail.manifest,
          practice: null,
        },
      },
    );
    expect(denied.status()).toBe(404);
    await other.goto(`/assignments/${f.assignmentId}/submissions/${detail.id}`);
    await expect(
      other.getByRole('heading', {
        name: 'Submission unavailable',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      other.getByLabel(`Frozen source: ${detail.published_version.title}`, {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.goto(`/assignments/${f.assignmentId}#submissions`);
    await expect(
      page
        .getByRole('region', { name: 'Assignment submissions', exact: true })
        .getByRole('link', { name: 'View submitted code', exact: true }),
    ).toBeVisible();
  } finally {
    await outsider.close();
    await f.close();
  }
});
