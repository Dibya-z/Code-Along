import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { createEditorProject, finishedRun, register } from './helpers.ts';

const source = (page: Page, path = 'main.py') =>
  page.getByLabel(`Python source for ${path}`);
const settled = (page: Page) =>
  expect(page.locator('.collaboration-status')).toHaveText('Saved', {
    timeout: 15000,
  });
async function modifier(page: Page) {
  return page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
  );
}
async function projectPair(
  owner: Page,
  browser: Browser,
  browserName: string,
  role: 'viewer' | 'editor' = 'editor',
) {
  const stamp = `${browserName}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  await register(owner, `collab-owner-${stamp}@example.test`, 'Mira');
  const context = await browser.newContext({
    baseURL: new URL(owner.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const peer = await context.newPage(),
      email = `collab-peer-${stamp}@example.test`;
    await register(peer, email, 'River');
    await createEditorProject(owner);
    const url = owner.url();
    await owner.getByRole('link', { name: '← Workspace', exact: true }).click();
    await owner
      .getByRole('button', { name: 'Invite member', exact: true })
      .click();
    const invitation = owner.getByRole('dialog', {
      name: 'Invite a workspace member',
    });
    await invitation.getByLabel('Recipient email').fill(email);
    await invitation
      .getByRole('button', { name: 'Create invitation', exact: true })
      .click();
    await expect(owner.getByLabel('Invitation link')).toBeVisible();
    await peer.goto(await owner.getByLabel('Invitation link').inputValue());
    await peer
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await owner.goto(url);
    await owner
      .getByLabel('Workspace member', { exact: true })
      .selectOption({ label: 'River' });
    await owner.getByLabel('Project role', { exact: true }).selectOption(role);
    await owner
      .getByRole('button', { name: 'Grant project access', exact: true })
      .click();
    await peer.goto(url);
    await expect(source(peer)).toBeVisible();
    await expect(source(peer)).toHaveAttribute(
      'aria-readonly',
      String(role === 'viewer'),
    );
    return { peer, context, url };
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function downloadText(page: Page, name: string): Promise<string> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile((await (await pending).path())!, 'utf8');
}
async function expectSource(page: Page, expected: string, path = 'main.py') {
  // Presence widgets and virtualized lines are not learner source; use the public full-source export.
  await expect
    .poll(
      async () => {
        const archive = JSON.parse(
          await downloadText(page, 'Export current code'),
        ) as { files: { path: string; source: string }[] };
        const file = archive.files.find((file) => file.path === path);
        if (!file)
          throw new Error('The exported project omitted the expected file.');
        return file.source;
      },
      { timeout: 20000 },
    )
    .toBe(expected);
}
async function replaceSource(page: Page, value: string, path = 'main.py') {
  const editor = source(page, path);
  // Use CodeMirror's actual select-all command; DOM fill includes remote caret widgets.
  await editor.press(`${await modifier(page)}+a`);
  if (value) await page.keyboard.insertText(value);
  else await page.keyboard.press('Backspace');
}

test('two accounts converge on empty/short text, show real multi-tab presence, and follow without stealing focus', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const pair = await projectPair(page, browser, browserName),
    peer = pair.peer;
  try {
    const ownerPeople = page.getByRole('list', { name: 'People in this file' });
    await expect(ownerPeople).toContainText('Mira (you)');
    await expect(ownerPeople).toContainText('River');
    await expect(
      peer.getByRole('list', { name: 'People in this file' }),
    ).toContainText('River (you)');
    const idleTab = await page.context().newPage();
    try {
      await idleTab.goto(pair.url);
      await expect(
        idleTab.getByRole('list', { name: 'People in this file' }),
      ).toContainText('Mira (you)');
      await expect(
        ownerPeople.getByRole('listitem').filter({ hasText: 'Mira' }),
      ).toContainText('2 tabs');
      await expect(
        peer
          .getByRole('list', { name: 'People in this file' })
          .getByRole('listitem')
          .filter({ hasText: 'Mira' }),
      ).toContainText('2 tabs');
    } finally {
      await idleTab.close();
    }
    const projectId = new URL(pair.url).pathname.split('/').at(-1)!;
    const project = (await (
      await page.request.get(`/api/v1/projects/${projectId}/`)
    ).json()) as { entrypoint_file_id: string };
    const initial = (await (
      await page.request.get(
        `/api/v1/projects/${projectId}/files/${project.entrypoint_file_id}/`,
      )
    ).json()) as { initial_source: string };
    const before = JSON.parse(
      await downloadText(page, 'Export current code'),
    ) as { files: { source: string }[] };
    expect(before.files[0]!.source).toBe(initial.initial_source);
    await replaceSource(page, 'x');
    await expectSource(peer, 'x');
    await replaceSource(page, '');
    await expectSource(peer, '');
    await settled(page);
    await peer.reload();
    await expectSource(peer, '');
    await expect(source(peer)).toHaveAttribute('aria-readonly', 'false');
    await replaceSource(page, 'ab');
    await expectSource(peer, 'ab');
    const peerModifier = await modifier(peer),
      ownerModifier = await modifier(page);
    await source(peer).press(`${peerModifier}+Home`);
    await source(peer).press('ArrowRight');
    await source(peer).press('Shift+ArrowRight');
    await expect
      .poll(() => page.locator('.cm-ySelectionCaret').count())
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.locator('.cm-ySelection').count())
      .toBeGreaterThan(0);
    await expect(
      page.getByRole('list', { name: 'People in this file' }),
    ).toContainText('River');

    const long =
      Array.from({ length: 120 }, (_, index) => `# line ${index + 1}`).join(
        '\n',
      ) + '\n';
    await replaceSource(page, long);
    await expectSource(peer, long);
    await source(page).press(`${ownerModifier}+Home`);
    await source(peer).press(`${peerModifier}+Home`);
    await page
      .getByRole('button', { name: 'Follow River', exact: true })
      .click();
    const position = await page.locator('.editor-status').innerText();
    // Safari's ordinary pointer-button policy does not focus buttons on click.
    await page
      .getByRole('button', { name: 'Stop following', exact: true })
      .focus();
    await expect(
      page.getByRole('button', { name: 'Stop following', exact: true }),
    ).toBeFocused();
    await source(peer).press(`${peerModifier}+End`);
    await expect
      .poll(() =>
        page
          .locator('.python-editor .cm-scroller')
          .evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(100);
    await expect(page.locator('.editor-status')).toHaveText(position, {
      useInnerText: true,
    });
    await expect(
      page.getByRole('button', { name: 'Stop following', exact: true }),
    ).toBeFocused();
    await source(page).press('Escape');
    await expect(
      page.getByRole('button', { name: 'Follow River', exact: true }),
    ).toBeVisible();

    const tab = await pair.context.newPage();
    try {
      await tab.goto(pair.url);
      await expectSource(tab, long);
      await expect(
        page
          .getByRole('list', { name: 'People in this file' })
          .getByRole('listitem')
          .filter({ hasText: 'River' }),
      ).toContainText('2 tabs');
      await replaceSource(tab, 'print("three views")\n');
      await expectSource(page, 'print("three views")\n');
      await expectSource(peer, 'print("three views")\n');
      await settled(page);
    } finally {
      await tab.close();
    }
    await page.screenshot({
      path: test.info().outputPath('collaboration-presence.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('collaboration-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath('collaboration-320.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await expect(
      page.getByRole('button', { name: 'Follow River', exact: true }),
    ).toHaveCSS('background-color', 'rgb(24, 35, 29)');
    await page.screenshot({
      path: test.info().outputPath('collaboration-dark.png'),
      fullPage: true,
    });
  } finally {
    await pair.context.close();
  }
});

test('rapid edit → Run captures exact source while a later edit reaches Saved and reloads from the server', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90000);
  await register(
    page,
    `collab-run-${browserName}-${Date.now()}@example.test`,
    'Mira',
  );
  await createEditorProject(page);
  await source(page).fill('print("captured source")\n');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await source(page).fill('print("later saved source")\n');
  await finishedRun(page);
  await expect(page.getByLabel('Python output')).toContainText(
    'captured source',
  );
  await expect(page.getByLabel('Python output')).not.toContainText(
    'later saved source',
  );
  await expect(
    page.getByText('Earlier source', { exact: false }),
  ).toBeVisible();
  await settled(page);
  await page.reload();
  await expectSource(page, 'print("later saved source")\n');
  await settled(page);
});

