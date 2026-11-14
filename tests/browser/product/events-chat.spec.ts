import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { login, register } from './helpers.ts';

const discussion = (page: Page) =>
  page.getByRole('region', { name: 'Discussion', exact: true });
const rows = (page: Page) => discussion(page).locator('li[data-message-id]');
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const ready = (page: Page) =>
  expect(page.locator('.discussion-status')).toHaveText(
    'Discussion is up to date.',
    { timeout: 20000 },
  );
async function send(page: Page, body: string) {
  const input = discussion(page).getByLabel('Message to project'),
    button = discussion(page).getByRole('button', {
      name: 'Send message',
      exact: true,
    });
  await input.fill(body);
  await expect(input).toHaveValue(body);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(input).toHaveValue('');
}
interface Wire {
  type?: string;
  event_type?: string;
  data?: { message?: { body?: string } };
}
async function notifications(
  page: Page,
  drop: (frame: Wire) => boolean,
  duplicate = false,
) {
  // Fault injection drops/duplicates actual authenticated server frames; it invents no message proof.
  await page.routeWebSocket('**/events', (route) => {
    const server = route.connectToServer();
    server.onMessage((data) => {
      let frame: Wire;
      try {
        frame = JSON.parse(data.toString()) as Wire;
      } catch {
        route.send(data);
        return;
      }
      if (drop(frame)) return;
      route.send(data);
      if (duplicate && frame.type === 'event') route.send(data);
    });
  });
}
async function pair(
  owner: Page,
  browser: Browser,
  browserName: string,
  role: 'viewer' | 'editor' = 'editor',
  prepare?: (peer: Page) => Promise<void>,
  seed?: (owner: Page, projectId: string) => Promise<void>,
) {
  const stamp = `${browserName}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await register(owner, `discussion-owner-${stamp}@example.test`, 'Mira');
  const context = await browser.newContext({
    baseURL: new URL(owner.url()).origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const peer = await context.newPage(),
      email = `discussion-peer-${stamp}@example.test`;
    const sourceStatuses: number[] = [];
    peer.on('response', (response) => {
      if (/\/files\/[a-f0-9-]{36}\/$/.test(new URL(response.url()).pathname))
        sourceStatuses.push(response.status());
    });
    await register(peer, email, 'River');
    // Use real authorized public APIs for setup before any project observers amplify reads.
    const origin = new URL(owner.url()).origin;
    const { csrfToken } = (await (
      await owner.request.get('/api/v1/csrf/')
    ).json()) as { csrfToken: string };
    const headers = { 'X-CSRFToken': csrfToken, Origin: origin };
    const workspaceResponse = await owner.request.post('/api/v1/workspaces/', {
      headers,
      data: { name: 'Discussion studio' },
    });
    expect(workspaceResponse.status()).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const projectResponse = await owner.request.post(
      `/api/v1/workspaces/${workspace.id}/projects/`,
      { headers, data: { name: 'A shared Python discussion' } },
    );
    expect(projectResponse.status()).toBe(201);
    const project = (await projectResponse.json()) as { id: string },
      projectId = project.id,
      url = `${origin}/projects/${projectId}`;
    const invitationResponse = await owner.request.post(
      `/api/v1/workspaces/${workspace.id}/invitations/`,
      {
        headers,
        data: { recipient_email: email, role: 'learner', expires_hours: 72 },
      },
    );
    expect(invitationResponse.status()).toBe(201);
    const invitation = (await invitationResponse.json()) as {
      invite_url: string;
    };
    await peer.goto(invitation.invite_url);
    await peer
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    const peerIdentity = (await (
      await peer.request.get('/api/v1/me/')
    ).json()) as { id: string };
    const grantResponse = await owner.request.put(
      `/api/v1/projects/${projectId}/grants/${peerIdentity.id}/`,
      { headers, data: { role } },
    );
    expect(grantResponse.status()).toBe(204);
    if (seed) await seed(owner, projectId);
    if (prepare) await prepare(peer);
    await owner.goto(url);
    await peer.goto(url);
    try {
      await expect(
        peer.getByRole('textbox', {
          name: 'Python source for main.py',
          exact: true,
        }),
      ).toBeVisible();
    } catch (error) {
      throw new Error(
        `Immutable file baseline response statuses: ${sourceStatuses.join(',') || 'none'}`,
        { cause: error },
      );
    }
    return { peer, context, url, projectId, email };
  } catch (error) {
    await context.close();
    throw error;
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function openFileDownload(page: Page) {
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download open file', exact: true })
    .click();
  return readFile((await (await download).path())!, 'utf8');
}
async function noStoredDiscussion(page: Page, values: string[]) {
  expect(
    await page.evaluate(async (secrets) => {
      const browserValues = [
        ...Object.values(localStorage),
        ...Object.values(sessionStorage),
      ].join('\n');
      if (secrets.some((value) => browserValues.includes(value))) return false;
      const data = await new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('code-along-local');
        open.onerror = () =>
          reject(new Error('Could not inspect the owned test recovery store.'));
        open.onsuccess = () => {
          const db = open.result;
          const read = db
            .transaction('drafts', 'readonly')
            .objectStore('drafts')
            .getAll();
          read.onsuccess = () => {
            resolve(JSON.stringify(read.result));
            db.close();
          };
          read.onerror = () => {
            db.close();
            reject(new Error('Could not inspect device draft records.'));
          };
        };
      });
      return !secrets.some((value) => data.includes(value));
    }, values),
  ).toBe(true);
}

test('two accounts receive plaintext once despite duplicate notifications and retain event-proven Sent after the HTTP reply is lost', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  let committedEvents = 0;
  await notifications(
    page,
    (frame) => {
      if (frame.event_type === 'chat.message.created') committedEvents++;
      return false;
    },
    true,
  );
  const p = await pair(page, browser, browserName, 'editor', (peer) =>
    notifications(peer, () => false, true),
  );
  const release = deferred();
  let committed = false;
  try {
    await ready(page);
    await ready(p.peer);
    await page.route(
      `**/api/v1/projects/${p.projectId}/chat/messages/`,
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        committed = true;
        await release.promise;
        await route.abort('failed');
      },
    );
    const text = '<b>Plain text, not markup</b> 🐍\nSecond line.';
    await send(page, text);
    await expect.poll(() => committed).toBe(true);
    // The HTTP response is still held: Sent must come from a committed authorized event.
    await expect(row(page, text)).toHaveCount(1, { timeout: 15000 });
    await expect(row(page, text)).toContainText('Sent');
    expect(committedEvents).toBeGreaterThan(0);
    await expect(row(p.peer, text)).toHaveCount(1);
    await expect(row(p.peer, text).locator('b')).toHaveCount(0);
    await expect(row(p.peer, text).locator('time')).toContainText('UTC');
    release.resolve();
    await expect(discussion(page).locator('.discussion-pending')).toHaveCount(
      0,
    );
    await expect(row(page, text)).toHaveCount(1);
    await expect(row(page, text)).toContainText('Sent');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('link', { name: 'Discussion', exact: true }).click();
    await discussion(page).screenshot({
      path: test.info().outputPath('discussion-desktop.png'),
    });
    await p.peer.setViewportSize({ width: 390, height: 844 });
    await p.peer.getByRole('link', { name: 'Discussion', exact: true }).click();
    await discussion(p.peer).screenshot({
      path: test.info().outputPath('discussion-mobile.png'),
    });
    await p.peer.mouse.move(0, 0);
    await p.peer.evaluate(
      () => (document.documentElement.dataset['theme'] = 'dark'),
    );
    await expect(
      discussion(p.peer).getByRole('button', {
        name: 'Recheck discussion',
        exact: true,
      }),
    ).toHaveCSS('background-color', 'rgb(24, 35, 29)');
    await discussion(p.peer).screenshot({
      path: test.info().outputPath('discussion-dark.png'),
    });
  } finally {
    release.resolve();
    await p.context.close();
  }
});

test('bootstrap buffers concurrent chat and authenticated heads repair a final dropped notification while metadata refresh preserves editor and composer', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const release = deferred();
  let held = false,
    first = true,
    dropped = 0,
    replayRequests = 0;
  const final = 'Final notification deliberately lost';
  const p = await pair(page, browser, browserName, 'editor', async (peer) => {
    await notifications(peer, (frame) => {
      if (frame.type === 'event' && frame.data?.message?.body === final) {
        dropped++;
        return true;
      }
      return false;
    });
    peer.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/events/') && url.searchParams.has('after'))
        replayRequests++;
    });
    await peer.route('**/chat/messages/?limit=50', async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      held = true;
      await release.promise;
      await route.fulfill({ response });
    });
  });
  try {
    await ready(page);
    await expect.poll(() => held).toBe(true);
    const during = 'Committed during the initial REST snapshot';
    await send(page, during);
    await expect(row(page, during)).toHaveCount(1);
    release.resolve();
    await ready(p.peer);
    await expect(row(p.peer, during)).toHaveCount(1);
    const beforeRepair = replayRequests;
    await send(page, final);
    await expect(row(page, final)).toHaveCount(1);
    await expect(row(p.peer, final)).toHaveCount(1, { timeout: 20000 });
    expect(dropped).toBeGreaterThan(0);
    expect(replayRequests).toBeGreaterThan(beforeRepair);
    await discussion(p.peer)
      .getByLabel('Message to project')
      .fill('Keep this composer draft');
    const source = await openFileDownload(p.peer),
      editor = p.peer.getByRole('textbox', {
        name: 'Python source for main.py',
        exact: true,
      });
    await editor.focus();
    await expect(editor).toBeFocused();
    await page.getByRole('button', { name: 'Add file', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add a Python file' });
    await add.getByLabel('File path', { exact: true }).fill('helper.py');
    await add
      .getByRole('button', { name: 'Add Python file', exact: true })
      .click();
    await expect(
      p.peer.getByRole('button', { name: 'helper.py', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(editor).toBeFocused();
    await expect(
      discussion(p.peer).getByLabel('Message to project'),
    ).toHaveValue('Keep this composer draft');
    expect(await openFileDownload(p.peer)).toBe(source);
  } finally {
    release.resolve();
    await p.context.close();
  }
});

test('unconfirmed messages retry one immutable nonce only manually, never replay offline, and pending state is destroyed across accounts', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  await notifications(
    page,
    (frame) =>
      frame.type === 'head' || frame.event_type === 'chat.message.created',
  );
  const p = await pair(page, browser, browserName);
  let loseReplies = true;
  const requests: { client_message_id: string; body: string }[] = [];
  const statuses: number[] = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/api/v1/projects/${p.projectId}/chat/messages/`
    )
      statuses.push(response.status());
  });
  try {
    await ready(page);
    await page.route(
      `**/api/v1/projects/${p.projectId}/chat/messages/`,
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        requests.push(
          route.request().postDataJSON() as (typeof requests)[number],
        );
        if (!loseReplies) return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort('failed');
      },
    );
    const text = 'Retry this same committed request';
    await send(page, text);
    await expect(discussion(page).locator('.discussion-pending')).toContainText(
      'Not confirmed',
    );
    for (let n = 1; n < 20; n++) {
      await send(page, `Other uncertain message ${n}`);
      await expect(discussion(page).locator('.discussion-pending')).toHaveCount(
        n + 1,
      );
    }
    await expect(
      discussion(page)
        .locator('.discussion-pending')
        .filter({ hasText: 'Sending…' }),
    ).toHaveCount(0);
    await discussion(page)
      .getByLabel('Message to project')
      .fill('New message capacity reached');
    await expect(
      discussion(page).getByRole('button', {
        name: 'Send message',
        exact: true,
      }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 960 });
    await discussion(page).screenshot({
      path: test.info().outputPath('discussion-pending.png'),
    });
    loseReplies = false;
    await discussion(page)
      .locator('.discussion-pending')
      .filter({ hasText: text })
      .getByRole('button', { name: 'Retry unconfirmed message', exact: true })
      .click();
    await expect.poll(() => requests.length).toBe(21);
    await expect.poll(() => statuses.at(-1)).toBe(200);
    await expect(row(page, text)).toHaveCount(1);
    expect(requests[20]).toEqual(requests[0]);
    await expect(discussion(page).locator('.discussion-pending')).toHaveCount(
      19,
    );
    await noStoredDiscussion(page, [
      text,
      requests[0]!.client_message_id,
      'Other uncertain message 19',
    ]);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await login(page, p.email);
    await page.goto(p.url);
    await ready(page);
    await expect(discussion(page).locator('.discussion-pending')).toHaveCount(
      0,
    );
    await expect(discussion(page).getByLabel('Message to project')).toHaveValue(
      '',
    );
    expect(requests).toHaveLength(21);
    await expect(row(page, 'Other uncertain message 19')).toHaveCount(1);
    await page.context().setOffline(true);
    await expect(page.locator('.discussion-status')).toHaveText(
      'Discussion is offline.',
    );
    await discussion(page)
      .getByLabel('Message to project')
      .fill('An offline composer draft');
    await expect(
      discussion(page).getByRole('button', {
        name: 'Send message',
        exact: true,
      }),
    ).toBeDisabled();
    await page.context().setOffline(false);
    await ready(page);
    expect(requests).toHaveLength(21);
    await expect(discussion(page).getByLabel('Message to project')).toHaveValue(
      'An offline composer draft',
    );
  } finally {
    if (!page.isClosed()) await page.context().setOffline(false);
    await p.context.close();
  }
});

