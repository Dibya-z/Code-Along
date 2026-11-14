import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createEditorProject,
  openProjectSection,
  openRecovery,
  openRunOptions,
  register,
  showFiles,
} from './helpers.ts';

async function downloadSource(page: Page) {
  const summary = page.locator('.local-recovery summary');
  const wasOpen = await summary.evaluate(
    (element) => (element.parentElement as HTMLDetailsElement).open,
  );
  await openRecovery(page);
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download open file', exact: true })
    .click();
  const source = await readFile((await (await downloading).path())!, 'utf8');
  if (!wasOpen) await summary.click();
  return source;
}

async function settledFocus(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const element = document.activeElement;
    return {
      tag: element?.tagName,
      id: element?.id,
      label: element?.getAttribute('aria-label'),
    };
  });
}

test('project tasks retain source, undo, a waiting run and discussion draft while controls stay reachable', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET') reads.push(new URL(request.url()).pathname);
  });
  await register(page, `nav-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  await expect(page.locator('.collaboration-status')).toHaveText('Saved');
  const projectPath = `/api/v1${new URL(page.url()).pathname}/`;
  expect(reads.filter((path) => path === `${projectPath}revisions/`)).toEqual(
    [],
  );
  expect(reads.filter((path) => path === `${projectPath}shares/`)).toEqual([]);
  expect(reads.filter((path) => path === `${projectPath}grants/`)).toEqual([]);
  const editor = page.getByLabel('Python source for main.py');
  const navigation = page.getByRole('navigation', {
    name: 'Project sections',
    exact: true,
  });
  const initialUrl = page.url();
  const initialHistory = await page.evaluate(() => history.length);
  await navigation.getByRole('link', { name: 'Code', exact: true }).click();
  await editor.focus();
  test.info().annotations.push({
    type: 'active-code-focus',
    description: JSON.stringify(await settledFocus(page)),
  });
  await expect(editor).toBeFocused();
  expect(page.url()).toBe(initialUrl);
  expect(await page.evaluate(() => history.length)).toBe(initialHistory);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(editor).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath('tasks-desktop.png'),
    fullPage: true,
  });
  const mobileStarts: { width: number; y: number }[] = [];
  for (const [width, height] of [
    [390, 844],
    [320, 800],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.evaluate(() => window.scrollTo(0, 0));
    const line = page.locator('.cm-line').first();
    const y = (await line.boundingBox())!.y;
    mobileStarts.push({ width: width!, y });
    test.info().annotations.push({
      type: 'default-code-position',
      description: `${width}x${height}: ${y}px`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`tasks-${width}.png`),
      fullPage: true,
    });
    await expect(line).toBeInViewport();
    await showFiles(page);
    await expect(
      page.getByRole('button', { name: 'Add file', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'main.py', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Hide files', exact: true }).click();
  }
  for (const { width, y } of mobileStarts)
    expect(y, `First code line at ${width}px`).toBeLessThan(700);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const original = await downloadSource(page);
  const source =
    'print("before input")\nname = input("Name: ")\nprint("Hello", name)\n';
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await navigation.getByRole('link', { name: 'Code', exact: true }).click();
  await editor.press(`${modifier}+a`);
  await page.keyboard.insertText(source.slice(0, -1));
  await editor.press('Enter');
  test.info().annotations.push({
    type: 'active-code-edit-focus',
    description: JSON.stringify(await settledFocus(page)),
  });
  await expect(editor).toBeFocused();
  expect(await downloadSource(page)).toBe(source);
  await editor.press(`${modifier}+Home`);
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await expect(page.locator('.editor-status')).toContainText('Ln 1, Col 3');
  await expect(page.locator('.collaboration-status')).toHaveText('Saved');
  const discussionLink = page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Discussion', exact: true });
  await discussionLink.focus();
  await discussionLink.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Discussion', exact: true }),
  ).toBeFocused();
  await expect
    .poll(async () => {
      const heading = await page
        .getByRole('heading', { name: 'Discussion', exact: true })
        .boundingBox();
      const bar = await page.locator('.project-command-bar').boundingBox();
      return !!heading && !!bar && heading.y >= bar.y + bar.height - 1;
    })
    .toBe(true);
  await page
    .getByLabel('Message to project')
    .fill('Keep this unsent discussion draft');
  await openProjectSection(page, 'History');
  await expect(
    page.getByText('No named revisions yet.', { exact: true }),
  ).toBeVisible();
  expect(
    reads.filter((path) => path === `${projectPath}revisions/`).length,
  ).toBeGreaterThan(0);
  await expect(page.locator('.collaboration-status')).toBeVisible();
  await openProjectSection(page, 'Sharing');
  await expect(
    page.getByRole('heading', { name: 'Project access', exact: true }),
  ).toBeVisible();
  await openProjectSection(page, 'Settings');
  await page
    .getByLabel('Project name', { exact: true })
    .fill('An unsaved project name');
  await openProjectSection(page, 'Discussion');
  await expect(page.getByLabel('Message to project')).toHaveValue(
    'Keep this unsent discussion draft',
  );
  await openProjectSection(page, 'Settings');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'An unsaved project name',
  );
  await page.getByLabel('Project name', { exact: true }).focus();
  await page.goBack();
  await expect(
    page.getByRole('region', { name: 'Discussion', exact: true }),
  ).toBeFocused();
  await page.goForward();
  await expect(page.locator('#settings')).toBeFocused();
  await openProjectSection(page, 'Code');
  await expect(page.locator('.editor-status')).toContainText('Ln 1, Col 3');
  await editor.press(`${modifier}+z`);
  expect(await downloadSource(page)).toBe(original);
  await editor.press(`${modifier}+Shift+Z`);
  expect(await downloadSource(page)).toBe(source);
  await openRunOptions(page);
  await page.getByLabel('Python input mode').selectOption('interactive');
  await openProjectSection(page, 'History');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Project sections' })
      .getByRole('link', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.execution-status')).toHaveText(
    'Waiting for input',
    { timeout: 40_000 },
  );
  const frame = await page
    .locator('iframe[title="Isolated Python runtime"]')
    .elementHandle();
  expect(frame).not.toBeNull();
  await openProjectSection(page, 'History');
  await expect(
    page.getByRole('button', { name: 'Stop run', exact: true }),
  ).toBeEnabled();
  await openProjectSection(page, 'Discussion');
  await expect(page.getByLabel('Message to project')).toHaveValue(
    'Keep this unsent discussion draft',
  );
  await openProjectSection(page, 'Code');
  await page.getByLabel('Input for Python', { exact: true }).fill('River');
  await page.getByRole('button', { name: 'Send input', exact: true }).click();
  await expect(page.locator('.execution-status')).toHaveText('Run finished');
  await expect(page.getByLabel('Python output')).toContainText('Hello River');
  expect(await frame!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(
    page.locator('iframe[title="Isolated Python runtime"]'),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(
    page.getByRole('button', { name: 'Refresh project', exact: true }),
  ).toHaveCSS('background-color', 'rgb(24, 35, 29)');
  await page.screenshot({
    path: test.info().outputPath('tasks-dark.png'),
    fullPage: true,
  });
  await openProjectSection(page, 'History');
  expect(await downloadSource(page)).toBe(source);
  await expect(
    page.getByRole('button', { name: 'Run code', exact: true }),
  ).toBeVisible();
  await openProjectSection(page, 'Code');
  for (const terminalLines of [1, 2]) {
    const bytes = 'print("active navigation")' + '\n'.repeat(terminalLines);
    await navigation.getByRole('link', { name: 'Code', exact: true }).click();
    await editor.press(`${modifier}+a`);
    await page.keyboard.insertText('print("active navigation")');
    for (let line = 0; line < terminalLines; line++)
      await editor.press('Enter');
    test.info().annotations.push({
      type: `active-code-${terminalLines}-lf-focus`,
      description: JSON.stringify(await settledFocus(page)),
    });
    await expect(editor).toBeFocused();
    expect(await downloadSource(page)).toBe(bytes);
    await expect(page.locator('.collaboration-status')).toHaveText('Saved');
  }
});
