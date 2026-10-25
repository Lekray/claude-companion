#!/usr/bin/env python3
"""Generate the bundled assets of the claude-companion extension.

    python scripts/gen-assets.py

Outputs (all deterministic, no timestamps):
    resources/claude-companion.woff  one glyph at U+E001, an original 8-ray spark
    resources/icon.png               128x128 RGBA, the same spark on a dark rounded square
    resources/done.wav               rising two-note chime      (0.55 s)
    resources/waiting.wav            two soft pings             (0.45 s)
    resources/error.wav              descending two-note tone   (0.50 s)

The script re-reads every file it writes and prints a verification summary;
it exits non-zero if anything is off.
"""

import math
import os
import struct
import sys
import wave
import zlib

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESOURCES = os.path.join(REPO_ROOT, "resources")

FONT_PATH = os.path.join(RESOURCES, "claude-companion.woff")
ICON_PATH = os.path.join(RESOURCES, "icon.png")
DONE_PATH = os.path.join(RESOURCES, "done.wav")
WAITING_PATH = os.path.join(RESOURCES, "waiting.wav")
ERROR_PATH = os.path.join(RESOURCES, "error.wav")

UNITS_PER_EM = 1000
GLYPH_CODEPOINT = 0xE001
GLYPH_NAME = "spark"

# 2026-10-18 00:00:00 UTC in the 1904 Mac epoch. A fixed, modern timestamp keeps
# the WOFF byte-identical and does not trip fontTools' "old Unix timestamp" shim.
FONT_TIMESTAMP = 1792281600 + 2082844800

# Ray geometry, in font units measured from the centre of the glyph.
# The long rays reach 450 units, so the whole spark spans 900 of the 1000-unit
# em box (90%), centred at (500, 500).
LONG_REACH = 450
SHORT_REACH = 300
LONG_BASE_HALF = 58
SHORT_BASE_HALF = 50
LONG_TIP_HALF = 20
SHORT_TIP_HALF = 17
CAP_SEGMENTS = 40
RADIAL_SAMPLES = 1440

ICON_SIZE = 128
ICON_SAMPLES = 4
ICON_RADIUS = 22
BG_COLOR = (0x1F, 0x1E, 0x1D)
SPARK_COLOR = (0xD9, 0x77, 0x57)

SAMPLE_RATE = 44100
PEAK_TARGET = 10.0 ** (-6.0 / 20.0)  # -6 dBFS
FADE_IN = 0.005
NOTE_FADE_OUT = 0.025
END_SILENCE = 0.017

NOTE_E6 = 1318.51
NOTE_B6 = 1975.53
NOTE_A5 = 880.00
NOTE_E5 = 659.25
NOTE_A4 = 440.00


def log(message):
    print("[gen-assets] %s" % message)


# ---------------------------------------------------------------------------
# geometry: an original eight-ray spark
# ---------------------------------------------------------------------------


def ray_polygon(reach, base_half, tip_half, angle_deg):
    """A tapered ray from the origin along +X, ending in a round cap."""
    body = reach - tip_half
    points = [(0.0, -base_half), (body, -tip_half)]
    for index in range(CAP_SEGMENTS + 1):
        arc = -math.pi / 2 + math.pi * index / CAP_SEGMENTS
        points.append((body + tip_half * math.cos(arc), tip_half * math.sin(arc)))
    points.append((body, tip_half))
    points.append((0.0, base_half))

    angle = math.radians(angle_deg)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    return [
        (x * cos_a - y * sin_a, x * sin_a + y * cos_a) for x, y in points
    ]


def build_rays():
    """Alternating long and short rays every 45 degrees."""
    rays = []
    for index in range(8):
        if index % 2 == 0:
            rays.append(
                ray_polygon(LONG_REACH, LONG_BASE_HALF, LONG_TIP_HALF, index * 45)
            )
        else:
            rays.append(
                ray_polygon(SHORT_REACH, SHORT_BASE_HALF, SHORT_TIP_HALF, index * 45)
            )
    return rays


def _cross(ax, ay, bx, by):
    return ax * by - ay * bx


def ray_extent(polygon, theta):
    """Farthest distance from the origin along `theta` inside a convex polygon."""
    ux, uy = math.cos(theta), math.sin(theta)
    farthest = 0.0
    count = len(polygon)
    for index in range(count):
        px, py = polygon[index]
        qx, qy = polygon[(index + 1) % count]
        dx, dy = qx - px, qy - py
        denom = _cross(ux, uy, dx, dy)
        if abs(denom) < 1e-12:
            continue
        t = _cross(px, py, dx, dy) / denom
        s = _cross(px, py, ux, uy) / denom
        if t > 0.0 and -1e-9 <= s <= 1.0 + 1e-9 and t > farthest:
            farthest = t
    return farthest


