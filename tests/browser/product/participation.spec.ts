import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { components } from '../../../packages/api-client/src/schema.d.ts';
import { finishedRun, register } from './helpers.ts';

type Assignment = components['schemas']['AssignmentSummary'];
type Version = components['schemas']['AssignmentVersionDetail'];
type Participation = components['schemas']['Participation'];
type Team = components['schemas']['Team'];
type Work = components['schemas']['Work'];
type WorkRequest = components['schemas']['WorkCreateRequest'];
type Project = components['schemas']['ProjectOutput'];
type Security = { Origin: string; 'X-CSRFToken': string };
type PageOf<T> = { items: T[]; count: number };
interface Actor {
  page: Page;
  context: BrowserContext;
  id: string;
  name: string;
  security: Security;
}
interface FileIdentity {
  id: string;
  document_id: string;
  generation: number;
  path: string;
}

async function security(page: Page): Promise<Security> {
  const response = await page.request.get('/api/v1/csrf/');
  expect(response.status()).toBe(200);
  return {
    Origin: new URL(page.url()).origin,
    'X-CSRFToken': ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}
async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `GET ${new URL(path, page.url()).pathname}`).toBe(
    200,
  );
  return response.json() as Promise<T>;
}
async function post<T>(
  page: Page,
  path: string,
  data: unknown,
  headers: Security,
): Promise<T> {
  const response = await page.request.post(path, { headers, data });
  expect(response.status(), `POST ${new URL(path, page.url()).pathname}`).toBe(
    201,
  );
  return response.json() as Promise<T>;
}
async function fixture(
  page: Page,
  browser: Browser,
  browserName: string,
  mode: 'individual' | 'team',
  names: readonly string[],
) {
  const stamp = `${browserName}-${randomUUID().slice(0, 8)}`;
  await register(page, `take-owner-${stamp}@example.test`, 'Mira');
  const ownerSecurity = await security(page);
  const workspace = await post<{ id: string }>(
    page,
    '/api/v1/workspaces/',
    { name: 'Participation studio' },
    ownerSecurity,
  );
  const project = await post<Project>(
    page,
    `/api/v1/workspaces/${workspace.id}/projects/`,
    { name: 'Private published starter' },
    ownerSecurity,
  );
  const files = await get<PageOf<FileIdentity>>(
    page,
    `/api/v1/projects/${project.id}/files/`,
  );
  const entrypoint = files.items.find(
    (file) => file.id === project.entrypoint_file_id,
  )!;
  const baseline = await get<{ initial_source: string }>(
    page,
    `/api/v1/projects/${project.id}/files/${entrypoint.id}/`,
  );
  // Unrelated setup uses the actual authorized capture API. Its cold-load path
  // initializes only the server document from the immutable verified baseline.
  const revision = await post<components['schemas']['RevisionOutput']>(
    page,
    `/api/v1/projects/${project.id}/revisions/`,
    {
      name: 'Published starter',
      expected_version: project.metadata_version,
      client_request_id: randomUUID(),
    },
    ownerSecurity,
  );
  const assignment = await post<Assignment>(
    page,
    `/api/v1/workspaces/${workspace.id}/assignments/`,
    { title: 'Pinned task A' },
    ownerSecurity,
  );
  const patch = await page.request.patch(
    `/api/v1/assignments/${assignment.id}/draft/`,
    {
      headers: ownerSecurity,
      data: {
        expected_revision: 1,
        instructions: 'Instructions pinned to A. Keep the exact source.',
        starter_revision_id: revision.id,
        submission_mode: mode,
        max_team_size: mode === 'team' ? 2 : 1,
        hints: [
          {
            id: randomUUID(),
            title: 'Read the source',
            body: 'This hint belongs to A.',
          },
        ],
      },
    },
  );
  expect(patch.status()).toBe(200);
  const draft = (await patch.json()) as { revision: number };
  const version = await post<Version>(
    page,
    `/api/v1/assignments/${assignment.id}/versions/`,
    { expected_revision: draft.revision, client_request_id: randomUUID() },
    ownerSecurity,
  );
  const actors: Actor[] = [];
  try {
    for (const [index, name] of names.entries()) {
      const context = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        ignoreHTTPSErrors: true,
      });
      try {
        const learner = await context.newPage();
        const email = `take-${index}-${stamp}@example.test`;
        await register(learner, email, name);
        const invite = await post<{ invite_url: string }>(
          page,
          `/api/v1/workspaces/${workspace.id}/invitations/`,
          { recipient_email: email, role: 'learner', expires_hours: 72 },
          ownerSecurity,
        );
        await learner.goto(invite.invite_url);
        await learner
          .getByRole('button', { name: 'Join workspace', exact: true })
          .click();
        await expect(learner).toHaveURL(
          new RegExp(`/workspaces/${workspace.id}$`),
        );
        const identity = await get<{ id: string }>(learner, '/api/v1/me/');
        actors.push({
          page: learner,
          context,
          name,
          id: identity.id,
          security: await security(learner),
        });
      } catch (error) {
        await context.close();
        throw error;
      }
    }
    return {
      workspaceId: workspace.id,
      starterProjectId: project.id,
      assignmentId: assignment.id,
      version,
      original: baseline.initial_source,
      ownerSecurity,
      actors,
      close: () => Promise.all(actors.map((actor) => actor.context.close())),
    };
  } catch (error) {
    await Promise.all(actors.map((actor) => actor.context.close()));
    throw error;
  }
}

