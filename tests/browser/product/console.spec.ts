import { test, expect } from '@playwright/test';
import {
  register,
  createEditorProject,
  runtimeDiagnostics,
  finishedRun,
  openRunOptions,
} from './helpers.ts';
test('safe coalesced console, output paging, immutable source and interactive input', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  runtimeDiagnostics(page);
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, `console-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  const editor = page.getByLabel('Python source for main.py'),
    output = page.getByLabel('Python output'),
    status = page.locator('.execution-status');
  await editor.fill(
    'import sys\nsys.stdout.write("Hel")\nsys.stdout.flush()\nsys.stdout.write("lo\\n")\nprint("\\x1b[31m<img src=x onerror=alert(1)>\\x1b[0m")\nprint("problem", file=sys.stderr)\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(output).toContainText('Hello');
  await expect(output).toContainText('<img src=x onerror=alert(1)>');
  await expect(output.locator('img')).toHaveCount(0);
  expect(await output.innerText()).not.toContain('\x1b');
  await expect(output.getByLabel('Standard error')).toBeVisible();
  await page.getByText('View captured source', { exact: true }).click();
  await editor.fill('for i in range(600): print("line", i)\n');
  await expect(page.locator('.execution-provenance')).toContainText(
    'Earlier source',
  );
  await expect(page.locator('.captured-source')).toContainText('sys.stdout');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await finishedRun(page);
  await expect(output.locator('.console-line')).toHaveCount(200);
  await expect(output).toContainText('line 599');
  await page
    .getByRole('button', { name: 'Earlier output', exact: true })
    .click();
  await expect(output).not.toContainText('line 599');
  await page
    .getByRole('button', { name: 'Follow latest output', exact: true })
    .click();
  await expect(output).toContainText('line 599');
  await page.getByRole('button', { name: 'Clear output', exact: true }).click();
  await expect(output.locator('.console-line')).toHaveCount(0);
  await openRunOptions(page);
  await page.getByLabel('Python input mode').selectOption('interactive');
  await editor.fill(
    'name = input("Name: ")\nprint("Hello", name)\ntry:\n    input("Next: ")\nexcept EOFError:\n    print("EOF received")\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText('Waiting for input', { timeout: 40_000 });
  await expect(output).toContainText('Name:');
  await page.getByLabel('Input for Python', { exact: true }).fill('River');
  await page.getByRole('button', { name: 'Send input', exact: true }).click();
  await expect(output).toContainText('Hello River');
  await expect(status).toHaveText('Waiting for input');
  await page
    .getByRole('button', { name: 'Send end of input', exact: true })
    .click();
  await expect(status).toHaveText('Run finished');
  await expect(output).toContainText('EOF received');
  await editor.fill(
    'import time\nfor i in range(400):\n    print("reading", i, flush=True)\n    time.sleep(0.02)\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(output).toContainText('reading 40', {
    timeout: 40_000,
  });
  await output.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(
    page.getByRole('button', { name: 'Follow latest output', exact: true }),
  ).toBeVisible();
  await expect(output).toContainText('reading 80');
  expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(status).toHaveText('Run stopped');
  expect(errors).toEqual([]);
});
