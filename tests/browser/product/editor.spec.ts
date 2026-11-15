import { test, expect } from '@playwright/test';
import {
  register,
  createEditorProject,
  openProjectSection,
  openEditorOptions,
} from './helpers.ts';

for (const keyboardPlatform of ['native', 'linux']) {
  test(`editing survives tab switches, rename/refetch and read-only transitions (${keyboardPlatform} keys)`, async ({
    page,
    browserName,
  }) => {
    if (keyboardPlatform === 'linux')
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64' });
      });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await register(page, `editor-${browserName}-${Date.now()}@example.test`);
    await createEditorProject(page);
    const modifier = await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
    );
    const source = page.getByLabel('Python source for main.py');
    const original = await source.innerText();
    const draft = 'from helper import answer\nprint("snow: 雪", answer)\n';
    await source.fill(draft);
    await expect(page.locator('.collaboration-status')).toHaveText('Saved');
    await source.press(`${modifier}+Home`);
    await source.press('ArrowRight');
    await source.press('ArrowRight');
    await expect(page.locator('.editor-status')).toContainText('Ln 1, Col 3');
    await page.getByRole('button', { name: 'Add file', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add a Python file' });
    await dialog.getByLabel('File path').fill('helper.py');
    await dialog.getByLabel('Starter source (optional)').fill('answer = 42\n');
    await dialog
      .getByRole('button', { name: 'Add Python file', exact: true })
      .click();
    await expect(page.getByLabel('Python source for helper.py')).toBeVisible();
    await page.getByRole('tab', { name: 'main.py' }).click();
    await expect(source).toHaveText(draft, { useInnerText: true });
    await expect(page.locator('.editor-status')).toContainText('Ln 1, Col 3');
    await source.press(`${modifier}+z`);
    await expect(source).toHaveText(original, { useInnerText: true });
    await source.press(`${modifier}+Shift+Z`);
    await expect(source).toHaveText(draft, { useInnerText: true });
    await source.fill('pri');
    await source.press('Control+Space');
    await expect(page.getByRole('option', { name: /^print\b/ })).toBeVisible();
    // CodeMirror intentionally ignores acceptance for 75ms after opening.
    await page.waitForTimeout(100);
    await source.press('Enter');
    await expect(source).toHaveText('print');
    await source.press('(');
    await expect(source).toHaveText('print()');
    await source.press(')');
    await expect(source).toHaveText('print()');
    await source.fill('student_name = "Ada"\nstu');
    await source.press('Control+Space');
    await expect(
      page.getByRole('option', { name: /^student_name\b/ }),
    ).toBeVisible();
    await source.press('Escape');
    await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
    await source.fill('def greet():');
    await source.press('Enter');
    await source.press('x');
    await expect(source).toHaveText('def greet():\n    x', {
      useInnerText: true,
    });
    await source.fill(draft);
    await page.getByRole('tab', { name: 'helper.py' }).click();
    await page.getByLabel('Python source for helper.py').fill('answer = 84\n');
    await page
      .getByRole('button', { name: 'Rename file', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Rename file' });
    await dialog.getByLabel('New file path').fill('lessons/helper.py');
    await dialog
      .getByRole('button', { name: 'Save file path', exact: true })
      .click();
    await expect(
      page.getByLabel('Python source for lessons/helper.py'),
    ).toHaveText('answer = 84\n');
    await page
      .getByRole('button', { name: 'Refresh project', exact: true })
      .click();
    await expect(
      page.getByLabel('Python source for lessons/helper.py'),
    ).toHaveText('answer = 84\n');
    const tab = page.getByRole('tab', { name: 'lessons/helper.py' });
    await tab.focus();
    await tab.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'main.py' })).toBeFocused();
    await page.getByRole('tab', { name: 'main.py' }).press('Delete');
    await expect(page.getByRole('tab', { name: 'main.py' })).toHaveCount(0);
    await page.getByRole('button', { name: 'main.py', exact: true }).click();
    await expect(source).toHaveText(draft, { useInnerText: true });
    await source.press('Tab');
    await expect(source).not.toBeFocused();
    const beforeOptions = await source.boundingBox();
    await openEditorOptions(page);
    const afterOptions = await source.boundingBox();
    expect(Math.abs(beforeOptions!.y - afterOptions!.y)).toBeLessThan(1);
    expect(Math.abs(beforeOptions!.height - afterOptions!.height)).toBeLessThan(
      1,
    );
    await page.getByLabel('Editor text size').selectOption('1.125rem');
    await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px');
    await page.getByLabel('Editor text size').press('Escape');
    await expect(page.locator('.editor-options')).not.toHaveAttribute(
      'open',
      '',
    );
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: test.info().outputPath('editor-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({
      path: test.info().outputPath('editor-desktop.png'),
      fullPage: true,
    });
    await page.evaluate(
      () => (document.documentElement.dataset.theme = 'dark'),
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.editor-workbench')).toHaveCSS(
      'background-color',
      'rgb(25, 35, 28)',
    );
    await page.screenshot({
      path: test.info().outputPath('editor-dark.png'),
      fullPage: true,
    });
    await openProjectSection(page, 'Settings');
    await page
      .getByRole('button', { name: 'Archive project', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm project archive', exact: true })
      .click();
    await openProjectSection(page, 'Code');
    await expect(source).toHaveAttribute('aria-readonly', 'true');
    await expect(source).toHaveText(draft, { useInnerText: true });
    await openProjectSection(page, 'Settings');
    await page
      .getByRole('button', { name: 'Restore project', exact: true })
      .click();
    await openProjectSection(page, 'Code');
    await expect(source).toHaveAttribute('aria-readonly', 'true');
    await page
      .getByRole('button', { name: 'Recheck access', exact: true })
      .click();
    await expect(page.locator('.collaboration-status')).toHaveText('Saved');
    await expect(source).toHaveAttribute('aria-readonly', 'false');
    await expect(source).toHaveText(draft, { useInnerText: true });
    expect(errors).toEqual([]);
  });
}
