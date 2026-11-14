import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  ENTRYPOINT,
  IMPORT_CHECKS,
  LEARNER_SOURCE,
  checks,
  disclosure,
  exported,
  get,
  pane,
  practiceCopy,
  practiceFixture,
  readySource,
  replaceSource,
  runChecks,
  saved,
  type PracticeFile,
  type Version,
} from './practice-fixture.ts';

const output = (page: Page) =>
  page.getByRole('region', { name: 'Python output', exact: true });
const status = (page: Page) => page.locator('.execution-status');
const frame = (page: Page) =>
  page.locator('iframe[title="Isolated Python runtime"]');
async function finished(page: Page) {
  await expect(status(page)).toHaveText('Checks finished', { timeout: 40000 });
}
async function capturedSource(page: Page, path: string, source: string) {
  await pane(page, 'Output');
  await disclosure(page, 'View captured source');
  const file = page.locator('.captured-source details').filter({
    has: page
      .locator('summary')
      .filter({ hasText: new RegExp(`^${path.replaceAll('.', '\\.')}$`) }),
  });
  const summary = file.locator(':scope > summary');
  if (!(await file.evaluate((element) => (element as HTMLDetailsElement).open)))
    await summary.click();
  // textContent compares exact bytes represented as text, including BOM/LF;
  // toHaveText deliberately normalizes whitespace and is unsuitable here.
  expect(await file.locator('pre').textContent()).toBe(source);
  await expect(file).toContainText(
    createHash('sha256').update(source, 'utf8').digest('hex'),
  );
}
async function capturedChecks(page: Page, source: string) {
  await disclosure(page, 'View captured checks');
  expect(
    await page
      .getByLabel('Captured visible Python checks', { exact: true })
      .textContent(),
  ).toBe(source);
}
async function assertFrameReplaced(
  page: Page,
  old: Awaited<ReturnType<ReturnType<typeof frame>['elementHandle']>>,
) {
  expect(old).not.toBeNull();
  await expect
    .poll(() => old!.evaluate((element) => element.isConnected))
    .toBe(false);
  await expect(frame(page)).toHaveCount(1);
}
async function visuals(page: Page, browserName: string) {
  for (const capture of [
    { width: 1440, height: 900, theme: 'light', name: 'practice-desktop' },
    { width: 390, height: 844, theme: 'light', name: 'practice-390' },
    { width: 390, height: 844, theme: 'dark', name: 'practice-390-dark' },
  ] as const) {
    await page.setViewportSize({
      width: capture.width,
      height: capture.height,
    });
    await page
      .locator('html')
      .evaluate(
        (element, theme) => element.setAttribute('data-theme', theme),
        capture.theme,
      );
    await expect(
      page.locator('.editor-workbench[data-guide="true"]'),
    ).toHaveAttribute('data-guide-compact', String(capture.width < 1280));
    await pane(page, 'Output');
    await disclosure(page, 'View captured source', false);
    await disclosure(page, 'View captured checks', false);
    await disclosure(page, 'Task and runtime provenance', false);
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const resultLine = output(page).locator('.console-line').first();
    const geometry = await page.evaluate(() => {
      const console = document.querySelector('.execution-output')!;
      const line = console.querySelector('.console-line')!;
      const rect = line.getBoundingClientRect();
      return {
        scrollY,
        firstLine: { top: rect.top, bottom: rect.bottom },
        consoleBottom: console.getBoundingClientRect().bottom,
        inspectors: [
          ...document.querySelectorAll(
            '.captured-source,.captured-checks,.practice-provenance',
          ),
        ].map((element) => element.getBoundingClientRect().top),
        targets: [
          ...document.querySelectorAll(
            '.captured-source > summary,.captured-checks > summary,.practice-provenance > summary',
          ),
        ].map((element) => element.getBoundingClientRect().height),
      };
    });
    await writeFile(
      test.info().outputPath(`${capture.name}-output.json`),
      JSON.stringify(geometry, null, 2),
    );
    expect(geometry.scrollY).toBe(0);
    expect(
      geometry.inspectors.every((top) => top >= geometry.consoleBottom),
    ).toBe(true);
    expect(geometry.targets).toHaveLength(3);
    expect(geometry.targets.every((height) => height >= 44)).toBe(true);
    if (capture.width === 390) {
      expect(geometry.firstLine.bottom).toBeLessThan(capture.height);
      await expect(resultLine).toBeInViewport();
    }
    await page.screenshot({
      path: test.info().outputPath(`${capture.name}-output.png`),
      fullPage: true,
      animations: 'disabled',
    });
    if (capture.width === 390) await expect(resultLine).toBeInViewport();
    await checks(page);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      window.scrollTo(0, 0);
      document.querySelector<HTMLElement>(
        '.workbench-guide-content',
      )!.scrollTop = 0;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`${capture.name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('html')
    .evaluate((element) => element.setAttribute('data-theme', 'light'));
  await checks(page);
  const run = page.getByRole('button', {
    name: 'Run visible checks',
    exact: true,
  });
  await run.focus();
  await expect(run).toBeFocused();
  const allControls = browserName === 'webkit' && process.platform === 'darwin';
  await run.press(allControls ? 'Alt+Tab' : 'Tab');
  await page.keyboard.press(allControls ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await expect(run).toBeFocused();
  const focus = await run.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      width: style.outlineWidth,
      style: style.outlineStyle,
      targetWidth: rect.width,
      targetHeight: rect.height,
    };
  });
  expect(focus.width).toBe('2px');
  expect(focus.style).toBe('solid');
  expect(focus.targetWidth).toBeGreaterThanOrEqual(44);
  expect(focus.targetHeight).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: test.info().outputPath('practice-keyboard-checks.png'),
    fullPage: true,
    animations: 'disabled',
  });
}

test('published visible checks import exact BOM learner source without running main, stage hints and remain untrusted plaintext', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const f = await practiceFixture(page, browser, browserName);
  const learner = f.learner;
  try {
    await readySource(learner);
    const archive = await exported(learner);
    expect(
      archive.files.find((file) => file.path === 'learner.py')?.source,
    ).toBe(LEARNER_SOURCE);
    expect(
      Buffer.from(LEARNER_SOURCE, 'utf8').subarray(0, 3).toString('hex'),
    ).toBe('efbbbf');
    await pane(learner, 'Task');
    const hints = learner.getByRole('region', {
      name: 'Task hints',
      exact: true,
    });
    await expect(hints.locator('summary')).toHaveCount(0);
    await hints
      .getByRole('button', { name: 'Reveal next hint', exact: true })
      .click();
    const first = hints
      .locator('summary')
      .filter({ hasText: /^Hint 1: Inspect the module$/ });
    await expect(first).toBeFocused();
    await expect(hints.locator('summary')).toHaveCount(1);
    await expect(
      hints.getByText('Compare its result with forty-two.', { exact: true }),
    ).toHaveCount(0);
    await first.click();
    await pane(learner, 'Code');
    await pane(learner, 'Task');
    await expect(first).toBeVisible();
    expect(
      await first.evaluate(
        (element) => (element.parentElement as HTMLDetailsElement).open,
      ),
    ).toBe(false);
    await hints
      .getByRole('button', { name: 'Reveal next hint', exact: true })
      .click();
    await expect(hints.locator('summary').last()).toBeFocused();
    await expect(
      hints.getByRole('button', { name: 'All hints revealed', exact: true }),
    ).toBeDisabled();
    await checks(learner);
    expect(
      await learner
        .getByLabel('Published visible Python checks', { exact: true })
        .textContent(),
    ).toBe(IMPORT_CHECKS);
    const run = learner.getByRole('button', {
      name: 'Run visible checks',
      exact: true,
    });
    await expect(run).toBeEnabled();
    await run.focus();
    await run.press('Enter');
    await pane(learner, 'Output');
    await finished(learner);
    await expect(output(learner)).toContainText('checked 42');
    await expect(output(learner)).toContainText('<b>plain output</b>');
    await expect(output(learner).locator('b')).toHaveCount(0);
    await expect(output(learner)).not.toContainText('ENTRYPOINT_ONLY');
    await expect(learner.locator('.practice-scope')).toHaveText(
      'Untrusted practice · No grade or submission.',
    );
    await capturedSource(learner, 'main.py', ENTRYPOINT);
    await capturedSource(learner, 'learner.py', LEARNER_SOURCE);
    await capturedChecks(learner, IMPORT_CHECKS);
    await disclosure(learner, 'Task and runtime provenance');
    await expect(learner.locator('.practice-provenance')).toContainText(
      f.version.id,
    );
    await expect(learner.locator('.practice-provenance')).toContainText(
      f.version.content_sha256,
    );
    await disclosure(learner, 'Run options');
    await expect(
      learner.getByText('Task environment', { exact: true }),
    ).toBeVisible();
    await expect(
      learner.getByLabel('Python environment', { exact: true }),
    ).toHaveCount(0);
    await disclosure(learner, 'Run options', false);
    await visuals(learner, browserName);
    const failing =
      'import learner\nassert learner.answer() == 99, "Try the learner module again"\n';
    await practiceCopy(learner, failing);
    await runChecks(learner);
    await expect(status(learner)).toHaveText('Checks failed', {
      timeout: 40000,
    });
    await expect(output(learner)).toContainText(
      'AssertionError: Try the learner module again',
    );
    await expect(output(learner)).toContainText('<Code Along visible checks>');
    await capturedChecks(learner, failing);
    await expect(learner.locator('.execution-provenance')).toContainText(
      'Practice copy',
    );
    const published = await get<Version>(
      learner,
      `/api/v1/assignments/${f.assignmentId}/versions/${f.version.id}/`,
    );
    expect(published).toEqual(f.version);
  } finally {
    await f.close();
  }
});

test('practice retains tested H and exact checks while a peer edits H2, with memory-only copies across panes', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(150000);
  const published = 'import learner\nprint("published", learner.answer())\n';
  const f = await practiceFixture(page, browser, browserName, published);
  const learner = f.learner;
  try {
    await readySource(learner);
    await f.grantTeacherSource();
    const before = await get<{ items: PracticeFile[] }>(
      learner,
      `/api/v1/projects/${f.projectId}/files/`,
    );
    const firstCopy =
      'import learner\nanswer = learner.answer()\nname = input("Continue: ")\nprint("captured", answer, name)\n';
    const secondCopy = 'import learner\nprint("next", learner.answer())\n';
    await pane(learner, 'Output');
    await disclosure(learner, 'Run options');
    await learner
      .getByLabel('Python input mode', { exact: true })
      .selectOption('interactive');
    await runChecksWithCopy();
    async function runChecksWithCopy() {
      await practiceCopy(learner, firstCopy);
      await runChecks(learner);
    }
    await expect(status(learner)).toHaveText('Waiting for input', {
      timeout: 40000,
    });
    const retainedFrame = await frame(learner).elementHandle();
    await learner.getByLabel('Input for Python', { exact: true }).fill('River');
    await pane(learner, 'Task');
    await expect(
      learner.getByRole('button', { name: 'Run visible checks', exact: true }),
    ).toBeDisabled();
    await expect(
      learner.getByRole('button', { name: 'Run code', exact: true }),
    ).toBeDisabled();
    await practiceCopy(learner, secondCopy);
    await replaceSource(
      page,
      'learner.py',
      '\uFEFFdef answer():\n    return 99\n',
    );
    await saved(learner);
    await pane(learner, 'Code');
    await pane(learner, 'Task');
    await expect(
      learner.getByRole('textbox', { name: /^Practice check copy/ }),
    ).toHaveValue(secondCopy);
    await pane(learner, 'Output');
    await expect(
      learner.getByLabel('Input for Python', { exact: true }),
    ).toHaveValue('River');
    expect(
      await retainedFrame!.evaluate((element) => element.isConnected),
    ).toBe(true);
    await learner
      .getByRole('button', { name: 'Send input', exact: true })
      .click();
    await finished(learner);
    await expect(output(learner)).toContainText('captured 42 River');
    await expect(learner.locator('.execution-provenance')).toContainText(
      'Earlier source',
    );
    await expect(learner.locator('.execution-provenance')).toContainText(
      'Earlier checks',
    );
    await capturedSource(learner, 'learner.py', LEARNER_SOURCE);
    await capturedChecks(learner, firstCopy);
    expect(
      (await exported(learner)).files.find((file) => file.path === 'learner.py')
        ?.source,
    ).toBe('\uFEFFdef answer():\n    return 99\n');
    await runChecks(learner);
    await finished(learner);
    await expect(output(learner)).toContainText('next 99');
    await capturedChecks(learner, secondCopy);
    const after = await get<{ items: PracticeFile[] }>(
      learner,
      `/api/v1/projects/${f.projectId}/files/`,
    );
    expect(after.items).toEqual(before.items);
    const unchanged = await get<Version>(
      learner,
      `/api/v1/assignments/${f.assignmentId}/versions/${f.version.id}/`,
    );
    expect(unchanged).toEqual(f.version);
    await learner.reload();
    await saved(learner);
    await checks(learner);
    await expect(
      learner.getByRole('button', {
        name: 'Make a practice copy',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      learner.getByRole('textbox', { name: /^Practice check copy/ }),
    ).toHaveCount(0);
    expect(
      await learner
        .getByLabel('Published visible Python checks', { exact: true })
        .textContent(),
    ).toBe(published);
    expect(
      (await exported(learner)).files.find((file) => file.path === 'learner.py')
        ?.source,
    ).toBe('\uFEFFdef answer():\n    return 99\n');
  } finally {
    await f.close();
  }
});

test('practice shares one input and Stop lifecycle, enforces deadline and output limits, and switches fixed Run protocols freshly', async ({
  page,
  browser,
  browserName,
}) => {
  test.setTimeout(240000);
  const observations: { phase: string; elapsed: number; ui?: unknown }[] = [];
  const started = Date.now();
  const live: { page?: Page } = {};
  async function observe(phase: string) {
    const record = {
      phase,
      elapsed: Date.now() - started,
      ui: undefined as unknown,
    };
    observations.push(record);
    const path = test.info().outputPath('lifecycle-phases.json');
    await writeFile(path, JSON.stringify(observations, null, 2));
    if (live.page && !live.page.isClosed()) {
      record.ui = await Promise.race([
        live.page
          .evaluate(() => {
            const known = [
              'Ready to run',
              'Capturing project…',
              'Starting Python…',
              'Running',
              'Waiting for input',
              'Run finished',
              'Run failed',
              'Run stopped',
              'Time limit reached',
              'Output limit reached',
              'Checks finished',
              'Checks failed',
            ];
            const value = document
              .querySelector('.execution-status')
              ?.textContent?.trim();
            const button = (name: string) =>
              [...document.querySelectorAll<HTMLButtonElement>('button')].find(
                (item) => item.textContent?.trim() === name,
              );
            const settings = [...document.querySelectorAll('summary')].find(
              (item) => item.textContent?.trim() === 'Run options',
            )?.parentElement as HTMLDetailsElement | undefined;
            const mode = document.querySelector<HTMLSelectElement>(
              '[aria-label="Python input mode"]',
            )?.value;
            const paneButtons = [
              ...document.querySelectorAll<HTMLButtonElement>(
                'nav[aria-label="Workbench panes"] button',
              ),
            ];
            const paneGeometry = paneButtons.map((item) => {
              const bounds = item.getBoundingClientRect();
              const hit = document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              );
              const hitName = hit?.closest('button')?.textContent?.trim();
              return {
                name: ['Task', 'Code', 'Output'].includes(
                  item.textContent?.trim() ?? '',
                )
                  ? item.textContent?.trim()
                  : 'other',
                x: Math.round(bounds.x),
                y: Math.round(bounds.y),
                width: Math.round(bounds.width),
                height: Math.round(bounds.height),
                center: [
                  'Task',
                  'Code',
                  'Output',
                  'Run code',
                  'Stop run',
                ].includes(hitName ?? '')
                  ? hitName
                  : hit?.closest('.project-command-bar')
                    ? 'command-bar'
                    : 'other-or-outside',
              };
            });
            return {
              status: known.includes(value ?? '') ? value : 'absent-or-other',
              mode:
                mode === 'batch' || mode === 'interactive' ? mode : 'absent',
              panes: paneButtons
                .filter((item) => item.getAttribute('aria-pressed') === 'true')
                .map((item) => item.textContent?.trim()),
              paneGeometry,
              windowScroll: Math.round(scrollY),
              guideScroll:
                document.querySelector('.workbench-guide-content')?.scrollTop ??
                null,
              runOptionsOpen: settings?.open ?? false,
              runDisabled: button('Run code')?.disabled ?? null,
              stopDisabled: button('Stop run')?.disabled ?? null,
              checksDisabled: button('Run visible checks')?.disabled ?? null,
              frames: document.querySelectorAll(
                'iframe[title="Isolated Python runtime"]',
              ).length,
              inspectorTargets: [
                ...document.querySelectorAll(
                  '.captured-source > summary,.captured-checks > summary,.practice-provenance > summary',
                ),
              ].map((item) => item.getBoundingClientRect().height),
            };
          })
          .catch(() => ({ unavailable: true })),
        new Promise((resolve) =>
          setTimeout(() => resolve({ unavailable: true }), 500),
        ),
      ]);
      await writeFile(path, JSON.stringify(observations, null, 2));
    }
  }
  async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
    await observe(`${name}:before`);
    return test.step(name, async () => {
      try {
        const result = await action();
        await observe(`${name}:after`);
        return result;
      } catch (error) {
        await observe(`${name}:failed`);
        throw error;
      }
    });
  }
  const interactive =
    'import os\nprint("fresh", "marker" in globals(), os.path.exists("scratch.txt"))\nmarker = 1\nwith open("scratch.txt", "w") as stream:\n    stream.write("local")\ntry:\n    name = input("Name: ")\n    print("hello", name)\n    input("End: ")\nexcept EOFError:\n    print("EOF received")\n';
  const f = await step('fixture', () =>
    practiceFixture(page, browser, browserName, interactive),
  );
  live.page = f.learner;
  const source = f.learner;
  let bodyFailed = false;
  async function cleanup() {
    let cleanupError: unknown;
    try {
      await step('cleanup-stop', async () => {
        const stop = source.getByRole('button', {
          name: 'Stop run',
          exact: true,
        });
        if (!source.isClosed() && (await stop.isEnabled({ timeout: 1000 })))
          await stop.click({ timeout: 5000 });
      });
    } catch (error) {
      cleanupError = error;
    }
    try {
      await step('context-cleanup', () => f.close());
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError && !bodyFailed) throw cleanupError;
  }
  try {
    await step('source', () => readySource(source));
    await step('interactive-mode', async () => {
      await pane(source, 'Output');
      await disclosure(source, 'Run options');
      await source
        .getByLabel('Python input mode', { exact: true })
        .selectOption('interactive');
    });
    await step('interactive-run', async () => {
      await runChecks(source);
      await expect(status(source)).toHaveText('Waiting for input', {
        timeout: 40000,
      });
    });
    await step('input', async () => {
      await source
        .getByLabel('Input for Python', { exact: true })
        .fill('River');
      await source
        .getByRole('button', { name: 'Send input', exact: true })
        .click();
      await expect(output(source)).toContainText('hello River');
      await expect(status(source)).toHaveText('Waiting for input');
    });
    await step('eof', async () => {
      await source
        .getByRole('button', { name: 'Send end of input', exact: true })
        .click();
      await finished(source);
      await expect(
        source.locator('.interactive-input [role="alert"]'),
      ).toHaveCount(0);
      await expect(output(source)).toContainText('fresh False False');
      await expect(output(source)).toContainText('EOF received');
    });
    await step('batch-mode', async () => {
      await source
        .getByLabel('Python input mode', { exact: true })
        .selectOption('batch');
      await source.getByLabel('Input before Run').fill('Again');
      await expect(source.getByLabel('Input before Run')).toHaveValue('Again');
    });
    await step('batch-run', async () => {
      await runChecks(source);
      await finished(source);
      await expect(output(source)).toContainText('fresh False False');
      await expect(output(source)).toContainText('hello Again');
      await expect(output(source)).toContainText('EOF received');
    });
    await step('stop-copy', () =>
      practiceCopy(
        source,
        'print("stop-ready", flush=True)\nwhile True:\n    pass\n',
      ),
    );
    await step('stop-run', async () => {
      await runChecks(source);
      await expect(output(source)).toContainText('stop-ready', {
        timeout: 40000,
      });
    });
    await step('stop', async () => {
      await source
        .getByRole('button', { name: 'Stop run', exact: true })
        .click();
      await expect(status(source)).toHaveText('Run stopped');
      await expect(frame(source)).toHaveCount(0);
    });
    await step('deadline-copy', () =>
      practiceCopy(source, 'while True:\n    pass\n'),
    );
    await step('deadline-run', () => runChecks(source));
    await step('deadline-result', async () => {
      await expect(status(source)).toHaveText('Time limit reached', {
        timeout: 40000,
      });
      await expect(frame(source)).toHaveCount(0);
    });
    await step('flood-copy', () =>
      practiceCopy(source, 'while True:\n    print("x" * 4096)\n'),
    );
    await step('flood-run', () => runChecks(source));
    await step('flood-result', async () => {
      await expect(status(source)).toHaveText('Output limit reached', {
        timeout: 40000,
      });
      await expect(frame(source)).toHaveCount(0);
    });
    await step('fresh-copy', () =>
      practiceCopy(
        source,
        'import os\nprint("clean", "marker" in globals(), os.path.exists("scratch.txt"))\n',
      ),
    );
    await step('fresh-run', async () => {
      await runChecks(source);
      await finished(source);
      await expect(output(source)).toContainText('clean False False');
    });
    const practiceFrame = await frame(source).elementHandle();
    await step('switch-to-code', async () => {
      await source
        .getByRole('button', { name: 'Run code', exact: true })
        .click();
      await expect(status(source)).toHaveText('Run finished', {
        timeout: 40000,
      });
      await expect(output(source)).toContainText('ENTRYPOINT_ONLY');
      await assertFrameReplaced(source, practiceFrame);
    });
    const ordinaryFrame = await frame(source).elementHandle();
    await step('code-provenance', async () => {
      await expect(source.locator('.practice-scope')).toHaveCount(0);
      await capturedSource(source, 'main.py', ENTRYPOINT);
      await disclosure(source, 'Task and runtime provenance');
      await expect(source.locator('.practice-provenance')).toContainText(
        f.version.id,
      );
    });
    await step('switch-to-checks', async () => {
      await runChecks(source);
      await finished(source);
      await assertFrameReplaced(source, ordinaryFrame);
      await expect(output(source)).toContainText('clean False False');
      await expect(output(source)).not.toContainText('ENTRYPOINT_ONLY');
    });
  } catch (error) {
    bodyFailed = true;
    await observe('body:failed');
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    await writeFile(
      test.info().outputPath('lifecycle-original-error.json'),
      JSON.stringify(
        {
          name: error instanceof Error ? error.name : 'unknown',
          assertion: error instanceof Error && /expect\(/.test(error.message),
          frames: [
            ...stack.matchAll(
              /(?:practice\.spec\.ts|practice-fixture\.ts):\d+:\d+/g,
            ),
          ]
            .slice(0, 6)
            .map((match) => match[0]),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await cleanup();
  }
});
