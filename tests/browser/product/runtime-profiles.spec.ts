import { test, expect } from '@playwright/test';
import { register, createEditorProject, openRunOptions } from './helpers.ts';
test('scientific packages are opt-in, pinned, self-hosted and fresh per run', async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.whl'))
      requests.push(request.url());
  });
  await register(page, `profiles-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  const source = page.getByLabel('Python source for main.py'),
    output = page.getByLabel('Python output'),
    status = page.locator('.execution-status');
  await source.fill('import numpy\nprint(numpy.arange(4).sum())\n');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText('Run failed', { timeout: 40_000 });
  await expect(output).toContainText('ModuleNotFoundError');
  expect(requests).toEqual([]);
  await openRunOptions(page);
  await page
    .getByLabel('Python environment')
    .selectOption('pyodide-314.0.7-scientific');
  await source.fill(
    'import numpy as np\nprint("sum", np.arange(4).sum())\nprint("mean", np.array([2, 4, 6]).mean())\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText(/^Run (finished|failed)$/, {
    timeout: 40_000,
  });
  await expect(status, await output.innerText()).toHaveText('Run finished');
  await expect(output).toContainText('sum 6');
  await expect(output).toContainText('mean 4.0');
  await expect(page.locator('.execution-provenance')).toContainText('NumPy');
  await page.screenshot({
    path: testInfo.outputPath('numpy-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('numpy-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  expect(requests.length).toBe(1);
  expect(
    requests.every((url) =>
      url.startsWith(
        'https://localhost:18443/runtime/v2/eb2bfd5f172ccce38411575452b4c723f939a14e095a94a612fb1f9d5fdf21ea/',
      ),
    ),
  ).toBe(true);
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  const project = await (
    await page.request.get(`/api/v1/projects/${projectId}/`)
  ).json();
  expect(project.runtime_id).toBe('pyodide-314.0.7-core');
  expect(project.metadata_version).toBe(1);
  await page.getByLabel('Python environment').selectOption('');
  await source.fill('import numpy\n');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText('Run failed', { timeout: 40_000 });
  await expect(output).toContainText('ModuleNotFoundError');
});
