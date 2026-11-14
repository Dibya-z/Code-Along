export interface HelperRelease {
  readonly release_id: string;
  readonly source_sha256: string;
}

/** The existing reviewed browser helper; this identity grants no assessment authority. */
export const REVIEWED_HELPER_RELEASE = Object.freeze({
  release_id: 'code-along-python-helpers-v1',
  source_sha256:
    '4b1ccdc64d339bad3c96154b465214f94e414b8b230cd50e59a478ca7fce51b1',
} as const satisfies HelperRelease);
