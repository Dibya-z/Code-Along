import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_PROTOCOL } from '@code-along/contracts/execution';
import { CORE_RUNTIME } from '@code-along/contracts/execution/profiles';
import {
  capturePracticeManifest,
  capturePublicChecksManifest,
  PRACTICE_PROTOCOL,
  REVIEWED_HELPER_RELEASE,
} from '@code-along/contracts/execution/practice';
import { IframeRunnerBridge } from './bridge.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function manifest() {
  const checks = await capturePublicChecksManifest('import main\n');
  return capturePracticeManifest({
    assignment_id: id(10),
    assignment_version_id: id(11),
    assignment_content_sha256: 'a'.repeat(64),
    helper_release: REVIEWED_HELPER_RELEASE,
    published_checks_sha256: checks.sha256,
    checks_source: checks.source,
    check_origin: 'published',
    source: {
      project_id: id(1),
      source_kind: 'project',
      metadata_version: 1,
      entrypoint_file_id: id(2),
      runtime: CORE_RUNTIME,
      stdin_mode: 'batch',
      files: [
        {
          file_id: id(2),
          document_id: id(3),
          generation: 1,
          path: 'main.py',
          source: 'answer = 42\n',
        },
      ],
    },
  });
}
function environment() {
  class Port {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage = vi.fn();
    start = vi.fn();
    close = vi.fn();
    emit(data: unknown) {
      this.onmessage?.({ data } as MessageEvent<unknown>);
    }
  }
  const channels: { port1: Port; port2: Port }[] = [];
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = new Port();
      port2 = new Port();
      constructor() {
        channels.push(this);
      }
    },
  );
  const frame = {
    src: '',
    title: '',
    hidden: false,
    tabIndex: 0,
    referrerPolicy: '',
    allow: '',
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    setAttribute: vi.fn(),
    sandbox: { add: vi.fn() },
    remove: vi.fn(),
    contentWindow: { postMessage: vi.fn() },
  };
  vi.stubGlobal('document', {
    createElement: vi.fn(() => frame),
    querySelector: vi.fn(() => ({ content: 'https://runner.test' })),
    body: { append: vi.fn() },
  });
  vi.stubGlobal('location', { origin: 'https://app.test' });
  return { frame, channels };
}
afterEach(() => vi.unstubAllGlobals());
describe('fixed protocol iframe execution connection', () => {
  it('selects practice at connect and rejects ordinary/malformed packets on that port', async () => {
    const m = await manifest(),
      dom = environment(),
      event = vi.fn(),
      fault = vi.fn();
    const bridge = new IframeRunnerBridge(event, fault, 'practice');
    const pending = bridge.start(id(20), m.source, [], m);
    void pending.catch(() => undefined);
    try {
      dom.frame.onload?.();
      const [connect, origin, ports] =
        dom.frame.contentWindow.postMessage.mock.calls[0]!;
      expect(connect).toEqual({
        protocol: PRACTICE_PROTOCOL,
        version: 1,
        type: 'connect',
        session_nonce: expect.any(String),
      });
      expect(origin).toBe('https://runner.test');
      expect(ports).toEqual([dom.channels[0]!.port2]);
      const nonce = (connect as { session_nonce: string }).session_nonce;
      const port = dom.channels[0]!.port1;
      port.emit({
        protocol: RUNNER_PROTOCOL,
        version: 2,
        type: 'ready',
        session_nonce: nonce,
        interactive: true,
        cross_origin_isolated: true,
      });
      await Promise.resolve();
      expect(port.postMessage).not.toHaveBeenCalled();
      port.emit({
        protocol: PRACTICE_PROTOCOL,
        version: 1,
        type: 'ready',
        session_nonce: nonce,
        interactive: true,
        cross_origin_isolated: true,
      });
      await pending;
      expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
        protocol: PRACTICE_PROTOCOL,
        version: 1,
        session_nonce: nonce,
        run_id: id(20),
        type: 'run',
        manifest: m,
        stdin: [],
      });
      const terminal = {
        protocol: PRACTICE_PROTOCOL,
        version: 1,
        session_nonce: nonce,
        run_id: id(20),
        type: 'terminal',
        status: 'succeeded',
        source_manifest_sha256: m.source.sha256,
        practice_manifest_sha256: m.sha256,
        checks_sha256: m.checks.sha256,
        helper_release_sha256: m.helper_release.source_sha256,
        runtime_id: CORE_RUNTIME.runtime_id,
      };
      const malformed: Partial<typeof terminal> = { ...terminal };
      delete malformed.helper_release_sha256;
      port.emit(malformed);
      port.emit({ ...terminal, protocol: RUNNER_PROTOCOL, version: 2 });
      expect(event).not.toHaveBeenCalled();
      bridge.input('River');
      bridge.cancel();
      expect(
        port.postMessage.mock.calls.slice(1).map(([value]) => value.protocol),
      ).toEqual([PRACTICE_PROTOCOL, PRACTICE_PROTOCOL]);
      port.emit(terminal);
      expect(event).toHaveBeenCalledExactlyOnceWith(terminal);
      expect(fault).not.toHaveBeenCalled();
    } finally {
      bridge.destroy();
      await pending.catch(() => undefined);
    }
    expect(dom.frame.remove).toHaveBeenCalledOnce();
    expect(dom.channels[0]!.port1.close).toHaveBeenCalledOnce();
  });
  it('does not smuggle a practice binding through an ordinary session or detach its source', async () => {
    const m = await manifest();
    environment();
    const ordinary = new IframeRunnerBridge(vi.fn(), vi.fn());
    await expect(ordinary.start(id(20), m.source, [], m)).rejects.toThrow(
      'does not match',
    );
    ordinary.destroy();
    const practice = new IframeRunnerBridge(vi.fn(), vi.fn(), 'practice');
    await expect(
      practice.start(id(21), { ...m.source }, [], m),
    ).rejects.toThrow('does not match');
    practice.destroy();
  });
});