def union_polygon(rays):
    """Radial envelope of the union: r(theta) = max over rays.

    Every ray is convex and contains the origin, so the union is star-shaped
    around the origin and this envelope is exactly its boundary.
    """
    points = []
    for index in range(RADIAL_SAMPLES):
        theta = 2.0 * math.pi * index / RADIAL_SAMPLES
        radius = max(ray_extent(polygon, theta) for polygon in rays)
        points.append(
            (UNITS_PER_EM / 2 + radius * math.cos(theta),
             UNITS_PER_EM / 2 + radius * math.sin(theta))
        )
    return drop_collinear(points)


def drop_collinear(points):
    """Remove points that lie on a straight run (keeps the outline identical)."""
    changed = True
    result = list(points)
    while changed and len(result) > 3:
        changed = False
        kept = []
        count = len(result)
        for index in range(count):
            ax, ay = result[index - 1]
            bx, by = result[index]
            cx, cy = result[(index + 1) % count]
            abx, aby = bx - ax, by - ay
            bcx, bcy = cx - bx, cy - by
            length = math.hypot(abx, aby) * math.hypot(bcx, bcy)
            if length > 0.0:
                sine = _cross(abx, aby, bcx, bcy) / length
                dot = abx * bcx + aby * bcy
                if abs(sine) < 1e-5 and dot > 0.0:
                    changed = True
                    continue
            kept.append(result[index])
        if len(kept) >= 3:
            result = kept
        else:
            break
    return result


