import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  register,
  login,
  createEditorProject,
  finishedRun,
  openRecovery,
  showFiles,
} from './helpers.ts';
const core = 'pyodide-314.0.7-core';
async function hub(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Local drafts', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Local drafts', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Stored local copies', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Code Along source backup')).not.toBeVisible();
}
async function startDraft(page: Page) {
  const summary = page
    .locator('summary')
    .filter({ hasText: /^Start a draft$/ });
  await summary.focus();
  await summary.press('Enter');
  await expect(page.getByLabel('Code Along source backup')).toBeVisible();
}
async function template(page: Page, title = 'A function, two files') {
  await hub(page);
  await startDraft(page);
  await page
    .getByRole('button', { name: `Preview ${title}`, exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Create local draft', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toBeVisible();
  await expect(page.locator('.recovery-status')).toHaveText(
    /^Local recovery updated/,
  );
}
async function backup(page: Page): Promise<string> {
  await openRecovery(page);
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  return readFile((await (await downloading).path())!, 'utf8');
}
test('templates, local metadata, Python imports and source export/import round trip', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [],
    writes: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, `tools-${browserName}-${Date.now()}@example.test`);
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/api/v1/projects/') &&
      ['POST', 'PATCH', 'DELETE'].includes(request.method())
    )
      writes.push(request.method());
  });
  await template(page);
  const firstUrl = page.url();
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText('Hello, River!');
  await showFiles(page);
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add a Python file' });
  await dialog.getByLabel('File path').fill('scratch.py');
  await dialog
    .getByRole('button', { name: 'Add Python file', exact: true })
    .click();
  await page
    .getByLabel('Python source for scratch.py')
    .fill('print("local module")\n');
  await page.getByRole('button', { name: 'Rename file', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Rename a Python file' });
  await dialog.getByLabel('File path').fill('lessons/scratch.py');
  await dialog
    .getByRole('button', { name: 'Rename Python file', exact: true })
    .click();
  await expect(
    page.getByLabel('Python source for lessons/scratch.py'),
  ).toHaveText('print("local module")\n');
  await page
    .getByRole('button', { name: 'Use as entrypoint', exact: true })
    .click();
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText('local module');
  await showFiles(page);
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  await page
    .getByRole('button', { name: 'Use as entrypoint', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'lessons/scratch.py', exact: true })
    .click();
  await page.getByRole('button', { name: 'Delete file', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete this local file?' })
    .getByRole('button', { name: 'Delete local file', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'main.py', exact: true }),
  ).toBeFocused();
  await page.getByLabel('Local draft name').fill('My copied experiment');
  await page
    .getByRole('button', { name: 'Update draft name', exact: true })
    .click();
  await expect(page.locator('.recovery-status')).toHaveText(
    /^Local recovery updated/,
  );
  let exported = await backup(page);
  expect(JSON.parse(exported).files).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'My copied experiment', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Python source for main.py')).toContainText(
    'from greeting import greet',
  );
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toHaveCount(0);
  const latestSource =
    'from greeting import greet\nprint(greet("River"))\n# revisited local route\n';
  await page.getByLabel('Python source for main.py').fill(latestSource);
  await expect(page.locator('.recovery-status')).toHaveText(
    /^Local recovery updated/,
  );
  await hub(page);
  await page.getByRole('link', { name: 'Open draft', exact: true }).click();
  await expect(page.getByLabel('Python source for main.py')).toContainText(
    '# revisited local route',
  );
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toHaveCount(0);
  exported = await backup(page);
  expect(
    (JSON.parse(exported).files as { path: string; source: string }[]).find(
      (file) => file.path === 'main.py',
    )?.source,
  ).toBe(latestSource);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await hub(page);
  await startDraft(page);
  await page.getByLabel('Code Along source backup').setInputFiles({
    name: 'round-trip.codealong.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exported),
  });
  await expect(
    page.getByRole('region', { name: 'Source preview' }),
  ).toContainText('My copied experiment');
  const preview = page.getByRole('region', {
    name: 'Source preview',
    exact: true,
  });
  await preview
    .getByRole('combobox', { name: 'Preview file', exact: true })
    .selectOption('greeting.py');
  const start = page.locator('summary').filter({ hasText: /^Start a draft$/ });
  await start.focus();
  await start.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Source preview' }),
  ).not.toBeVisible();
  await start.press('Enter');
  await expect(
    preview.getByRole('combobox', { name: 'Preview file', exact: true }),
  ).toHaveValue('greeting.py');
  await expect(start).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath('local-drafts-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('local-drafts-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark'),
  );
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    'rgb(17, 26, 22)',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh local list', exact: true }),
  ).toHaveCSS('background-color', 'rgb(24, 35, 29)');
  await expect(
    page.getByRole('button', { name: 'Create local draft', exact: true }),
  ).toHaveCSS('background-color', 'rgb(148, 215, 176)');
  await page.screenshot({
    path: test.info().outputPath('local-drafts-dark.png'),
    fullPage: true,
  });
  await page.evaluate(() =>
    document.documentElement.removeAttribute('data-theme'),
  );
  await page
    .getByRole('button', { name: 'Create local draft', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toBeVisible();
  expect(page.url()).not.toBe(firstUrl);
  expect(JSON.parse(await backup(page))).toEqual(JSON.parse(exported));
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText('Hello, River!');
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test('invalid backups leave storage unchanged and source previews cannot execute markup', async ({
  page,
  browserName,
}) => {
  await register(page, `import-${browserName}-${Date.now()}@example.test`);
  await hub(page);
  await startDraft(page);
  const archive = {
    version: 1,
    name: 'Imported text',
    runtime_id: core,
    entrypoint: 'main.py',
    files: [
      { path: 'main.py', source: 'print("<img src=x onerror=alert(1)>")\n' },
    ],
  };
  for (const input of [
    Buffer.from([255]),
    Buffer.from(
      JSON.stringify({ ...archive, runtime_id: 'download-any-package' }),
    ),
    Buffer.from(
      JSON.stringify({
        ...archive,
        files: [{ path: '../main.py', source: '' }],
      }),
    ),
    Buffer.from(JSON.stringify({ ...archive, token: 'forbidden-field' })),
  ]) {
    await page.getByLabel('Code Along source backup').setInputFiles({
      name: 'invalid.codealong.json',
      mimeType: 'application/json',
      buffer: input,
    });
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create local draft', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.local-draft-row')).toHaveCount(0);
  }
  await page.getByLabel('Code Along source backup').setInputFiles({
    name: 'safe-text.codealong.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  const preview = page.getByRole('region', { name: 'Source preview' });
  await expect(preview).toContainText('<img src=x onerror=alert(1)>');
  await expect(preview.locator('img,script,iframe')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Create local draft', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toHaveText(
    archive.files[0]!.source,
  );
  await expect(page.locator('.execution-status')).toHaveText('Ready to run');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('retained local drafts are account-scoped and confirmed deletion restores focus', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  const email = `local-owner-${browserName}-${Date.now()}@example.test`;
  await register(page, email);
  await template(page, 'Ask, then respond');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText(
    'Welcome, Python learner!',
  );
  const url = page.url();
  await openRecovery(page);
  await page
    .getByLabel('Keep my local drafts after sign out on this device.')
    .check();
  await expect(
    page.getByLabel('Keep my local drafts after sign out on this device.'),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('https://127.0.0.1:18443/');
  await register(page, `local-other-${browserName}-${Date.now()}@example.test`);
  await hub(page);
  await expect(page.locator('.local-draft-row')).toHaveCount(0);
  await page.goto(url);
  await expect(
    page.getByRole('heading', {
      name: 'Local draft unavailable.',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('https://127.0.0.1:18443/');
  await login(page, email);
  await page.goto(url);
  await expect(page.getByLabel('Python source for main.py')).toContainText(
    'def welcome',
  );
  await hub(page);
  await page.getByRole('button', { name: 'Delete copy', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this local copy?' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Delete copy', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Delete copy', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete this local copy?' })
    .getByRole('button', { name: 'Delete local copy', exact: true })
    .click();
  await expect(page.locator('.local-draft-row')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Refresh local list', exact: true }),
  ).toBeFocused();
  const optionTab = browserName === 'webkit' && process.platform === 'darwin';
  await page.keyboard.press(optionTab ? 'Alt+Shift+Tab' : 'Shift+Tab');
  // Focus can leave and return to the list after the deleted row's trigger disappears.
  await expect(
    page.getByRole('button', { name: 'Refresh local list', exact: true }),
  ).not.toBeFocused();
  await page.keyboard.press(optionTab ? 'Alt+Tab' : 'Tab');
  await expect(
    page.getByRole('button', { name: 'Refresh local list', exact: true }),
  ).toBeFocused();
});

test('a project local copy captures current edits and cannot alter the original project', async ({
  page,
  browserName,
}) => {
  await register(page, `fork-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  const original = page.url(),
    source = 'print("copied current text")\n';
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith('/api/v1/projects/') &&
      !(
        request.method() === 'POST' &&
        /^\/api\/v1\/projects\/[a-f0-9-]{36}\/documents\/[a-f0-9-]{36}\/ticket\/$/.test(
          path,
        )
      ) &&
      ['POST', 'PATCH', 'DELETE'].includes(request.method())
    )
      writes.push(request.method());
  });
  await page.getByLabel('Python source for main.py').fill(source);
  await expect(page.locator('.collaboration-status')).toHaveText('Saved');
  await openRecovery(page);
  await page
    .getByRole('button', { name: 'Open local copy', exact: true })
    .click();
  await expect(page).toHaveURL(/\/drafts\/[a-f0-9-]+$/);
  await expect(page.getByLabel('Python source for main.py')).toHaveText(source);
  await page
    .getByLabel('Python source for main.py')
    .fill('print("separate local edit")\n');
  await expect(page.locator('.recovery-status')).toHaveText(
    /^Local recovery updated/,
  );
  await page.goto(original);
  await expect(page.locator('.collaboration-status')).toHaveText('Saved');
  await openRecovery(page);
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toBeEnabled();
  expect(
    (JSON.parse(await backup(page)).files as { source: string }[])[0]!.source,
  ).toBe(source);
  await page
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toHaveText(source);
  expect(writes).toEqual([]);
});

test('the scientific template uses the reviewed NumPy runtime and produces a PNG', async ({
  page,
  browserName,
}) => {
  await register(page, `numbers-${browserName}-${Date.now()}@example.test`);
  await template(page, 'Find a pattern');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText('Mean: 4.8');
  await expect(
    page.getByRole('img', { name: 'Try changing these numbers', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.execution-provenance')).toContainText('NumPy');
});
