import { RUNTIME_ID } from './runner.ts';

export interface RuntimeIdentity {
  readonly runtime_id: string;
  readonly manifest_sha256: string;
  readonly engine: 'pyodide';
  readonly engine_version: string;
  readonly python_version: string;
}
/** Reviewed core inventory, also seeded by Django. Changing its bytes needs a new identity. */
export const CORE_RUNTIME: RuntimeIdentity = Object.freeze({
  runtime_id: RUNTIME_ID,
  manifest_sha256:
    '4eb12f345e0f14f57c93603c8d8a2d3d62c69e2e82618c63cac87dc0aafadf40',
  engine: 'pyodide',
  engine_version: '314.0.7',
  python_version: '3.14.2',
});
export function reviewedRuntime(value: unknown): value is RuntimeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(CORE_RUNTIME);
  return (
    Object.keys(record).length === fields.length &&
    fields.every(
      (key) => record[key] === CORE_RUNTIME[key as keyof RuntimeIdentity],
    )
  );
}
