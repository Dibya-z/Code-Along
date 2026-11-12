import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const css = readFileSync(
  new URL('../../packages/design-system/src/tokens.css', import.meta.url),
  'utf8',
);
function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+):\s*(#[a-f0-9]{6})/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}
function luminance(hex: string): number {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
const light = tokens(css.split('}')[0]!);
const dark = {
  ...light,
  ...tokens(css.split("[data-theme='dark'] {")[1]!.split('}')[0]!),
};
it.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme meets named text/control contrast gates', (_theme, t) => {
  const pairs: [string, string, number][] = [
    ['ink', 'canvas', 4.5],
    ['ink', 'surface', 4.5],
    ['ink', 'raised', 4.5],
    ['muted', 'surface', 4.5],
    ['on-primary', 'primary', 4.5],
    ['on-primary', 'primary-hover', 4.5],
    ['focus', 'surface', 3],
    ['border', 'surface', 3],
    ...['success', 'warning', 'error', 'info'].map(
      (s): [string, string, number] => [s, 'surface', 4.5],
    ),
  ];
  for (const [foreground, background, minimum] of pairs) {
    const a = luminance(t[foreground]!),
      b = luminance(t[background]!);
    expect(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      `${foreground} on ${background}`,
    ).toBeGreaterThanOrEqual(minimum);
  }
});
