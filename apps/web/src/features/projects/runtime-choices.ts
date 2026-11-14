import type { components } from '@code-along/api-client';
import { isRunnerId } from '@code-along/contracts/execution';
import { RUNTIME_PROFILES } from '@code-along/contracts/execution/profiles';

type Runtime = components['schemas']['RuntimeOutput'];

/** The enabled server catalogue supplies IDs; reviewed local identities supply choices and labels. */
export function projectRuntimeChoices(catalogue: readonly Runtime[]) {
  return RUNTIME_PROFILES.flatMap((profile) => {
    const matches = catalogue.filter(
      (item) => item.runtime_id === profile.identity.runtime_id,
    );
    const item = matches.length === 1 ? matches[0] : undefined;
    if (
      !item ||
      !isRunnerId(item.id) ||
      item.manifest_sha256 !== profile.identity.manifest_sha256 ||
      catalogue.some((other) => other !== item && other.id === item.id)
    )
      return [];
    return [{ id: item.id, profile }];
  });
}
