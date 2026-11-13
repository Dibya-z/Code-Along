import { test as base, type BrowserContext } from '@playwright/test';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh owned disk cache; never reads a user's browser profile or installs OS trust. */
export const test = base.extend({
  context: async ({ playwright, browserName }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ca-offline-browser-'));
    let context: BrowserContext | undefined;
    try {
      const certificate = new X509Certificate(
        await readFile(
          new URL('../../../.runtime/certs/cert.pem', import.meta.url),
        ),
      );
      const pin = createHash('sha256')
        .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64');
      context = await playwright[browserName].launchPersistentContext(
        directory,
        {
          baseURL: 'https://127.0.0.1:18443',
          viewport: { width: 1440, height: 1000 },
          // Chromium excludes certificate-error responses from its HTTP cache.
          // Pin only this fixture's public key for this disposable process.
          ignoreHTTPSErrors: browserName === 'webkit',
          ...(browserName === 'chromium'
            ? { args: [`--ignore-certificate-errors-spki-list=${pin}`] }
            : {}),
          serviceWorkers: 'block',
        },
      );
      await use(context);
    } finally {
      try {
        await context?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});
