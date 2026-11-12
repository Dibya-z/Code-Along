import { test, expect, type Page } from '@playwright/test';
import type {
  RunnerEvent,
  TerminalStatus,
} from '@code-along/contracts/execution';
import type {} from '../src/app.ts';

async function ready(page: Page, path = '/') {
  await page.goto(path);
  await expect
    .poll(() => page.evaluate(() => window.proof?.ready))
    .not.toBeNull();
}
async function run(
  page: Page,
  source: string,
  mode: 'batch' | 'interactive' = 'batch',
  stdin: string[] = [],
) {
  return page.evaluate(
    ({ source, mode, stdin }) =>
      window.proof.run(
        [
          {
            document_id: crypto.randomUUID(),
            generation: 1,
            path: 'main.py',
            source,
          },
        ],
        mode,
        stdin,
      ),
    { source, mode, stdin },
  );
}
async function terminal(
  page: Page,
  id: string,
  status: TerminalStatus = 'succeeded',
) {
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.proof.events.filter(
            (e) => e.run_id === id && e.type === 'terminal',
          ),
        id,
      ),
    )
    .toHaveLength(1);
  const events = await page.evaluate(
    (id) => window.proof.events.filter((e) => e.run_id === id),
    id,
  );
  expect(events.at(-1)).toMatchObject({ type: 'terminal', status });
  return events;
}
function text(events: RunnerEvent[], stream = 'stdout') {
  return events
    .filter((e) => e.type === 'output' && e.stream === stream)
    .map((e) => (e.type === 'output' ? e.text : ''))
    .join('');
}
test.beforeEach(async ({ page }) => {
  await ready(page);
});

test('rejects a sibling-window handshake and invalid nonce before accepting its parent', async ({
  page,
}) => {
  await page.goto('/?manual=1');
  await page
    .frames()
    .find((f) => f.url().startsWith('https://localhost:9443/'))!
    .waitForLoadState();
  await page.evaluate(() => {
    const sibling = document.createElement('iframe');
    sibling.title = 'Owned handshake attacker';
    document.body.append(sibling);
  });
  const sibling = page
    .frames()
    .find((f) => f !== page.mainFrame() && f.url() === 'about:blank')!;
  const answered = await sibling.evaluate(async () => {
    const channel = new MessageChannel();
    let received = false;
    channel.port1.onmessage = () => {
      received = true;
    };
    parent.frames[0]!.postMessage(
      {
        protocol: 'code-along.runner',
        version: 1,
        type: 'connect',
        session_nonce: crypto.randomUUID(),
      },
      'https://localhost:9443',
      [channel.port2],
    );
    await new Promise((r) => setTimeout(r, 100));
    channel.port1.close();
    return received;
  });
  expect(answered).toBe(false);
  await page.evaluate(async () => {
    const channel = new MessageChannel();
    frames[0]!.postMessage(
      {
        protocol: 'code-along.runner',
        version: 1,
        type: 'connect',
        session_nonce: 'invalid',
      },
      'https://localhost:9443',
      [channel.port2],
    );
    await new Promise((r) => setTimeout(r, 100));
    channel.port1.close();
    window.proof.connect();
  });
  await expect
    .poll(() => page.evaluate(() => window.proof.ready))
    .not.toBeNull();
  const r = await run(page, 'print("parent only")');
  expect(text(await terminal(page, r.id))).toBe('parent only\n');
});

