import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SCIENTIFIC_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  finishedRun,
  openProjectSection,
  openRecovery,
  register,
} from './helpers.ts';

type Headers = { Origin: string; 'X-CSRFToken': string };
interface Assignment {
  id: string;
  workspace_id: string;
  current_version: { id: string; number: number } | null;
}
interface Draft {
  revision: number;
  starter_revision_id: string | null;
  due_at: string | null;
}
interface Version {
  id: string;
  number: number;
  instructions: string;
  starter: { revision_id: string; manifest_sha256: string };
  runtime: { runtime_id: string };
  content_sha256: string;
  published_at: string;
}
async function headers(page: Page): Promise<Headers> {
  const response = await page.request.get('/api/v1/csrf/');
  expect(response.status()).toBe(200);
  return {
    Origin: new URL(page.url()).origin,
    'X-CSRFToken': ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}
async function post<T>(
  page: Page,
  path: string,
  data: unknown,
  security?: Headers,
): Promise<T> {
  const response = await page.request.post(path, {
    headers: security ?? (await headers(page)),
    data,
  });
  expect(
    response.status(),
    `POST ${new URL(path, new URL(page.url()).origin).pathname}`,
  ).toBe(201);
  return response.json() as Promise<T>;
}
async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(
    response.status(),
    `GET ${new URL(path, new URL(page.url()).origin).pathname}`,
  ).toBe(200);
  return response.json() as Promise<T>;
}
async function newActor(page: Page, label: string, browserName: string) {
  const email = `learning-${label}-${browserName}-${randomUUID().slice(0, 8)}@example.test`;
  await register(page, email, label === 'owner' ? 'Mira' : 'River');
  return email;
}
async function member(
  owner: Page,
  browser: Browser,
  browserName: string,
  workspaceId: string,
  role: 'instructor' | 'learner',
) {
  const context = await browser.newContext({
    baseURL: new URL(owner.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await context.newPage(),
      email = await newActor(page, role, browserName);
    const invitation = await post<{ invite_url: string }>(
      owner,
      `/api/v1/workspaces/${workspaceId}/invitations/`,
      { recipient_email: email, role, expires_hours: 72 },
    );
    await page.goto(invitation.invite_url);
    await page
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    return { page, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}
const saved = (page: Page) =>
  expect(page.locator('.collaboration-status')).toHaveText('Saved', {
    timeout: 20000,
  });
async function source(page: Page, value: string) {
  await openProjectSection(page, 'Code');
  const editor = page.getByRole('textbox', {
    name: 'Python source for main.py',
    exact: true,
  });
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await editor.press(`${modifier}+a`);
  const trailing = value.match(/\n+$/)?.[0].length ?? 0;
  const body = trailing ? value.slice(0, -trailing) : value;
  if (body) await page.keyboard.insertText(body);
  else await page.keyboard.press('Backspace');
  for (let i = 0; i < trailing; i++) await page.keyboard.press('Enter');
  await openRecovery(page);
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  const archive = JSON.parse(
    await readFile((await (await download).path())!, 'utf8'),
  ) as { files: { path: string; source: string }[] };
  expect(archive.files.find((file) => file.path === 'main.py')?.source).toBe(
    value,
  );
  await saved(page);
}
async function revision(page: Page, name: string) {
  await openProjectSection(page, 'History');
  await page.getByLabel('Revision name', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Capture shared revision', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: `Frozen source: ${name}`, exact: true }),
  ).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  const list = await get<{
    items: { id: string; name: string; manifest_sha256: string }[];
  }>(page, `/api/v1/projects/${projectId}/revisions/`);
  return list.items.find((item) => item.name === name)!;
}
async function fixture(page: Page, browserName: string) {
  await newActor(page, 'owner', browserName);
  const workspace = await post<{ id: string }>(page, '/api/v1/workspaces/', {
    name: 'Learning studio',
  });
  const project = await post<{ id: string }>(
    page,
    `/api/v1/workspaces/${workspace.id}/projects/`,
    { name: 'Private starter source' },
  );
  await page.goto(`/projects/${project.id}`);
  await expect(
    page.getByLabel('Python source for main.py', { exact: true }),
  ).toBeVisible();
  const original = 'print("frozen starter H")\n';
  await source(page, original);
  const frozen = await revision(page, 'Starter H');
  return { workspaceId: workspace.id, projectId: project.id, frozen, original };
}
async function seedAssignment(
  page: Page,
  workspaceId: string,
  revisionId: string,
) {
  const assignment = await post<Assignment>(
    page,
    `/api/v1/workspaces/${workspaceId}/assignments/`,
    { title: 'A frozen assignment' },
  );
  const response = await page.request.patch(
    `/api/v1/assignments/${assignment.id}/draft/`,
    {
      headers: await headers(page),
      data: {
        expected_revision: 1,
        instructions: 'Published instructions H',
        starter_revision_id: revisionId,
      },
    },
  );
  expect(response.status()).toBe(200);
  const draft = (await response.json()) as Draft;
  const version = await post<Version>(
    page,
    `/api/v1/assignments/${assignment.id}/versions/`,
    { expected_revision: draft.revision, client_request_id: randomUUID() },
  );
  return { assignment, version };
}
async function task(
  page: Page,
  name: 'Overview' | 'Edit draft' | 'Published versions',
) {
  const link = page
    .getByRole('navigation', { name: 'Assignment sections' })
    .getByRole('link', { name, exact: true });
  if ((await link.getAttribute('aria-current')) === 'page') return;
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(
    page.locator(
      name === 'Overview'
        ? '#overview'
        : name === 'Edit draft'
          ? '#draft'
          : '#versions',
    ),
  ).toBeFocused();
}
async function publish(page: Page) {
  await page
    .getByRole('button', { name: 'Review publication', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Publish this saved draft?',
    exact: true,
  });
  await expect(dialog).toContainText(
    "Active members of this workspace can read the frozen assignment content and starter. Reading is not enrollment and grants no access to the source project's live code.",
  );
  await dialog
    .getByRole('button', { name: 'Publish saved draft', exact: true })
    .click();
  await expect(
    page.getByText(/^Published version [0-9]+ is confirmed\.$/, {
      exact: true,
    }),
  ).toBeVisible();
}
async function frozenExport(page: Page) {
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export revision source', exact: true })
    .click();
  return JSON.parse(
    await readFile((await (await download).path())!, 'utf8'),
  ) as { runtime_id: string; files: { path: string; source: string }[] };
}

test('teacher authors and publishes a frozen NumPy assignment while learner reads immutable content', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  await newActor(page, 'owner', browserName);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  let dialog = page.getByRole('dialog', {
    name: 'Create a workspace',
    exact: true,
  });
  await dialog.getByLabel('Workspace name').fill('Assignment studio');
  await dialog
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/);
  const workspaceId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  dialog = page.getByRole('dialog', {
    name: 'Create a Python project',
    exact: true,
  });
  await dialog.getByLabel('Project name').fill('Array starter');
  await dialog
    .getByLabel('Python environment')
    .selectOption({ label: 'NumPy' });
  await dialog
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(
    page.getByLabel('Python source for main.py', { exact: true }),
  ).toBeVisible();
  const original =
    'import numpy as np\nprint((np.array([1, 2]) * 2).tolist())\n';
  await source(page, original);
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText('[2, 4]');
  const frozen = await revision(page, 'Arrays H');
  await page.getByRole('link', { name: '← Workspace', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('link', { name: 'Assignments', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Create assignment', exact: true })
    .click();
  dialog = page.getByRole('dialog', {
    name: 'Create an assignment',
    exact: true,
  });
  await dialog.getByLabel('Assignment title').fill('Working with arrays');
  await dialog
    .getByRole('button', { name: 'Create assignment', exact: true })
    .click();
  await page
    .getByLabel('Instructions', { exact: true })
    .fill('Keep <script>plain text</script> and arrays H.');
  await task(page, 'Overview');
  await expect(
    page.getByText('Not published yet', { exact: true }),
  ).toBeVisible();
  await task(page, 'Edit draft');
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Keep <script>plain text</script> and arrays H.',
  );
  await page
    .locator('summary')
    .filter({ hasText: /^Hints/ })
    .click();
  await page.getByRole('button', { name: 'Add hint', exact: true }).click();
  await page
    .getByLabel('Hint 1 title', { exact: true })
    .fill('Look at the shape');
  await page
    .getByLabel('Hint 1 body', { exact: true })
    .fill('Inspect each value.');
  await page
    .locator('summary')
    .filter({ hasText: /^Visible Python checks$/ })
    .click();
  await page
    .getByLabel('Include inspectable practice checks', { exact: true })
    .check();
  await page
    .getByLabel('Visible Python check source', { exact: true })
    .fill('assert 2 * 2 == 4\n');
  await page
    .getByRole('button', {
      name: 'Choose a new starter from my project',
      exact: true,
    })
    .click();
  await page
    .getByLabel('Starter source project', { exact: true })
    .selectOption({ label: 'Array starter' });
  await page
    .getByRole('button', { name: 'Inspect revision Arrays H', exact: true })
    .click();
  const patches: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname.endsWith('/draft/')
    )
      patches.push(request.url());
  });
  await expect(
    page.getByRole('region', { name: 'Frozen source: Arrays H', exact: true }),
  ).toBeVisible();
  const inspected = await frozenExport(page);
  expect(inspected.files[0]?.source).toBe(original);
  expect(patches).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Use this frozen starter', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText(/Draft saved · revision 2/)).toBeVisible();
  await publish(page);
  const assignmentId = new URL(page.url()).pathname.split('/').at(-1)!;
  const summary = await get<Assignment>(
    page,
    `/api/v1/assignments/${assignmentId}/`,
  );
  expect(summary.current_version?.number).toBe(1);
  const version = await get<Version>(
    page,
    `/api/v1/assignments/${assignmentId}/versions/${summary.current_version!.id}/`,
  );
  expect(version.starter.revision_id).toBe(frozen.id);
  expect(version.starter.manifest_sha256).toBe(frozen.manifest_sha256);
  expect(version.runtime.runtime_id).toBe(SCIENTIFIC_RUNTIME.runtime_id);
  const learner = await member(
    page,
    browser,
    browserName,
    workspaceId,
    'learner',
  );
  try {
    const requests: string[] = [];
    learner.page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/projects/') || path.endsWith('/draft/'))
        requests.push(path);
    });
    await learner.page.goto(`/assignments/${assignmentId}`);
    const publicationTime = learner.page.locator('time');
    await expect(publicationTime).toHaveAttribute(
      'datetime',
      version.published_at,
    );
    await expect(publicationTime).toHaveText(
      /^\d{1,2} [A-Z][a-z]{2} \d{4}(?:,| at) \d{2}:\d{2}:\d{2} UTC$/,
    );
    await expect(
      learner.page.getByText('Keep <script>plain text</script> and arrays H.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      learner.page.locator('script').filter({ hasText: 'plain text' }),
    ).toHaveCount(0);
    await expect(
      learner.page.getByRole('link', { name: 'Edit draft', exact: true }),
    ).toHaveCount(0);
    await learner.page
      .getByRole('button', { name: 'View frozen starter', exact: true })
      .click();
    const archive = await frozenExport(learner.page);
    expect(archive.files[0]?.source).toBe(original);
    expect(archive.runtime_id).toBe(version.runtime.runtime_id);
    const frozenViewer = learner.page.getByRole('region', {
      name: 'Frozen source: Assignment version 1 starter',
      exact: true,
    });
    await expect(
      frozenViewer.getByText(
        `NumPy · Python ${SCIENTIFIC_RUNTIME.python_version}.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      frozenViewer.getByText(SCIENTIFIC_RUNTIME.runtime_id, { exact: true }),
    ).toBeHidden();
    const provenance = frozenViewer
      .locator('summary')
      .filter({ hasText: /^Source and runtime provenance$/ });
    await provenance.click();
    await expect(
      frozenViewer.getByText(SCIENTIFIC_RUNTIME.runtime_id, { exact: true }),
    ).toBeVisible();
    await expect(
      frozenViewer.getByText('code-along-python-helpers-v1', { exact: true }),
    ).toBeVisible();
    await provenance.click();
    expect(requests).toEqual([]);
    await page
      .getByLabel('Instructions', { exact: true })
      .fill('Unpublished instructions H2');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText(/Draft saved · revision 4/)).toBeVisible();
    await learner.page.reload();
    await expect(
      learner.page.getByText('Keep <script>plain text</script> and arrays H.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      learner.page.getByText('Unpublished instructions H2', { exact: true }),
    ).toHaveCount(0);
    await learner.page
      .getByRole('button', { name: 'View frozen starter', exact: true })
      .click();
    await expect(
      learner.page.getByRole('region', {
        name: 'Frozen source: Assignment version 1 starter',
        exact: true,
      }),
    ).toBeVisible();
    await learner.page.setViewportSize({ width: 1440, height: 900 });
    await learner.page.screenshot({
      path: test.info().outputPath('assignment-desktop.png'),
      fullPage: true,
    });
    await learner.page.setViewportSize({ width: 390, height: 844 });
    await learner.page.screenshot({
      path: test.info().outputPath('assignment-390.png'),
      fullPage: true,
    });
    expect(
      await learner.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await learner.page.setViewportSize({ width: 320, height: 800 });
    expect(
      await learner.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await learner.page.screenshot({
      path: test.info().outputPath('assignment-320.png'),
      fullPage: true,
    });
    await learner.page.setViewportSize({ width: 390, height: 844 });
    await learner.page
      .locator('html')
      .evaluate((element) => element.setAttribute('data-theme', 'dark'));
    await learner.page
      .getByRole('button', { name: 'Refresh assignment', exact: true })
      .evaluate(async (element) => {
        const style = getComputedStyle(element);
        if (style.transitionProperty.includes('background'))
          await Promise.all(
            element
              .getAnimations()
              .map((animation) => animation.finished.catch(() => undefined)),
          );
      });
    await learner.page.screenshot({
      path: test.info().outputPath('assignment-dark.png'),
      fullPage: true,
    });
  } finally {
    await learner.context.close();
  }
});

test('co-teacher reuses only this assignment published starter without private source access', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const f = await fixture(page, browserName);
  const seeded = await seedAssignment(page, f.workspaceId, f.frozen.id);
  await page.goto(`/projects/${f.projectId}`);
  await source(page, 'print("private H2")\n');
  const h2 = await revision(page, 'Private H2');
  const peer = await member(
    page,
    browser,
    browserName,
    f.workspaceId,
    'instructor',
  );
  try {
    const privatePaths: string[] = [],
      sockets: string[] = [];
    peer.page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/projects/') || path.endsWith('/projects/'))
        privatePaths.push(path);
    });
    peer.page.on('websocket', (socket) =>
      sockets.push(new URL(socket.url()).pathname),
    );
    await peer.page.goto(`/assignments/${seeded.assignment.id}#draft`);
    await expect(
      peer.page.getByText('Published starter — version 1', { exact: true }),
    ).toBeVisible();
    await peer.page
      .getByLabel('Instructions', { exact: true })
      .fill('Co-teacher corrected instructions');
    await peer.page
      .getByRole('button', { name: 'Choose a published starter', exact: true })
      .click();
    let releaseChoice!: () => void, choiceRequested!: () => void;
    const choiceGate = new Promise<void>((resolve) => {
      releaseChoice = resolve;
    });
    const choiceArrived = new Promise<void>((resolve) => {
      choiceRequested = resolve;
    });
    await peer.page.route(
      `**/api/v1/assignments/${seeded.assignment.id}/versions/${seeded.version.id}/`,
      async (route) => {
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        choiceRequested();
        await choiceGate;
        await route.fulfill({ response: actual });
      },
    );
    await peer.page
      .getByRole('button', { name: 'Use starter from version 1', exact: true })
      .click();
    await choiceArrived;
    await expect(
      peer.page.getByRole('button', { name: 'Save draft', exact: true }),
    ).toBeDisabled();
    await expect(
      peer.page.getByRole('button', {
        name: 'Review publication',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      peer.page.getByRole('button', {
        name: 'Review and reload draft',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      peer.page.getByRole('button', {
        name: 'Clear starter selection',
        exact: true,
      }),
    ).toBeDisabled();
    releaseChoice();
    await expect(
      peer.page.getByRole('button', { name: 'Save draft', exact: true }),
    ).toBeEnabled();
    await peer.page
      .getByRole('button', { name: 'Save draft', exact: true })
      .click();
    await expect(peer.page.getByText(/Draft saved · revision 4/)).toBeVisible();
    const selectedDraft = await get<Draft>(
      peer.page,
      `/api/v1/assignments/${seeded.assignment.id}/draft/`,
    );
    expect(selectedDraft.starter_revision_id).toBe(f.frozen.id);
    await expect(
      peer.page
        .getByRole('status')
        .filter({ hasText: 'Published starter — version 1' }),
    ).toBeVisible();
    await publish(peer.page);
    expect(privatePaths).toEqual([]);
    expect(sockets).toEqual([]);
    await task(peer.page, 'Overview');
    await peer.page
      .getByRole('button', { name: 'View frozen starter', exact: true })
      .click();
    const exported = await frozenExport(peer.page);
    expect(exported.files[0]?.source).toBe(f.original);
    expect(privatePaths).toEqual([]);
    expect(sockets).toEqual([]);
    const assignment = await get<Assignment>(
      peer.page,
      `/api/v1/assignments/${seeded.assignment.id}/`,
    );
    const detail = await get<Version>(
      peer.page,
      `/api/v1/assignments/${seeded.assignment.id}/versions/${assignment.current_version!.id}/`,
    );
    expect(detail.number).toBe(2);
    expect(detail.starter).toEqual(seeded.version.starter);
    expect(detail.instructions).toBe('Co-teacher corrected instructions');
    const draft = await get<Draft>(
      peer.page,
      `/api/v1/assignments/${seeded.assignment.id}/draft/`,
    );
    const denied = await peer.page.request.patch(
      `/api/v1/assignments/${seeded.assignment.id}/draft/`,
      {
        headers: await headers(peer.page),
        data: { expected_revision: draft.revision, starter_revision_id: h2.id },
      },
    );
    expect(denied.status()).toBe(404);
    expect(
      (
        await peer.page.request.get(`/api/v1/projects/${f.projectId}/`)
      ).status(),
    ).toBe(404);
    const otherWorkspace = await post<{ id: string }>(
      page,
      '/api/v1/workspaces/',
      { name: 'Different teaching scope' },
    );
    const wrongScope = await post<Assignment>(
      page,
      `/api/v1/workspaces/${otherWorkspace.id}/assignments/`,
      { title: 'Different scope assignment' },
    );
    const wrongStarter = await page.request.patch(
      `/api/v1/assignments/${wrongScope.id}/draft/`,
      {
        headers: await headers(page),
        data: { expected_revision: 1, starter_revision_id: f.frozen.id },
      },
    );
    expect(wrongStarter.status()).toBe(404);
  } finally {
    await peer.context.close();
  }
});

test('draft CAS preserves local text and uncertain publication retries the same immutable request', async ({
  page,
  browserName,
}) => {
  test.setTimeout(120000);
  const f = await fixture(page, browserName);
  const seeded = await seedAssignment(page, f.workspaceId, f.frozen.id);
  await page.goto(`/assignments/${seeded.assignment.id}#draft`);
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Published instructions H',
  );
  const other = await page.context().newPage();
  try {
    let summaryUnavailable = false;
    await page.route(
      `**/api/v1/assignments/${seeded.assignment.id}/`,
      async (route) => {
        if (summaryUnavailable && route.request().method() === 'GET')
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Temporarily unavailable.' }),
          });
        else await route.continue();
      },
    );
    await other.goto(`/assignments/${seeded.assignment.id}#draft`);
    await expect(other.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Published instructions H',
    );
    await page
      .getByLabel('Instructions', { exact: true })
      .fill('Saved from first tab');
    await task(page, 'Overview');
    await page.goBack();
    await expect(page.locator('#draft')).toBeFocused();
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Saved from first tab',
    );
    await page.goForward();
    await expect(page.locator('#overview')).toBeFocused();
    await task(page, 'Edit draft');
    summaryUnavailable = true;
    await page
      .getByRole('button', { name: 'Refresh assignment', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Recheck assignment access',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Saved from first tab',
    );
    await expect(
      page.getByLabel('Instructions', { exact: true }),
    ).toBeDisabled();
    summaryUnavailable = false;
    await page
      .getByRole('button', { name: 'Recheck assignment access', exact: true })
      .click();
    await expect(
      page.getByLabel('Instructions', { exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Saved from first tab',
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText(/Draft saved · revision 4/)).toBeVisible();
    await other
      .getByLabel('Instructions', { exact: true })
      .fill('Keep this conflicting local text');
    await other
      .getByRole('button', { name: 'Save draft', exact: true })
      .click();
    await expect(
      other.getByText(
        'Your displayed draft revision is out of date. Your text is still here. Review it before choosing to reload the server draft.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(other.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Keep this conflicting local text',
    );
    const requests: { expected_revision: number; client_request_id: string }[] =
      [];
    let lost = true;
    await page.route(
      `**/api/v1/assignments/${seeded.assignment.id}/versions/`,
      async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        requests.push(
          route.request().postDataJSON() as {
            expected_revision: number;
            client_request_id: string;
          },
        );
        if (lost) {
          lost = false;
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          await route.abort('failed');
        } else await route.continue();
      },
    );
    await page
      .getByRole('button', { name: 'Review publication', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Publish this saved draft?', exact: true })
      .getByRole('button', { name: 'Publish saved draft', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Retry same publication', exact: true }),
    ).toBeVisible();
    summaryUnavailable = true;
    await page
      .getByRole('button', { name: 'Refresh assignment', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Retry same publication', exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Saved from first tab',
    );
    const committed = await get<Draft>(
      other,
      `/api/v1/assignments/${seeded.assignment.id}/draft/`,
    );
    const archived = await other.request.patch(
      `/api/v1/assignments/${seeded.assignment.id}/`,
      {
        headers: await headers(other),
        data: { expected_revision: committed.revision, archived: true },
      },
    );
    expect(archived.status()).toBe(200);
    summaryUnavailable = false;
    await page
      .getByRole('button', { name: 'Recheck assignment access', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Retry same publication', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Retry same publication', exact: true })
      .click();
    await expect(
      page.getByText(/^Published version [0-9]+ is confirmed\.$/, {
        exact: true,
      }),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const versions = await get<{ count: number; items: { number: number }[] }>(
      page,
      `/api/v1/assignments/${seeded.assignment.id}/versions/`,
    );
    expect(versions.count).toBe(2);
    expect(versions.items.map((version) => version.number)).toEqual([2, 1]);
    await other
      .getByRole('button', { name: 'Review and reload draft', exact: true })
      .click();
    await other
      .getByRole('dialog', { name: 'Reload the server draft?', exact: true })
      .getByRole('button', {
        name: 'Replace form with server draft',
        exact: true,
      })
      .click();
    await other
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(other.getByLabel('Instructions', { exact: true })).toHaveValue(
      'Saved from first tab',
    );
  } finally {
    await other.close();
  }
});

test('workspace assignment discovery pages and filters without enrollment or authoring reads for learners', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  await newActor(page, 'owner', browserName);
  const workspace = await post<{ id: string }>(page, '/api/v1/workspaces/', {
    name: 'Paged learning studio',
  });
  const learner = await member(
    page,
    browser,
    browserName,
    workspace.id,
    'learner',
  );
  try {
    const created: Assignment[] = [];
    // One fresh token for this authenticated seed batch; nothing survives a session change.
    const seedHeaders = await headers(page);
    for (let i = 0; i < 21; i++)
      created.push(
        await post<Assignment>(
          page,
          `/api/v1/workspaces/${workspace.id}/assignments/`,
          { title: `Draft assignment ${String(i + 1).padStart(2, '0')}` },
          seedHeaders,
        ),
      );
    await page.goto(`/workspaces/${workspace.id}#assignments`);
    await expect(page.getByText('1–20 of 21', { exact: true })).toBeVisible();
    const panel = page.locator('#assignments');
    await panel.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByText('21–21 of 21', { exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Workspace sections' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Workspace sections' })
      .getByRole('link', { name: 'Assignments', exact: true })
      .click();
    await expect(page.getByText('21–21 of 21', { exact: true })).toBeVisible();
    const unpublished = created[0]!;
    expect(
      (
        await learner.page.request.get(`/api/v1/assignments/${unpublished.id}/`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await learner.page.request.get(
          `/api/v1/assignments/${unpublished.id}/draft/`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await learner.page.request.post(
          `/api/v1/workspaces/${workspace.id}/assignments/`,
          {
            headers: await headers(learner.page),
            data: { title: 'Unauthorized draft' },
          },
        )
      ).status(),
    ).toBe(403);
    const paths: string[] = [];
    learner.page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/draft/')) paths.push(path);
    });
    await learner.page.goto(`/workspaces/${workspace.id}#assignments`);
    await expect(
      learner.page.getByText('No current assignments to show.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      learner.page.getByRole('button', {
        name: 'Create assignment',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(paths).toEqual([]);
    const archive = await page.request.patch(
      `/api/v1/assignments/${unpublished.id}/`,
      {
        headers: await headers(page),
        data: { expected_revision: 1, archived: true },
      },
    );
    expect(archive.status()).toBe(200);
    await page.reload();
    await expect(page.locator('#assignments .list-row')).toHaveCount(20);
    await page
      .getByLabel('Include archived assignments', { exact: true })
      .check();
    await expect(page.getByText('1–20 of 21', { exact: true })).toBeVisible();
    await learner.page
      .getByLabel('Include archived assignments', { exact: true })
      .check();
    await expect(
      learner.page.getByText('No assignments to show.', { exact: true }),
    ).toBeVisible();
  } finally {
    await learner.context.close();
  }
});
