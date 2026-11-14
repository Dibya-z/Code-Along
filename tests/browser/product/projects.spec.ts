import {
  test,
  expect,
  type Page,
  type Request,
  type ConsoleMessage,
} from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import {
  openProjectSection,
  openWorkspaceMembers,
  register,
  showFiles,
} from './helpers.ts';

type Actor = 'owner' | 'recipient';
type Phase =
  | 'setup'
  | 'projectcreate'
  | 'privatedenial'
  | 'fileadd'
  | 'filerename'
  | 'invitecreate'
  | 'invitejoin'
  | 'viewerwritedenied'
  | 'grantEditor'
  | 'editorreload'
  | 'revoke'
  | 'deniedreload'
  | 'inviteReuseDenied'
  | 'responsive'
  | 'transfer'
  | 'newOwnerOpen';
function projectObservations() {
  const phases: Record<Actor, Phase> = { owner: 'setup', recipient: 'setup' };
  const errors: {
    actor: Actor;
    phase: Phase;
    kind: string;
    access?: string;
    route?: string;
    frame?: string;
  }[] = [];
  const recent: {
    a: Actor;
    p: Phase;
    m: string;
    r: string;
    s: number | string;
    ms: number;
    end?: Phase;
  }[] = [];
  const pending = new Map<
    Request,
    { a: Actor; p: Phase; m: string; r: string; at: number }
  >();
  const dispose: (() => void)[] = [];
  const uuid = '[0-9a-f-]{36}';
  const routes: [RegExp, string][] = [
    [/^\/api\/v1\/me\/$/, 'me'],
    [/^\/api\/v1\/csrf\/$/, 'csrf'],
    [/^\/api\/v1\/runtime-profiles\/$/, 'runtimes'],
    [/^\/api\/v1\/workspaces\/$/, 'workspaces'],
    [new RegExp(`^/api/v1/workspaces/${uuid}/$`), 'workspace'],
    [
      new RegExp(`^/api/v1/workspaces/${uuid}/projects/$`),
      'workspace-projects',
    ],
    [new RegExp(`^/api/v1/workspaces/${uuid}/members/$`), 'workspace-members'],
    [
      new RegExp(`^/api/v1/workspaces/${uuid}/invitations/(?:${uuid}/)?$`),
      'workspace-invitations',
    ],
    [/^\/api\/v1\/invitations\/preview\/$/, 'invitation-preview'],
    [/^\/api\/v1\/invitations\/accept\/$/, 'invitation-accept'],
    [new RegExp(`^/api/v1/projects/${uuid}/$`), 'project'],
    [new RegExp(`^/api/v1/projects/${uuid}/files/$`), 'project-files'],
    [new RegExp(`^/api/v1/projects/${uuid}/files/${uuid}/$`), 'project-file'],
    [
      new RegExp(`^/api/v1/projects/${uuid}/grants/(?:${uuid}/)?$`),
      'project-grants',
    ],
    [
      new RegExp(`^/api/v1/projects/${uuid}/invitations/(?:${uuid}/)?$`),
      'project-invitations',
    ],
    [new RegExp(`^/api/v1/projects/${uuid}/ownership/$`), 'project-transfer'],
    [
      new RegExp(`^/api/v1/projects/${uuid}/documents/${uuid}/ticket/$`),
      'document-ticket',
    ],
    [new RegExp(`^/api/v1/projects/${uuid}/events/$`), 'project-events'],
    [new RegExp(`^/api/v1/projects/${uuid}/chat/messages/$`), 'project-chat'],
    [
      new RegExp(`^/api/v1/projects/${uuid}/(?:shares|revisions)/$`),
      'project-records',
    ],
  ];
  const routeShape = (value: string): string | null => {
    try {
      const path = new URL(value, 'https://diagnostic.invalid').pathname;
      if (!path.startsWith('/api/')) return null;
      return routes.find(([pattern]) => pattern.test(path))?.[1] ?? 'other-api';
    } catch {
      return null;
    }
  };
  const accessControl = (value: string) =>
    /access.?control|\bCORS\b|cross.origin.*(?:blocked|denied)/i.test(value);
  function observe(page: Page, actor: Actor) {
    const pageError = (error: Error) => {
      const access = accessControl(error.message);
      const frame = error.stack?.match(
        /\/assets\/([A-Za-z0-9_-]{1,100}\.js):([0-9]{1,9}):([0-9]{1,9})(?=[\s)]|$)/,
      );
      const address = error.message
        .match(/https?:\/\/[^\s'"<>]+|\/api\/[^\s'"<>]+/g)
        ?.map(routeShape)
        .find((route) => route !== null);
      errors.push({
        actor,
        phase: phases[actor],
        kind: access
          ? 'native-access-control'
          : /AbortError|aborted|cancelled/i.test(error.message)
            ? 'aborted'
            : /Failed to fetch dynamically imported module|Importing a module script failed/.test(
                  error.message,
                )
              ? 'dynamic-import'
              : error.name === 'TypeError'
                ? 'type-error'
                : error.name === 'ReferenceError'
                  ? 'reference-error'
                  : error.name === 'SyntaxError'
                    ? 'syntax-error'
                    : 'other-js-error',
        ...(access
          ? {
              access: /fetch/i.test(error.message)
                ? 'fetch'
                : /XMLHttpRequest/i.test(error.message)
                  ? 'xhr'
                  : /resource|script|stylesheet/i.test(error.message)
                    ? 'resource'
                    : 'unknown',
              route: address ?? 'other-api',
            }
          : {}),
        ...(frame ? { frame: `${frame[1]}:${frame[2]}:${frame[3]}` } : {}),
      });
    };
    const request = (value: Request) => {
      const route = routeShape(value.url());
      if (!route) return;
      if (pending.size >= 16) pending.delete(pending.keys().next().value!);
      pending.set(value, {
        a: actor,
        p: phases[actor],
        m: [
          'GET',
          'POST',
          'PATCH',
          'PUT',
          'DELETE',
          'OPTIONS',
          'HEAD',
        ].includes(value.method())
          ? value.method()
          : 'other',
        r: route,
        at: Date.now(),
      });
    };
    const record = (value: Request, status: number | string) => {
      const route = routeShape(value.url());
      if (!route) return;
      const started = pending.get(value);
      recent.push({
        a: actor,
        p: started?.p ?? phases[actor],
        m: started?.m ?? 'other',
        r: route,
        s: status,
        ms: started ? Date.now() - started.at : 0,
        ...(started && started.p !== phases[actor]
          ? { end: phases[actor] }
          : {}),
      });
      if (recent.length > 16) recent.shift();
    };
    const response = (value: import('@playwright/test').Response) =>
      record(value.request(), value.status());
    const finished = (value: Request) => {
      pending.delete(value);
    };
    const failed = (value: Request) => {
      const reason = value.failure()?.errorText ?? '';
      record(
        value,
        accessControl(reason)
          ? 'failed:access-control'
          : /abort|cancel/i.test(reason)
            ? 'failed:aborted'
            : 'failed:network',
      );
      pending.delete(value);
    };
    page.on('pageerror', pageError);
    page.on('request', request);
    page.on('response', response);
    page.on('requestfinished', finished);
    page.on('requestfailed', failed);
    dispose.push(() => {
      page.off('pageerror', pageError);
      page.off('request', request);
      page.off('response', response);
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
    });
  }
  return {
    errors,
    observe,
    phase: (actor: Actor, phase: Phase) => {
      phases[actor] = phase;
    },
    message: () => {
      const data = {
        errorCount: errors.length,
        phases,
        errors: errors.slice(-4),
        recent: [...recent],
        pending: [...pending.values()].map(({ at, ...entry }) => ({
          ...entry,
          ms: Date.now() - at,
        })),
      };
      let message = JSON.stringify(data);
      while (message.length > 1900) {
        if (data.recent.length) data.recent.shift();
        else if (data.pending.length) data.pending.shift();
        else if (data.errors.length > 1) data.errors.shift();
        else break;
        message = JSON.stringify(data);
      }
      return message;
    },
    dispose: () => dispose.forEach((stop) => stop()),
  };
}
async function dialogLifecycle(page: Page) {
  const prefix = 'code-along-dialog-lifecycle:';
  const events: object[] = [];
  const receive = (message: ConsoleMessage) => {
    const text = message.text();
    if (message.type() !== 'debug' || !text.startsWith(prefix)) return;
    events.push(JSON.parse(text.slice(prefix.length)) as object);
    if (events.length > 40) events.shift();
  };
  page.on('console', receive);
  const handle = await page.evaluateHandle((prefix) => {
    const started = performance.now();
    const targetName = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return 'none';
      const button = target.closest('button,a');
      const text = button?.textContent?.trim();
      if (text === 'Create project invitation') return 'invite-trigger';
      if (text === 'Transfer project ownership') return 'transfer-trigger';
      if (text === 'Grant project access') return 'grant-button';
      if (text === 'Rename file') return 'rename-trigger';
      if (text === 'Save file path') return 'rename-save';
      if (text === 'Sharing') return 'sharing-link';
      if (button?.getAttribute('aria-label') === 'Close') return 'dialog-close';
      if (target.id === 'sharing') return 'sharing-section';
      if (target.matches('[data-radix-focus-guard]')) return 'focus-guard';
      if (target instanceof HTMLInputElement)
        return ['path', 'recipient_email'].includes(target.name)
          ? `field:${target.name}`
          : 'input';
      return target.tagName.toLowerCase();
    };
    const state = () => {
      const sharing = document.getElementById('sharing');
      const trigger = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Create project invitation',
      );
      const rect = trigger?.getBoundingClientRect();
      return {
        a: targetName(document.activeElement),
        d: [...document.querySelectorAll('[role="dialog"]')]
          .slice(0, 3)
          .map((dialog) => {
            const title = dialog.querySelector('h2')?.textContent?.trim();
            return `${title === 'Rename file' ? 'rename' : title === 'Invite to project' ? 'invite' : 'other'}:${dialog.getAttribute('data-state') === 'open' ? 'open' : 'closed'}`;
          }),
        y: Math.round(scrollY),
        r: rect
          ? [rect.x, rect.y, rect.width, rect.height].map(Math.round)
          : null,
        o: trigger?.getAttribute('data-state') === 'open',
        l: [...(sharing?.querySelectorAll('[role="status"]') ?? [])].some(
          (status) => status.textContent?.trim() === 'Loading shared links…',
        ),
        s: [
          sharing?.querySelectorAll('[aria-busy="true"]').length ?? 0,
          sharing?.querySelectorAll('.list-row').length ?? 0,
          sharing?.querySelectorAll('[role="alert"]').length ?? 0,
        ],
      };
    };
    const emit = (e: string, target?: EventTarget | null, point?: number[]) =>
      console.debug(
        prefix +
          JSON.stringify({
            t: Math.round(performance.now() - started),
            e,
            ...(target ? { n: targetName(target) } : {}),
            ...(point ? { p: point } : {}),
            ...state(),
          }),
      );
    const pointer = (event: Event) => {
      const point = event as PointerEvent;
      emit(event.type, event.target, [
        Math.round(point.clientX),
        Math.round(point.clientY),
      ]);
    };
    const focus = (event: Event) => emit(event.type, event.target);
    const key = (event: KeyboardEvent) => {
      if (['Escape', 'Tab', 'Enter'].includes(event.key))
        emit(`key:${event.key}`, event.target);
    };
    let previous = JSON.stringify(state());
    const observer = new MutationObserver(() => {
      const current = JSON.stringify(state());
      if (current !== previous) {
        previous = current;
        emit('dom');
      }
    });
    const pointerEvents = ['pointerdown', 'pointerup', 'click'];
    const focusEvents = ['focusin', 'focusout'];
    pointerEvents.forEach((name) =>
      document.addEventListener(name, pointer, true),
    );
    focusEvents.forEach((name) => document.addEventListener(name, focus, true));
    document.addEventListener('keydown', key, true);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'hidden', 'aria-hidden', 'aria-expanded'],
    });
    emit('start');
    return {
      stop() {
        emit('stop');
        observer.disconnect();
        pointerEvents.forEach((name) =>
          document.removeEventListener(name, pointer, true),
        );
        focusEvents.forEach((name) =>
          document.removeEventListener(name, focus, true),
        );
        document.removeEventListener('keydown', key, true);
      },
    };
  }, prefix);
  let stopped = false;
  return {
    evidence: () => JSON.stringify(events),
    message: () => {
      const data = [...events];
      while (JSON.stringify(data).length > 1900 && data.length > 1)
        data.shift();
      return JSON.stringify(data);
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await handle.evaluate((probe) => probe.stop());
      } finally {
        page.off('console', receive);
        await handle.dispose();
      }
    },
  };
}
test('private project, scoped invitation, viewer/editor permissions and ownership', async ({
  page,
  browser,
  browserName,
}) => {
  const stamp = Date.now();
  const recipientEmail = `project-recipient-${browserName}-${stamp}@example.test`;
  const observations = projectObservations();
  const errors = observations.errors;
  let lifecycle: Awaited<ReturnType<typeof dialogLifecycle>> | undefined;
  observations.observe(page, 'owner');
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
    observations.observe(recipient, 'recipient');
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
    await openWorkspaceMembers(page);
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
    observations.phase('recipient', 'invitejoin');
    await recipient.goto(await workspaceLink.inputValue());
    await recipient
      .getByRole('button', { name: 'Join workspace', exact: true })
      .click();
    await expect(
      recipient.getByRole('heading', { name: 'Python studio', exact: true }),
    ).toBeVisible();
    observations.phase('owner', 'projectcreate');
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
    observations.phase('recipient', 'privatedenial');
    await recipient.goto(projectUrl);
    await expect(
      recipient.getByRole('heading', {
        name: 'Project unavailable.',
        exact: true,
      }),
    ).toBeVisible();
    observations.phase('owner', 'fileadd');
    await showFiles(page);
    await page.getByRole('button', { name: 'Add file', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add a Python file' });
    await dialog.getByLabel('File path').fill('helper.py');
    await dialog.getByLabel('Starter source (optional)').fill('answer = 42\n');
    await dialog
      .getByRole('button', { name: 'Add Python file', exact: true })
      .click();
    await expect(
      page.getByRole('tab', { name: 'helper.py', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByLabel('Python source for helper.py', { exact: true }),
    ).toBeVisible();
    observations.phase('owner', 'filerename');
    await page
      .getByRole('button', { name: 'Rename file', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Rename file' });
    await dialog.getByLabel('New file path').fill('lessons/helper.py');
    lifecycle = await dialogLifecycle(page);
    await dialog
      .getByRole('button', { name: 'Save file path', exact: true })
      .click();
    await expect(
      page.getByRole('tab', { name: 'lessons/helper.py', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByLabel('Python source for lessons/helper.py', { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    observations.phase('owner', 'invitecreate');
    await openProjectSection(page, 'Sharing');
    await page
      .getByRole('button', { name: 'Create project invitation', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Invite to project' });
    await dialog.getByLabel('Member email').fill(recipientEmail);
    await lifecycle.stop();
    await dialog
      .getByRole('button', { name: 'Create project invitation', exact: true })
      .click();
    const projectLink = page.getByLabel('Project invitation link');
    await expect(projectLink).toBeVisible();
    const inviteUrl = await projectLink.inputValue();
    observations.phase('recipient', 'invitejoin');
    await recipient.goto(inviteUrl);
    await recipient
      .getByRole('button', { name: 'Join project', exact: true })
      .click();
    await expect(
      recipient
        .locator('.project-heading')
        .getByText('Viewer', { exact: true }),
    ).toBeVisible();
    observations.phase('recipient', 'viewerwritedenied');
    await showFiles(recipient);
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
    observations.phase('owner', 'grantEditor');
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
    observations.phase('recipient', 'editorreload');
    await recipient.reload();
    await expect(
      recipient
        .locator('.project-heading')
        .getByText('Editor', { exact: true }),
    ).toBeVisible();
    await showFiles(recipient);
    await expect(
      recipient.getByRole('button', { name: 'Add file', exact: true }),
    ).toBeVisible();
    observations.phase('owner', 'revoke');
    await page
      .getByRole('button', { name: 'Remove project access', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Remove project access', exact: true }),
    ).toHaveCount(0);
    observations.phase('recipient', 'deniedreload');
    await recipient.reload();
    await expect(
      recipient.getByRole('heading', {
        name: 'Project unavailable.',
        exact: true,
      }),
    ).toBeVisible();
    observations.phase('recipient', 'inviteReuseDenied');
    await recipient.goto(inviteUrl);
    await expect(recipient.getByRole('alert')).toContainText(
      'Invitation unavailable',
    );
    observations.phase('owner', 'responsive');
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
    observations.phase('owner', 'transfer');
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
    await expect(
      page.locator('.project-heading').getByText('Editor', { exact: true }),
    ).toBeVisible();
    observations.phase('recipient', 'newOwnerOpen');
    await recipient.goto(projectUrl);
    await expect(
      recipient.locator('.project-heading').getByText('Owner', { exact: true }),
    ).toBeVisible();
    expect(errors, observations.message()).toEqual([]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : 'Project journey failed.'}\nBounded dialog lifecycle: ${lifecycle?.message() ?? 'not-started'}\nBounded project requests: ${observations.message()}`,
      { cause: error },
    );
  } finally {
    if (lifecycle)
      await writeFile(
        test.info().outputPath('dialog-lifecycle.json'),
        lifecycle.evidence(),
      );
    await writeFile(
      test.info().outputPath('project-network.json'),
      observations.message(),
    );
    await lifecycle?.stop().catch(() => undefined);
    await context.close();
    observations.dispose();
  }
});
