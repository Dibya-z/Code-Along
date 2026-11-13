import { describe, expect, it, vi } from 'vitest';
import {
  downloadReviewedWheel,
  verifyAssetBytes,
} from '../../tools/dev/runtime_assets.ts';
import {
  sha256,
  sourceBytes,
} from '../../packages/contracts/execution/runner.ts';
async function asset() {
  return {
    name: 'example-1.0-py3-none-any.whl',
    bytes: 3,
    sha256: await sha256(sourceBytes('abc')),
  };
}
describe('pinned runtime build downloads', () => {
  it('uses only the fixed official versioned distribution without credentials or redirects', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('abc'));
    expect(
      new TextDecoder().decode(
        await downloadReviewedWheel(await asset(), request),
      ),
    ).toBe('abc');
    expect(request).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/example-1.0-py3-none-any.whl',
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    );
  });
  it('rejects paths/URLs and invalid metadata without making a request', async () => {
    const request = vi.fn<typeof fetch>();
    const base = await asset();
    for (const value of [
      { ...base, name: '../example.whl' },
      { ...base, name: 'https://host/example.whl' },
      { ...base, bytes: 1.5 },
      { ...base, sha256: 'unreviewed' },
    ])
      await expect(downloadReviewedWheel(value, request)).rejects.toThrow(
        'Invalid reviewed wheel',
      );
    expect(request).not.toHaveBeenCalled();
  });
  it('fails on incorrect bytes or hashes and does not retry corrupted content', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad'));
    await expect(downloadReviewedWheel(await asset(), request)).rejects.toThrow(
      'integrity check',
    );
    expect(request).toHaveBeenCalledOnce();
    await expect(
      verifyAssetBytes(await asset(), sourceBytes('too large')),
    ).rejects.toThrow('integrity check');
  });
  it('bounds a chunked download before writing any cache file', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('12345'));
    await expect(downloadReviewedWheel(await asset(), request)).rejects.toThrow(
      'byte budget',
    );
  });
  it('retries transient transport errors with a fixed destination and verifies the result', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('abc'));
    await downloadReviewedWheel(await asset(), request);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