test('actual embedding, Worker headers, pinned Python and CodeMirror binding', async ({
  page,
  browserName,
  browser,
}) => {
  const capability = await page.evaluate(() => ({
    app: location.origin,
    embedded: {
      interactive: window.proof.ready!.interactive,
      cross_origin_isolated: window.proof.ready!.cross_origin_isolated,
    },
    secure: isSecureContext,
  }));
  console.log(
    JSON.stringify({
      browser: browserName,
      version: browser.version(),
      capability,
    }),
  );
  expect(capability.secure).toBe(true);
  expect(
    page.frames().some((f) => f.url().startsWith('https://localhost:9443/')),
  ).toBe(true);
  expect(await page.evaluate(() => window.proof.editorProof())).toEqual({
    inserted: 'print(1)',
    replaced: 'print(2)',
    singleYjs: true,
  });
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  const r = await run(
    page,
    'import sys\nprint(sys.version_info.major, sys.version_info.minor)',
  );
  const events = await terminal(page, r.id);
  expect(text(events)).toBe('3 14\n');
  expect(events.at(-1)).toMatchObject({
    manifest_sha256: r.manifest.sha256,
    runtime_id: 'pyodide-314.0.7-core',
  });
  // The Worker belongs to the child frame, so inspect its emitted build asset too.
  const html = await (await page.request.get('https://localhost:9443/')).text();
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  expect(script).toBeTruthy();
  const js = await (
    await page.request.get(`https://localhost:9443${script}`)
  ).text();
  const workerPath = /\/assets\/worker-[A-Za-z0-9_-]+\.js/.exec(js)?.[0];
  expect(workerPath).toBeTruthy();
  const response = await page.request.get(
    `https://localhost:9443${workerPath}`,
  );
  expect(response.headers()['content-security-policy']).toContain(
    "connect-src 'self'",
  );
  expect(response.headers()['content-security-policy']).toContain(
    "worker-src 'none'",
  );
  expect(response.headers()['content-security-policy']).not.toContain(
    "'unsafe-eval'",
  );
});
test('runs the frozen multi-file snapshot while live source changes', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const files = [
      {
        document_id: crypto.randomUUID(),
        generation: 1,
        path: 'main.py',
        source: 'from helper import answer\nprint(answer)',
      },
      {
        document_id: crypto.randomUUID(),
        generation: 1,
        path: 'helper.py',
        source: 'answer = 42',
      },
    ];
    const promise = window.proof.run(files);
    files[1]!.source = 'answer = 99';
    return promise;
  });
  expect(text(await terminal(page, r.id))).toBe('42\n');
  expect(r.manifest.files[0]?.source).toBe('answer = 42');
});
test('keeps chunked Unicode output ordered and separate from stderr', async ({
  page,
}) => {
  const r = await run(
    page,
    'import sys\nsys.stdout.write("hé")\nsys.stdout.flush()\nsys.stdout.write("llo\\n")\nsys.stderr.write("error\\n")',
  );
  const events = await terminal(page, r.id);
  expect(text(events)).toBe('héllo\n');
  expect(text(events, 'stderr')).toBe('error\n');
  const output = events.filter((e) => e.type === 'output');
  expect(output.map((e) => e.sequence)).toEqual(output.map((_, i) => i));
});
test('recreates interpreter globals and filesystem for every run', async ({
  page,
}) => {
  const a = await run(
    page,
    'leaked = 7\nopen("leftover", "w").write("x")\nprint("first")',
  );
  await terminal(page, a.id);
  const b = await run(
    page,
    'import os\nprint("leaked" in globals(), os.path.exists("leftover"))',
  );
  expect(text(await terminal(page, b.id))).toBe('False False\n');
});
test('provides declared batch stdin and EOF', async ({ page }) => {
  const r = await run(
    page,
    'import sys\nprint(input())\nprint(repr(sys.stdin.readline()))',
    'batch',
    ['Ada'],
  );
  expect(text(await terminal(page, r.id))).toBe("Ada\n''\n");
});
test('gates interactive stdin on actual embedded capability', async ({
  page,
}) => {
  const interactive = await page.evaluate(
    () => window.proof.ready!.interactive,
  );
  const r = await run(page, 'print(input("Name: "))', 'interactive');
  if (!interactive) {
    await terminal(page, r.id, 'failed');
    return;
  }
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.proof.events.some(
            (e) =>
              e.run_id === id &&
              e.type === 'state' &&
              e.state === 'waiting_for_input',
          ),
        r.id,
      ),
    )
    .toBe(true);
  await page.evaluate((id) => {
    window.proof.input(crypto.randomUUID(), 'ignored');
    window.proof.input(id, 'Ada');
  }, r.id);
  expect(text(await terminal(page, r.id))).toBe('Name: Ada\n');
});
test('hard Stop ends an infinite loop once and a later run still works', async ({
  page,
}) => {
  const r = await run(page, 'while True:\n    pass');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.proof.events.some(
            (e) =>
              e.run_id === id && e.type === 'state' && e.state === 'running',
          ),
        r.id,
      ),
    )
    .toBe(true);
  const start = Date.now();
  await page.evaluate((id) => window.proof.cancel(id), r.id);
  await terminal(page, r.id, 'cancelled');
  expect(Date.now() - start).toBeLessThan(2000);
  const next = await run(page, 'print("fresh")');
  await page.evaluate((id) => {
    window.proof.cancel(id);
    window.proof.input(id, 'late');
  }, r.id);
  expect(text(await terminal(page, next.id))).toBe('fresh\n');
  await terminal(page, r.id, 'cancelled');
});
test('hard deadline terminates infinite Python', async ({ page }) => {
  const r = await run(page, 'while True:\n    pass');
  await terminal(page, r.id, 'timed_out');
});
test('bounds output floods without wedging the app', async ({ page }) => {
  const r = await run(page, 'while True:\n    print("x" * 4096)');
  const events = await terminal(page, r.id, 'output_limit');
  expect(new TextEncoder().encode(text(events)).length).toBeLessThanOrEqual(
    1024 * 1024,
  );
  const next = await run(page, 'print("recovered")');
  expect(text(await terminal(page, next.id))).toBe('recovered\n');
});
test('blocks Worker access to application authority and external network', async ({
  page,
}) => {
  const before = await (await page.request.get('/authority-count')).text();
  const r = await run(
    page,
    `import js\nprint(js.location.origin)\nprint(hasattr(js, "document"), hasattr(js, "parent"))\nfor url in ["https://127.0.0.1:9443/authority", "https://example.invalid/probe"]:\n    try:\n        request = js.XMLHttpRequest.new()\n        request.open("GET", url, False)\n        request.send()\n        print("UNEXPECTED")\n    except Exception:\n        print("BLOCKED")`,
  );
  const events = await terminal(page, r.id);
  expect(text(events)).toBe(
    'https://localhost:9443\nFalse False\nBLOCKED\nBLOCKED\n',
  );
  expect(await (await page.request.get('/authority-count')).text()).toBe(
    before,
  );
  const unknown = await page.request.get(
    'https://localhost:9443/runtime/not-approved.whl',
  );
  expect(unknown.status()).toBe(404);
});
test('rejects tampered snapshots, reused IDs, repeated handshakes and undeclared commands', async ({
  page,
}) => {
  expect(await page.evaluate(() => window.proof.secondHandshake())).toBe(false);
  const r = await run(page, 'print("original")');
  await terminal(page, r.id);
  await page.evaluate(({ id, manifest }) => {
    window.proof.send(id, { type: 'run', manifest, stdin: [] });
    window.proof.sendRaw({
      protocol: 'code-along.runner',
      version: 1,
      session_nonce: crypto.randomUUID(),
      run_id: crypto.randomUUID(),
      type: 'cancel',
    });
    window.proof.send(crypto.randomUUID(), {
      type: 'fetch',
      url: '/authority',
    });
  }, r);
  await terminal(page, r.id);
  const bad = await page.evaluate(({ manifest }) => {
    const id = crypto.randomUUID();
    window.proof.send(id, {
      type: 'run',
      stdin: [],
      manifest: { ...manifest, sha256: '0'.repeat(64) },
    });
    return id;
  }, r);
  await terminal(page, bad, 'failed');
});
test('declares batch fallback when isolation is unavailable', async ({
  page,
}) => {
  await ready(page, '/?fallback=1');
  expect(await page.evaluate(() => window.proof.ready!.interactive)).toBe(
    false,
  );
  const r = await run(page, 'print(input())', 'batch', ['fallback']);
  expect(text(await terminal(page, r.id))).toBe('fallback\n');
  const unsupported = await run(page, 'print(input())', 'interactive');
  await terminal(page, unsupported.id, 'failed');
});
