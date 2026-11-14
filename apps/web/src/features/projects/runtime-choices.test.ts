import { describe, expect, it } from 'vitest';
import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
} from '@code-along/contracts/execution/profiles';
import { projectRuntimeChoices } from './runtime-choices.ts';

const core = { id: '00000000-0000-4000-8000-000000000001', ...CORE_RUNTIME };
const numpy = {
  id: '00000000-0000-4000-8000-000000000002',
  ...SCIENTIFIC_RUNTIME,
};

describe('new project runtime choices', () => {
  it('uses enabled catalogue IDs and reviewed labels in Core then NumPy order', () => {
    expect(
      projectRuntimeChoices([numpy, core]).map(({ id, profile }) => ({
        id,
        name: profile.name,
      })),
    ).toEqual([
      { id: core.id, name: 'Python core' },
      { id: numpy.id, name: 'NumPy' },
    ]);
  });

  it('does not manufacture a default when Core is absent or accept another digest under its name', () => {
    expect(projectRuntimeChoices([numpy]).map((choice) => choice.id)).toEqual([
      numpy.id,
    ]);
    expect(
      projectRuntimeChoices([
        { ...core, manifest_sha256: SCIENTIFIC_RUNTIME.manifest_sha256 },
        { ...numpy, runtime_id: 'unreviewed-runtime' },
      ]),
    ).toEqual([]);
  });

  it('rejects ambiguous runtime names, shared catalogue IDs and invalid IDs', () => {
    expect(projectRuntimeChoices([core, { ...core, id: numpy.id }])).toEqual(
      [],
    );
    expect(projectRuntimeChoices([core, { ...numpy, id: core.id }])).toEqual(
      [],
    );
    expect(
      projectRuntimeChoices([{ ...core, id: 'not-a-profile-id' }]),
    ).toEqual([]);
  });
});