test('offline canonical edits stay detached until fresh admission and merge with a connected peer', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const pair = await projectPair(page, browser, browserName),
    peer = pair.peer;
  try {
    await source(page).fill('shared = 0\n');
    await expectSource(peer, 'shared = 0\n');
    await settled(peer);
    await pair.context.setOffline(true);
    await expect(peer.locator('.collaboration-status')).toHaveText(/Offline/);
    await expect(source(peer)).toHaveAttribute('aria-readonly', 'false');
    await source(peer).press(`${await modifier(peer)}+Home`);
    await peer.keyboard.insertText('# peer offline\n');
    await source(page).press(`${await modifier(page)}+End`);
    await page.keyboard.insertText('# owner online\n');
    await settled(page);
    await expect(peer.locator('.collaboration-status')).not.toHaveText('Saved');
    await pair.context.setOffline(false);
    const expected = '# peer offline\nshared = 0\n# owner online\n';
    await expectSource(peer, expected);
    await expectSource(page, expected);
    await settled(peer);
    await settled(page);
    await peer.reload();
    await expectSource(peer, expected);
  } finally {
    await pair.context.setOffline(false);
    await pair.context.close();
  }
});

test('viewer write tickets are denied and revocation freezes the editor while preserving exact export', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const pair = await projectPair(page, browser, browserName, 'viewer'),
    peer = pair.peer;
  try {
    const projectId = new URL(pair.url).pathname.split('/').at(-1)!;
    const files = (await (
      await peer.request.get(`/api/v1/projects/${projectId}/files/`)
    ).json()) as { items: { document_id: string; generation: number }[] };
    const csrf = (await (await peer.request.get('/api/v1/csrf/')).json()) as {
      csrfToken: string;
    };
    const denied = await peer.request.post(
      `/api/v1/projects/${projectId}/documents/${files.items[0]!.document_id}/ticket/`,
      {
        headers: {
          Origin: new URL(pair.url).origin,
          'X-CSRFToken': csrf.csrfToken,
        },
        data: {
          generation: files.items[0]!.generation,
          scope: 'write',
          client_session_id: randomUUID(),
          awareness_client_id: 12345,
        },
      },
    );
    expect(denied.status()).toBe(403);
    await page
      .getByLabel('Workspace member', { exact: true })
      .selectOption({ label: 'River' });
    await page
      .getByLabel('Project role', { exact: true })
      .selectOption('editor');
    await page
      .getByRole('button', { name: 'Grant project access', exact: true })
      .click();
    await peer.reload();
    await expect(source(peer)).toHaveAttribute('aria-readonly', 'false');
    const unsaved = '# preserve on access loss\nprint("my exact buffer")\n';
    await source(peer).fill(unsaved);
    await page
      .getByRole('button', { name: 'Remove project access', exact: true })
      .click();
    await expect(peer.locator('.collaboration-status')).toHaveText(
      /Editing paused/,
      { timeout: 15000 },
    );
    await expect(source(peer)).toHaveAttribute('aria-readonly', 'true');
    await expectSource(peer, unsaved);
    const archive = JSON.parse(
      await downloadText(peer, 'Export current code'),
    ) as { files: { source: string }[] };
    expect(archive.files[0]!.source).toBe(unsaved);
  } finally {
    await pair.context.close();
  }
});

