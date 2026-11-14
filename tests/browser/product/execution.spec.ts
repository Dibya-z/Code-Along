import { test, expect } from '@playwright/test';
import {
  register,
  createEditorProject,
  runtimeDiagnostics,
  finishedRun,
  openRunOptions,
} from './helpers.ts';
test('frozen multi-file Python runs, fresh globals/files, batch stdin and errors', async ({
  page,
  browserName,
}) => {
  const errors: string[] = [];
  runtimeDiagnostics(page);
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, `execution-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  await expect(page.locator('meta[name="runner-origin"]')).toHaveAttribute(
    'content',
    'https://localhost:18443',
  );
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a Python file' });
  await dialog.getByLabel('File path').fill('helper.py');
  await dialog.getByLabel('Starter source (optional)').fill('answer = 42\n');
  await dialog
    .getByRole('button', { name: 'Add Python file', exact: true })
    .click();
  await expect(page.getByLabel('Python source for helper.py')).toBeVisible();
  await page.getByLabel('Python source for helper.py').fill('answer = 84\n');
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const editor = page.getByLabel('Python source for main.py');
  const source =
    'from helper import answer\nimport os, js\nprint("answer", answer)\nprint("isolated", bool(js.crossOriginIsolated))\nprint("fresh", "marker" in globals(), os.path.exists("scratch.txt"))\nmarker = 1\nwith open("scratch.txt", "w") as stream:\n    stream.write("local")\n';
  const output = page.getByLabel('Python output');
  const status = page.locator('.execution-status');
  await editor.fill(source);
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await editor.fill('print("edited during the run")\n');
  await finishedRun(page);
  await expect(output).toContainText('answer 84');
  await expect(output).toContainText('isolated True');
  await expect(output).toContainText('fresh False False');
  await expect(output).not.toContainText('edited during');
  await expect(page.locator('.execution-provenance')).toContainText(
    'Earlier source',
  );
  await expect(page.locator('.execution-provenance')).toContainText(
    'Python 3.14.2',
  );
  await editor.fill(source);
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(output).toContainText('fresh False False');
  await expect(page.locator('.execution-provenance')).not.toContainText(
    'Earlier source',
  );
  await editor.fill('name = input("Name: ")\nprint("Hello", name)\n');
  await openRunOptions(page);
  await page.getByLabel('Input before Run').fill('River');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(output).toContainText('Hello River');
  await editor.fill('raise ValueError("learning error")\n');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText('Run failed', { timeout: 40_000 });
  await expect(output).toContainText('ValueError: learning error');
  await expect(output.getByLabel('Standard error').first()).toBeVisible();
  await editor.fill(source);
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(output).toContainText('fresh False False');
  await expect(
    page.locator('iframe[title="Isolated Python runtime"]'),
  ).toHaveCount(1);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: test.info().outputPath('execution.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
