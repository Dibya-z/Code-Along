import {
  RUNNER_PROTOCOL,
  RUNNER_VERSION,
  isRunnerId,
} from '@code-along/contracts/execution';
import { RunnerSupervisor } from './supervisor.ts';

const appOrigin = document.querySelector<HTMLMetaElement>(
  'meta[name="app-origin"]',
)?.content;
if (
  !appOrigin ||
  new URL(appOrigin).origin !== appOrigin ||
  appOrigin === location.origin
)
  throw new Error('invalid_runner_configuration');
let connected = false;
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const d = event.data;
  if (
    connected ||
    event.source !== parent ||
    event.origin !== appOrigin ||
    typeof d !== 'object' ||
    d === null
  )
    return;
  const v = d as Record<string, unknown>;
  if (
    Object.keys(v).length !== 4 ||
    v['protocol'] !== RUNNER_PROTOCOL ||
    v['version'] !== RUNNER_VERSION ||
    v['type'] !== 'connect' ||
    !isRunnerId(v['session_nonce']) ||
    event.ports.length !== 1
  )
    return;
  const port = event.ports[0]!;
  connected = true;
  const supervisor = new RunnerSupervisor(v['session_nonce'], (message) =>
    port.postMessage(message),
  );
  port.onmessage = (message: MessageEvent<unknown>) => {
    void supervisor.handle(message.data);
  };
  port.start();
  port.postMessage({
    protocol: RUNNER_PROTOCOL,
    version: RUNNER_VERSION,
    type: 'ready',
    session_nonce: v['session_nonce'],
    interactive:
      crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined',
    cross_origin_isolated: crossOriginIsolated,
  });
  window.addEventListener(
    'pagehide',
    () => {
      supervisor.destroy();
      port.close();
    },
    { once: true },
  );
});
