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
      page.getByRole('heading', { name: /Write Python\.\s*Learn together\./ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /Write Python\.\s*Learn together\./ }),
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
  await page
    .getByRole('link', { name: 'Open your workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page.goto('/missing-page');
  await expect(
    page.getByRole('heading', { name: "Let's get you back." }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});
test('appearance preference survives reload and unavailable storage stays optional', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Switch to dark theme', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Switch to light theme', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page
    .getByRole('button', { name: 'Switch to light theme', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.evaluate(() => {
    document.documentElement.dataset['theme'] = 'dark';
  });
  await page
    .getByRole('button', { name: 'Switch to light theme', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException(
          'Preference storage unavailable.',
          'SecurityError',
        );
      },
    });
  });
  await page.reload();
  await page
    .getByRole('button', { name: 'Switch to dark theme', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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