async function legacyRecovery(page: Page, legacySource: string): Promise<void> {
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  const project = (await (
    await page.request.get(`/api/v1/projects/${projectId}/`)
  ).json()) as {
    id: string;
    name: string;
    metadata_version: number;
    entrypoint_file_id: string;
    runtime_id: string;
  };
  const account = (await (await page.request.get('/api/v1/me/')).json()) as {
    id: string;
  };
  const initial = (await (
    await page.request.get(
      `/api/v1/projects/${projectId}/files/${project.entrypoint_file_id}/`,
    )
  ).json()) as {
    id: string;
    document_id: string;
    generation: number;
    path: string;
    kind: 'python';
    initial_sha256: string;
    initial_source: string;
  };
  const doc = new Y.Doc();
  doc.getText('source').insert(0, initial.initial_source);
  doc.getText('source').delete(0, doc.getText('source').length);
  doc.getText('source').insert(0, legacySource);
  const binary = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const { initial_source, ...metadata } = initial;
  const data = {
    version: 1,
    origin: 'm2-local',
    account_id: account.id,
    project_id: project.id,
    kind: 'project',
    name: project.name,
    metadata_version: project.metadata_version,
    entrypoint_file_id: project.entrypoint_file_id,
    runtime_id: project.runtime_id,
    files: [
      {
        metadata,
        initial_source,
        state: Array.from(binary),
        state_sha256: createHash('sha256').update(binary).digest('hex'),
        source_sha256: createHash('sha256').update(legacySource).digest('hex'),
      },
    ],
  };
  const bytes = 2048 + binary.length + Buffer.byteLength(initial_source);
  await page.evaluate(
    ({ data, bytes }) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('code-along-local');
        opening.onerror = () =>
          reject(new Error('Legacy fixture could not open storage'));
        opening.onsuccess = () => {
          const db = opening.result,
            transaction = db.transaction(['drafts', 'accounts'], 'readwrite'),
            drafts = transaction.objectStore('drafts'),
            accounts = transaction.objectStore('accounts');
          const old = drafts.get([data.account_id, data.project_id]);
          old.onsuccess = () => {
            const previous = old.result as
              { revision: number; bytes: number } | undefined;
            if (!previous) {
              transaction.abort();
              return;
            }
            const account = accounts.get(data.account_id);
            account.onsuccess = () => {
              const policy = account.result as { used_bytes: number };
              accounts.put({
                ...policy,
                used_bytes: policy.used_bytes - previous.bytes + bytes,
              });
              drafts.put({
                account_id: data.account_id,
                project_id: data.project_id,
                revision: previous.revision + 1,
                updated_at: Date.now(),
                bytes,
                data: {
                  ...data,
                  files: data.files.map((file) => ({
                    ...file,
                    state: Uint8Array.from(file.state),
                  })),
                },
              });
            };
          };
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(new Error('Legacy fixture transaction failed'));
          };
        };
      }),
    { data, bytes },
  );
}

