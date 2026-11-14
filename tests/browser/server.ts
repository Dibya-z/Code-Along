/** Owned loopback HTTPS fixture. No product APIs, runtime proxy or global TLS trust changes. */
import { createServer } from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import { verifyRuntimeInventory } from '@code-along/contracts/execution/runtime-inventory';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'code-along-proof-tls-'));
// Also clean startup/hash/listen failures, before the async signal path exists.
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(temporary, 'key.pem'),
    '-out',
    join(temporary, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'ignore' },
);
const app = 'https://127.0.0.1:9443',
  runner = 'https://localhost:9443';
const inventoryBytes = await readFile(
  join(root, 'apps/runner-web/public/runtime-manifests/pyodide-core.json'),
);
const inventory = await verifyRuntimeInventory(
  JSON.parse(inventoryBytes.toString('utf8')),
  CORE_RUNTIME,
);
const runtime = new Map<string, Buffer>();
for (const asset of inventory.assets) {
  const bytes = await readFile(
    join(root, 'apps/runner-web/node_modules/pyodide', asset.name),
  );
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error('runtime_integrity_failure');
  runtime.set(`/runtime/${asset.name}`, bytes);
  runtime.set(
    `/runtime/v2/${CORE_RUNTIME.manifest_sha256}/${asset.name}`,
    bytes,
  );
}
let authorityRequests = 0;
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.css': 'text/css',
};
const server = createServer(
  {
    key: await readFile(join(temporary, 'key.pem')),
    cert: await readFile(join(temporary, 'cert.pem')),
  },
  (req, res) => {
    void (async () => {
      const isRunner = req.headers.host === 'localhost:9443';
      if (!isRunner && req.headers.host !== '127.0.0.1:9443') {
        res.writeHead(421).end();
        return;
      }
      const url = new URL(req.url ?? '/', isRunner ? runner : app);
      const worker = url.pathname.startsWith('/assets/worker-');
      const fallback = url.search === '?fallback=1';
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader(
        'Cross-Origin-Embedder-Policy',
        fallback ? 'unsafe-none' : 'require-corp',
      );
      res.setHeader(
        'Cross-Origin-Resource-Policy',
        isRunner ? 'cross-origin' : 'same-origin',
      );
      res.setHeader(
        'Permissions-Policy',
        `cross-origin-isolated=(self "${runner}"), camera=(), microphone=(), geolocation=()`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Security-Policy',
        worker
          ? "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'"
          : isRunner
            ? `default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'none'; style-src 'self'; frame-ancestors ${app}; base-uri 'none'; form-action 'none'`
            : `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${runner}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname === '/health') {
        res.end('ok');
        return;
      }
      if (!isRunner && url.pathname === '/authority') {
        authorityRequests++;
        res.end('synthetic-app-authority');
        return;
      }
      if (!isRunner && url.pathname === '/authority-count') {
        res.end(String(authorityRequests));
        return;
      }
      let bytes: Buffer;
      if (
        isRunner &&
        url.pathname === '/runtime-manifests/pyodide-core.json' &&
        url.search === `?sha256=${CORE_RUNTIME.manifest_sha256}`
      )
        bytes = inventoryBytes;
      else if (isRunner && runtime.has(url.pathname) && url.search === '')
        bytes = runtime.get(url.pathname)!;
      else {
        if (
          url.pathname !== '/' &&
          (!/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(url.pathname) ||
            url.search !== '')
        ) {
          res.writeHead(404).end();
          return;
        }
        const dist = join(
          root,
          isRunner ? 'apps/runner-web/dist' : 'tests/browser/dist',
        );
        const target = resolve(
          dist,
          url.pathname === '/' ? 'index.html' : `.${url.pathname}`,
        );
        if (!target.startsWith(`${dist}/`)) {
          res.writeHead(404).end();
          return;
        }
        bytes = await readFile(target);
        if (url.pathname === '/' && isRunner)
          bytes = Buffer.from(bytes.toString().replace('%APP_ORIGIN%', app));
      }
      if (!isRunner && url.pathname === '/')
        res.setHeader(
          'Set-Cookie',
          '__Host-proof-session=synthetic-app-only; Secure; HttpOnly; SameSite=None; Path=/',
        );
      const contentType =
        mime[extname(url.pathname === '/' ? 'index.html' : url.pathname)] ??
        'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.end(bytes);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
  },
);
await new Promise<void>((resolve) => server.listen(9443, '127.0.0.1', resolve));
async function close() {
  server.closeAllConnections();
  server.close();
  await rm(temporary, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
