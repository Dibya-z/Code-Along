import {
  expect,
  test,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateMailLink } from './mail-link.ts';
export const password = 'orbit-copper-river-83!';
const mailDirectory = resolve(
  fileURLToPath(new URL('../../../.runtime/mail', import.meta.url)),
);
export async function mailLink(
  email: string,
  kind: 'verify' | 'reset',
): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        for (const name of (await readdir(mailDirectory)).reverse()) {
          const data = await readFile(resolve(mailDirectory, name), 'utf8');
          const found = privateMailLink(data, email, kind);
          if (found) {
            link = found;
            return true;
          }
        }
        return false;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  if (!link) throw new Error('Private development email did not arrive');
  return link;
}
export async function register(
  page: Page,
  email: string,
  name = 'River',
  linkProvider: typeof mailLink = mailLink,
) {
  await page.goto('/auth/signup');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Check your email.');
  await page.goto(await linkProvider(email, 'verify'));
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Your email is verified.',
  );
  await login(page, email);
}
export async function login(page: Page, email: string, secret = password) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
}

export async function openProjectSection(
  page: Page,
  name: 'Code' | 'Discussion' | 'History' | 'Sharing' | 'Settings',
) {
  if (!new URL(page.url()).pathname.startsWith('/projects/')) return;
  const navigation = page.getByRole('navigation', {
    name: 'Project sections',
    exact: true,
  });
  await expect(navigation).toBeVisible();
  const link = navigation.getByRole('link', { name, exact: true });
  if ((await link.getAttribute('aria-current')) === 'page') return;
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`#${name.toLowerCase()}`)).toBeFocused();
}

