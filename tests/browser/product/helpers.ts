import { expect, test, type Page } from '@playwright/test';
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

export async function createEditorProject(page: Page) {
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
  await expect(page.getByLabel('Python source for main.py')).toBeVisible();
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
