import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { components } from '../../../packages/api-client/src/schema.d.ts';
import { register } from './helpers.ts';

type Security = { Origin: string; 'X-CSRFToken': string };
type Project = components['schemas']['ProjectOutput'];
export type Version = components['schemas']['AssignmentVersionDetail'];
export interface PracticeFile {
  id: string;
  document_id: string;
  generation: number;
  path: string;
}
export const ENTRYPOINT = 'print("ENTRYPOINT_ONLY")\n';
export const LEARNER_SOURCE = '\uFEFFdef answer():\n    return 42\n';
export const IMPORT_CHECKS =
  'import learner\nprint("checked", learner.answer())\nprint("<b>plain output</b>")\nassert learner.answer() == 42, "Try the learner module again"\n';

async function security(page: Page): Promise<Security> {
  const response = await page.request.get('/api/v1/csrf/');
  expect(response.status()).toBe(200);
  return {
    Origin: new URL(page.url()).origin,
    'X-CSRFToken': ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}
export async function get<T>(page: Page, path: string): Promise<T> {
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
export async function practiceFixture(
  owner: Page,
  browser: Browser,
  browserName: string,
  checks = IMPORT_CHECKS,
) {
  const stamp = `${browserName}-${randomUUID().slice(0, 8)}`;
  await register(owner, `pr-teach-${stamp}@example.test`, 'Mira');
  const ownerSecurity = await security(owner);
  const teacher = await get<{ id: string }>(owner, '/api/v1/me/');
  const workspace = await post<{ id: string }>(
    owner,
    '/api/v1/workspaces/',
    { name: 'Visible practice studio' },
    ownerSecurity,
  );
  let project = await post<Project>(
    owner,
    `/api/v1/workspaces/${workspace.id}/projects/`,
    { name: 'Private practice starter' },
    ownerSecurity,
  );
  await post<PracticeFile>(
    owner,
    `/api/v1/projects/${project.id}/files/`,
    {
      path: 'learner.py',
      initial_source: 'def answer():\n    return 0\n',
      expected_version: project.metadata_version,
    },
    ownerSecurity,
  );
  project = await get<Project>(owner, `/api/v1/projects/${project.id}/`);
  // Capture cold canonical documents from their immutable baselines before any
  // observer mounts. Learner edits below still use the genuine shared editor.
  const revision = await post<components['schemas']['RevisionOutput']>(
    owner,
    `/api/v1/projects/${project.id}/revisions/`,
    {
      name: 'Published practice starter',
      expected_version: project.metadata_version,
      client_request_id: randomUUID(),
    },
    ownerSecurity,
  );
  const assignment = await post<components['schemas']['AssignmentSummary']>(
    owner,
    `/api/v1/workspaces/${workspace.id}/assignments/`,
    { title: 'Inspect, then practise' },
    ownerSecurity,
  );
  const patched = await owner.request.patch(
    `/api/v1/assignments/${assignment.id}/draft/`,
    {
      headers: ownerSecurity,
      data: {
        expected_revision: 1,
        instructions: 'Import the learner module. Explain what you observed.',
        starter_revision_id: revision.id,
        submission_mode: 'individual',
        max_team_size: 1,
        public_checks_source: checks,
        hints: [
          {
            id: randomUUID(),
            title: 'Inspect the module',
            body: 'Find the function that returns an answer.',
          },
          {
            id: randomUUID(),
            title: 'Check the result',
            body: 'Compare its result with forty-two.',
          },
        ],
      },
    },
  );
  expect(patched.status()).toBe(200);
  const draft = (await patched.json()) as { revision: number };
  const published = await post<
    components['schemas']['AssignmentVersionSummary']
  >(
    owner,
    `/api/v1/assignments/${assignment.id}/versions/`,
    { expected_revision: draft.revision, client_request_id: randomUUID() },
    ownerSecurity,
  );
  const version = await get<Version>(
    owner,
    `/api/v1/assignments/${assignment.id}/versions/${published.id}/`,
  );
  const context: BrowserContext = await browser.newContext({
    baseURL: new URL(owner.url()).origin,
    ignoreHTTPSErrors: true,
    viewport: { width: 1000, height: 900 },
  });
  try {
    const learner = await context.newPage();
    const email = `pr-learn-${stamp}@example.test`;
    await register(learner, email, 'River');
    const invitation = await post<{ invite_url: string }>(
      owner,
      `/api/v1/workspaces/${workspace.id}/invitations/`,
      { recipient_email: email, role: 'learner', expires_hours: 72 },
      ownerSecurity,
    );
    await learner.goto(invitation.invite_url);
    await learner
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(learner).toHaveURL(new RegExp(`/workspaces/${workspace.id}$`));
    const learnerId = (await get<{ id: string }>(learner, '/api/v1/me/')).id;
    const learnerSecurity = await security(learner);
    const offer = await post<components['schemas']['Participation']>(
      owner,
      `/api/v1/assignments/${assignment.id}/participations/`,
      { recipient_id: learnerId },
      ownerSecurity,
    );
    const accepted = await learner.request.post(
      `/api/v1/assignments/${assignment.id}/participation/accept/`,
      { headers: learnerSecurity, data: { expected_revision: offer.revision } },
    );
    expect(accepted.status()).toBe(200);
    const participation =
      (await accepted.json()) as components['schemas']['Participation'];
    const work = await post<components['schemas']['Work']>(
      learner,
      `/api/v1/assignments/${assignment.id}/works/`,
      {
        client_request_id: randomUUID(),
        assignment_version_id: version.id,
        expected_participation_revision: participation.revision,
        expected_team_roster_revision: null,
        project_name: 'My visible practice',
        sharing: 'private',
      },
      learnerSecurity,
    );
    expect(work.project).not.toBeNull();
    const workProject = work.project!;
    await learner.goto(`/assignments/${assignment.id}/works/${work.id}`);
    await expect(
      learner.locator('.editor-workbench[data-guide="true"]'),
    ).toBeVisible();
    await pane(learner, 'Code');
    await expect(sourceEditor(learner, 'main.py')).toBeEditable({
      timeout: 20000,
    });
    await saved(learner);
    return {
      learner,
      owner,
      context,
      assignmentId: assignment.id,
      version,
      workId: work.id,
      projectId: workProject.id,
      close: () => context.close(),
      async grantTeacherSource() {
        const response = await learner.request.put(
          `/api/v1/projects/${workProject.id}/grants/${teacher.id}/`,
          { headers: learnerSecurity, data: { role: 'editor' } },
        );
        expect(response.status()).toBe(204);
        await owner.goto(`/projects/${workProject.id}`);
        await expect(sourceEditor(owner, 'main.py')).toBeEditable({
          timeout: 20000,
        });
        await saved(owner);
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export const sourceEditor = (page: Page, path: string) =>
  page.getByRole('textbox', { name: `Python source for ${path}`, exact: true });
export const saved = (page: Page) =>
  expect(page.locator('.collaboration-status')).toHaveText('Saved', {
    timeout: 20000,
  });
export async function pane(page: Page, name: 'Task' | 'Code' | 'Output') {
  const button = page
    .getByRole('navigation', { name: 'Workbench panes', exact: true })
    .getByRole('button', { name, exact: true });
  if (await button.isVisible()) {
    if ((await button.getAttribute('aria-pressed')) !== 'true')
      await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  } else if (name === 'Task') {
    const task = page
      .locator('.workbench-context-switch')
      .getByRole('button', { name: 'Task', exact: true });
    if (await task.isVisible()) await task.click();
  }
}
export async function disclosure(page: Page, title: string, open = true) {
  const summary = page
    .locator('summary')
    .filter({ hasText: new RegExp(`^${title}$`) });
  await expect(summary).toBeVisible();
  if (
    (await summary.evaluate(
      (element) => (element.parentElement as HTMLDetailsElement).open,
    )) !== open
  )
    await summary.click();
}
export async function selectFile(page: Page, path: string) {
  await pane(page, 'Code');
  const editor = sourceEditor(page, path);
  if (await editor.isVisible()) return;
  const show = page.getByRole('button', { name: 'Show files', exact: true });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole('navigation', { name: 'Project file explorer', exact: true })
    .getByRole('button', { name: path, exact: true })
    .click();
  await expect(editor).toBeEditable({ timeout: 20000 });
}
export async function exported(page: Page) {
  const summary = page.locator('summary').filter({
    has: page
      .locator('.recovery-title')
      .filter({ hasText: /^Local recovery & export$/ }),
  });
  await expect(summary).toBeVisible();
  if (
    !(await summary.evaluate(
      (element) => (element.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  const path = await (await download).path();
  expect(path).not.toBeNull();
  const result = JSON.parse(await readFile(path!, 'utf8')) as {
    files: { path: string; source: string }[];
    runtime_id: string;
  };
  await summary.click();
  return result;
}
export async function replaceSource(page: Page, path: string, value: string) {
  await selectFile(page, path);
  const editor = sourceEditor(page, path);
  await editor.click();
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await editor.press(`${modifier}+a`);
  const trailing = value.match(/\n+$/)?.[0].length ?? 0;
  const body = trailing ? value.slice(0, -trailing) : value;
  if (body) await page.keyboard.insertText(body);
  else await page.keyboard.press('Backspace');
  for (let index = 0; index < trailing; index++)
    await page.keyboard.press('Enter');
  await saved(page);
  const inserted = (await exported(page)).files.find(
    (file) => file.path === path,
  )?.source;
  let removedIndent = false;
  // This BOM-prefixed fixture produces exactly three autoindent spaces on Enter.
  // Remove only this observed helper-created suffix, preserving the LF and BOM.
  if (trailing > 0 && inserted === `${value}   `) {
    removedIndent = true;
    expect(inserted.slice(0, -3)).toBe(value);
    expect(inserted.slice(0, -3).endsWith('\n')).toBe(true);
    await editor.focus();
    await editor.press(`${modifier}+End`);
    for (let index = 0; index < 3; index++)
      await editor.press('Shift+ArrowLeft');
    await editor.press('Backspace');
    await saved(page);
  }
  const actual = (await exported(page)).files.find(
    (file) => file.path === path,
  )?.source;
  const suffix = (source: string | undefined) => ({
    length: source?.length,
    bodyPreserved: source?.startsWith(body),
    codepoints: source?.startsWith(body)
      ? [...source.slice(body.length)].slice(0, 24).map((c) => c.codePointAt(0))
      : [],
  });
  expect(
    actual,
    `Exact keyboard fixture: ${JSON.stringify({ before: suffix(inserted), after: suffix(actual), removedIndent })}`,
  ).toBe(value);
}
export async function readySource(page: Page) {
  await replaceSource(page, 'main.py', ENTRYPOINT);
  await replaceSource(page, 'learner.py', LEARNER_SOURCE);
}
export async function checks(page: Page) {
  await pane(page, 'Task');
  await disclosure(page, 'Visible checks');
}
export async function runChecks(page: Page) {
  await checks(page);
  const run = page.getByRole('button', {
    name: 'Run visible checks',
    exact: true,
  });
  await expect(run).toBeEnabled();
  await run.click();
  await pane(page, 'Output');
}
export async function practiceCopy(page: Page, source: string) {
  await checks(page);
  const copy = page.getByRole('button', {
    name: /^(Make a practice copy|Use practice copy)$/,
  });
  if (await copy.isVisible()) await copy.click();
  const input = page.getByRole('textbox', { name: /^Practice check copy/ });
  await input.fill(source);
  await expect(input).toHaveValue(source);
}
