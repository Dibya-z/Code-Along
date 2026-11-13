import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import process from 'node:process';
const proxied = process.env['CODE_ALONG_DEV_PROXY'] === 'true';
const origin = new URL(
  process.env['CODE_ALONG_APP_ORIGIN'] ?? 'https://127.0.0.1:8443',
);
if (
  proxied &&
  (origin.protocol !== 'https:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password)
) {
  throw new Error(
    'Development proxy requires an exact loopback HTTPS application origin.',
  );
}
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false },
  ...(proxied
    ? {
        html: { cspNonce: '__CODE_ALONG_DEV_NONCE__' },
        server: {
          strictPort: true,
          cors: { origin: origin.origin },
          forwardConsole: false,
          ws: {
            protocol: 'wss',
            host: origin.hostname,
            clientPort: Number(origin.port || 443),
          },
          watch: { usePolling: true, interval: 1000 },
        },
      }
    : {}),
});
