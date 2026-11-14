import { expect, test, type Page } from '@playwright/test';
import type { PracticeRunnerEvent } from '@code-along/contracts/execution/practice';
import type { TerminalStatus } from '@code-along/contracts/execution';
import type {} from '../src/app.ts';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { verifyRuntimeInventory } from '@code-along/contracts/execution/runtime-inventory';
import { createHash } from 'node:crypto';

async function terminal(
  page: Page,
  id: string,
  status: TerminalStatus = 'succeeded',
) {
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.proof.practiceEvents.filter(
            (event) => event.run_id === id && event.type === 'terminal',
          ),
        id,
      ),
    )
    .toHaveLength(1);
  const events = await page.evaluate(
    (id) => window.proof.practiceEvents.filter((event) => event.run_id === id),
    id,
  );
  expect(events.at(-1)).toMatchObject({ type: 'terminal', status });
  return events;
}
function output(events: readonly PracticeRunnerEvent[]) {
  return events
    .filter((event) => event.type === 'output' && event.stream === 'stdout')
    .map((event) => (event.type === 'output' ? event.text : ''))
    .join('');
}
test.beforeEach(async ({ page }) => {
  await page.goto('/?practice=1');
  await expect
    .poll(() => page.evaluate(() => window.proof?.ready))
    .not.toBeNull();
});

test('practice keeps maximum source files separate from checks and rejects tampered or old-wire attempts', async ({
  page,
}) => {
  const identity = CORE_RUNTIME.manifest_sha256;
  const runner = 'https://localhost:9443';
  const inventory = await page.request.get(
    `${runner}/runtime-manifests/pyodide-core.json?sha256=${identity}`,
  );
  expect(inventory.status()).toBe(200);
  const reviewed = await verifyRuntimeInventory(
    await inventory.json(),
    CORE_RUNTIME,
  );
  const asset = reviewed.assets[0]!;
  const response = await page.request.get(
    `${runner}/runtime/v2/${identity}/${asset.name}`,
  );
  expect(response.status()).toBe(200);
  expect(
    createHash('sha256')
      .update(await response.body())
      .digest('hex'),
  ).toBe(asset.sha256);
  for (const path of [
    '/runtime-manifests/pyodide-core.json',
    `/runtime-manifests/pyodide-core.json?sha256=${'0'.repeat(64)}`,
    `/runtime-manifests/pyodide-core.json?sha256=${identity}&extra=1`,
    `/runtime/v2/${'0'.repeat(64)}/${asset.name}`,
    `/runtime/v2/${identity}/not-approved.whl`,
  ])
    expect((await page.request.get(`${runner}${path}`)).status()).toBe(404);
  const run = await page.evaluate(async () => {
    const code = [
      ...Array.from({ length: 19 }, (_, index) => `import module${index}`),
      `assert ${Array.from({ length: 19 }, (_, index) => `module${index}.answer`).join(' + ')} == 171`,
      'print("all twenty source files")',
      '#',
    ].join('\n');
    const checks =
      code + 'x'.repeat(16384 - new TextEncoder().encode(code).length);
    return window.proof.runPractice(
      [
        {
          document_id: crypto.randomUUID(),
          generation: 1,
          path: 'main.py',
          source: 'raise AssertionError("ENTRYPOINT_MUST_NOT_RUN")',
        },
        ...Array.from({ length: 19 }, (_, index) => ({
          document_id: crypto.randomUUID(),
          generation: 1,
          path: `module${index}.py`,
          source: `${index === 0 ? '\uFEFF' : ''}answer = ${index}\n`,
        })),
      ],
      checks,
    );
  });
  const events = await terminal(page, run.id);
  expect(output(events)).toBe('all twenty source files\n');
  expect(run.manifest.source.files).toHaveLength(20);
  expect(Buffer.byteLength(run.manifest.checks.source, 'utf8')).toBe(16384);
  expect(events.at(-1)).toMatchObject({
    source_manifest_sha256: run.manifest.source.sha256,
    practice_manifest_sha256: run.manifest.sha256,
    checks_sha256: run.manifest.checks.sha256,
    helper_release_sha256: run.manifest.helper_release.source_sha256,
    runtime_id: run.manifest.source.runtime.runtime_id,
  });
  const rejected = await page.evaluate(({ manifest, id }) => {
    window.proof.send(id, { type: 'run', manifest, stdin: [] });
    const bad = crypto.randomUUID();
    window.proof.send(bad, {
      type: 'run',
      stdin: [],
      manifest: {
        ...manifest,
        checks: { ...manifest.checks, source: 'print("TAMPERED")' },
      },
    });
    const oldWire = crypto.randomUUID();
    window.proof.sendRaw({
      protocol: 'code-along.runner',
      version: 2,
      session_nonce: window.proof.ready!.session_nonce,
      run_id: oldWire,
      type: 'run',
      manifest: manifest.source,
      stdin: [],
    });
    return { bad, oldWire };
  }, run);
  expect(output(await terminal(page, rejected.bad, 'failed'))).toBe('');
  await terminal(page, run.id);
  const next = await page.evaluate(() =>
    window.proof.runPractice(
      [
        {
          document_id: crypto.randomUUID(),
          generation: 1,
          path: 'main.py',
          source: '',
        },
      ],
      'print("fresh practice")',
    ),
  );
  expect(output(await terminal(page, next.id))).toBe('fresh practice\n');
  expect(
    await page.evaluate(
      (id) =>
        window.proof.practiceEvents.filter((event) => event.run_id === id),
      rejected.oldWire,
    ),
  ).toEqual([]);
});

test('practice Worker cannot reach application authority or an external network', async ({
  page,
}) => {
  const before = await (await page.request.get('/authority-count')).text();
  const run = await page.evaluate(() =>
    window.proof.runPractice(
      [
        {
          document_id: crypto.randomUUID(),
          generation: 1,
          path: 'main.py',
          source: '',
        },
      ],
      `import js\nprint(js.location.origin)\nprint(hasattr(js, "document"), hasattr(js, "parent"), hasattr(js, "localStorage"))\nfor url in ["https://127.0.0.1:9443/authority", "https://example.invalid/probe"]:\n    try:\n        request = js.XMLHttpRequest.new()\n        request.open("GET", url, False)\n        request.send()\n        print("UNEXPECTED")\n    except Exception:\n        print("BLOCKED")`,
    ),
  );
  expect(output(await terminal(page, run.id))).toBe(
    'https://localhost:9443\nFalse False False\nBLOCKED\nBLOCKED\n',
  );
  expect(await (await page.request.get('/authority-count')).text()).toBe(
    before,
  );
});
