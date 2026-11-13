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
export const SCIENTIFIC_RUNTIME: RuntimeIdentity = Object.freeze({
  runtime_id: 'pyodide-314.0.7-scientific',
  manifest_sha256:
    'eb2bfd5f172ccce38411575452b4c723f939a14e095a94a612fb1f9d5fdf21ea',
  engine: 'pyodide',
  engine_version: '314.0.7',
  python_version: '3.14.2',
});
export const RUNTIME_PROFILES = Object.freeze([
  Object.freeze({
    identity: CORE_RUNTIME,
    name: 'Python core',
    description: 'Python basics and the bundled standard library.',
    inventory: 'pyodide-core.json',
    packages: Object.freeze([] as string[]),
  }),
  Object.freeze({
    identity: SCIENTIFIC_RUNTIME,
    name: 'NumPy',
    description:
      'NumPy 2.4.6 for arrays and numeric work, loaded when selected.',
    inventory: 'pyodide-scientific.json',
    packages: Object.freeze(['numpy']),
  }),
]);
export function runtimeProfile(runtimeId: unknown) {
  return RUNTIME_PROFILES.find(
    (profile) => profile.identity.runtime_id === runtimeId,
  );
}
export function reviewedRuntime(value: unknown): value is RuntimeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = runtimeProfile(record['runtime_id'])?.identity;
  if (!expected) return false;
  const fields = Object.keys(CORE_RUNTIME);
  return (
    Object.keys(record).length === fields.length &&
    fields.every(
      (key) => record[key] === expected[key as keyof RuntimeIdentity],
    )
  );
}
