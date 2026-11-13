import { test, expect } from '@playwright/test';
import { register, createEditorProject } from './helpers.ts';
test('Stop, output floods and virtual file limits leave a fresh usable runtime', async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, `budgets-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  const editor = page.getByLabel('Python source for main.py'),
    output = page.getByLabel('Python output'),
    status = page.locator('.execution-status'),
    run = page.getByRole('button', { name: 'Run code', exact: true }),
    stop = page.getByRole('button', { name: 'Stop run', exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await editor.fill('marker = 42\nwhile True: pass\n');
    await run.click();
    await expect(status).toHaveText(
      /^(Running|Run failed|Run finished|Time limit reached)$/,
      { timeout: 40_000 },
    );
    await expect(
      status,
      `${await output.innerText()} ${await page.locator('.execution-panel .notice.error').allTextContents()}`,
    ).toHaveText('Running');
    const started = Date.now();
    await stop.click();
    await expect(status).toHaveText('Run stopped');
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(stop).toBeDisabled();
  }
  await editor.fill(
    'import sys\nfor i in range(1100000): sys.stdout.write("x")\n',
  );
  await run.click();
  await expect(status).toHaveText(
    /^(Output limit reached|Run finished|Run failed|Time limit reached)$/,
    { timeout: 40_000 },
  );
  await expect(status, await output.innerText()).toHaveText(
    'Output limit reached',
  );
  expect(await output.locator('.console-line').count()).toBeLessThanOrEqual(
    200,
  );
  for (const source of [
    'with open("too-big.bin", "wb") as stream:\n    stream.write(b"x" * (9 * 1024 * 1024))\n',
    'with open("sparse.bin", "wb") as stream:\n    stream.truncate(9 * 1024 * 1024)\n',
    'with open("seek.bin", "wb") as stream:\n    stream.seek(9 * 1024 * 1024)\n    stream.write(b"x")\n',
    'with open("append.bin", "wb") as stream:\n    stream.write(b"x" * (8 * 1024 * 1024))\nwith open("append.bin", "ab") as stream:\n    stream.write(b"y")\n',
    'for i in range(65):\n    open(f"scratch-{i}.txt", "w").close()\n',
  ]) {
    await editor.fill(source);
    await run.click();
    await expect(status).toHaveText(/^Run (finished|failed)$/, {
      timeout: 40_000,
    });
    await expect(status, await output.innerText()).toHaveText('Run failed');
    await expect(output).toContainText('No space left on device');
    await expect(output).toContainText('Python virtual-file limit reached');
  }
  await editor.fill(
    'import os\nprint("fresh", "marker" in globals(), os.path.exists("too-big.bin"), os.path.exists("scratch-0.txt"))\nprint("alive", end="")\n',
  );
  await run.click();
  await expect(status).toHaveText('Run finished', { timeout: 40_000 });
  await expect(output).toContainText('fresh False False False');
  await expect(output).toContainText('alive');
  expect(errors).toEqual([]);
});
test('product wall deadline ends an infinite run exactly once', async ({
  page,
  browserName,
}) => {
  test.setTimeout(75_000);
  await register(page, `deadline-${browserName}-${Date.now()}@example.test`);
  await createEditorProject(page);
  await page.getByLabel('Python source for main.py').fill('while True: pass\n');
  await page.getByRole('button', { name: 'Run code', exact: true }).click();
  await expect(page.locator('.execution-status')).toHaveText(
    'Time limit reached',
    { timeout: 65_000 },
  );
  await expect(
    page.getByRole('button', { name: 'Run code', exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator('iframe[title="Isolated Python runtime"]'),
  ).toHaveCount(0);
});
