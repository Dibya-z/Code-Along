import {
  captureRunManifest,
  parseRunnerReady,
  parseRunnerEvent,
  RUNNER_PROTOCOL,
  RUNNER_VERSION,
  type SourceFile,
  type RunnerEvent,
  type RunManifest,
} from '@code-along/contracts/execution';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import { Awareness } from 'y-protocols/awareness';

const frame = document.createElement('iframe');
const runnerOrigin = `https://localhost:${location.port}`;
frame.sandbox.add('allow-scripts', 'allow-same-origin');
frame.allow = `cross-origin-isolated ${runnerOrigin}`;
frame.title = 'Isolated Python practice';
frame.src = `${runnerOrigin}/${location.search.includes('fallback') ? '?fallback=1' : ''}`;
const nonce = crypto.randomUUID();
const channel = new MessageChannel();
const events: RunnerEvent[] = [];
let ready: { interactive: boolean; cross_origin_isolated: boolean } | null =
  null;
channel.port1.onmessage = (event: MessageEvent<unknown>) => {
  const capability = parseRunnerReady(event.data, nonce);
  if (capability) {
    ready = capability;
    return;
  }
  const result = parseRunnerEvent(event.data, nonce);
  if (result) events.push(result);
};
function connect() {
  frame.contentWindow!.postMessage(
    {
      protocol: RUNNER_PROTOCOL,
      version: RUNNER_VERSION,
      type: 'connect',
      session_nonce: nonce,
    },
    runnerOrigin,
    [channel.port2],
  );
}
frame.onload = () => {
  if (!location.search.includes('manual=1')) connect();
};
document.body.append(frame);
function command(run_id: string, body: object) {
  channel.port1.postMessage({
    protocol: RUNNER_PROTOCOL,
    version: RUNNER_VERSION,
    session_nonce: nonce,
    run_id,
    ...body,
  });
}
const proof = {
  connect,
  events,
  get ready() {
    return ready;
  },
  async run(
    files: readonly SourceFile[],
    mode: RunManifest['stdin_mode'] = 'batch',
    stdin: string[] = [],
  ) {
    const pending = captureRunManifest(files, 'main.py', 1, mode);
    const manifest = await pending;
    const id = crypto.randomUUID();
    command(id, { type: 'run', manifest, stdin });
    return { id, manifest };
  },
  sendRaw(value: unknown) {
    channel.port1.postMessage(value);
  },
  send(run_id: string, body: object) {
    command(run_id, body);
  },
  input(run_id: string, text: string | null) {
    command(run_id, { type: 'stdin', text });
  },
  cancel(run_id: string) {
    command(run_id, { type: 'cancel' });
  },
  secondHandshake() {
    const other = new MessageChannel();
    let answered = false;
    other.port1.onmessage = () => {
      answered = true;
    };
    frame.contentWindow!.postMessage(
      {
        protocol: RUNNER_PROTOCOL,
        version: RUNNER_VERSION,
        type: 'connect',
        session_nonce: crypto.randomUUID(),
      },
      runnerOrigin,
      [other.port2],
    );
    return new Promise<boolean>((resolve) =>
      setTimeout(() => {
        other.port1.close();
        resolve(answered);
      }, 100),
    );
  },
  editorProof() {
    const a = new Y.Doc(),
      b = new Y.Doc();
    const aa = new Awareness(a),
      ab = new Awareness(b);
    a.on('update', (u, origin) => {
      if (origin !== b) Y.applyUpdate(b, u, a);
    });
    b.on('update', (u, origin) => {
      if (origin !== a) Y.applyUpdate(a, u, b);
    });
    const root = document.getElementById('editors')!;
    const view = (doc: Y.Doc, awareness: Awareness) =>
      new EditorView({
        parent: root,
        state: EditorState.create({
          extensions: [yCollab(doc.getText('source'), awareness)],
        }),
      });
    const va = view(a, aa),
      vb = view(b, ab);
    va.dispatch({ changes: { from: 0, insert: 'print(1)' } });
    const inserted = vb.state.doc.toString();
    vb.dispatch({ changes: { from: 0, to: 8, insert: 'print(2)' } });
    const replaced = va.state.doc.toString();
    const result = {
      inserted,
      replaced,
      singleYjs: va.state.doc.toString() === a.getText('source').toString(),
    };
    va.destroy();
    vb.destroy();
    aa.destroy();
    ab.destroy();
    a.destroy();
    b.destroy();
    return result;
  },
};
declare global {
  interface Window {
    proof: typeof proof;
  }
}
window.proof = proof;
