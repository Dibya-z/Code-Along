import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { register, login, createEditorProject } from './helpers.ts';
interface Row {
  revision: number;
  account: string;
  project: string;
  hashes: string[];
  keys: string[];
}
async function records(page: Page): Promise<Row[]> {
  return page.evaluate(
    () =>
      new Promise<Row[]>((resolve, reject) => {
        const opening = indexedDB.open('code-along-local');
        opening.onerror = () => reject(new Error('Fixture database failed'));
        opening.onsuccess = () => {
          const db = opening.result,
            transaction = db.transaction('drafts'),
            request = transaction.objectStore('drafts').getAll();
          request.onerror = () => reject(new Error('Fixture read failed'));
          request.onsuccess = () => {
            const values = request.result as {
              revision: number;
              data: {
                account_id: string;
                project_id: string;
                files: { source_sha256: string }[];
              };
            }[];
            resolve(
              values.map((row) => ({
                revision: row.revision,
                account: row.data.account_id,
                project: row.data.project_id,
                hashes: row.data.files.map((file) => file.source_sha256),
                keys: Object.keys(row.data),
              })),
            );
          };
          transaction.oncomplete = () => db.close();
          transaction.onabort = () => {
            db.close();
            reject(new Error('Fixture transaction aborted'));
          };
        };
      }),
  );
}
async function saved(page: Page, source: string) {
  const hash = createHash('sha256').update(source).digest('hex');
  await expect
    .poll(async () =>
      (await records(page)).some((row) => row.hashes.includes(hash)),
    )
    .toBe(true);
  await expect(page.locator('.recovery-status')).toHaveText(
    /^Local recovery updated/,
  );
}
test('binary recovery, immediate route flush, competing tabs and default logout cleanup', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, `recovery-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  const projectUrl = page.url(),
    source = '# 🐍\nprint("private draft")\n';
  await expect(page.locator('.recovery-status')).toHaveText(
    'Local recovery ready',
  );
  await expect(
    page.getByLabel('Keep my local drafts after sign out on this device.'),
  ).not.toBeChecked();
  await page.getByLabel('Python source for main.py').fill(source);
  await saved(page, source);
  expect((await records(page))[0]!.keys.sort()).toEqual(
    [
      'version',
      'origin',
      'account_id',
      'project_id',
      'kind',
      'name',
      'metadata_version',
      'entrypoint_file_id',
      'runtime_id',
      'files',
    ].sort(),
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Python source for main.py')).not.toContainText(
    'private draft',
  );
  await page
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toContainText(
    'private draft',
  );
  await page
    .getByLabel('Python source for main.py')
    .fill('print("route flush")\n');
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await expect
    .poll(async () =>
      (await records(page)).some((row) =>
        row.hashes.includes(
          createHash('sha256').update('print("route flush")\n').digest('hex'),
        ),
      ),
    )
    .toBe(true);
  await page.goto(projectUrl);
  await page
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toHaveText(
    'print("route flush")\n',
  );
  const other = await page.context().newPage();
  await other.goto(projectUrl);
  await other
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await page
    .getByLabel('Python source for main.py')
    .fill('print("first tab wins")\n');
  await saved(page, 'print("first tab wins")\n');
  await other
    .getByLabel('Python source for main.py')
    .fill('print("second tab stays local")\n');
  await expect(other.locator('.recovery-status')).toHaveText(
    'Local recovery paused: another tab changed it.',
  );
  await expect(other.getByLabel('Python source for main.py')).toHaveText(
    'print("second tab stays local")\n',
  );
  const downloading = other.waitForEvent('download');
  await other
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  const path = await (await downloading).path();
  expect(JSON.parse(await readFile(path!, 'utf8')).files[0].source).toBe(
    'print("second tab stays local")\n',
  );
  await other
    .getByRole('button', { name: 'Review newer recovery', exact: true })
    .click();
  await other
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await expect(other.getByLabel('Python source for main.py')).toHaveText(
    'print("first tab wins")\n',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: test.info().outputPath('recovery-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('recovery-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.reload();
  await page
    .getByRole('button', { name: "Use this tab's code", exact: true })
    .click();
  const replace = page.getByRole('dialog', { name: "Use this tab's code?" });
  await replace
    .getByRole('button', { name: 'Replace local recovery', exact: true })
    .click();
  await expect(replace).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export current code', exact: true }),
  ).toBeFocused();
  await expect.poll(async () => (await records(page)).length).toBe(0);
  await page
    .getByLabel('Python source for main.py')
    .fill('print("pending at logout")\n');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('https://127.0.0.1:18443/');
  await expect(other).toHaveURL('https://127.0.0.1:18443/');
  await expect.poll(async () => (await records(page)).length).toBe(0);
  await expect(
    other.getByRole('link', { name: 'Sign in', exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await other.close();
});
test('explicit retention survives sign out and a different account cannot open the private project', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  const email = `retain-${browserName}-${Date.now()}@example.test`;
  await register(page, email);
  await createEditorProject(page);
  const projectUrl = page.url(),
    source = 'print("retained by choice")\n';
  await page.getByLabel('Python source for main.py').fill(source);
  await saved(page, source);
  await page
    .getByLabel('Keep my local drafts after sign out on this device.')
    .check();
  await expect(
    page.getByLabel('Keep my local drafts after sign out on this device.'),
  ).toBeChecked();
  await expect(
    page.getByLabel('Keep my local drafts after sign out on this device.'),
  ).toBeEnabled();
  const actor = (await records(page))[0]!.account;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('https://127.0.0.1:18443/');
  expect((await records(page))[0]!.account).toBe(actor);
  await register(page, `different-${browserName}-${Date.now()}@example.test`);
  await page.goto(projectUrl);
  await expect(
    page.getByRole('heading', { name: 'Project unavailable.', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('https://127.0.0.1:18443/');
  await login(page, email);
  await page.goto(projectUrl);
  await page
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await expect(page.getByLabel('Python source for main.py')).toHaveText(source);
  await page
    .getByLabel('Keep my local drafts after sign out on this device.')
    .uncheck();
  await expect(
    page.getByLabel('Keep my local drafts after sign out on this device.'),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('https://127.0.0.1:18443/');
  await expect.poll(async () => (await records(page)).length).toBe(0);
});
test('stale document generations refuse restore and quota failure preserves current/exported code', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  await register(
    page,
    `recovery-fault-${browserName}-${Date.now()}@example.test`,
  );
  await createEditorProject(page);
  const source = 'print("stored copy")\n';
  await page.getByLabel('Python source for main.py').fill(source);
  await saved(page, source);
  const generation = async (value: number) =>
    page.evaluate(
      (value) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('code-along-local');
          open.onerror = () => reject(new Error('Fixture open failed'));
          open.onsuccess = () => {
            const db = open.result,
              transaction = db.transaction('drafts', 'readwrite'),
              store = transaction.objectStore('drafts'),
              request = store.getAll();
            request.onsuccess = () => {
              const row = request.result[0] as {
                data: { files: { metadata: { generation: number } }[] };
              };
              row.data.files[0]!.metadata.generation = value;
              store.put(row);
            };
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            transaction.onabort = () => {
              db.close();
              reject(new Error('Fixture update failed'));
            };
          };
        }),
      value,
    );
  await generation(2);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Restore local changes', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel('Local recovery', { exact: true }),
  ).toContainText('same writable file identities and generations');
  await expect(page.getByLabel('Python source for main.py')).not.toContainText(
    'stored copy',
  );
  await expect(
    page.getByRole('button', { name: 'Export stored recovery', exact: true }),
  ).toBeEnabled();
  await generation(1);
  await page.reload();
  await page
    .getByRole('button', { name: 'Restore local changes', exact: true })
    .click();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'drafts')
        throw new DOMException(
          'Owned fixture quota failure',
          'QuotaExceededError',
        );
      return put.apply(this, args);
    };
  });
  await page
    .getByLabel('Python source for main.py')
    .fill('print("quota work preserved")\n');
  await expect(page.locator('.recovery-status')).toHaveText(
    'Local recovery needs attention.',
  );
  await expect(page.getByLabel('Python source for main.py')).toContainText(
    'quota work preserved',
  );
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  const path = await (await downloading).path();
  expect(JSON.parse(await readFile(path!, 'utf8')).files[0].source).toBe(
    'print("quota work preserved")\n',
  );
  expect((await records(page))[0]!.hashes).toEqual([
    createHash('sha256').update(source).digest('hex'),
  ]);
});
test('unavailable IndexedDB keeps export and server sign out usable', async ({
  page,
  browserName,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', {
      value: class {
        constructor() {
          throw new DOMException(
            'Owned fixture blocked channel',
            'SecurityError',
          );
        }
      },
    });
    IDBFactory.prototype.open = () => {
      throw new DOMException(
        'Owned fixture blocked IndexedDB',
        'SecurityError',
      );
    };
  });
  await register(page, `no-storage-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  await expect(page.locator('.recovery-status')).toHaveText(
    'Local recovery needs attention.',
  );
  await page
    .getByLabel('Python source for main.py')
    .fill('print("export without storage")\n');
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export current code', exact: true })
    .click();
  const path = await (await downloading).path();
  expect(JSON.parse(await readFile(path!, 'utf8')).files[0].source).toBe(
    'print("export without storage")\n',
  );
  const fileDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download open file', exact: true })
    .click();
  const file = await fileDownload;
  expect(file.suggestedFilename()).toBe('main.py');
  expect(await readFile((await file.path())!, 'utf8')).toBe(
    'print("export without storage")\n',
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(
    'https://127.0.0.1:18443/?local-recovery=unavailable',
  );
  await expect(page.getByRole('alert')).toContainText('You are signed out.');
});

test('a missing source blocks complete actions but a loaded file can be rescued', async ({
  page,
  browserName,
}) => {
  await register(page, `partial-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a Python file' });
  await dialog.getByLabel('File path').fill('helper.py');
  await dialog
    .getByRole('button', { name: 'Add Python file', exact: true })
    .click();
  await expect(page.getByLabel('Python source for helper.py')).toBeVisible();
  const id = (await page
    .getByRole('button', { name: 'helper.py', exact: true })
    .getAttribute('id'))!.replace('editor-file-', '');
  await page.route(`**/files/${id}/`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"detail":"Owned fixture source unavailable"}',
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'main.py', exact: true }).click();
  const source = '# one complete loaded file\nprint("rescue")\n';
  await page.getByLabel('Python source for main.py').fill(source);
  await expect(
    page.getByRole('button', { name: 'Run code', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Export current code', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.recovery-status')).toContainText(
    'waiting for every project file',
  );
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download open file', exact: true })
    .click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('main.py');
  expect(await readFile((await file.path())!, 'utf8')).toBe(source);
});
