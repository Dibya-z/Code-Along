import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  kinds: [] as string[],
  handles: [] as ReturnType<typeof vi.fn>[],
  destroys: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock('./supervisor.ts', () => {
  function supervisor(kind: string) {
    return class {
      handle = vi.fn();
      destroy = vi.fn();
      constructor() {
        created.kinds.push(kind);
        created.handles.push(this.handle);
        created.destroys.push(this.destroy);
      }
    };
  }
  return {
    RunnerSupervisor: supervisor('legacy'),
    ProductRunnerSupervisor: supervisor('product'),
    PracticeRunnerSupervisor: supervisor('practice'),
  };
});
const appOrigin = 'https://app.example';
const nonce = '00000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.resetModules();
  created.kinds.length = 0;
  created.handles.length = 0;
  created.destroys.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const parentWindow = {};
  const addEventListener = vi.fn();
  vi.stubGlobal('parent', parentWindow);
  vi.stubGlobal('window', { addEventListener });
  vi.stubGlobal('document', {
    querySelector: () => ({ content: appOrigin }),
  });
  vi.stubGlobal('location', { origin: 'https://runner.example' });
  vi.stubGlobal('crossOriginIsolated', false);
  await import('./bootstrap.ts');
  const receive = addEventListener.mock.calls.find(
    (call) => call[0] === 'message',
  )?.[1] as (event: MessageEvent<unknown>) => void;
  const port = {
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };
  const send = (data: unknown, override: Record<string, unknown> = {}) =>
    receive({
      data,
      source: parentWindow,
      origin: appOrigin,
      ports: [port],
      ...override,
    } as unknown as MessageEvent<unknown>);
  return { addEventListener, port, send };
}
function connect(protocol: string, version: number) {
  return { protocol, version, type: 'connect', session_nonce: nonce };
}

describe('one strict runner connection', () => {
  it.each([
    ['code-along.runner', 1, 'legacy'],
    ['code-along.runner', 2, 'product'],
    ['code-along.practice', 1, 'practice'],
  ] as const)(
    'admits only the intended %s v%s adapter',
    async (protocol, version, kind) => {
      const f = await fixture();
      f.send(connect(protocol, version));
      expect(created.kinds).toEqual([kind]);
      expect(f.port.start).toHaveBeenCalledOnce();
      expect(f.port.postMessage).toHaveBeenCalledExactlyOnceWith({
        protocol,
        version,
        type: 'ready',
        session_nonce: nonce,
        interactive: false,
        cross_origin_isolated: false,
      });
      f.port.onmessage?.({
        data: { command: 'opaque' },
      } as MessageEvent<unknown>);
      expect(created.handles[0]).toHaveBeenCalledWith({ command: 'opaque' });
      f.send(connect('code-along.practice', 1));
      expect(created.kinds).toHaveLength(1);
      const hide = f.addEventListener.mock.calls.find(
        (call) => call[0] === 'pagehide',
      )?.[1] as () => void;
      hide();
      expect(created.destroys[0]).toHaveBeenCalledOnce();
      expect(f.port.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    connect('code-along.practice', 2),
    connect('code-along.runner', 3),
    connect('unknown.protocol', 1),
    { ...connect('code-along.practice', 1), extra: true },
    { ...connect('code-along.practice', 1), session_nonce: 'not-a-uuid' },
    { ...connect('code-along.practice', 1), type: 'run' },
    null,
    [],
  ])(
    'does not consume a connection for malformed wire pairing %j',
    async (data) => {
      const f = await fixture();
      f.send(data);
      expect(created.kinds).toEqual([]);
      expect(f.port.postMessage).not.toHaveBeenCalled();
      f.send(connect('code-along.practice', 1));
      expect(created.kinds).toEqual(['practice']);
    },
  );

  it.each([
    { origin: 'https://foreign.example' },
    { source: {} },
    { ports: [] },
    { ports: [{}, {}] },
  ])('rejects wrong origin/window/port ownership %j', async (override) => {
    const f = await fixture();
    f.send(connect('code-along.practice', 1), override);
    expect(created.kinds).toEqual([]);
    f.send(connect('code-along.practice', 1));
    expect(created.kinds).toEqual(['practice']);
  });
});
