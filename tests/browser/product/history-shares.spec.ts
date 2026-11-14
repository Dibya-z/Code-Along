import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createEditorProject,
  finishedRun,
  openProjectSection,
  openRecovery,
  openWorkspaceMembers,
  register,
} from './helpers.ts';

const editor = (page: Page) =>
  page.getByRole('textbox', { name: 'Python source for main.py', exact: true });
const saved = (page: Page) =>
  expect(page.locator('.collaboration-status')).toHaveText('Saved', {
    timeout: 15000,
  });
async function replace(page: Page, source: string) {
  await openProjectSection(page, 'Code');
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await editor(page).press(`${modifier}+a`);
  const terminalLines = source.match(/\n+$/)?.[0].length ?? 0;
  const body = terminalLines ? source.slice(0, -terminalLines) : source;
  if (body) await page.keyboard.insertText(body);
  else await page.keyboard.press('Backspace');
  // Use real Enter actions for terminal line breaks rather than native contenteditable placeholder BRs.
  for (let line = 0; line < terminalLines; line++)
    await page.keyboard.press('Enter');
}
async function exported(page: Page, name = 'Export current code') {
  if (name === 'Export current code') {
    await openProjectSection(page, 'Code');
    await openRecovery(page);
  } else if (name === 'Export revision source')
    await openProjectSection(page, 'History');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return JSON.parse(
    await readFile((await (await pending).path())!, 'utf8'),
  ) as {
    name: string;
    entrypoint: string;
    files: { path: string; source: string }[];
  };
}
async function exactSource(page: Page, source: string) {
  await expect
    .poll(
      async () =>
        (await exported(page)).files.find((file) => file.path === 'main.py')!
          .source,
      { timeout: 20000 },
    )
    .toBe(source);
}
async function capture(page: Page, name: string) {
  await openProjectSection(page, 'History');
  await page.getByLabel('Revision name', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Capture shared revision', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: `Frozen source: ${name}`, exact: true }),
  ).toBeVisible();
}
async function share(
  page: Page,
  kind: 'live' | 'snapshot',
  options: {
    scope?: 'read' | 'write';
    revision?: string;
    recipient?: string;
  } = {},
) {
  await openProjectSection(page, 'Sharing');
  await page.getByLabel('Link type', { exact: true }).selectOption(kind);
  if (kind === 'snapshot')
    await page
      .getByLabel('Frozen revision', { exact: true })
      .selectOption({ label: options.revision! });
  else
    await page
      .getByLabel('Source access', { exact: true })
      .selectOption(options.scope ?? 'read');
  await page
    .getByLabel('Recipient (optional)', { exact: true })
    .selectOption(options.recipient ? { label: options.recipient } : '');
  await page
    .getByRole('button', { name: 'Create shared link', exact: true })
    .click();
  await expect(
    page.getByLabel('New shared link', { exact: true }),
  ).toBeVisible();
  const url = await page
    .getByLabel('New shared link', { exact: true })
    .inputValue();
  expect(new URL(url).pathname).toBe('/shares');
  expect(new URL(url).search).toBe('');
  expect(new URL(url).hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
  await page
    .getByRole('button', { name: 'Dismiss shared link', exact: true })
    .click();
  return url;
}
async function ownerProject(page: Page, prefix: string, browserName: string) {
  await register(
    page,
    `${prefix}-${browserName}-${randomUUID()}@example.test`,
    'Mira',
  );
  await createEditorProject(page);
  return {
    url: page.url(),
    projectId: new URL(page.url()).pathname.split('/').at(-1)!,
  };
}
async function memberWithoutGrant(
  owner: Page,
  browser: Browser,
  browserName: string,
) {
  const context = await browser.newContext({
    baseURL: new URL(owner.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const peer = await context.newPage(),
      email = `capability-${browserName}-${randomUUID()}@example.test`;
    await register(peer, email, 'River');
    const url = owner.url();
    await owner.getByRole('link', { name: '← Workspace', exact: true }).click();
    await openWorkspaceMembers(owner);
    await owner
      .getByRole('button', { name: 'Invite member', exact: true })
      .click();
    const dialog = owner.getByRole('dialog', {
      name: 'Invite a workspace member',
    });
    await dialog.getByLabel('Recipient email').fill(email);
    await dialog
      .getByRole('button', { name: 'Create invitation', exact: true })
      .click();
    await expect(owner.getByLabel('Invitation link')).toBeVisible();
    await peer.goto(await owner.getByLabel('Invitation link').inputValue());
    await peer
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await owner.goto(url);
    return { peer, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}
function ordinaryRequests(page: Page, projectId: string) {
  const paths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith(`/api/v1/projects/${projectId}/`) &&
      !/^\/api\/v1\/projects\/[^/]+\/documents\/[^/]+\/ticket\/$/.test(path)
    )
      paths.push(path);
  });
  return paths;
}
async function noStoredCapability(page: Page, token: string) {
  expect(
    await page.evaluate(async (secret) => {
      if (
        [...Object.values(localStorage), ...Object.values(sessionStorage)].some(
          (value) => value.includes(secret),
        )
      )
        return false;
      const databases = await indexedDB.databases();
      return !databases.some(
        (database) => database.name === 'code-along-local',
      );
    }, token),
  ).toBe(true);
}

test('named shared revisions survive a lost response, later edits, and create a new project with fresh identities', async ({
  page,
  browserName,
}) => {
  test.setTimeout(120000);
  const original = await ownerProject(page, 'revision', browserName);
  const oldSource = 'print("frozen revision 🐍")\n';
  await replace(page, oldSource);
  await saved(page);
  await exactSource(page, oldSource);
  const nonces: string[] = [];
  let drop = true;
  await page.route(
    `**/api/v1/projects/${original.projectId}/revisions/`,
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      nonces.push(
        (route.request().postDataJSON() as { client_request_id: string })
          .client_request_id,
      );
      if (!drop) return route.continue();
      drop = false;
      await route.fetch();
      await route.abort('failed');
    },
  );
  await openProjectSection(page, 'History');
  await page
    .getByLabel('Revision name', { exact: true })
    .fill('Before refactoring');
  await page
    .getByRole('button', { name: 'Capture shared revision', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Retry same capture', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry same capture', exact: true })
    .click();
  await expect(
    page.getByRole('region', {
      name: 'Frozen source: Before refactoring',
      exact: true,
    }),
  ).toBeVisible();
  expect(nonces).toHaveLength(2);
  expect(nonces[0]).toBe(nonces[1]);
  const revisions = (await (
    await page.request.get(`/api/v1/projects/${original.projectId}/revisions/`)
  ).json()) as { count: number };
  expect(revisions.count).toBe(1);
  await replace(page, 'print("later live source")\n');
  await saved(page);
  await openProjectSection(page, 'History');
  expect(
    await page
      .getByLabel('Frozen Python source for main.py', { exact: true })
      .textContent(),
  ).toBe(oldSource);
  expect(
    (await exported(page, 'Export revision source')).files[0]!.source,
  ).toBe(oldSource);
  await page.screenshot({
    path: test.info().outputPath('history-desktop.png'),
    fullPage: true,
  });
  await page.getByLabel('Copied project name').fill('From frozen revision');
  await page
    .getByRole('button', { name: 'Copy revision to new project', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}$/);
  await expect.poll(() => page.url()).not.toBe(original.url);
  await exactSource(page, oldSource);
  const copiedId = new URL(page.url()).pathname.split('/').at(-1)!;
  const before = (await (
    await page.request.get(`/api/v1/projects/${original.projectId}/files/`)
  ).json()) as { items: { id: string; document_id: string }[] };
  const after = (await (
    await page.request.get(`/api/v1/projects/${copiedId}/files/`)
  ).json()) as typeof before;
  expect(after.items[0]!.id).not.toBe(before.items[0]!.id);
  expect(after.items[0]!.document_id).not.toBe(before.items[0]!.document_id);
  const originalTab = await page.context().newPage();
  try {
    await originalTab.goto(original.url);
    await exactSource(originalTab, 'print("later live source")\n');
  } finally {
    await originalTab.close();
  }
});

test('snapshot links open anonymously without live transport, enforce recipients and retain exact exported frozen bytes', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const original = await ownerProject(page, 'snapshot', browserName),
    frozen = 'print("snapshot only")\n';
  await replace(page, frozen);
  const liveBefore = (await exported(page)).files[0]!.source;
  expect(liveBefore).toBe(frozen);
  await saved(page);
  await capture(page, 'For review');
  const frozenBefore = (await exported(page, 'Export revision source'))
    .files[0]!.source;
  expect(frozenBefore).toBe(frozen);
  const link = await share(page, 'snapshot', { revision: 'For review' });
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const visitor = await context.newPage(),
      privatePaths = ordinaryRequests(visitor, original.projectId),
      sockets: string[] = [];
    visitor.on('websocket', (socket) =>
      sockets.push(new URL(socket.url()).pathname),
    );
    await visitor.goto(link);
    await expect(
      visitor.getByLabel('Frozen Python source for main.py', { exact: true }),
    ).toHaveText(frozen);
    expect(
      (await exported(visitor, 'Export revision source')).files[0]!.source,
    ).toBe(frozen);
    await expect(
      visitor.getByRole('button', { name: 'Run code', exact: true }),
    ).toHaveCount(0);
    await expect(
      visitor.getByRole('heading', { name: 'Project access', exact: true }),
    ).toHaveCount(0);
    expect(privatePaths).toEqual([]);
    expect(sockets).toEqual([]);
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.screenshot({
      path: test.info().outputPath('snapshot-mobile.png'),
      fullPage: true,
    });
    await visitor.mouse.move(0, 0);
    await visitor.evaluate(
      () => (document.documentElement.dataset['theme'] = 'dark'),
    );
    await expect(
      visitor.getByRole('button', { name: 'Recheck shared link', exact: true }),
    ).toHaveCSS('background-color', 'rgb(24, 35, 29)');
    await expect(
      visitor.getByLabel('Frozen Python source for main.py', { exact: true }),
    ).toHaveCSS('color', 'rgb(237, 242, 235)');
    await visitor.screenshot({
      path: test.info().outputPath('snapshot-dark.png'),
      fullPage: true,
    });
    const bound = await share(page, 'snapshot', {
      revision: 'For review',
      recipient: 'Mira',
    });
    await visitor.goto(bound);
    await expect(
      visitor.getByText(/requires a verified signed-in account/),
    ).toBeVisible();
    await expect(
      visitor.getByLabel('Frozen Python source for main.py', { exact: true }),
    ).toHaveCount(0);
    await visitor.goto(link);
    await expect(
      visitor.getByLabel('Frozen Python source for main.py', { exact: true }),
    ).toBeVisible();
    const shareRows = page.getByRole('region', {
      name: 'Shared links',
      exact: true,
    });
    await shareRows
      .locator('.list-row')
      .filter({ hasText: 'Unbound link' })
      .getByRole('button', { name: 'Revoke snapshot link', exact: true })
      .click();
    await visitor
      .getByRole('button', { name: 'Recheck shared link', exact: true })
      .click();
    await expect(
      visitor.getByText(/unavailable, expired, revoked/),
    ).toBeVisible();
    expect(
      (await exported(visitor, 'Export revision source')).files[0]!.source,
    ).toBe(frozen);
    await register(
      visitor,
      `snapshot-copy-${browserName}-${randomUUID()}@example.test`,
      'Reader',
    );
    // A second still-active snapshot may be copied by a signed-in recipient only when authorized.
    const freshLink = await share(page, 'snapshot', { revision: 'For review' });
    await visitor.goto(freshLink);
    await visitor
      .getByRole('button', { name: 'Open local copy', exact: true })
      .click();
    await expect(visitor).toHaveURL(/\/drafts\/[a-f0-9-]{36}$/);
    await expect(editor(visitor)).toHaveAttribute('aria-readonly', 'false');
    await exactSource(visitor, frozen);
  } finally {
    await context.close();
  }
});

