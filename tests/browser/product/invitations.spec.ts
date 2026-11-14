import { test, expect } from '@playwright/test';
import { openWorkspaceMembers, register } from './helpers.ts';
test('a recipient joins by invitation and removal invalidates the old link', async ({
  page,
  browser,
  browserName,
}) => {
  const stamp = Date.now();
  const recipientEmail = `invite-recipient-${browserName}-${stamp}@example.test`;
  await register(
    page,
    `invite-owner-${browserName}-${stamp}@example.test`,
    'Mira',
  );
  const context = await browser.newContext({
    baseURL: 'https://127.0.0.1:18443',
    ignoreHTTPSErrors: true,
  });
  try {
    const recipient = await context.newPage();
    await register(recipient, recipientEmail, 'River');
    await page
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    const create = page.getByRole('dialog', { name: 'Create a workspace' });
    await create.getByLabel('Workspace name').fill('Shared learning');
    await create
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Shared learning', exact: true }),
    ).toBeVisible();
    await openWorkspaceMembers(page);
    await page
      .getByRole('button', { name: 'Invite member', exact: true })
      .click();
    const invite = page.getByRole('dialog', {
      name: 'Invite a workspace member',
    });
    await invite.getByLabel('Recipient email').fill(recipientEmail);
    await invite
      .getByRole('button', { name: 'Create invitation', exact: true })
      .click();
    const link = page.getByLabel('Invitation link');
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await recipient.goto(url);
    await recipient
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(
      recipient.getByRole('heading', { name: 'Shared learning', exact: true }),
    ).toBeVisible();
    await expect(
      recipient.getByText('LEARNING WORKSPACE · LEARNER'),
    ).toBeVisible();
    await recipient.goto(url);
    await expect(
      recipient.getByRole('button', { name: 'Open workspace', exact: true }),
    ).toBeVisible();
    await page.reload();
    await openWorkspaceMembers(page);
    await page
      .getByRole('button', { name: 'Remove member', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm removal', exact: true })
      .click();
    await expect(
      page.locator('.list-row').filter({ hasText: 'River' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await recipient.goto(url);
    await expect(recipient.getByRole('alert')).toContainText(
      'Invitation unavailable',
    );
    await expect(
      recipient.getByRole('button', { name: 'Join workspace', exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
