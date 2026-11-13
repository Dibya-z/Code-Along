import { expect } from '@playwright/test';
import { test } from './offline-fixture.ts';
import { register, createEditorProject, finishedRun } from './helpers.ts';

for (const [kind, scientific] of [
  ['project', false],
  ['local draft', false],
  ['local draft', true],
] as const) {
  test(`a complete warmed ${scientific ? 'NumPy ' : ''}${kind} runs offline with fresh Python globals and files`, async ({
    page,
    browserName,
    context,
  }) => {
    test.setTimeout(90_000);
    await register(
      page,
      `offline-${scientific ? 'numpy-' : ''}${kind.replace(' ', '-')}-${browserName}-${Date.now()}@example.test`,
    );
    if (kind === 'project') await createEditorProject(page);
    else {
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Local drafts', exact: true })
        .click();
      await page
        .getByRole('button', {
          name: scientific
            ? 'Preview Find a pattern'
            : 'Preview A function, two files',
          exact: true,
        })
        .click();
      await page
        .getByRole('button', { name: 'Create local draft', exact: true })
        .click();
      await expect(page.getByLabel('Python source for main.py')).toBeVisible();
    }
    const editor = page.getByLabel('Python source for main.py');
    const source =
      (scientific
        ? 'import numpy as np\nprint("NumPy", int(np.arange(3).sum()))\n'
        : '') +
      'import os, builtins\nprint("fresh", hasattr(builtins, "practice_marker"), os.path.exists("scratch.txt"))\nbuiltins.practice_marker = 1\nwith open("scratch.txt", "w") as stream:\n    stream.write("one run")\nprint("offline candidate")\n';
    await editor.fill(source);
    await page.getByRole('button', { name: 'Run code', exact: true }).click();
    await finishedRun(page);
    await expect(page.getByLabel('Python output')).toContainText(
      'fresh False False',
    );
    const frame = await page
      .locator('iframe[title="Isolated Python runtime"]')
      .elementHandle();
    expect(frame).not.toBeNull();
    try {
      await context.setOffline(true);
      await expect(
        page.getByText('You are offline.', { exact: false }),
      ).toBeVisible();
      await editor.fill(
        source.replace('offline candidate', 'offline edited source'),
      );
      if (kind === 'project') {
        await page
          .getByRole('button', { name: 'Refresh project', exact: true })
          .click();
        await expect(
          page.getByRole('heading', {
            name: 'A small Python experiment',
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Add file', exact: true })
          .click();
        const dialog = page.getByRole('dialog', { name: 'Add a Python file' });
        await dialog
          .getByLabel('File path')
          .fill('offline_should_not_be_created.py');
        await dialog
          .getByRole('button', { name: 'Add Python file', exact: true })
          .click();
        await expect(dialog.getByRole('alert')).toContainText(
          'Could not connect',
        );
        await page.keyboard.press('Escape');
      }
      await expect(
        page.getByRole('button', { name: 'Run code', exact: true }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Run code', exact: true }).click();
      await finishedRun(page);
      await expect(page.getByLabel('Python output')).toContainText(
        'fresh False False',
      );
      await expect(page.getByLabel('Python output')).toContainText(
        'offline edited source',
      );
      expect(await frame!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      await expect(
        page.locator('iframe[title="Isolated Python runtime"]'),
      ).toHaveCount(1);
      await page.getByRole('button', { name: 'Run code', exact: true }).click();
      await finishedRun(page);
      await expect(page.getByLabel('Python output')).toContainText(
        'fresh False False',
      );
      if (scientific)
        await expect(page.getByLabel('Python output')).toContainText('NumPy 3');
      if (kind === 'local draft') {
        await editor.fill(
          'import builtins\nbuiltins.practice_marker = 1\nraise ValueError("fix me offline")\n',
        );
        await page
          .getByRole('button', { name: 'Run code', exact: true })
          .click();
        await expect(page.locator('.execution-status')).toHaveText(
          'Run failed',
          { timeout: 30_000 },
        );
        await expect(page.getByLabel('Python output')).toContainText(
          'fix me offline',
        );
        await editor.fill(source);
        await page
          .getByRole('button', { name: 'Run code', exact: true })
          .click();
        await finishedRun(page);
        await expect(page.getByLabel('Python output')).toContainText(
          'fresh False False',
        );
        await editor.fill('while True:\n    pass\n');
        await page
          .getByRole('button', { name: 'Run code', exact: true })
          .click();
        await expect(page.locator('.execution-status')).toHaveText('Running', {
          timeout: 30_000,
        });
        await page
          .getByRole('button', { name: 'Stop run', exact: true })
          .click();
        await expect(page.locator('.execution-status')).toHaveText(
          'Run stopped',
        );
        await expect(
          page.locator('iframe[title="Isolated Python runtime"]'),
        ).toHaveCount(0);
      }
    } finally {
      await context.setOffline(false);
    }
    if (kind === 'project') {
      await page
        .getByRole('button', { name: 'Refresh project', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Refresh project', exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole('button', {
          name: 'offline_should_not_be_created.py',
          exact: true,
        }),
      ).toHaveCount(0);
    }
  });
}