test('live read links grant only source capability to workspace members, run locally and revoke with export available', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const original = await ownerProject(page, 'live-read', browserName),
    pair = await memberWithoutGrant(page, browser, browserName);
  try {
    const code = 'print("shared read run")\n';
    await replace(page, code);
    await saved(page);
    expect(
      (
        await pair.peer.request.get(`/api/v1/projects/${original.projectId}/`)
      ).status(),
    ).toBe(404);
    const link = await share(page, 'live'),
      privatePaths = ordinaryRequests(pair.peer, original.projectId);
    await pair.peer.goto(link);
    await expect(editor(pair.peer)).toHaveAttribute('aria-readonly', 'true');
    await exactSource(pair.peer, code);
    for (const name of [
      'Add file',
      'Rename file',
      'Capture shared revision',
      'Create shared link',
    ])
      await expect(
        pair.peer.getByRole('button', { name, exact: true }),
      ).toHaveCount(0);
    await expect(
      pair.peer.getByRole('region', { name: 'Local recovery', exact: true }),
    ).toHaveCount(0);
    await noStoredCapability(pair.peer, new URL(link).hash.slice(1));
    await pair.peer
      .getByRole('button', { name: 'Run code', exact: true })
      .click();
    await finishedRun(pair.peer);
    await expect(pair.peer.getByLabel('Python output')).toContainText(
      'shared read run',
    );
    expect(privatePaths).toEqual([]);
    await openProjectSection(page, 'Sharing');
    await page
      .getByRole('button', { name: 'Revoke live link', exact: true })
      .click();
    await pair.peer
      .getByRole('button', { name: 'Recheck shared link', exact: true })
      .click();
    await expect(
      pair.peer.getByText(/unavailable, expired, revoked/),
    ).toBeVisible();
    await expect(editor(pair.peer)).toHaveAttribute('aria-readonly', 'true');
    await exactSource(pair.peer, code);
    expect(
      (
        await pair.peer.request.get(`/api/v1/projects/${original.projectId}/`)
      ).status(),
    ).toBe(404);
  } finally {
    await pair.context.close();
  }
});

