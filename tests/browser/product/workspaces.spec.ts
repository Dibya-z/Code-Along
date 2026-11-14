import { test, expect } from '@playwright/test';
import { register } from './helpers.ts';
test('create, rename, archive and restore a workspace', async ({
  page,
  browserName,
}) => {
  await register(page, `workspace-${browserName}-${Date.now()}@example.test`);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Create a workspace' });
  await dialog.getByLabel('Workspace name').fill('Python circle');
  await dialog
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Python circle', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('LEARNING WORKSPACE · OWNER')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Workspace name', { exact: true }),
  ).not.toBeVisible();
  const administration = page
    .locator('summary')
    .filter({ hasText: /^Workspace administration$/ });
  await administration.focus();
  await administration.press('Enter');
  await page
    .getByLabel('Workspace name', { exact: true })
    .fill('Weekend Python');
  await page
    .getByRole('button', { name: 'Save workspace name', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Weekend Python', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Archive workspace', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm archive', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).toContainText('archived');
  await page
    .getByRole('button', { name: 'Restore workspace', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Archive workspace', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: '← Your workspaces', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Weekend Python', exact: true }),
  ).toBeVisible();
});
