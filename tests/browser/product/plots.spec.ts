import { test, expect } from '@playwright/test';
import { register, createEditorProject } from './helpers.ts';
test('bounded original PNG helpers, fresh plots and responsive retained panes', async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await register(page, `plots-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  const editor = page.getByLabel('Python source for main.py'),
    status = page.locator('.execution-status'),
    output = page.getByLabel('Python output');
  await editor.fill(
    'from code_along import plot\nprint("before plot")\nplot([1, 4, 2, 7, 5], title="My first line plot")\nprint("after plot")\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText(/^Run (finished|failed)$/, {
    timeout: 40_000,
  });
  await expect(status, await output.innerText()).toHaveText('Run finished');
  await expect(output).toContainText('before plot');
  await expect(output).toContainText('after plot');
  const image = page.getByRole('img', {
    name: 'My first line plot',
    exact: true,
  });
  await expect(image).toBeVisible();
  expect(
    await image.evaluate(
      (element) => (element as HTMLImageElement).naturalWidth,
    ),
  ).toBe(640);
  const previousUrl = await image.getAttribute('src');
  const sourceBox = await page.locator('.editor-pane').boundingBox(),
    outputBox = await output.boundingBox();
  expect(
    sourceBox && outputBox && sourceBox.x + sourceBox.width <= outputBox.x,
  ).toBe(true);
  await page.getByLabel('Console width', { exact: false }).focus();
  await page.keyboard.press('ArrowRight');
  await page.screenshot({
    path: testInfo.outputPath('workbench-desktop.png'),
    fullPage: true,
  });
  await expect(output).toHaveCount(1);
  await page.evaluate(
    () => (document.documentElement.dataset['theme'] = 'dark'),
  );
  await expect(
    page.getByRole('button', { name: 'Refresh project', exact: true }),
  ).toHaveCSS('background-color', 'rgb(24, 35, 29)');
  await page.screenshot({
    path: testInfo.outputPath('workbench-dark.png'),
    fullPage: true,
  });
  await page.evaluate(() => delete document.documentElement.dataset['theme']);
  for (const width of [1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(editor).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Stop run', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('My first line plot');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(image).toBeVisible();
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.screenshot({
    path: testInfo.outputPath('workbench-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await editor.fill(
    'from code_along import display_png\ndisplay_png(b"<svg onload=alert(1) />")\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText('Run failed', { timeout: 40_000 });
  await expect(page.getByLabel('Python plots')).toHaveCount(0);
  expect(
    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(false);
          image.onerror = () => resolve(true);
          image.src = url!;
        }),
      previousUrl,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await editor.fill(
    'from code_along import plot\nfor i in range(5):\n    plot([i, i + 1], title=f"Plot {i}")\n',
  );
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(status).toHaveText('Run failed', { timeout: 40_000 });
  await expect(page.getByLabel('Python plots').locator('img')).toHaveCount(4);
  await expect(output).toContainText('Plot limit');
  expect(errors).toEqual([]);
});