test('live write links sync Saved without permanent project access or automatic recovery and fork current source after revocation', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const original = await ownerProject(page, 'live-write', browserName),
    pair = await memberWithoutGrant(page, browser, browserName);
  try {
    const link = await share(page, 'live', { scope: 'write' }),
      privatePaths = ordinaryRequests(pair.peer, original.projectId);
    await pair.peer.goto(link);
    await expect(editor(pair.peer)).toHaveAttribute('aria-readonly', 'false');
    const code = 'print("capability saved 🐍")\n';
    await replace(pair.peer, code);
    await saved(pair.peer);
    await exactSource(page, code);
    await pair.peer.reload();
    await exactSource(pair.peer, code);
    await saved(pair.peer);
    await noStoredCapability(pair.peer, new URL(link).hash.slice(1));
    expect(privatePaths).toEqual([]);
    await openProjectSection(page, 'Sharing');
    await page
      .getByRole('button', { name: 'Revoke live link', exact: true })
      .click();
    await expect(editor(pair.peer)).toHaveAttribute('aria-readonly', 'true', {
      timeout: 35000,
    });
    await exactSource(pair.peer, code);
    expect(
      (
        await pair.peer.request.get(`/api/v1/projects/${original.projectId}/`)
      ).status(),
    ).toBe(404);
    await pair.peer
      .getByRole('button', { name: 'Open local copy', exact: true })
      .click();
    await expect(pair.peer).toHaveURL(/\/drafts\/[a-f0-9-]{36}$/);
    await expect(editor(pair.peer)).toHaveAttribute('aria-readonly', 'false');
    await exactSource(pair.peer, code);
    expect(new URL(pair.peer.url()).hash).toBe('');
    await replace(pair.peer, 'print("independent local copy")\n');
    await exactSource(page, code);
  } finally {
    await pair.context.close();
  }
});
