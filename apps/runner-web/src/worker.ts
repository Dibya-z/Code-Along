/// <reference lib="webworker" />
// Pinned browser-only adapter surface. Upstream declarations also require DOM,
// Node and Emscripten globals; keep those out of this Worker's type environment.
interface BrowserPyodide {
  readonly loadedPackages: Readonly<Record<string, string>>;
  FS: BudgetedFS & {
    mkdir(path: string): void;
    mkdirTree(path: string): void;
    writeFile(path: string, bytes: Uint8Array): void;
    chdir(path: string): void;
  };
  globals: { set(key: string, value: unknown): void };
  setStdout(options: { write: (bytes: Uint8Array) => number }): void;
  setStderr(options: { write: (bytes: Uint8Array) => number }): void;
  setStdin(options: { stdin: () => string | null }): void;
  runPythonAsync(source: string): Promise<{ destroy?: () => void } | undefined>;
}
type LoadPyodide = (options: {
  indexURL: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  lockFileContents?: unknown;
  packageBaseUrl?: string;
  packages?: string[];
  checkIntegrity?: boolean;
}) => Promise<BrowserPyodide>;
import type { RunManifest } from '@code-along/contracts/execution';
import type { ProjectRunManifest } from '@code-along/contracts/execution/project';
import { prepareRuntime } from './runtime.ts';
import helperSource from './code_along.py?raw';
import { isRasterPlot } from '@code-along/contracts/execution/plots';
import { WorkerOutput } from './output-buffer.ts';
import { installFileBudgets, type BudgetedFS } from './file-budgets.ts';
declare const self: DedicatedWorkerGlobalScope;
let started = false;
self.onmessage = async (
  event: MessageEvent<{
    run_id: string;
    manifest: RunManifest | ProjectRunManifest;
    stdin: string[];
    input?: SharedArrayBuffer;
  }>,
) => {
  if (started) return;
  started = true;
  const { run_id, manifest, stdin, input } = event.data;
  const send = (message: object) => self.postMessage({ run_id, ...message });
  const buffered = new WorkerOutput(
    (stream, text) => send({ type: 'output', stream, text }),
    () => send({ type: 'limit' }),
  );
  const output = (stream: 'stdout' | 'stderr', text: string) =>
    buffered.append(stream, text);
  const stdout = new TextDecoder(),
    stderr = new TextDecoder();
  let startup = 'verified runtime assets';
  try {
    const prepared =
      manifest.version === 2 ? await prepareRuntime(manifest.runtime) : null;
    const base = prepared?.base ?? '/runtime/';
    const runtimeUrl = `${base}pyodide.mjs`;
    startup = 'Python module import';
    const runtime = (await import(/* @vite-ignore */ runtimeUrl)) as {
      loadPyodide: LoadPyodide;
    };
    startup = 'interpreter and packages';
    const pyodide = await runtime.loadPyodide({
      indexURL: base,
      stdout: (s) => output('stdout', `${s}\n`),
      stderr: (s) => output('stderr', `${s}\n`),
      ...(prepared
        ? {
            lockFileContents: prepared.lock,
            packageBaseUrl: base,
            packages: prepared.packages,
            checkIntegrity: true,
          }
        : {}),
    });
    if (
      prepared &&
      prepared.packages.some(
        (name) => !Object.hasOwn(pyodide.loadedPackages, name),
      )
    )
      throw new Error(
        'The selected Python packages could not load. Retry with a fresh runtime.',
      );
    pyodide.setStdout({
      write(bytes) {
        output('stdout', stdout.decode(bytes, { stream: true }));
        return bytes.length;
      },
    });
    pyodide.setStderr({
      write(bytes) {
        output('stderr', stderr.decode(bytes, { stream: true }));
        return bytes.length;
      },
    });
    const mailbox = input ? new Int32Array(input) : null;
    pyodide.setStdin({
      stdin: () => {
        buffered.flush(); // input() prompts must precede Atomics.wait.
        if (!mailbox) return stdin.shift() ?? null;
        Atomics.store(mailbox, 0, 0);
        send({ type: 'input' });
        while (Atomics.load(mailbox, 0) === 0) Atomics.wait(mailbox, 0, 0);
        if (Atomics.load(mailbox, 0) === 2) return null;
        return new TextDecoder().decode(
          Uint8Array.from(
            new Uint8Array(mailbox.buffer, 8, Atomics.load(mailbox, 1)),
          ),
        );
      },
    });
    pyodide.FS.mkdir('/project');
    for (const file of manifest.files) {
      const target = `/project/${file.path}`;
      const folder = target.slice(0, target.lastIndexOf('/'));
      pyodide.FS.mkdirTree(folder);
      pyodide.FS.writeFile(target, new TextEncoder().encode(file.source));
    }
    pyodide.FS.chdir('/project');
    if (manifest.version === 2) {
      let plotIndex = 0;
      pyodide.globals.set(
        '__code_along_png',
        (data: { toJs(): unknown }, title: string) => {
          const plot = {
            type: 'plot',
            index: plotIndex,
            title,
            png: data.toJs(),
          };
          if (!isRasterPlot(plot))
            throw new Error(
              'Plot limit or PNG validation failed. Use at most four bounded RGB/RGBA PNGs.',
            );
          plotIndex++;
          buffered.flush();
          send({ ...plot, png: Uint8Array.from(plot.png) });
        },
      );
      pyodide.FS.mkdir('/code_along_support');
      pyodide.FS.writeFile(
        '/code_along_support/code_along.py',
        new TextEncoder().encode(helperSource),
      );
      await pyodide.runPythonAsync(
        'import sys, builtins\nsys.dont_write_bytecode = True\nbuiltins._code_along_emit_png = __code_along_png\nsys.path.insert(0, "/code_along_support")',
      );
      installFileBudgets(pyodide.FS, () => {
        output(
          'stderr',
          'Python virtual-file limit reached: 8 MiB of cumulative growth, 64 new files or 128 new filesystem entries per run. Reduce temporary output.\n',
        );
        buffered.flush();
      });
    }
    const entrypoint =
      manifest.version === 1
        ? manifest.entrypoint
        : manifest.files.find(
            (file) => file.file_id === manifest.entrypoint_file_id,
          )?.path;
    if (!entrypoint) throw new Error('The captured entrypoint is missing.');
    pyodide.globals.set('__entrypoint', `/project/${entrypoint}`);
    startup = '';
    send({ type: 'ready' });
    const result = await pyodide.runPythonAsync(
      'import sys, runpy\nsys.path.insert(0, "/project")\ntry:\n    runpy.run_path(__entrypoint, run_name="__main__")\nfinally:\n    for stream in (sys.stdout, sys.stderr):\n        try:\n            stream.flush()\n        except Exception:\n            pass',
    );
    result?.destroy?.();
    output('stdout', stdout.decode());
    output('stderr', stderr.decode());
    buffered.flush();
    send({ type: 'done', status: 'succeeded' });
  } catch (error) {
    output('stdout', stdout.decode());
    output('stderr', stderr.decode());
    output(
      'stderr',
      startup
        ? `Python startup failed (${startup}): ${String(error)}`
        : String(error),
    );
    buffered.flush();
    send({ type: 'done', status: 'failed' });
  }
};
