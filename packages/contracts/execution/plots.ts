export const PLOT_LIMITS = Object.freeze({
  count: 4,
  bytes: 512 * 1024,
  totalBytes: 2 * 1024 * 1024,
  width: 1600,
  height: 1200,
  pixels: 1_920_000,
  titleBytes: 160,
});
export interface RasterPlot {
  readonly type: 'plot';
  readonly index: number;
  readonly title: string;
  readonly png: Uint8Array;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Narrow raster subset: CRC-checked 8-bit RGB/RGBA, no animation/metadata/interlace. */
export function pngDimensions(
  value: unknown,
): { width: number; height: number } | null {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.length < 57 ||
    value.length > PLOT_LIMITS.bytes
  )
    return null;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => value[i] === byte))
    return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let offset = 8,
    width = 0,
    height = 0,
    data = false;
  while (offset + 12 <= value.length) {
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > value.length) return null;
    const kind = String.fromCharCode(...value.subarray(offset + 4, offset + 8));
    if (crc32(value.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4))
      return null;
    if (offset === 8) {
      if (kind !== 'IHDR' || length !== 13) return null;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (
        !width ||
        !height ||
        width > PLOT_LIMITS.width ||
        height > PLOT_LIMITS.height ||
        width * height > PLOT_LIMITS.pixels ||
        value[offset + 16] !== 8 ||
        ![2, 6].includes(value[offset + 17]!) ||
        value[offset + 18] !== 0 ||
        value[offset + 19] !== 0 ||
        value[offset + 20] !== 0
      )
        return null;
    } else if (kind === 'IDAT') {
      if (!length) return null;
      data = true;
    } else if (kind === 'IEND')
      return length === 0 && data && end === value.length
        ? { width, height }
        : null;
    else return null;
    offset = end;
  }
  return null;
}
export function isRasterPlot(value: unknown): value is RasterPlot {
  if (!value || typeof value !== 'object') return false;
  const plot = value as RasterPlot;
  if (
    plot.type !== 'plot' ||
    !Number.isSafeInteger(plot.index) ||
    plot.index < 0 ||
    plot.index >= PLOT_LIMITS.count ||
    typeof plot.title !== 'string' ||
    plot.title.length > PLOT_LIMITS.titleBytes ||
    plot.title.includes('\0')
  )
    return false;
  const bytes = new TextEncoder().encode(plot.title);
  return (
    bytes.length <= PLOT_LIMITS.titleBytes &&
    new TextDecoder('utf-8', { fatal: true }).decode(bytes) === plot.title &&
    pngDimensions(plot.png) !== null
  );
}
