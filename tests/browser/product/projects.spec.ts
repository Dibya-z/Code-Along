import { test, expect } from '@playwright/test';
import { register } from './helpers.ts';
test('private project, scoped invitation, viewer/editor permissions and ownership', async ({
  page,
  browser,
  browserName,
}) => {
  const stamp = Date.now();
  const recipientEmail = `project-recipient-${browserName}-${stamp}@example.test`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await register(
    page,
    `project-owner-${browserName}-${stamp}@example.test`,
    'Mira',
  );
  const context = await browser.newContext({
    baseURL: 'https://127.0.0.1:18443',
    ignoreHTTPSErrors: true,
  });
  try {
    const recipient = await context.newPage();
    recipient.on('pageerror', (e) => errors.push(e.message));
    await register(recipient, recipientEmail, 'River');
    await page
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    const workspaceDialog = page.getByRole('dialog', {
      name: 'Create a workspace',
    });
    await workspaceDialog.getByLabel('Workspace name').fill('Python studio');
    await workspaceDialog
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Python studio', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Invite member', exact: true })
      .click();
    const invitation = page.getByRole('dialog', {
      name: 'Invite a workspace member',
    });
    await invitation.getByLabel('Recipient email').fill(recipientEmail);
    await invitation
      .getByRole('button', { name: 'Create invitation', exact: true })
      .click();
    const workspaceLink = page.getByLabel('Invitation link');
    await expect(workspaceLink).toBeVisible();
    await recipient.goto(await workspaceLink.inputValue());
    await recipient
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(
      recipient.getByRole('heading', { name: 'Python studio', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    const projectDialog = page.getByRole('dialog', {
      name: 'Create a Python project',
    });
    await projectDialog.getByLabel('Project name').fill('Loops together');
    await projectDialog
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Loops together', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Python source for main.py')).toContainText(
      'def greet',
    );
    const projectUrl = page.url();
    const projectId = new URL(projectUrl).pathname.split('/').at(-1);
    await recipient.goto(projectUrl);
    await expect(
      recipient.getByRole('heading', {
        name: 'Project unavailable.',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add file', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add a Python file' });
    await dialog.getByLabel('File path').fill('helper.py');
    await dialog.getByLabel('Starter source (optional)').fill('answer = 42\n');
    await dialog
      .getByRole('button', { name: 'Add Python file', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'helper.py', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Rename file', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Rename file' });
    await dialog.getByLabel('New file path').fill('lessons/helper.py');
    await dialog
      .getByRole('button', { name: 'Save file path', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'lessons/helper.py', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Create project invitation', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Invite to project' });
    await dialog.getByLabel('Member email').fill(recipientEmail);
    await dialog
      .getByRole('button', { name: 'Create project invitation', exact: true })
      .click();
    const projectLink = page.getByLabel('Project invitation link');
    await expect(projectLink).toBeVisible();
    const inviteUrl = await projectLink.inputValue();
    await recipient.goto(inviteUrl);
    await recipient
      .getByRole('button', { name: 'Join project', exact: true })
      .click();
    await expect(recipient.getByText('PYTHON PROJECT · VIEWER')).toBeVisible();
    await expect(
      recipient.getByRole('button', { name: 'Add file', exact: true }),
    ).toHaveCount(0);
    const meta = await (
      await recipient.request.get(`/api/v1/projects/${projectId}/`)
    ).json();
    const csrf = await (await recipient.request.get('/api/v1/csrf/')).json();
    const denied = await recipient.request.post(
      `/api/v1/projects/${projectId}/files/`,
      {
        headers: {
          Origin: 'https://127.0.0.1:18443',
          'X-CSRFToken': csrf.csrfToken,
        },
        data: { path: 'denied.py', expected_version: meta.metadata_version },
      },
    );
    expect(denied.status()).toBe(403);
    expect((await denied.json()).detail).toContain('project role');
    await page
      .getByLabel('Workspace member', { exact: true })
      .selectOption({ label: 'River' });
    await page
      .getByLabel('Project role', { exact: true })
      .selectOption('editor');
    await page
      .getByRole('button', { name: 'Grant project access', exact: true })
      .click();
    await expect(
      page
        .locator('.list-row')
        .filter({ hasText: 'River' })
        .getByText('editor', { exact: true }),
    ).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByText('PYTHON PROJECT · EDITOR')).toBeVisible();
    await expect(
      recipient.getByRole('button', { name: 'Add file', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Remove project access', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Remove project access', exact: true }),
    ).toHaveCount(0);
    await recipient.reload();
    await expect(
      recipient.getByRole('heading', {
        name: 'Project unavailable.',
        exact: true,
      }),
    ).toBeVisible();
    await recipient.goto(inviteUrl);
    await expect(recipient.getByRole('alert')).toContainText(
      'Invitation unavailable',
    );
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: test.info().outputPath('project.png'),
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Transfer project ownership', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Transfer project ownership' });
    await dialog
      .getByLabel('New project owner')
      .selectOption({ label: 'River' });
    await dialog
      .getByRole('button', { name: 'Confirm project transfer', exact: true })
      .click();
    await expect(page.getByText('PYTHON PROJECT · EDITOR')).toBeVisible();
    await recipient.goto(projectUrl);
    await expect(recipient.getByText('PYTHON PROJECT · OWNER')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