test('viewer history loads older UTC messages, denies writes, and a live capability page contains no discussion or events transport', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const p = await pair(
    page,
    browser,
    browserName,
    'viewer',
    undefined,
    async (owner, projectId) => {
      const { csrfToken } = (await (
        await owner.request.get('/api/v1/csrf/')
      ).json()) as { csrfToken: string };
      for (let n = 1; n <= 52; n++) {
        const response = await owner.request.post(
          `/api/v1/projects/${projectId}/chat/messages/`,
          {
            headers: {
              'X-CSRFToken': csrfToken,
              Origin: new URL(owner.url()).origin,
            },
            data: {
              client_message_id: randomUUID(),
              body: `History message ${String(n).padStart(2, '0')}`,
            },
          },
        );
        expect(response.status()).toBe(201);
      }
    },
  );
  try {
    await ready(p.peer);
    await expect(rows(p.peer)).toHaveCount(50);
    const log = discussion(p.peer).getByRole('list', {
      name: 'Project discussion messages',
    });
    await log.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBe(0);
    const initialOffset = await row(p.peer, 'History message 03').evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest('ol')!.getBoundingClientRect().top,
    );
    await discussion(p.peer)
      .getByRole('button', { name: 'Load older messages', exact: true })
      .click();
    await expect(rows(p.peer)).toHaveCount(52);
    await expect(rows(p.peer).first()).toContainText('History message 01');
    // scrollTop rounds to device pixels while row rectangles retain subpixel values.
    await expect
      .poll(async () =>
        Math.abs(
          (await row(p.peer, 'History message 03').evaluate(
            (element) =>
              element.getBoundingClientRect().top -
              element.closest('ol')!.getBoundingClientRect().top,
          )) - initialOffset,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect(
      discussion(p.peer).getByRole('button', {
        name: 'Jump to latest',
        exact: true,
      }),
    ).toHaveCount(0);
    await log.focus();
    await send(page, 'Incoming while reading older messages');
    await expect(
      discussion(p.peer).getByText('1 new message loaded.', { exact: true }),
    ).toBeVisible();
    await expect(log).toBeFocused();
    const jump = discussion(p.peer).getByRole('button', {
      name: 'Jump to latest',
      exact: true,
    });
    await jump.focus();
    await jump.press('Enter');
    await expect(
      discussion(p.peer).getByRole('button', {
        name: 'Jump to latest',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(log).toBeFocused();
    await expect
      .poll(() =>
        log.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(48);
    await expect(
      discussion(p.peer).getByRole('button', {
        name: 'Send message',
        exact: true,
      }),
    ).toBeDisabled();
    const peerCsrf = (await (
      await p.peer.request.get('/api/v1/csrf/')
    ).json()) as { csrfToken: string };
    const denied = await p.peer.request.post(
      `/api/v1/projects/${p.projectId}/chat/messages/`,
      {
        headers: {
          'X-CSRFToken': peerCsrf.csrfToken,
          Origin: new URL(p.url).origin,
        },
        data: { client_message_id: randomUUID(), body: 'Viewer must not post' },
      },
    );
    expect(denied.status()).toBe(403);
    await page.getByLabel('Link type', { exact: true }).selectOption('live');
    await page
      .getByRole('button', { name: 'Create shared link', exact: true })
      .click();
    await expect(
      page.getByLabel('New shared link', { exact: true }),
    ).toBeVisible();
    const link = await page
      .getByLabel('New shared link', { exact: true })
      .inputValue();
    const requests: string[] = [];
    p.peer.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes('/chat/') || path.endsWith('/events/'))
        requests.push(path);
    });
    const sockets: string[] = [];
    p.peer.on('websocket', (socket) =>
      sockets.push(new URL(socket.url()).pathname),
    );
    await p.peer.goto(link);
    await expect(
      p.peer.getByRole('textbox', {
        name: 'Python source for main.py',
        exact: true,
      }),
    ).toBeVisible();
    await expect(discussion(p.peer)).toHaveCount(0);
    await expect(
      p.peer.getByRole('link', { name: 'Discussion', exact: true }),
    ).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(sockets).not.toContain('/events');
  } finally {
    await p.context.close();
  }
});
