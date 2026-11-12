import { test, expect } from '@playwright/test';
import process from 'node:process';
test('signed-out shell reflows and supports keyboard navigation', async ({
  page,
  browserName,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Your workspaces' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your workspaces' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('shell.png'),
    fullPage: true,
  });
  // Safari on macOS uses Option-Tab for links with its default keyboard setting.
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Tab'
      : 'Tab',
  );
  await expect(page.getByText('Skip to content')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await page.getByRole('link', { name: 'Sign in to Code Along' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page.goto('/missing-page');
  await expect(
    page.getByRole('heading', { name: "Let's get you back." }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});
test('dialog traps focus, closes by escape and restores trigger focus', async ({
  page,
}) => {
  await page.goto(
    'http://127.0.0.1:15174/iframe.html?id=code-along-primitives--accessible-dialog&viewMode=story',
  );
  const trigger = page.getByRole('button', {
    name: 'Invite member',
    exact: true,
  });
  await trigger.click();
  await expect(
    page.getByRole('dialog', { name: 'Invite a member' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Email address' }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: 'Close dialog' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('textbox', { name: 'Email address' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