def signed_area(points):
    total = 0.0
    for index in range(len(points)):
        x1, y1 = points[index]
        x2, y2 = points[(index + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return total / 2.0


# ---------------------------------------------------------------------------
# icon font
# ---------------------------------------------------------------------------


def write_font(points):
    pen = TTGlyphPen(None)
    pen.moveTo(points[0])
    for point in points[1:]:
        pen.lineTo(point)
    pen.closePath()

    builder = FontBuilder(unitsPerEm=UNITS_PER_EM, isTTF=True)
    builder.setupGlyphOrder([".notdef", GLYPH_NAME])
    builder.setupCharacterMap({GLYPH_CODEPOINT: GLYPH_NAME})
    builder.setupGlyf({".notdef": TTGlyphPen(None).glyph(), GLYPH_NAME: pen.glyph()})
    x_min = min(x for x, _ in points)
    builder.setupHorizontalMetrics(
        {".notdef": (UNITS_PER_EM, 0), GLYPH_NAME: (UNITS_PER_EM, int(round(x_min)))}
    )
    builder.setupHorizontalHeader(ascent=950, descent=-110)
    builder.setupOS2(
        sTypoAscender=950,
        sTypoDescender=-110,
        sTypoLineGap=0,
        usWinAscent=1000,
        usWinDescent=120,
    )
    builder.setupNameTable(
        {
            "familyName": "claude-companion",
            "styleName": "Regular",
            "uniqueFontIdentifier": "claude-companion-1.0",
            "fullName": "claude-companion",
            "psName": "claude-companion",
            "version": "Version 1.0",
        }
    )
    builder.setupPost()
    # FontBuilder stamps head.created/modified with the current time; pin them so
    # re-running the script produces byte-identical files.
    builder.font.recalcTimestamp = False
    builder.font["head"].created = FONT_TIMESTAMP
    builder.font["head"].modified = FONT_TIMESTAMP
    builder.font.flavor = "woff"
    builder.save(FONT_PATH)


# ---------------------------------------------------------------------------
# icon.png
# ---------------------------------------------------------------------------


def polygon_mask(points, size):
    """Scanline rasterisation of a simple polygon into a size*size byte mask."""
    mask = bytearray(size * size)
    count = len(points)
    for row in range(size):
        y = row + 0.5
        crossings = []
        for index in range(count):
            x1, y1 = points[index]
            x2, y2 = points[(index + 1) % count]
            if (y1 <= y) != (y2 <= y):
                crossings.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        crossings.sort()
        for index in range(0, len(crossings) - 1, 2):
            start = max(0, int(math.ceil(crossings[index] - 0.5)))
            end = min(size - 1, int(math.floor(crossings[index + 1] - 0.5)))
            if end < start:
                continue
            offset = row * size
            mask[offset + start : offset + end + 1] = b"\x01" * (end - start + 1)
    return mask


def rounded_square_mask(size, radius):
    mask = bytearray(size * size)
    inner = size - radius
    for row in range(size):
        y = row + 0.5
        cy = min(max(y, radius), inner)
        offset = row * size
        for column in range(size):
            x = column + 0.5
            cx = min(max(x, radius), inner)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius:
                mask[offset + column] = 1
    return mask


def write_png():
    """Draw the icon with a 4x supersampled rasteriser and write it with zlib.

    Pillow is deliberately not used even when installed: the pixel grid is
    computed here, so the PNG is byte-identical on every machine.
    """
    rays = build_rays()
    union = union_polygon(rays)
    scale = ICON_SIZE / float(UNITS_PER_EM)
    big = ICON_SIZE * ICON_SAMPLES
    icon_points = [
        (
            ((x - UNITS_PER_EM / 2.0) * scale + ICON_SIZE / 2.0) * ICON_SAMPLES,
            (ICON_SIZE / 2.0 - (y - UNITS_PER_EM / 2.0) * scale) * ICON_SAMPLES,
        )
        for x, y in union
    ]

    background = rounded_square_mask(big, ICON_RADIUS * ICON_SAMPLES)
    spark = polygon_mask(icon_points, big)
    cell = ICON_SAMPLES * ICON_SAMPLES

    rows = []
    for out_y in range(ICON_SIZE):
        row = bytearray()
        for out_x in range(ICON_SIZE):
            bg_count = 0
            red = green = blue = 0
            for sy in range(ICON_SAMPLES):
                base = (out_y * ICON_SAMPLES + sy) * big + out_x * ICON_SAMPLES
                for sx in range(ICON_SAMPLES):
                    index = base + sx
                    if not background[index]:
                        continue
                    bg_count += 1
                    if spark[index]:
                        red += SPARK_COLOR[0]
                        green += SPARK_COLOR[1]
                        blue += SPARK_COLOR[2]
                    else:
                        red += BG_COLOR[0]
                        green += BG_COLOR[1]
                        blue += BG_COLOR[2]
            if bg_count == 0:
                row += b"\x00\x00\x00\x00"
                continue
            row += bytes(
                (
                    int(round(red / float(bg_count))),
                    int(round(green / float(bg_count))),
                    int(round(blue / float(bg_count))),
                    int(round(255 * bg_count / float(cell))),
                )
            )
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(
            b"IHDR",
            struct.pack(">IIBBBBB", ICON_SIZE, ICON_SIZE, 8, 6, 0, 0, 0),
        )
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(ICON_PATH, "wb") as handle:
        handle.write(png)


# ---------------------------------------------------------------------------
# sounds
# ---------------------------------------------------------------------------


def add_note(buffer, start, duration, frequency, tau, harmonics, fade_out=NOTE_FADE_OUT):
    first = int(round(start * SAMPLE_RATE))
    count = int(round(duration * SAMPLE_RATE))
    attack_count = max(1, int(round(FADE_IN * SAMPLE_RATE)))
    fade_count = max(1, int(round(fade_out * SAMPLE_RATE)))
    for index in range(count):
        t = index / float(SAMPLE_RATE)
        attack = 1.0
        if index < attack_count:
            attack = 0.5 - 0.5 * math.cos(math.pi * index / attack_count)
        envelope = attack * math.exp(-t / tau)
        remaining = count - index
        if remaining < fade_count:
            envelope *= 0.5 - 0.5 * math.cos(math.pi * remaining / fade_count)
        value = 0.0
        for multiplier, amplitude in harmonics:
            value += amplitude * math.sin(2.0 * math.pi * frequency * multiplier * t)
        buffer[first + index] += envelope * value


def write_wav(path, duration, notes):
    count = int(round(duration * SAMPLE_RATE))
    buffer = [0.0] * count
    for note in notes:
        add_note(buffer, *note)

    # Keep the tail exactly silent so the file ends without a click.
    silence = int(round(END_SILENCE * SAMPLE_RATE))
    for index in range(max(0, count - silence), count):
        buffer[index] = 0.0

    peak = max(abs(value) for value in buffer) or 1.0
    gain = PEAK_TARGET / peak
    samples = [int(round(value * gain * 32767.0)) for value in buffer]
    samples = [max(-32768, min(32767, value)) for value in samples]

    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(struct.pack("<%dh" % len(samples), *samples))


def write_sounds():
    bell = ((1, 1.0), (2, 0.32), (3, 0.08))
    soft = ((1, 1.0), (2, 0.18))
    dark = ((1, 1.0), (2, 0.12), (3, 0.05))

    write_wav(
        DONE_PATH,
        0.55,
        [
            (0.00, 0.33, NOTE_E6, 0.10, bell),
            (0.17, 0.363, NOTE_B6, 0.13, bell),
        ],
    )
    write_wav(
        WAITING_PATH,
        0.45,
        [
            (0.00, 0.18, NOTE_A5, 0.06, soft),
            (0.15, 0.18, NOTE_A5, 0.06, soft),
        ],
    )
    write_wav(
        ERROR_PATH,
        0.50,
        [
            (0.00, 0.28, NOTE_E5, 0.11, dark),
            (0.17, 0.313, NOTE_A4, 0.14, dark),
        ],
    )


# ---------------------------------------------------------------------------
# read-back verification
# ---------------------------------------------------------------------------


def verify_wav(path):
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.getnframes()
        payload = handle.readframes(frames)
    if (channels, width, rate) != (1, 2, SAMPLE_RATE):
        raise SystemExit("%s: expected mono 16-bit %d Hz" % (path, SAMPLE_RATE))

    samples = struct.unpack("<%dh" % frames, payload)
    duration = frames / float(rate)
    peak = max(abs(value) for value in samples)
    peak_db = 20.0 * math.log10(peak / 32768.0) if peak else float("-inf")
    tail = samples[-int(round(0.010 * rate)) :]
    tail_peak = max(abs(value) for value in tail)

    if abs(peak_db - (-6.0)) > 0.1:
        raise SystemExit("%s: peak %.2f dBFS is not about -6 dBFS" % (path, peak_db))
    if tail_peak != 0:
        raise SystemExit("%s: tail is not silent (max %d)" % (path, tail_peak))
    return duration, peak_db, tail_peak


def verify_font(path):
    font = TTFont(path)
    cmap = font.getBestCmap()
    if GLYPH_CODEPOINT not in cmap:
        raise SystemExit("%s: cmap has no U+E001" % path)
    name = cmap[GLYPH_CODEPOINT]
    glyph = font["glyf"][name]
    bbox = (glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax)
    advance = font["hmtx"][name][0]
    if bbox[0] > 50 or bbox[1] > 50 or bbox[2] < 950 or bbox[3] < 950:
        raise SystemExit("%s: glyph does not fill 90%% of the em box: %s" % (path, bbox))
    if advance != UNITS_PER_EM:
        raise SystemExit("%s: unexpected advance width %s" % (path, advance))
    contours = glyph.numberOfContours
    if contours != 1:
        raise SystemExit("%s: expected one solid contour, got %s" % (path, contours))
    head = font["head"]
    if (head.created, head.modified) != (FONT_TIMESTAMP, FONT_TIMESTAMP):
        raise SystemExit("%s: non-deterministic head timestamps" % path)
    return cmap, bbox, advance


def verify_png(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("%s: not a PNG" % path)

    offset = 8
    width = height = None
    idat = b""
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            width, height, depth, color_type = struct.unpack(">IIBB", payload[:10])
            if (width, height, depth, color_type) != (ICON_SIZE, ICON_SIZE, 8, 6):
                raise SystemExit("%s: expected 128x128 RGBA" % path)
        elif kind == b"IDAT":
            idat += payload
        elif kind == b"IEND":
            break

    raw = zlib.decompress(idat)
    stride = width * 4
    rows = []
    for row in range(height):
        start = row * (stride + 1)
        if raw[start] != 0:
            raise SystemExit("%s: unexpected row filter %d" % (path, raw[start]))
        rows.append(raw[start + 1 : start + 1 + stride])

    corner = tuple(rows[0][0:4])
    center = tuple(rows[height // 2][(width // 2) * 4 : (width // 2) * 4 + 4])
    if corner[3] != 0:
        raise SystemExit("%s: corner is not transparent: %s" % (path, corner))
    if center[:3] != SPARK_COLOR:
        raise SystemExit("%s: centre pixel is %s, expected %s" % (path, center, SPARK_COLOR))
    return width, height, corner, center


def main():
    os.makedirs(RESOURCES, exist_ok=True)

    # TrueType outer contours are conventionally clockwise (negative area).
    outline = union_polygon(build_rays())
    if signed_area(outline) > 0:
        outline.reverse()
    outline = [(int(round(x)), int(round(y))) for x, y in outline]
    write_font(outline)
    write_png()
    write_sounds()

    cmap, bbox, advance = verify_font(FONT_PATH)
    log(
        "claude-companion.woff: cmap U+%04X -> %s, bbox %s, advance %d, %d outline points"
        % (GLYPH_CODEPOINT, cmap[GLYPH_CODEPOINT], bbox, advance, len(outline))
    )

    width, height, corner, center = verify_png(ICON_PATH)
    log(
        "icon.png: %dx%d RGBA, corner pixel %s, centre pixel %s"
        % (width, height, corner, center)
    )

    for path in (DONE_PATH, WAITING_PATH, ERROR_PATH):
        duration, peak_db, tail = verify_wav(path)
        log(
            "%s: %.3f s, peak %.2f dBFS, max |sample| in the last 10 ms = %d"
            % (os.path.basename(path), duration, peak_db, tail)
        )

    log("all assets verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
