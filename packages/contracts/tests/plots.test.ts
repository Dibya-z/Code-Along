import { describe, expect, it } from 'vitest';
import { RUNNER_PROTOCOL } from '../execution/runner.ts';
import {
  isRasterPlot,
  pngDimensions,
  PLOT_LIMITS,
} from '../execution/plots.ts';
import { parseProductEvent } from '../execution/product-runner.ts';
const png = () =>
  Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8J8BAAf/Af8Bf4mnAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
const id = '00000000-0000-4000-8000-000000000001';
describe('bounded PNG product output', () => {
  it('admits an independently encoded RGB PNG with a text title', () => {
    expect(pngDimensions(png())).toEqual({ width: 2, height: 1 });
    expect(
      isRasterPlot({
        type: 'plot',
        index: 0,
        title: '<svg> remains text',
        png: png(),
      }),
    ).toBe(true);
  });
  it('rejects SVG, malformed chunks/CRC, oversized buffers and invalid titles/indexes', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(png().length));
    shared.set(png());
    expect(pngDimensions(shared)).toBeNull(); // A sender must not mutate bytes after validation.
    const corrupt = png();
    corrupt[44] = 0;
    for (const invalid of [
      new TextEncoder().encode('<svg/>'),
      png().slice(0, -1),
      corrupt,
      new Uint8Array(PLOT_LIMITS.bytes + 1),
    ])
      expect(pngDimensions(invalid)).toBeNull();
    for (const [index, title] of [
      [4, 'x'],
      [-1, 'x'],
      [0, '🐍'.repeat(41)],
      [0, '\ud800'],
    ] as const)
      expect(isRasterPlot({ type: 'plot', index, title, png: png() })).toBe(
        false,
      );
  });
  it('adds plots to v2 without consuming stdout sequence numbers or permitting extra command fields', () => {
    const event = {
      protocol: RUNNER_PROTOCOL,
      version: 2,
      session_nonce: id,
      run_id: id,
      type: 'plot',
      index: 0,
      title: 'Two pixels',
      png: png(),
    };
    expect(parseProductEvent(event, id)).not.toBeNull();
    expect(parseProductEvent({ ...event, sequence: 0 }, id)).toBeNull();
    expect(parseProductEvent({ ...event, version: 1 }, id)).toBeNull();
    expect(
      parseProductEvent(event, '00000000-0000-4000-8000-000000000002'),
    ).toBeNull();
  });
});