const taskNames = {
  'my-work': 'My work',
  'teaching-roster': 'Teaching roster',
  'teaching-teams': 'Teams',
  overview: 'Overview',
} as const;
async function task(
  page: Page,
  assignmentId: string,
  section: keyof typeof taskNames,
) {
  if (new URL(page.url()).pathname !== `/assignments/${assignmentId}`)
    await page.goto(`/assignments/${assignmentId}#${section}`);
  const link = page
    .getByRole('navigation', { name: 'Assignment sections', exact: true })
    .getByRole('link', { name: taskNames[section], exact: true });
  await expect(link).toBeVisible();
  if ((await link.getAttribute('aria-current')) !== 'page') await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`#${section}`)).toBeVisible();
}
async function disclosure(page: Page, title: string) {
  const summary = page
    .locator('summary')
    .filter({ hasText: new RegExp(`^${title}$`) });
  await expect(summary).toBeVisible();
  if (
    !(await summary.evaluate(
      (element) => (element.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
  await expect(summary.locator('..')).toHaveJSProperty('open', true);
}
async function offer(page: Page, assignmentId: string, actor: Actor) {
  await task(page, assignmentId, 'teaching-roster');
  await disclosure(page, 'Offer participation');
  await page
    .getByLabel('Participation recipient', { exact: true })
    .selectOption(actor.id);
  await page
    .getByRole('button', { name: 'Review participation offer', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Offer participation?',
    exact: true,
  });
  await expect(dialog).toContainText(actor.name);
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === 'POST' &&
      new URL(value.url()).pathname ===
        `/api/v1/assignments/${assignmentId}/participations/`,
  );
  await dialog
    .getByRole('button', { name: 'Send participation offer', exact: true })
    .click();
  expect((await response).status()).toBe(201);
  const record = page.getByRole('region', {
    name: `Participation: ${actor.name}`,
    exact: true,
  });
  await expect(record).toContainText('Participation: Invited');
}
async function accept(actor: Actor, assignmentId: string) {
  await task(actor.page, assignmentId, 'my-work');
  await actor.page
    .getByRole('button', { name: 'Accept participation', exact: true })
    .click();
  const dialog = actor.page.getByRole('dialog', {
    name: 'Accept this participation offer?',
    exact: true,
  });
  await expect(dialog).toContainText(
    'does not consent to any team roster or share an existing source project',
  );
  await dialog
    .getByRole('button', {
      name: 'Confirm participation acceptance',
      exact: true,
    })
    .click();
  await expect(
    actor.page
      .getByRole('region', { name: 'My participation', exact: true })
      .locator('.badge'),
  ).toHaveText('Accepted');
  return get<Participation>(
    actor.page,
    `/api/v1/assignments/${assignmentId}/participation/`,
  );
}
async function refreshMine(actor: Actor) {
  const button = actor.page.getByRole('button', {
    name: 'Refresh my work',
    exact: true,
  });
  await button.click();
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
}
async function consent(
  actor: Actor,
  assignmentId: string,
  team: Team,
  names: readonly string[],
) {
  await task(actor.page, assignmentId, 'my-work');
  await refreshMine(actor);
  await actor.page
    .getByRole('button', { name: 'Review team consent', exact: true })
    .click();
  const dialog = actor.page.getByRole('dialog', {
    name: 'Consent to this exact team roster?',
    exact: true,
  });
  const list = dialog.locator('.learning-roster');
  await expect(list.getByRole('listitem')).toHaveCount(names.length);
  for (const name of names) await expect(list).toContainText(name);
  await expect(list).toContainText(`${actor.name} (you)`);
  await expect(dialog).toContainText(`Roster revision ${team.roster_revision}`);
  await dialog
    .getByRole('button', { name: 'Consent to this exact roster', exact: true })
    .click();
  await expect(
    actor.page.getByText('Your consent covers this exact roster revision.', {
      exact: false,
    }),
  ).toBeVisible();
}
async function reviewWork(page: Page, name: string, team: boolean) {
  await page.getByLabel('New work project name', { exact: true }).fill(name);
  await page
    .getByRole('button', {
      name: team
        ? 'Review team work creation'
        : 'Review individual work creation',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: team ? 'Create team work?' : 'Start individual work?',
    exact: true,
  });
  await expect(dialog).toContainText(name);
  return dialog;
}
async function createWork(
  actor: Actor,
  assignmentId: string,
  name: string,
  team: boolean,
) {
  await test.step('Open My work and refresh current eligibility', async () => {
    await task(actor.page, assignmentId, 'my-work');
    await refreshMine(actor);
  });
  const dialog = await test.step('Review the exact work creation', () =>
    reviewWork(actor.page, name, team));
  if (team) {
    await expect(dialog).toContainText(
      'This does not share any existing project.',
    );
    await expect(
      dialog
        .locator('.learning-roster')
        .getByRole('listitem')
        .filter({ hasText: actor.name }),
    ).toContainText('Project owner');
  } else await expect(dialog).toContainText('new private project');
  const receipt =
    await test.step('Confirm work creation and receive its actual POST reply', async () => {
      // Observe both operations together, so a failed click cannot leave an
      // unhandled response waiter to obscure the original action failure.
      const [response] = await Promise.all([
        actor.page.waitForResponse(
          (value) =>
            value.request().method() === 'POST' &&
            new URL(value.url()).pathname ===
              `/api/v1/assignments/${assignmentId}/works/`,
        ),
        dialog
          .getByRole('button', {
            name: team ? 'Create team work' : 'Start individual work',
            exact: true,
          })
          .click(),
      ]);
      return response;
    });
  expect(receipt.status()).toBe(201);
  const work = (await receipt.json()) as Work;
  const confirmation = actor.page
    .getByRole('status')
    .filter({ hasText: 'Work confirmed.' });
  await expect(
    confirmation.getByRole('link', { name: 'Continue work', exact: true }),
  ).toBeVisible();
  await test.step('Continue to the confirmed work route', async () => {
    await confirmation
      .getByRole('link', { name: 'Continue work', exact: true })
      .click();
    await expect(actor.page).toHaveURL(
      new RegExp(`/assignments/${assignmentId}/works/${work.id}(?:#.*)?$`),
    );
  });
  return work;
}
const editor = (page: Page) =>
  page.getByRole('textbox', { name: 'Python source for main.py', exact: true });
const saved = (page: Page) =>
  expect(page.locator('.collaboration-status')).toHaveText('Saved', {
    timeout: 20000,
  });
async function pane(page: Page, name: 'Task' | 'Code' | 'Output') {
  const button = page
    .getByRole('navigation', { name: 'Workbench panes', exact: true })
    .getByRole('button', { name, exact: true });
  if (await button.isVisible()) {
    if ((await button.getAttribute('aria-pressed')) !== 'true')
      await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
}
async function exported(page: Page) {
  // The shared helper deliberately gates ordinary routes; work frames expose
  // the same explicit public recovery disclosure through their own portal.
  await recovery(page, true);
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  const path = await (await download).path();
  expect(path).not.toBeNull();
  return JSON.parse(await readFile(path!, 'utf8')) as {
    files: { path: string; source: string }[];
    runtime_id: string;
  };
}
async function recovery(page: Page, open: boolean) {
  const summary = page.locator('summary').filter({
    has: page
      .locator('.recovery-title')
      .filter({ hasText: /^Local recovery & export$/ }),
  });
  await expect(summary).toBeVisible();
  if (
    (await summary.evaluate(
      (element) => (element.parentElement as HTMLDetailsElement).open,
    )) !== open
  )
    await summary.click();
}
async function compactFiles(page: Page, expectedSource: string) {
  const root = page.locator('.editor-workbench[data-guide="true"]');
  const primary = root.getByRole('navigation', {
    name: 'Workbench panes',
    exact: true,
  });
  await expect(primary.getByRole('button')).toHaveCount(3);
  await expect(primary.getByRole('button')).toHaveText([
    'Task',
    'Code',
    'Output',
  ]);
  await expect(root.locator('.workbench-context-switch')).toBeHidden();
  const head = root.locator('.editor-pane-head');
  const show = head.getByRole('button', { name: 'Show files', exact: true });
  const hide = head.getByRole('button', { name: 'Hide files', exact: true });
  const files = root.getByRole('navigation', {
    name: 'Project file explorer',
    exact: true,
  });
  await expect(show).toBeVisible();
  await show.click();
  await expect(hide).toBeVisible();
  await expect(files).toBeVisible();
  await hide.click();
  await expect(show).toBeVisible();
  await expect(files).toBeHidden();
  await show.click();
  await files.getByRole('button', { name: 'main.py', exact: true }).click();
  await expect(files).toBeHidden();
  await expect(show).toBeVisible();
  await expect(
    primary.getByRole('button', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    root.getByRole('tab', { name: 'main.py', exact: true }),
  ).toBeFocused();
  await sourceIs(page, expectedSource);
  await recovery(page, false);
}
async function workbenchVisuals(page: Page, expectedSource: string) {
  const captures = [
    {
      theme: 'light',
      width: 1440,
      height: 900,
      view: 'Code',
      name: 'learning-work-desktop',
    },
    {
      theme: 'light',
      width: 390,
      height: 844,
      view: 'Code',
      name: 'learning-work-390-code',
    },
    {
      theme: 'light',
      width: 390,
      height: 844,
      view: 'Task',
      name: 'learning-work-390-task',
    },
    {
      theme: 'dark',
      width: 1440,
      height: 900,
      view: 'Code',
      name: 'learning-work-desktop-dark',
    },
    {
      theme: 'dark',
      width: 390,
      height: 844,
      view: 'Code',
      name: 'learning-work-390-dark',
    },
    {
      theme: 'dark',
      width: 390,
      height: 844,
      view: 'Task',
      name: 'learning-work-390-task-dark',
    },
  ] as const;
  for (const capture of captures) {
    await page.setViewportSize({
      width: capture.width,
      height: capture.height,
    });
    await page
      .locator('html')
      .evaluate(
        (element, theme) => element.setAttribute('data-theme', theme),
        capture.theme,
      );
    const root = page.locator('.editor-workbench[data-guide="true"]');
    await expect(root).toHaveAttribute(
      'data-guide-compact',
      String(capture.width < 1280),
    );
    await recovery(page, false);
    const options = page
      .locator('summary')
      .filter({ hasText: /^Run options$/ });
    if (
      await options.evaluate(
        (element) => (element.parentElement as HTMLDetailsElement).open,
      )
    ) {
      await pane(page, 'Output');
      await options.click();
    }
    await pane(page, capture.view);
    if (capture.width === 390) {
      const primary = root.getByRole('navigation', {
        name: 'Workbench panes',
        exact: true,
      });
      await expect(primary.getByRole('button')).toHaveCount(3);
      await expect(primary.getByRole('button')).toHaveText([
        'Task',
        'Code',
        'Output',
      ]);
      await expect(root.locator('.workbench-context-switch')).toBeHidden();
      if (capture.view === 'Code') {
        await expect(
          root
            .locator('.editor-pane-head')
            .getByRole('button', { name: 'Show files', exact: true }),
        ).toBeVisible();
        if (capture.theme === 'light') await compactFiles(page, expectedSource);
      }
    } else
      await expect(root.locator('.workbench-context-switch')).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
      const finite = document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return timing && Number.isFinite(Number(timing.endTime));
      });
      await Promise.race([
        Promise.allSettled(finite.map((animation) => animation.finished)),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      window.scrollTo(0, 0);
      for (const element of document.querySelectorAll<HTMLElement>(
        '.cm-scroller, .workbench-guide-content',
      ))
        element.scrollTop = 0;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const geometry = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '.editor-workbench[data-guide="true"]',
      )!;
      const controls = root.querySelector<HTMLElement>('.workbench-controls')!;
      const rect = (element: HTMLElement | null) => {
        if (
          !element ||
          !element.getClientRects().length ||
          getComputedStyle(element).visibility === 'hidden'
        )
          return null;
        const value = element.getBoundingClientRect();
        return {
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          left: value.left,
          width: value.width,
          height: value.height,
        };
      };
      const style = getComputedStyle(controls),
        rootStyle = getComputedStyle(root);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        theme: document.documentElement.dataset['theme'],
        compact: root.dataset['guideCompact'],
        pane: root.dataset['pane'],
        root: rect(root),
        controls: rect(controls),
        paneNavigation: rect(root.querySelector('.pane-switch')),
        contextNavigation: rect(
          root.querySelector('.workbench-context-switch'),
        ),
        editor: rect(root.querySelector('.editor-pane')),
        firstCodeLine: rect(root.querySelector('.cm-line')),
        taskHeading: rect(
          root.querySelector('.workbench-guide-content .assignment-reading h2'),
        ),
        controlsStyle: { position: style.position, top: style.top },
        rootOverflow: { x: rootStyle.overflowX, y: rootStyle.overflowY },
        scroll: {
          windowX: scrollX,
          windowY: scrollY,
          cm: root.querySelector('.cm-scroller')?.scrollTop ?? null,
          guide:
            root.querySelector('.workbench-guide-content')?.scrollTop ?? null,
        },
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    const output = test.info().outputPath(`${capture.name}.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(geometry, null, 2), 'utf8');
    await page.screenshot({
      path: test.info().outputPath(`${capture.name}.png`),
      animations: 'disabled',
    });
    expect(geometry.scroll.windowY).toBe(0);
    expect(geometry.horizontalOverflow).toBe(false);
    expect(geometry.root).not.toBeNull();
    expect(geometry.controls).not.toBeNull();
    expect(geometry.controls!.top).toBeLessThanOrEqual(geometry.root!.top + 1);
    if (capture.view === 'Code') {
      expect(geometry.firstCodeLine).not.toBeNull();
      expect(geometry.firstCodeLine!.top).toBeGreaterThanOrEqual(
        geometry.controls!.bottom,
      );
      if (capture.width === 390)
        expect(geometry.firstCodeLine!.top).toBeLessThan(700);
    }
    if (geometry.taskHeading)
      expect(geometry.taskHeading.top).toBeGreaterThanOrEqual(
        Math.max(
          geometry.controls!.bottom,
          geometry.contextNavigation?.bottom ?? geometry.controls!.bottom,
        ),
      );
    else if (capture.view === 'Task')
      expect(geometry.taskHeading).not.toBeNull();
  }
  await page
    .locator('html')
    .evaluate((element) => element.setAttribute('data-theme', 'light'));
}
async function sourceIs(page: Page, expected: string) {
  await pane(page, 'Code');
  await expect(editor(page)).toBeVisible({ timeout: 20000 });
  await expect
    .poll(
      () =>
        editor(page).evaluate((element) => {
          const clone = element.cloneNode(true) as HTMLElement;
          clone
            .querySelectorAll('.cm-ySelectionCaret')
            .forEach((caret) => caret.remove());
          return [...clone.querySelectorAll('.cm-line')]
            .map((line) => line.textContent ?? '')
            .join('\n');
        }),
      { timeout: 15000 },
    )
    .toBe(expected);
  await saved(page);
  expect(
    (await exported(page)).files.find((file) => file.path === 'main.py')
      ?.source,
  ).toBe(expected);
}
async function replace(page: Page, value: string) {
  await pane(page, 'Code');
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await editor(page).press(`${modifier}+a`);
  const trailing = value.match(/\n+$/)?.[0].length ?? 0;
  const body = trailing ? value.slice(0, -trailing) : value;
  if (body) await page.keyboard.insertText(body);
  else await page.keyboard.press('Backspace');
  for (let index = 0; index < trailing; index++)
    await page.keyboard.press('Enter');
  await sourceIs(page, value);
}

test('participation offer requires the actual recipient and never creates source access or acceptance for a teacher', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const f = await fixture(page, browser, browserName, 'individual', ['River']);
  const actor = f.actors[0]!;
  try {
    await offer(page, f.assignmentId, actor);
    const offered = await get<PageOf<Participation>>(
      page,
      `/api/v1/assignments/${f.assignmentId}/participations/`,
    );
    expect(offered.items).toHaveLength(1);
    expect(offered.items[0]!.user.id).toBe(actor.id);
    const wrongActor = await page.request.post(
      `/api/v1/assignments/${f.assignmentId}/participation/accept/`,
      {
        headers: f.ownerSecurity,
        data: { expected_revision: offered.items[0]!.revision },
      },
    );
    expect(wrongActor.status()).toBe(404);
    await task(actor.page, f.assignmentId, 'my-work');
    const acceptance = actor.page.getByRole('button', {
      name: 'Accept participation',
      exact: true,
    });
    await expect(acceptance).toBeEnabled();
    let releaseSummary!: () => void;
    const heldSummary = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summaryPath = `/api/v1/assignments/${f.assignmentId}/`;
    const handled: Promise<void>[] = [];
    const holdSummary = (route: Route) => {
      const handling = (async () => {
        if (route.request().method() === 'GET') await heldSummary;
        await route.continue();
      })();
      handled.push(handling);
      return handling;
    };
    await actor.page.route(`**${summaryPath}`, holdSummary);
    try {
      const requested = actor.page.waitForRequest(
        (request) =>
          request.method() === 'GET' &&
          new URL(request.url()).pathname === summaryPath,
        { timeout: 15000 },
      );
      await actor.page
        .getByRole('button', { name: 'Refresh my work', exact: true })
        .click();
      await requested;
      await expect.poll(() => handled.length).toBeGreaterThan(0);
      await expect(acceptance).toBeDisabled();
    } finally {
      releaseSummary();
      await Promise.all(handled);
      await actor.page.unroute(`**${summaryPath}`, holdSummary);
    }
    await expect(acceptance).toBeEnabled();
    const accepted = await accept(actor, f.assignmentId);
    expect(accepted.state).toBe('accepted');
    expect(accepted.user.id).toBe(actor.id);
    expect(accepted.team_offer).toBeNull();
    const noSource = await actor.page.request.get(
      `/api/v1/projects/${f.starterProjectId}/`,
    );
    expect(noSource.status()).toBe(404);
    expect(
      (
        await get<PageOf<Work>>(
          actor.page,
          `/api/v1/assignments/${f.assignmentId}/works/?mine=true`,
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await get<components['schemas']['GrantPage']>(
          page,
          `/api/v1/projects/${f.starterProjectId}/grants/`,
        )
      ).items,
    ).toEqual([]);
    await page
      .getByRole('button', { name: 'Refresh participation', exact: true })
      .click();
    const record = page.getByRole('region', {
      name: 'Participation: River',
      exact: true,
    });
    await expect(record).toContainText('Participation: Accepted');
    await expect(
      record.getByRole('button', {
        name: 'Re-offer participation',
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test('exact team consent and approval creates only its new shared work, while withdrawal retains old source and teaching opens no source', async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(180000);
  const f = await fixture(page, browser, browserName, 'team', [
    'River',
    'Sage',
  ]);
  const actor = f.actors[0]!,
    peer = f.actors[1]!;
  let primary: unknown;
  let phase = 'participation';
  const began = Date.now();
  const events: Record<string, unknown>[] = [];
  const receipts: Record<string, unknown>[] = [];
  type QuotaObservation = { at: number; seconds: number; route: string };
  const quotas = new WeakMap<Page, Map<string, QuotaObservation>>();
  function rememberQuota(currentPage: Page, observation: QuotaObservation) {
    const routes =
      quotas.get(currentPage) ?? new Map<string, QuotaObservation>();
    routes.set(observation.route, observation);
    quotas.set(currentPage, routes);
  }
  const recovered = new WeakMap<Page, Set<string>>();
  async function waitObservedQuota(
    currentPage: Page,
    stage: string,
    since: number,
    routes: readonly string[],
  ) {
    const quota = [...(quotas.get(currentPage)?.values() ?? [])]
      .filter((value) => value.at >= since && routes.includes(value.route))
      .sort((a, b) => b.at - a.at)[0];
    const used = recovered.get(currentPage) ?? new Set<string>();
    if (
      !quota ||
      quota.at < since ||
      !routes.includes(quota.route) ||
      used.has(stage)
    )
      return false;
    used.add(stage);
    recovered.set(currentPage, used);
    info.annotations.push({
      type: 'observed-quota',
      description: `${stage}: respected Retry-After ${quota.seconds}s before explicit read-only recheck`,
    });
    await currentPage.waitForTimeout(
      Math.max(0, quota.at + quota.seconds * 1000 - Date.now()) + 2000,
    );
    return true;
  }
  const pending = new Set<Promise<void>>();
  const disposers: (() => void)[] = [];
  function watchPage(currentPage: Page, role: string) {
    const ids = new WeakMap<import('@playwright/test').Request, number>();
    let sequence = 0;
    const append = (value: Record<string, unknown>) => {
      const event = { ms: Date.now() - began, phase, role, ...value };
      events.push(event);
      if (
        value['event'] === 'consent-receipt' ||
        (role === 'teacher' && phase === 'teacher-refresh')
      ) {
        receipts.push(event);
        if (receipts.length > 40) receipts.shift();
      }
      if (events.length > 160) events.shift();
    };
    const route = (url: string) => {
      const path = new URL(url).pathname;
      const base = `/api/v1/assignments/${f.assignmentId}/`;
      if (!path.startsWith(base)) {
        if (path === '/api/v1/me/') return 'me';
        if (/^\/api\/v1\/projects\/[^/]+\/$/.test(path))
          return 'source-metadata';
        if (/^\/api\/v1\/projects\/[^/]+\/files\/(?:[^/]+\/)?$/.test(path))
          return 'source-files';
        if (
          /^\/api\/v1\/projects\/[^/]+\/documents\/[^/]+\/ticket\/$/.test(path)
        )
          return 'source-ticket';
        return null;
      }
      const rest = path.slice(base.length);
      return rest === 'participation/team-consent/'
        ? 'consent'
        : rest === 'participation/withdraw/'
          ? 'withdraw'
          : rest === 'teams/'
            ? 'teams'
            : /^teams\/[^/]+\/$/.test(rest)
              ? 'team-detail'
              : rest === 'participations/'
                ? 'roster'
                : rest === 'participation/'
                  ? 'participation'
                  : rest === 'learning-head/'
                    ? 'head'
                    : rest.startsWith('works/')
                      ? 'work'
                      : rest === ''
                        ? 'summary'
                        : 'other-learning';
    };
    const onRequest = (request: import('@playwright/test').Request) => {
      const kind = route(request.url());
      if (!kind) return;
      const id = ++sequence;
      ids.set(request, id);
      append({ event: 'request', id, route: kind, method: request.method() });
    };
    const onResponse = (response: import('@playwright/test').Response) => {
      const kind = route(response.url());
      if (!kind) return;
      const seconds = Number(response.headers()['retry-after']);
      const status = response.status();
      if (
        status === 429 &&
        Number.isInteger(seconds) &&
        seconds >= 1 &&
        seconds <= 60
      )
        rememberQuota(currentPage, { at: Date.now(), seconds, route: kind });
      append({
        event: 'response',
        id: ids.get(response.request()),
        route: kind,
        status,
        retryAfter:
          Number.isInteger(seconds) && seconds >= 1 && seconds <= 60
            ? seconds
            : null,
      });
      if (status !== 200 || !['consent', 'teams', 'team-detail'].includes(kind))
        return;
      const task = response
        .json()
        .then((data: unknown) => {
          if (!data || typeof data !== 'object') return;
          if (kind === 'consent') {
            const value = data as Participation;
            append({
              event: 'consent-receipt',
              revision: value.revision,
              roster: value.team_offer?.roster_revision ?? null,
              consented: value.team_offer?.consented_revision ?? null,
            });
          } else {
            const values =
              kind === 'teams' ? (data as PageOf<Team>).items : [data as Team];
            if (!Array.isArray(values)) return;
            for (const team of values.slice(0, 2))
              append({
                event: 'team-read',
                id: ids.get(response.request()),
                roster: team.roster_revision,
                ready: team.consent_ready,
                members: team.members.map((member) => ({
                  actor:
                    member.user.id === actor.id
                      ? 'actor'
                      : member.user.id === peer.id
                        ? 'peer'
                        : 'other',
                  consented: member.consented,
                })),
              });
          }
        })
        .catch(() => undefined)
        .finally(() => pending.delete(task));
      pending.add(task);
    };
    const onFailed = (request: import('@playwright/test').Request) => {
      const kind = route(request.url());
      if (kind)
        append({
          event: 'failed',
          id: ids.get(request),
          route: kind,
          reason: /abort|cancel/i.test(request.failure()?.errorText ?? '')
            ? 'cancelled'
            : 'other-network-failure',
        });
    };
    currentPage.on('request', onRequest);
    currentPage.on('response', onResponse);
    currentPage.on('requestfailed', onFailed);
    disposers.push(() => {
      currentPage.off('request', onRequest);
      currentPage.off('response', onResponse);
      currentPage.off('requestfailed', onFailed);
    });
  }
  for (const [index, currentPage] of [page, actor.page, peer.page].entries())
    watchPage(currentPage, ['teacher', 'actor', 'peer'][index]!);
  try {
    for (const learner of f.actors) {
      await offer(page, f.assignmentId, learner);
      await accept(learner, f.assignmentId);
      // No work exists yet; reopen the real consent UI when this learner acts.
      await learner.page.goto('about:blank');
    }
    phase = 'team-setup';
    await task(page, f.assignmentId, 'teaching-teams');
    await disclosure(page, 'Create a team');
    await page
      .getByLabel('New team name', { exact: true })
      .fill('River and Sage');
    await page
      .getByRole('button', { name: 'Create team', exact: true })
      .click();
    const selected = page.getByRole('region', {
      name: 'Selected team: River and Sage',
      exact: true,
    });
    await expect(selected).toBeVisible();
    await disclosure(page, 'Offer or move a participant');
    const acceptedRows = await get<PageOf<Participation>>(
      page,
      `/api/v1/assignments/${f.assignmentId}/participations/`,
    );
    for (const learner of f.actors) {
      const record = acceptedRows.items.find(
        (entry) => entry.user.id === learner.id,
      )!;
      await selected
        .getByLabel('Accepted participant', { exact: true })
        .selectOption(record.id);
      await selected
        .getByRole('button', { name: 'Review team offer', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Offer this participant the team?',
        exact: true,
      });
      await expect(dialog).toContainText(learner.name);
      await dialog
        .getByRole('button', { name: 'Confirm team action', exact: true })
        .click();
      await expect(
        selected.getByRole('list', {
          name: 'Exact roster for River and Sage',
          exact: true,
        }),
      ).toContainText(learner.name);
      const approve = selected.getByRole('button', {
        name: 'Review exact roster approval',
        exact: true,
      });
      if (learner === f.actors.at(-1)) await expect(approve).toBeEnabled();
      else await expect(approve).toBeDisabled();
    }
    await selected
      .getByRole('button', {
        name: 'Review exact roster approval',
        exact: true,
      })
      .click();
    const approval = page.getByRole('dialog', {
      name: 'Approve this exact roster?',
      exact: true,
    });
    await expect(approval).toContainText('River');
    await expect(approval).toContainText('Sage');
    await expect(approval).toContainText('consent pending');
    await approval
      .getByRole('button', { name: 'Confirm team action', exact: true })
      .click();
    await expect(selected).toContainText(
      'Teacher approval: approved for this roster',
    );
    await expect(selected).toContainText(
      'Consent and approval: not ready for this exact roster',
    );
    const teamPage = await get<PageOf<Team>>(
      page,
      `/api/v1/assignments/${f.assignmentId}/teams/?assignment_version_id=${f.version.id}`,
    );
    const team = teamPage.items[0]!;
    expect(team.members.map((member) => member.user.id).sort()).toEqual(
      [actor.id, peer.id].sort(),
    );
    expect(team.consent_ready).toBe(false);
    let finalConsentConfirmedAt = 0;
    for (const [index, learner] of f.actors.entries()) {
      phase = index === 0 ? 'actor-consent' : 'peer-consent';
      await consent(learner, f.assignmentId, team, ['River', 'Sage']);
      finalConsentConfirmedAt = Date.now();
      // The accepted roster is server-owned. No editor or pending choice exists here.
      await learner.page.goto('about:blank');
    }
    phase = 'teacher-refresh';
    const teacherReadStarted = Date.now();
    await page
      .getByRole('button', { name: 'Refresh teams', exact: true })
      .click();
    try {
      await expect(selected).toContainText(
        'Consent and approval: ready for this exact roster',
      );
    } catch (error) {
      if (
        !(await waitObservedQuota(
          page,
          'teacher-roster-read',
          teacherReadStarted,
          ['teams', 'team-detail', 'roster', 'me'],
        ))
      )
        throw error;
      await page
        .getByRole('button', { name: 'Refresh teams', exact: true })
        .click();
      await expect(selected).toContainText(
        'Consent and approval: ready for this exact roster',
      );
    }
    // Keep the real 120/minute quota. These compressed multi-account setup
    // actions are functional QA, not a load test; no Work or source exists yet.
    phase = 'post-consent-pacing';
    const remainingSetupWindow = Math.max(
      0,
      finalConsentConfirmedAt + 60000 - Date.now(),
    );
    info.annotations.push({
      type: 'functional-fixture-pacing',
      description:
        'Kept the normal 120/minute quota; aged out compressed setup reads before creating work.',
    });
    if (remainingSetupWindow > 0)
      await page.waitForTimeout(remainingSetupWindow);
    phase = 'actor-work';
    await info.attach('team-before-first-work', {
      body: JSON.stringify({
        phase,
        elapsedMs: Date.now() - began,
        receipts,
        events,
      }),
      contentType: 'application/json',
    });
    const work = await createWork(
      actor,
      f.assignmentId,
      'Our exact team work',
      true,
    );
    expect(work.project?.role).toBe('owner');
    const projectId = work.project!.id;
    await sourceIs(actor.page, f.original);
    await workbenchVisuals(actor.page, f.original);
    phase = 'peer-work';
    const peerReadStarted = Date.now();
    await peer.page.goto(`/assignments/${f.assignmentId}/works/${work.id}`);
    try {
      await sourceIs(peer.page, f.original);
    } catch (error) {
      if (
        !(await waitObservedQuota(
          peer.page,
          'peer-source-entry',
          peerReadStarted,
          ['source-metadata', 'source-files', 'source-ticket', 'work', 'me'],
        ))
      )
        throw error;
      const refresh = peer.page.getByRole('button', {
        name: 'Refresh work access',
        exact: true,
      });
      await refresh.click();
      await expect(refresh).toBeEnabled();
      const retryFile = peer.page.getByRole('button', {
        name: 'Retry file',
        exact: true,
      });
      if (await retryFile.isVisible()) await retryFile.click();
      const recheck = peer.page.getByRole('button', {
        name: 'Recheck access',
        exact: true,
      });
      if (await recheck.isVisible()) await recheck.click();
      await sourceIs(peer.page, f.original);
    }
    async function sourceIdentity(currentPage: Page): Promise<Project> {
      const path = `/api/v1/projects/${projectId}/`;
      let response = await currentPage.request.get(path);
      if (response.status() === 429) {
        const seconds = Number(response.headers()['retry-after']);
        if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 60) {
          const at = Date.now();
          rememberQuota(currentPage, { at, seconds, route: 'source-metadata' });
          if (
            await waitObservedQuota(currentPage, 'source-identity-read', at, [
              'source-metadata',
            ])
          )
            response = await currentPage.request.get(path);
        }
      }
      expect(response.status(), 'GET source project identity').toBe(200);
      return response.json() as Promise<Project>;
    }
    const project = await sourceIdentity(actor.page);
    expect(project.owner_id).toBe(actor.id);
    expect((await sourceIdentity(peer.page)).role).toBe('editor');
    const grants = await get<components['schemas']['GrantPage']>(
      actor.page,
      `/api/v1/projects/${projectId}/grants/`,
    );
    expect(
      grants.items.map(({ user_id, role }) => ({ user_id, role })),
    ).toEqual([{ user_id: peer.id, role: 'editor' }]);
    const edited = 'value = "team π"\nprint(value)\n';
    await replace(actor.page, edited);
    await sourceIs(peer.page, edited);
    await peer.page.reload();
    await sourceIs(peer.page, edited);

    phase = 'teacher-source-denial';
    const privateRequests: string[] = [],
      sockets: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/projects/') || path.endsWith('/projects/'))
        privateRequests.push(path);
    });
    page.on('websocket', (socket) => {
      const path = new URL(socket.url()).pathname;
      if (path === '/collab' || path === '/events') sockets.push(path);
    });
    await task(page, f.assignmentId, 'teaching-roster');
    await disclosure(page, 'Learning work records');
    const records = page.getByRole('region', {
      name: 'Teaching work records',
      exact: true,
    });
    const visibility = await page.evaluate(() => {
      const panel = document.getElementById('teaching-roster');
      const summary = [...document.querySelectorAll('summary')].find(
        (element) => element.textContent === 'Learning work records',
      );
      return {
        hash: location.hash,
        panelPresent: panel !== null,
        panelHidden: panel?.hidden ?? null,
        disclosureOpen:
          summary?.parentElement instanceof HTMLDetailsElement
            ? summary.parentElement.open
            : null,
        regionInDom: Boolean(
          document.querySelector('section[aria-label="Teaching work records"]'),
        ),
      };
    });
    await expect(records, JSON.stringify(visibility)).toContainText(
      'This account does not currently have access to the source project.',
    );
    const projection = await get<Work>(
      page,
      `/api/v1/assignments/${f.assignmentId}/works/${work.id}/`,
    );
    expect(projection.project).toBeNull();
    expect(projection.can_continue).toBe(false);
    await records
      .locator(`a[href="/assignments/${f.assignmentId}/works/${work.id}"]`)
      .click();
    await expect(
      page.getByRole('heading', { name: 'Assignment work', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: 'Pinned work task', exact: true }),
    ).toContainText('Instructions pinned to A.');
    await expect(
      page.getByRole('textbox', {
        name: 'Python source for main.py',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Run code', exact: true }),
    ).toHaveCount(0);
    expect(privateRequests).toEqual([]);
    expect(sockets).toEqual([]);
    expect(
      (await page.request.get(`/api/v1/projects/${projectId}/`)).status(),
    ).toBe(404);

    phase = 'worker-retention';
    // Finish roster administration before the bounded interactive run. Task,
    // source and output switches must preserve the actual running Worker/input.
    await actor.page.setViewportSize({ width: 1000, height: 900 });
    const interactive = 'name = input("Name: ")\nprint("Hello", name)\n';
    await replace(actor.page, interactive);
    await sourceIs(peer.page, interactive);
    await pane(actor.page, 'Output');
    await disclosure(actor.page, 'Run options');
    await expect(
      actor.page.getByText('Task environment', { exact: true }).locator('..'),
    ).toContainText('Python core');
    await expect(actor.page.getByLabel('Python environment')).toHaveCount(0);
    await actor.page
      .getByLabel('Python input mode', { exact: true })
      .selectOption('interactive');
    await actor.page
      .getByRole('button', { name: 'Run code', exact: true })
      .click();
    const runStatus = actor.page.locator('.execution-status');
    await expect(runStatus).toHaveText('Waiting for input', { timeout: 40000 });
    await expect(actor.page.locator('.practice-provenance')).toContainText(
      f.version.id,
    );
    const stdin = actor.page.getByLabel('Input for Python', { exact: true });
    await stdin.fill('River');
    const capture = await actor.page
      .locator('.execution-provenance')
      .innerText();
    const runtime = actor.page.locator(
      'iframe[title="Isolated Python runtime"]',
    );
    await expect(runtime).toHaveCount(1);
    const originalFrame = await runtime.elementHandle();
    await pane(actor.page, 'Task');
    await expect(
      actor.page.getByRole('article', {
        name: 'Pinned work task',
        exact: true,
      }),
    ).toContainText('Instructions pinned to A.');
    await actor.page
      .getByRole('button', { name: 'Reveal next hint', exact: true })
      .click();
    await disclosure(actor.page, 'Hint 1: Read the source');
    await expect(
      actor.page.getByText('This hint belongs to A.', { exact: true }),
    ).toBeVisible();
    await sourceIs(actor.page, interactive);
    await pane(actor.page, 'Output');
    await expect(runStatus).toHaveText('Waiting for input');
    await expect(stdin).toHaveValue('River');
    await expect(actor.page.locator('.execution-provenance')).toHaveText(
      capture,
    );
    expect(
      await originalFrame!.evaluate((element) => element.isConnected),
    ).toBe(true);
    await actor.page
      .getByRole('button', { name: 'Send input', exact: true })
      .click();
    await finishedRun(actor.page);
    await expect(
      actor.page.getByLabel('Python output').locator('.console-line'),
    ).toHaveCount(1);
    await expect(
      actor.page
        .getByLabel('Python output')
        .locator('.console-line > span:last-child'),
    ).toHaveText('Name: Hello River');
    await pane(actor.page, 'Task');
    await expect(
      actor.page.getByText('This hint belongs to A.', { exact: true }),
    ).toBeVisible();
    await replace(actor.page, edited);
    await sourceIs(peer.page, edited);

    await expect(actor.page.locator('.cm-editor')).toHaveCount(1);
    const originalEditor = await actor.page
      .locator('.cm-editor')
      .elementHandle();
    expect(originalEditor).not.toBeNull();
    phase = 'withdrawal';
    const withdrawal = await actor.context.newPage();
    watchPage(withdrawal, 'withdrawal');
    try {
      await task(withdrawal, f.assignmentId, 'my-work');
      await withdrawal
        .getByRole('button', { name: 'Withdraw participation', exact: true })
        .click();
      const dialog = withdrawal.getByRole('dialog', {
        name: 'Withdraw from this assignment?',
        exact: true,
      });
      await expect(dialog).toContainText(
        'Existing projects keep their owner and sharing',
      );
      const [receipt] = await Promise.all([
        withdrawal.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname ===
              `/api/v1/assignments/${f.assignmentId}/participation/withdraw/`,
        ),
        dialog
          .getByRole('button', {
            name: 'Confirm participation withdrawal',
            exact: true,
          })
          .click(),
      ]);
      expect(receipt.status()).toBe(200);
      expect(((await receipt.json()) as Participation).state).toBe('withdrawn');
      await expect(
        withdrawal
          .getByRole('region', { name: 'My participation', exact: true })
          .locator('.badge'),
      ).toHaveText('Withdrawn');
    } catch (error) {
      const state = await withdrawal
        .evaluate(() => ({
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          activeTag: document.activeElement?.tagName ?? null,
          dialog: Boolean(document.querySelector('[role="dialog"]')),
          confirmDisabled:
            [...document.querySelectorAll('button')].find(
              (button) =>
                button.textContent === 'Confirm participation withdrawal',
            )?.disabled ?? null,
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (element) =>
              /throttl/i.test(element.textContent ?? '') ? 'quota' : 'other',
          ),
        }))
        .catch(() => ({ closed: true }));
      const detail = {
        state,
        events: events.filter((event) => event['role'] === 'withdrawal'),
      };
      await info
        .attach('withdrawal-original-failure', {
          body: JSON.stringify(detail),
          contentType: 'application/json',
        })
        .catch(() => undefined);
      if (error instanceof Error)
        error.message += `\nWithdrawal evidence: ${JSON.stringify(detail).slice(0, 1800)}`;
      throw error;
    } finally {
      await withdrawal.close();
    }
    await actor.page
      .getByRole('button', { name: 'Refresh work access', exact: true })
      .click();
    await expect(
      actor.page.getByText(
        'This work is no longer eligible for learning actions.',
        { exact: false },
      ),
    ).toBeVisible();
    await sourceIs(actor.page, edited);
    await expect(actor.page.locator('.cm-editor')).toHaveCount(1);
    expect(
      await originalEditor!.evaluate((element) => element.isConnected),
    ).toBe(true);
    const retained = await get<Work>(
      actor.page,
      `/api/v1/assignments/${f.assignmentId}/works/${work.id}/`,
    );
    expect(retained.state).toBe('retired');
    expect(retained.can_continue).toBe(false);
    expect(retained.project?.id).toBe(projectId);
    expect(
      (await get<Project>(actor.page, `/api/v1/projects/${projectId}/`))
        .owner_id,
    ).toBe(actor.id);
    expect(
      (
        await get<components['schemas']['GrantPage']>(
          actor.page,
          `/api/v1/projects/${projectId}/grants/`,
        )
      ).items,
    ).toEqual(grants.items);
    expect(
      (await get<Project>(peer.page, `/api/v1/projects/${projectId}/`)).role,
    ).toBe('editor');
    expect(
      (await exported(actor.page)).files.find((file) => file.path === 'main.py')
        ?.source,
    ).toBe(edited);
  } catch (error) {
    primary = error;
    for (const dispose of disposers) dispose();
    await Promise.allSettled([...pending]);
    const states = await Promise.all(
      [page, actor.page, peer.page].map(async (currentPage, index) => {
        const role = ['teacher', 'actor', 'peer'][index]!;
        const state = await currentPage
          .evaluate(() => ({
            path: /\/works\//.test(location.pathname) ? 'work' : 'assignment',
            hash: ['#my-work', '#teaching-teams', '#teaching-roster'].includes(
              location.hash,
            )
              ? location.hash
              : 'other',
            workbench: Boolean(document.querySelector('.editor-workbench')),
            editors: document.querySelectorAll(
              '[aria-label^="Python source for"]',
            ).length,
            panes: [
              ...document.querySelectorAll(
                'nav[aria-label="Workbench panes"] button',
              ),
            ].map((e) => ({
              name: e.textContent,
              pressed: e.getAttribute('aria-pressed'),
            })),
            alerts: [...document.querySelectorAll('[role="alert"]')].map((e) =>
              /throttl/i.test(e.textContent ?? '')
                ? 'quota'
                : /cancel/i.test(e.textContent ?? '')
                  ? 'cancelled'
                  : 'other',
            ),
            teamButtons: [
              ...document.querySelectorAll(
                'section[aria-label="Selected team: River and Sage"] button',
              ),
            ].map((e) => ({ disabled: (e as HTMLButtonElement).disabled })),
            learning: document.querySelector(
              '.learning-update-status [role="status"]',
            )?.textContent,
          }))
          .catch(() => ({ closed: true }));
        await currentPage
          .screenshot({
            path: info.outputPath(`team-${role}-original-failure.png`),
            fullPage: true,
            animations: 'disabled',
            timeout: 3000,
          })
          .catch(() => undefined);
        return { role, ...state };
      }),
    );
    await writeFile(
      info.outputPath('team-original-failure.json'),
      JSON.stringify({ phase, receipts, events, states }, null, 2),
    );
    throw error;
  } finally {
    for (const dispose of disposers) dispose();
    await f.close().catch((error: unknown) => {
      if (primary === undefined) throw error;
    });
  }
});

test('publishing B leaves A work pinned and edited source intact, while explicit B work has fresh project file and document identities', async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(150000);
  const f = await fixture(page, browser, browserName, 'individual', ['River']);
  const actor = f.actors[0]!;
  let phase = 'work-A',
    primary: unknown;
  const began = Date.now();
  const phaseWindows = [{ phase, atMs: 0 }];
  function setPhase(next: string) {
    phase = next;
    phaseWindows.push({ phase, atMs: Date.now() - began });
  }
  type HttpCount = {
    requests: number;
    responses: number;
    failed: number;
    statuses: Record<string, number>;
  };
  const http = new Map<string, HttpCount>();
  const starts = new WeakMap<
    import('@playwright/test').Request,
    { phase: string; route: string }
  >();
  const manualContextReads: { phase: string; route: string }[] = [];
  let overflow = 0;
  const category = (url: string) => {
    const path = new URL(url).pathname;
    if (!path.startsWith('/api/')) return null;
    if (path === '/api/v1/me/') return 'me';
    if (/\/learning-head\/$/.test(path)) return 'learning-head';
    if (/^\/api\/v1\/assignments\/[^/]+\/$/.test(path))
      return 'assignment-summary';
    if (/\/participations?\//.test(path)) return 'participation';
    if (/\/works\//.test(path)) return 'work';
    if (/\/versions\//.test(path)) return 'version';
    if (/\/progress\//.test(path)) return 'progress';
    if (/\/submissions\//.test(path)) return 'submissions';
    if (/^\/api\/v1\/projects\/[^/]+\/$/.test(path)) return 'source-metadata';
    if (/^\/api\/v1\/projects\/[^/]+\/files\/$/.test(path))
      return 'source-list';
    if (/^\/api\/v1\/projects\/[^/]+\/files\/[^/]+\/$/.test(path))
      return 'source-file';
    if (/^\/api\/v1\/projects\/[^/]+\/documents\/[^/]+\/ticket\/$/.test(path))
      return 'source-ticket';
    if (/^\/api\/v1\/projects\/[^/]+\/events\/head\/$/.test(path))
      return 'project-head';
    if (/^\/api\/v1\/projects\/[^/]+\/events\/$/.test(path))
      return 'project-replay';
    if (path.startsWith('/api/v1/projects/')) return 'project-other';
    return 'other-api';
  };
  function counted(scope: { phase: string; route: string }) {
    const key = `${scope.phase}:${scope.route}`;
    if (!http.has(key)) {
      if (http.size >= 128) {
        overflow++;
        return null;
      }
      http.set(key, { requests: 0, responses: 0, failed: 0, statuses: {} });
    }
    return http.get(key)!;
  }
  function httpSnapshot() {
    const totals: Record<
      string,
      { requests: number; responses: number; failed: number; quota: number }
    > = {};
    const routes = [...http].map(([key, value]) => {
      const [p, route] = key.split(':');
      const total = (totals[p!] ??= {
        requests: 0,
        responses: 0,
        failed: 0,
        quota: 0,
      });
      total.requests += value.requests;
      total.responses += value.responses;
      total.failed += value.failed;
      total.quota += value.statuses['429'] ?? 0;
      return { phase: p, route, ...value };
    });
    return {
      totals,
      routes,
      phaseWindows,
      elapsedMs: Date.now() - began,
      overflow,
      knownManualContextReads: manualContextReads,
      scope:
        'Actor page HTTP only after fixture; API-context calls are separate known reads. No owner or earlier fixture traffic.',
    };
  }
  const reads: {
    ms: number;
    phase: string;
    event: string;
    route: string;
    status?: number;
    retryAfter?: number | null;
  }[] = [];
  const route = (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/me/') return 'me';
    if (/^\/api\/v1\/projects\/[^/]+\/$/.test(path)) return 'source-metadata';
    if (/^\/api\/v1\/projects\/[^/]+\/files\/(?:[^/]+\/)?$/.test(path))
      return 'source-files';
    if (/^\/api\/v1\/projects\/[^/]+\/documents\/[^/]+\/ticket\/$/.test(path))
      return 'source-ticket';
    if (path.startsWith(`/api/v1/assignments/${f.assignmentId}/works/`))
      return 'work';
    if (path.startsWith(`/api/v1/assignments/${f.assignmentId}/versions/`))
      return 'version';
    return null;
  };
  const append = (value: Omit<(typeof reads)[number], 'ms' | 'phase'>) => {
    reads.push({ ms: Date.now() - began, phase, ...value });
    if (reads.length > 32) reads.shift();
  };
  const request = (value: import('@playwright/test').Request) => {
    const allRoute = category(value.url());
    if (allRoute) {
      const scope = { phase, route: allRoute };
      starts.set(value, scope);
      const count = counted(scope);
      if (count) count.requests++;
    }
    const kind = route(value.url());
    if (kind) append({ event: 'request', route: kind });
  };
  let quota: {
    at: number;
    seconds: number;
    route: string;
    pathname: string;
  } | null = null;
  const response = (value: import('@playwright/test').Response) => {
    const allRoute = category(value.url());
    if (allRoute) {
      const count = counted(
        starts.get(value.request()) ?? {
          phase: 'fixture-inflight',
          route: allRoute,
        },
      );
      if (count) {
        count.responses++;
        const status = [
          200, 201, 202, 204, 304, 400, 401, 403, 404, 409, 413, 422, 429, 500,
          502, 503, 504,
        ].includes(value.status())
          ? String(value.status())
          : 'other';
        count.statuses[status] = (count.statuses[status] ?? 0) + 1;
      }
    }
    const kind = route(value.url());
    if (!kind) return;
    const seconds = Number(value.headers()['retry-after']);
    if (
      value.status() === 429 &&
      Number.isInteger(seconds) &&
      seconds >= 1 &&
      seconds <= 60
    )
      quota = {
        at: Date.now(),
        seconds,
        route: kind,
        pathname: new URL(actor.page.url()).pathname,
      };
    append({
      event: 'response',
      route: kind,
      status: value.status(),
      retryAfter:
        Number.isInteger(seconds) && seconds >= 1 && seconds <= 60
          ? seconds
          : null,
    });
  };
  const failedRequest = (value: import('@playwright/test').Request) => {
    const scope = starts.get(value);
    if (!scope) return;
    const count = counted(scope);
    if (count) count.failed++;
  };
  actor.page.on('request', request);
  actor.page.on('response', response);
  actor.page.on('requestfailed', failedRequest);
  async function enteredSource(work: Work, expected: string, since: number) {
    const throttled = actor.page
      .getByRole('alert')
      .filter({
        hasText:
          /Request was throttled|Too many attempts\. Please try again later\.|The server asked collaboration to wait before reconnecting\./,
      })
      .first();
    await expect
      .poll(
        async () =>
          (await editor(actor.page).isVisible()) ||
          (await throttled.isVisible()),
        {
          timeout: 20000,
          message:
            'Source entry must show main.py or the actual throttled-read alert',
        },
      )
      .toBe(true);
    if (!(await editor(actor.page).isVisible())) {
      const observed = quota;
      expect(
        Boolean(
          observed &&
          observed.at >= since &&
          observed.pathname ===
            `/assignments/${f.assignmentId}/works/${work.id}` &&
          [
            'work',
            'version',
            'me',
            'source-metadata',
            'source-files',
            'source-ticket',
          ].includes(observed.route),
        ),
        'Only an actual current-entry 429 permits one read-only recheck',
      ).toBe(true);
      if (!observed) throw new Error('Missing current-entry quota evidence');
      info.annotations.push({
        type: 'observed-quota',
        description: `${phase}: respected Retry-After ${observed.seconds}s before one explicit source read recheck`,
      });
      await actor.page.waitForTimeout(
        Math.max(0, observed.at + observed.seconds * 1000 - Date.now()) + 2000,
      );
      if (!(await editor(actor.page).isVisible())) {
        const refresh = actor.page.getByRole('button', {
          name: 'Refresh work access',
          exact: true,
        });
        if (await refresh.isVisible()) {
          await expect(refresh).toBeEnabled();
          await refresh.click();
          await expect(refresh).toBeEnabled();
          const retryFile = actor.page.getByRole('button', {
            name: 'Retry file',
            exact: true,
          });
          if (await retryFile.isVisible()) await retryFile.click();
          const reconnect = actor.page.getByRole('button', {
            name: /^(Recheck access|Reconnect)$/,
          });
          if (
            !(await editor(actor.page).isVisible()) &&
            (await reconnect.isVisible())
          )
            await reconnect.click();
        } else {
          // A failed initial /me read stops above WorkSource. Retry only that
          // actual account read; private Work remains hidden until it succeeds.
          expect(
            observed.route,
            'Only the account quota gate uses account retry',
          ).toBe('me');
          await expect(actor.page.locator('.editor-workbench')).toHaveCount(0);
          await expect(throttled).toBeVisible();
          const retryAccount = actor.page.getByRole('button', {
            name: 'Retry account check',
            exact: true,
          });
          await expect(retryAccount).toBeEnabled();
          await retryAccount.click();
        }
      }
    }
    await sourceIs(actor.page, expected);
  }
  try {
    await offer(page, f.assignmentId, actor);
    await accept(actor, f.assignmentId);
    manualContextReads.push({ phase, route: 'participation' });
    const a = await createWork(actor, f.assignmentId, 'My work on A', false);
    await sourceIs(actor.page, f.original);
    const changed = '# My retained A source\nprint("A stays pinned")\n';
    await replace(actor.page, changed);
    manualContextReads.push({ phase, route: 'source-list' });
    const oldFiles = await get<PageOf<FileIdentity>>(
      actor.page,
      `/api/v1/projects/${a.project!.id}/files/`,
    );
    const verifiedASetupAt = Date.now();
    setPhase('publish-B');
    const draft = await get<{ revision: number }>(
      page,
      `/api/v1/assignments/${f.assignmentId}/draft/`,
    );
    const patched = await page.request.patch(
      `/api/v1/assignments/${f.assignmentId}/draft/`,
      {
        headers: f.ownerSecurity,
        data: {
          expected_revision: draft.revision,
          title: 'Published task B',
          instructions: 'Instructions pinned to B, never substituted into A.',
          max_attempts: 9,
        },
      },
    );
    expect(patched.status()).toBe(200);
    const latest = (await patched.json()) as { revision: number };
    const bVersion = await post<Version>(
      page,
      `/api/v1/assignments/${f.assignmentId}/versions/`,
      { expected_revision: latest.revision, client_request_id: randomUUID() },
      f.ownerSecurity,
    );
    expect(bVersion.id).not.toBe(f.version.id);
    setPhase('retained-A');
    await actor.page
      .getByRole('button', { name: 'Refresh work access', exact: true })
      .click();
    await expect(
      actor.page.getByRole('article', {
        name: 'Pinned work task',
        exact: true,
      }),
    ).toContainText('Instructions pinned to A.');
    await expect(
      actor.page.getByText(
        'Instructions pinned to B, never substituted into A.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await sourceIs(actor.page, changed);
    manualContextReads.push({ phase, route: 'work' });
    const continued = await get<Work>(
      actor.page,
      `/api/v1/assignments/${f.assignmentId}/works/${a.id}/`,
    );
    expect(continued.assignment_version_id).toBe(f.version.id);
    expect(continued.state).toBe('active');
    expect(continued.can_continue).toBe(true);
    // This checks version identity and retained source, not burst capacity.
    // Keep A mounted while the compressed setup reads age out of the real quota.
    setPhase('aged-A');
    const remainingSetupWindow = Math.max(
      0,
      verifiedASetupAt + 60000 - Date.now(),
    );
    info.annotations.push({
      type: 'functional-fixture-pacing',
      description: `Kept the normal 120/minute quota; waited ${Math.ceil(remainingSetupWindow / 1000)}s of the verified A setup window before creating B.`,
    });
    if (remainingSetupWindow > 0)
      await actor.page.waitForTimeout(remainingSetupWindow);
    setPhase('create-B');
    const bEntryStarted = Date.now();
    const b = await createWork(
      actor,
      f.assignmentId,
      'New work explicitly on B',
      false,
    );
    expect(b.assignment_version_id).toBe(bVersion.id);
    expect(b.project!.id).not.toBe(a.project!.id);
    manualContextReads.push({ phase, route: 'source-list' });
    const newFiles = await get<PageOf<FileIdentity>>(
      actor.page,
      `/api/v1/projects/${b.project!.id}/files/`,
    );
    for (const file of newFiles.items) {
      expect(oldFiles.items.some((old) => old.id === file.id)).toBe(false);
      expect(
        oldFiles.items.some((old) => old.document_id === file.document_id),
      ).toBe(false);
      expect(file.generation).toBe(1);
    }
    setPhase('fresh-B-source');
    await enteredSource(b, f.original, bEntryStarted);
    setPhase('reopen-A-source');
    const aEntryStarted = Date.now();
    await actor.page.goto(`/assignments/${f.assignmentId}/works/${a.id}`);
    await enteredSource(a, changed, aEntryStarted);
    manualContextReads.push({ phase, route: 'work' });
    expect(
      (
        await get<PageOf<Work>>(
          actor.page,
          `/api/v1/assignments/${f.assignmentId}/works/?mine=true`,
        )
      ).items
        .map((work) => work.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  } catch (error) {
    primary = error;
    const state = await actor.page
      .evaluate(() => ({
        route: /\/works\//.test(location.pathname) ? 'work' : 'assignment',
        workbench: Boolean(document.querySelector('.editor-workbench')),
        editors: document.querySelectorAll('[aria-label^="Python source for"]')
          .length,
        panes: ['Task', 'Code', 'Output'].map((name) => ({
          name,
          pressed:
            [
              ...document.querySelectorAll(
                'nav[aria-label="Workbench panes"] button',
              ),
            ]
              .find((element) => element.textContent === name)
              ?.getAttribute('aria-pressed') ?? null,
        })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(
          (element) =>
            /throttl/i.test(element.textContent ?? '')
              ? 'quota'
              : /cancel/i.test(element.textContent ?? '')
                ? 'cancelled'
                : 'other',
        ),
      }))
      .catch(() => ({ closed: true }));
    const httpCounts = httpSnapshot();
    const detail = { phase, httpCounts, state, reads };
    await info
      .attach('published-B-original-failure', {
        body: JSON.stringify(detail),
        contentType: 'application/json',
      })
      .catch(() => undefined);
    // Keep bounded source-free evidence in public assertion annotations too.
    if (error instanceof Error)
      error.message += `\nWork phase evidence: ${JSON.stringify({ phase, httpPhases: httpCounts.totals, state, tail: reads.slice(-8) }).slice(0, 1800)}`;
    throw error;
  } finally {
    actor.page.off('request', request);
    actor.page.off('response', response);
    actor.page.off('requestfailed', failedRequest);
    const counter = JSON.stringify(httpSnapshot(), null, 2);
    await writeFile(info.outputPath('actor-http-counter.json'), counter).catch(
      () => undefined,
    );
    await info
      .attach('actor-http-counter', {
        body: counter,
        contentType: 'application/json',
      })
      .catch(() => undefined);
    await f.close().catch((error: unknown) => {
      if (primary === undefined) throw error;
    });
  }
});

test('lost work creation replies retain one manual request identity with no offline or reconnect mutation replay', async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(150000);
  const f = await fixture(page, browser, browserName, 'individual', ['River']);
  const actor = f.actors[0]!;
  let lose = true,
    committed: Work | null = null,
    authChecks = 0;
  const requests: WorkRequest[] = [];
  let phase = 'participation',
    primary: unknown,
    postStatus: number | null = null;
  let abortCompleted = false,
    failedEventSeen = false;
  let interceptedPost: import('@playwright/test').Request | null = null;
  let resolveLoss!: () => void, rejectLoss!: (error: unknown) => void;
  const didLoseReply = new Promise<void>((resolve, reject) => {
    resolveLoss = resolve;
    rejectLoss = reject;
  });
  try {
    await offer(page, f.assignmentId, actor);
    await accept(actor, f.assignmentId);
    actor.page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).pathname === '/api/v1/me/'
      )
        authChecks++;
    });
    await actor.page.route(
      `**/api/v1/assignments/${f.assignmentId}/works/`,
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        requests.push(route.request().postDataJSON() as WorkRequest);
        if (!lose) return route.continue();
        interceptedPost = route.request();
        try {
          phase = 'fetch-committed-reply';
          const response = await route.fetch();
          postStatus = response.status();
          expect(postStatus).toBe(201);
          committed = (await response.json()) as Work;
          phase = 'abort-committed-reply';
          await route.abort('failed');
          abortCompleted = true;
          resolveLoss();
        } catch (error) {
          rejectLoss(error);
          await route.abort('failed').catch(() => undefined);
        }
      },
    );
    phase = 'review-work';
    const dialog = await reviewWork(
      actor.page,
      'One exact uncertain work',
      false,
    );
    const failedPost = actor.page
      .waitForEvent('requestfailed', {
        predicate: (request) =>
          request === interceptedPost &&
          request.method() === 'POST' &&
          new URL(request.url()).pathname ===
            `/api/v1/assignments/${f.assignmentId}/works/`,
      })
      .then(() => {
        failedEventSeen = true;
      });
    phase = 'await-committed-reply-loss';
    await Promise.all([
      dialog
        .getByRole('button', { name: 'Start individual work', exact: true })
        .click(),
      didLoseReply,
      failedPost,
    ]);
    phase = 'retry-visible-after-loss';
    const retry = actor.page.getByRole('button', {
      name: 'Retry same work request',
      exact: true,
    });
    await expect(retry).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(committed).not.toBeNull();
    expect(Object.keys(requests[0]!).sort()).toEqual([
      'assignment_version_id',
      'client_request_id',
      'expected_participation_revision',
      'expected_team_roster_revision',
      'project_name',
      'sharing',
    ]);
    expect(requests[0]!.sharing).toBe('private');
    expect(requests[0]!.expected_team_roster_revision).toBeNull();
    phase = 'offline-manual-retry';
    await actor.context.setOffline(true);
    await retry.click();
    await expect(retry).toBeVisible();
    expect(requests).toHaveLength(1);
    await actor.context.setOffline(false);
    await refreshMine(actor);
    await expect(actor.page.locator('.learning-work-row')).toHaveCount(1);
    await actor.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(requests).toHaveLength(1);
    await expect(retry).toBeEnabled();
    phase = 'online-manual-retry';
    const beforeAuth = authChecks;
    lose = false;
    const response = actor.page.waitForResponse(
      (value) =>
        value.request().method() === 'POST' &&
        new URL(value.url()).pathname ===
          `/api/v1/assignments/${f.assignmentId}/works/`,
    );
    await retry.click();
    const receipt = await response;
    expect(receipt.status()).toBe(200);
    const recovered = (await receipt.json()) as Work;
    expect(authChecks).toBeGreaterThan(beforeAuth);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(recovered.id).toBe((committed as Work | null)?.id);
    expect(recovered.project?.id).toBe((committed as Work | null)?.project?.id);
    const confirmation = actor.page
      .getByRole('status')
      .filter({ hasText: 'Work confirmed.' });
    await expect(
      confirmation.getByRole('link', { name: 'Continue work', exact: true }),
    ).toBeVisible();
    await confirmation
      .getByRole('link', { name: 'Continue work', exact: true })
      .click();
    phase = 'verify-recovered-source';
    await sourceIs(actor.page, f.original);
    const works = await get<PageOf<Work>>(
      actor.page,
      `/api/v1/assignments/${f.assignmentId}/works/?mine=true`,
    );
    expect(works.items.map((work) => work.id)).toEqual([recovered.id]);
    expect(
      (
        await get<components['schemas']['GrantPage']>(
          actor.page,
          `/api/v1/projects/${recovered.project!.id}/grants/`,
        )
      ).items,
    ).toEqual([]);
  } catch (error) {
    primary = error;
    const state = {
      phase,
      postStatus,
      postCount: requests.length,
      committed: committed !== null,
      abortCompleted,
      failedEventSeen,
      authChecks,
    };
    const body = JSON.stringify(state);
    await writeFile(info.outputPath('lost-work-failure.json'), body).catch(
      () => undefined,
    );
    await info
      .attach('lost-work-failure', { body, contentType: 'application/json' })
      .catch(() => undefined);
    if (error instanceof Error)
      error.message += `\nLost work fixture state: ${body}`;
    throw error;
  } finally {
    await f.close().catch((error: unknown) => {
      if (primary === undefined) throw error;
    });
  }
});
