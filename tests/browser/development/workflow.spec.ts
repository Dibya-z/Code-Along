import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const fixture = new URL('./hmr.css', import.meta.url);

test('React refresh, actual API/CSRF and separate runner work behind the development proxy', async ({
  page,
  request,
  baseURL,
}) => {
  const first = await request.get('/login');
  const second = await request.get('/login');
  const policy = first.headers()['content-security-policy'] ?? '';
  const nonce = policy.match(/script-src 'self' 'nonce-([a-f0-9]{32})'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(await first.text()).toContain(`nonce="${nonce}"`);
  expect(await first.text()).not.toContain('__CODE_ALONG_DEV_NONCE__');
  expect(await first.text()).not.toContain('__CODE_ALONG_RUNNER_ORIGIN__');
  expect(second.headers()['content-security-policy']).not.toEqual(policy);
  expect(policy).toContain("worker-src 'none'");
  expect(first.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  const csrf = await request.get('/api/v1/csrf/');
  expect(csrf.ok()).toBe(true);
  expect(((await csrf.json()) as { csrfToken: string }).csrfToken).toHaveLength(
    64,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Email address')
    .fill(`dev-check-${randomUUID()}@example.test`);
  await page
    .getByLabel('Password', { exact: true })
    .fill('not-a-real-account-password');
  const login = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/browser/v1/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await login;
  expect(response.status()).toBe(400); // Credential validation, not CSRF rejection or HTML fallback.
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toBe('no-store');
  const runner = new URL(baseURL ?? 'https://127.0.0.1:8443');
  runner.hostname = 'localhost';
  expect(
    (await request.get(new URL('/api/v1/me/', runner).href)).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
});

test('a watched CSS edit arrives over the proxy without a page reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  const modulePath = '/@fs/app/development-proof/hmr.css';
  await page.evaluate(async (path) => {
    await import(/* @vite-ignore */ path);
  }, modulePath);
  const input = page.getByLabel('Email address');
  await input.fill('retained@example.test');
  const original = await readFile(fixture, 'utf8');
  const marker = `proof-${randomUUID()}`;
  const modified = `${original}\n:root { --code-along-development-proof: ${marker}; }\n`;
  try {
    await writeFile(fixture, modified);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--code-along-development-proof')
            .trim(),
        ),
      )
      .toBe(marker);
    await expect(input).toHaveValue('retained@example.test');
    expect(errors).toEqual([]);
  } finally {
    // Preserve any unexpected concurrent edit instead of overwriting it.
    expect(await readFile(fixture, 'utf8')).toBe(modified);
    await writeFile(fixture, original);
  }
});

test('registration, private email verification and project creation use the real development backend', async ({
  page,
  baseURL,
}) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { existsSync } = await import('node:fs');
  const process = await import('node:process');
  const { register } = await import('../product/helpers.ts');
  const root = new URL('../../../', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const python = new URL('.venv/bin/python', root);
  const executable = existsSync(python) ? fileURLToPath(python) : 'python';
  const project =
    process.env['CODE_ALONG_DEVELOPMENT_PROJECT'] ?? 'code-along-ci';
  const run = promisify(execFile);
  const args = [
    '-m',
    'tools.ci.development_mail',
    '--project',
    project,
    '--origin',
    baseURL ?? 'https://127.0.0.1:8443',
  ];
  // Guard the project/port before creating accounts; the primary dev stack is ineligible.
  await run(executable, args, { cwd: fileURLToPath(root) });
  const email = `development-${randomUUID()}@example.test`;
  await register(page, email, 'Development check', async (recipient) => {
    const result = await run(executable, [...args, '--recipient', recipient], {
      cwd: fileURLToPath(root),
    });
    return result.stdout.trim();
  });
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  const workspace = page.getByRole('dialog', { name: 'Create a workspace' });
  await workspace.getByLabel('Workspace name').fill('Development workspace');
  await workspace
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Development workspace', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Create a Python project' });
  await dialog.getByLabel('Project name').fill('Development project');
  await dialog
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Development project', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Python source for main.py')).toContainText(
    'def greet',
  );
});
