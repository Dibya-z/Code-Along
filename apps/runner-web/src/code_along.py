"""Original bounded raster helpers for local Code Along practice, not a plotting framework."""

import binascii
import itertools
import math
import struct
import zlib


def display_png(data, *, title="Plot"):
    """Display an 8-bit RGB/RGBA PNG, subject to independent runner/app validation."""
    if not isinstance(data, (bytes, bytearray)) or len(data) > 512 * 1024:
        raise ValueError("Use PNG bytes no larger than 512 KiB.")
    if not isinstance(title, str) or len(title.encode("utf-8")) > 160 or "\0" in title:
        raise ValueError("Use a plot title of at most 160 UTF-8 bytes.")
    import builtins

    builtins._code_along_emit_png(bytes(data), title)


def plot(values, *, title="Line plot"):
    """Plot 2–1,000 finite numeric samples on a small raster canvas."""
    samples = list(itertools.islice(iter(values), 1001))
    if not 2 <= len(samples) <= 1000:
        raise ValueError("Use between 2 and 1,000 samples.")
    samples = [float(value) for value in samples]
    if not all(math.isfinite(value) for value in samples):
        raise ValueError("Plot samples must be finite numbers.")
    low, high = min(samples), max(samples)
    span = high - low
    if not math.isfinite(span):
        raise ValueError("The sample range is too large.")
    width, height = 640, 360
    pixels = bytearray([255]) * (width * height * 3)

    def pixel(x, y, color):
        if 0 <= x < width and 0 <= y < height:
            offset = (y * width + x) * 3
            pixels[offset : offset + 3] = color

    def line(x0, y0, x1, y1, color):
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = 1 if x0 < x1 else -1, 1 if y0 < y1 else -1
        error = dx + dy
        while True:
            pixel(x0, y0, color)
            if color == ink:
                pixel(x0 + 1, y0, color)
                pixel(x0, y0 + 1, color)
            if x0 == x1 and y0 == y1:
                break
            twice = 2 * error
            if twice >= dy:
                error += dy
                x0 += sx
            if twice <= dx:
                error += dx
                y0 += sy

    axis, ink = bytes((124, 138, 126)), bytes((35, 101, 67))
    line(32, 16, 32, 328, axis)
    line(32, 328, 624, 328, axis)
    points = [
        (
            32 + round(i * 592 / (len(samples) - 1)),
            172 if span == 0 else 328 - round((value - low) / span * 312),
        )
        for i, value in enumerate(samples)
    ]
    for first, second in zip(points, points[1:], strict=False):
        line(*first, *second, ink)
    raw = b"".join(
        b"\0" + pixels[y * width * 3 : (y + 1) * width * 3] for y in range(height)
    )

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    display_png(png, title=title)