async function openDisclosure(page: Page, name: string | RegExp) {
  const summary = page.locator('summary').filter({ hasText: name });
  await expect(summary).toBeVisible();
  if (
    !(await summary.evaluate(
      (element) => (element.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
}

export const openWorkspaceMembers = (page: Page) =>
  openDisclosure(page, /^Members$/);
export const openWorkspaceAdministration = (page: Page) =>
  openDisclosure(page, /^Workspace administration$/);
export const openStartDraft = (page: Page) =>
  openDisclosure(page, /^Start a draft$/);
export async function openRecovery(page: Page) {
  if (!/^\/(projects|drafts)\//.test(new URL(page.url()).pathname)) return;
  await openDisclosure(page, /^Local recovery & export/);
}
export const openRunOptions = (page: Page) =>
  openDisclosure(page, /^Run options$/);
export const openPeople = (page: Page) =>
  openDisclosure(page, /^People & saving/);
export const openEditorOptions = (page: Page) =>
  openDisclosure(page, /^Editor options$/);
export async function showFiles(page: Page) {
  const toggle = page.getByRole('button', { name: 'Show files', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

function projectSetupDiagnostics(page: Page) {
  const started = Date.now();
  const pending = new Map<Request, { m: string; r: string; at: number }>();
  const recent: {
    m: string;
    r: string;
    s: number | 'network-failed';
    ms: number;
  }[] = [];
  const uuid = '[0-9a-f-]{36}';
  const routes: [RegExp, string][] = [
    [/^\/api\/v1\/me\/$/, 'me'],
    [/^\/api\/v1\/csrf\/$/, 'csrf'],
    [/^\/api\/v1\/runtime-profiles\/$/, 'runtime-profiles'],
    [/^\/api\/v1\/workspaces\/$/, 'workspaces'],
    [new RegExp(`^/api/v1/workspaces/${uuid}/$`), 'workspace'],
    [
      new RegExp(`^/api/v1/workspaces/${uuid}/projects/$`),
      'workspace-projects',
    ],
    [new RegExp(`^/api/v1/workspaces/${uuid}/members/$`), 'workspace-members'],
    [
      new RegExp(`^/api/v1/workspaces/${uuid}/invitations/$`),
      'workspace-invitations',
    ],
    [new RegExp(`^/api/v1/projects/${uuid}/$`), 'project'],
    [new RegExp(`^/api/v1/projects/${uuid}/files/$`), 'project-files'],
    [
      new RegExp(`^/api/v1/projects/${uuid}/files/${uuid}/$`),
      'project-file-source',
    ],
    [
      new RegExp(`^/api/v1/projects/${uuid}/documents/${uuid}/ticket/$`),
      'document-ticket',
    ],
  ];
  const routeShape = (value: string) => {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.pathname.startsWith('/api/')
    )
      return null;
    return (
      routes.find(([pattern]) => pattern.test(url.pathname))?.[1] ?? 'other-api'
    );
  };
  const request = (value: Request) => {
    const route = routeShape(value.url());
    if (!route) return;
    if (pending.size >= 32) pending.delete(pending.keys().next().value!);
    pending.set(value, { m: value.method(), r: route, at: Date.now() });
  };
  const record = (value: Request, status: number | 'network-failed') => {
    const route = routeShape(value.url());
    if (!route) return;
    recent.push({
      m: value.method(),
      r: route,
      s: status,
      ms: Date.now() - (pending.get(value)?.at ?? started),
    });
    if (recent.length > 16) recent.shift();
  };
  const response = (value: Response) => record(value.request(), value.status());
  const finished = (value: Request) => {
    pending.delete(value);
  };
  const failed = (value: Request) => {
    record(value, 'network-failed');
    pending.delete(value);
  };
  page.on('request', request);
  page.on('response', response);
  page.on('requestfinished', finished);
  page.on('requestfailed', failed);
  return {
    async snapshot() {
      const path = new URL(page.url()).pathname;
      const safePath = new RegExp(`^/(projects|workspaces)/${uuid}$`).test(path)
        ? path.replace(new RegExp(uuid), ':id')
        : [
              '/',
              '/workspaces',
              '/login',
              '/auth/signup',
              '/auth/verify',
            ].includes(path)
          ? path
          : 'other-page';
      const ui = await page
        .evaluate(() => {
          const visible = (element: Element | null) =>
            Boolean(
              element &&
              element.getClientRects().length &&
              getComputedStyle(element).visibility !== 'hidden' &&
              !element.closest('[hidden]'),
            );
          const headings = [...document.querySelectorAll('h1,h2')];
          const knownHeading = (text: string) =>
            headings.some(
              (element) =>
                element.textContent?.trim() === text && visible(element),
            );
          const dialog =
            [...document.querySelectorAll('[role="dialog"]')].find(
              (element) =>
                element.querySelector('h2')?.textContent ===
                'Create a Python project',
            ) ?? null;
          const submit = dialog
            ? [...dialog.querySelectorAll('button')].find(
                (button) => button.textContent?.trim() === 'Create project',
              )
            : null;
          const projectName =
            dialog?.querySelector<HTMLInputElement>('input[name="name"]');
          const runtime = dialog?.querySelector<HTMLSelectElement>('select');
          const selectedRuntime = runtime?.selectedOptions.item(0);
          const states = [
            'Saved',
            'Saving…',
            'Connecting to server…',
            'Read only',
            'Changes pending',
            'Not saved',
            'Editing paused · Not saved',
            'Offline · Server saving paused',
          ];
          const phase = document
            .querySelector('.collaboration-status')
            ?.textContent?.trim();
          return {
            projectNav: visible(
              document.querySelector('nav[aria-label="Project sections"]'),
            ),
            workbench: Boolean(document.querySelector('.editor-workbench')),
            editorAttached: Boolean(
              document.querySelector(
                '[aria-label="Python source for main.py"]',
              ),
            ),
            projectLoading: [
              ...document.querySelectorAll('[role="status"]'),
            ].some(
              (element) =>
                ['Loading project…', 'Loading workbench…'].includes(
                  element.textContent?.trim() ?? '',
                ) && visible(element),
            ),
            projectUnavailable: knownHeading('Project unavailable.'),
            appError: knownHeading('Something went wrong.'),
            createDialog: visible(dialog),
            createDisabled: submit?.disabled ?? null,
            createAlert: Boolean(dialog?.querySelector('[role="alert"]')),
            projectNameLength: projectName?.value.length ?? null,
            projectNameValid: projectName?.validity.valid ?? null,
            runtimeDisabled: runtime?.disabled ?? null,
            runtimeSelected: Boolean(selectedRuntime),
            runtimeOptionDisabled: selectedRuntime?.disabled ?? null,
            collaboration:
              phase && states.includes(phase) ? phase : 'absent-or-other',
          };
        })
        .catch(() => ({ snapshotUnavailable: true }));
      return {
        path: safePath,
        ui,
        pending: [...pending.values()]
          .slice(-8)
          .map((item) => ({ m: item.m, r: item.r, ms: Date.now() - item.at })),
        recent,
      };
    },
    dispose() {
      page.off('request', request);
      page.off('response', response);
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
    },
  };
}

export async function createEditorProject(page: Page) {
  const diagnostic = projectSetupDiagnostics(page);
  try {
    await page
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    let dialog = page.getByRole('dialog', { name: 'Create a workspace' });
    await dialog.getByLabel('Workspace name').fill('Editor studio');
    await dialog
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Create a Python project' });
    await dialog.getByLabel('Project name').fill('A small Python experiment');
    await dialog
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    try {
      await expect(page.getByLabel('Python source for main.py')).toBeVisible();
    } catch (error) {
      const state = await diagnostic
        .snapshot()
        .catch(() => ({ snapshotUnavailable: true }));
      throw new Error(
        `${error instanceof Error ? error.message : 'Source readiness assertion failed.'}\nBounded project setup diagnostic: ${JSON.stringify(state).slice(0, 1900)}`,
        { cause: error },
      );
    }
  } finally {
    diagnostic.dispose();
  }
}

// Collect only public runtime paths; account requests and token-bearing query strings are excluded.
export function runtimeDiagnostics(page: Page) {
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (
      url.hostname === 'localhost' &&
      /^\/(runtime|assets)\//.test(url.pathname)
    )
      test.info().annotations.push({
        type: 'runtime-request',
        description: `${url.pathname}: ${request.failure()?.errorText ?? 'request failed'}`,
      });
  });
}

export async function finishedRun(page: Page) {
  const status = page.locator('.execution-status');
  await expect(status).toHaveText(
    /^(Run finished|Run failed|Run stopped|Time limit reached|Output limit reached)$/,
    { timeout: 40_000 },
  );
  await expect(
    status,
    (await page.getByLabel('Python output').innerText()).slice(0, 4096),
  ).toHaveText('Run finished');
}