test('legacy independently seeded M2 recovery forks to fresh local identities without entering the canonical room', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90000);
  await register(
    page,
    `collab-legacy-${browserName}-${Date.now()}@example.test`,
    'Mira',
  );
  await createEditorProject(page);
  const url = page.url(),
    canonical = 'print("canonical server")\n',
    legacy = 'print("legacy device copy")\n';
  await source(page).fill(canonical);
  await settled(page);
  await expect(page.locator('.recovery-status')).toHaveText(
    /^Local recovery updated/,
  );
  await legacyRecovery(page, legacy);
  await page.reload();
  await expectSource(page, canonical);
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Open stored local copy', exact: true })
    .click();
  await expect(page).toHaveURL(/\/drafts\//);
  await expectSource(page, legacy);
  expect(new URL(page.url()).pathname.split('/').at(-1)).not.toBe(
    new URL(url).pathname.split('/').at(-1),
  );
  await page.goto(url);
  await expectSource(page, canonical);
});

test('a removed file preserves its offline text for export after generation admission is rejected', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  await register(
    page,
    `collab-delete-${browserName}-${Date.now()}@example.test`,
    'Mira',
  );
  await createEditorProject(page);
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a Python file' });
  await dialog.getByLabel('File path').fill('helper.py');
  await dialog
    .getByRole('button', { name: 'Add Python file', exact: true })
    .click();
  await expect(source(page, 'helper.py')).toHaveAttribute(
    'aria-readonly',
    'false',
  );
  await settled(page);
  let other: BrowserContext | undefined;
  try {
    other = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      ignoreHTTPSErrors: true,
      storageState: await page.context().storageState(),
    });
    const remover = await other.newPage();
    await remover.goto(page.url());
    await remover
      .getByRole('button', { name: 'helper.py', exact: true })
      .click();
    await page.context().setOffline(true);
    await expect(page.locator('.collaboration-status')).toHaveText(/Offline/);
    const text = '# keep this removed file\nanswer = 73\n';
    await source(page, 'helper.py').fill(text);
    await remover
      .getByRole('button', { name: 'Remove file', exact: true })
      .click();
    await remover
      .getByRole('dialog', { name: 'Remove this file?' })
      .getByRole('button', { name: 'Confirm file removal', exact: true })
      .click();
    await page.context().setOffline(false);
    await expect(page.locator('.collaboration-status')).toHaveText(
      /Editing paused/,
      { timeout: 15000 },
    );
    await page
      .getByRole('button', { name: 'Refresh project', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Download preserved helper.py',
        exact: true,
      }),
    ).toBeVisible();
    expect(await downloadText(page, 'Download preserved helper.py')).toBe(text);
  } finally {
    await page.context().setOffline(false);
    await other?.close();
  }
});
