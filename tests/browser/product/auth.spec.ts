import { test, expect } from '@playwright/test';
import { register, mailLink, login } from './helpers.ts';
test('register, verify, login, logout and reset through real browser sessions', async ({
  page,
  browserName,
}) => {
  const email = `auth-${browserName}-${Date.now()}@example.test`;
  await register(page, email);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page.goto('/auth/forgot');
  await page.getByLabel('Email address').fill(email);
  await page
    .getByRole('button', { name: 'Send reset link', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
  await page.goto(await mailLink(email, 'reset'));
  await page
    .getByLabel('Password', { exact: true })
    .fill('new-orbit-river-copper-96!');
  await page
    .getByRole('button', { name: 'Set new password', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Your password has been changed.',
  );
  await login(page, email, 'new-orbit-river-copper-96!');
  const runner = await page.request.get('https://localhost:18443/api/v1/me/');
  expect(runner.status()).toBe(404);
});
