#!/usr/bin/env python3
"""Generate every Ghostly brand asset from one parametric construction.

    python3 scripts/generate-icons.py

Why a script and not exported artwork: the previous assets were base64 PNGs
wrapped in an `<svg>` element — 880 kB across two files, no real vectors, no
way to recolour them per theme and visibly soft when scaled. Everything here is
real vector, derived from a handful of numbers, and regenerable.

The mark is a faceless ghost: a semicircular dome over a three-lobed hem whose
leftmost lobe stretches into a trailing sweep. The trail is the ownable part —
it gives the silhouette direction and echoes the descender of the lowercase `g`
the wordmark spells out. The old mark's dot eyes and sticker outline are what
made it read as a toy rather than a tool.

Outputs
    src/assets/ghostly-mark.svg          in-app mark, inherits currentColor
    src-tauri/icons/Ghostly-icon.svg     app icon, master vector
    src-tauri/icons/*.png, icon.icns     app icon, rasterised
    src-tauri/resources/tray_*.png       menu-bar glyphs (template images)
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CX = 256.0  # horizontal centre of the 512 design box


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def ghost(r, cy, hem_y, depth, lobes=3, trail=0.0, notch=0.66):
    """Ghost outline, clockwise from the left shoulder.

    r/cy    dome radius and centre — the form's geometric spine
    hem_y   where the flanks stop and the hem begins
    depth   how far a lobe hangs below the hem line
    trail   how far the leftmost lobe stretches down and left (0 = symmetric)
    notch   how high the cut between lobes rides back up, as a fraction of
            depth. Above ~0.8 the cut closes to a hairline below 32 px.
    """
    left, right = CX - r, CX + r
    w = 2 * r / lobes
    d = [
        f"M {left:.1f} {cy:.1f}",
        f"A {r:.1f} {r:.1f} 0 0 1 {right:.1f} {cy:.1f}",
        f"L {right:.1f} {hem_y:.1f}",
    ]
    x = right
    for i in range(lobes):
        last = i == lobes - 1
        nx = x - w
        extra = depth * trail if last else 0.0
        dx = w * trail * 0.55 if last else 0.0
        mid = x - w / 2 - dx
        bot = hem_y + depth + extra
        ny = hem_y if last else hem_y + depth * (1 - notch)
        d.append(
            f"C {x:.1f} {hem_y + (depth + extra) * 0.70:.1f} "
            f"{mid + w * 0.30:.1f} {bot:.1f} {mid:.1f} {bot:.1f}"
        )
        d.append(
            f"C {mid - w * 0.34:.1f} {bot:.1f} "
            f"{nx - dx * 0.5:.1f} {hem_y + (depth + extra) * 0.66:.1f} "
            f"{nx:.1f} {ny:.1f}"
        )
        x = nx
    d.append("Z")
    return " ".join(d)


def squircle(cx, cy, half, n=5.0, steps=192):
    """Apple-style continuous corner (superellipse), sampled as a path.

    A plain rounded rect reads visibly rounder than macOS's corner, and at icon
    sizes that difference is most of what separates "native" from "not".
    """
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        pts.append(
            (
                cx + half * math.copysign(abs(ct) ** (2.0 / n), ct),
                cy + half * math.copysign(abs(st) ** (2.0 / n), st),
            )
        )
    return (
        f"M {pts[0][0]:.2f} {pts[0][1]:.2f} "
        + " ".join(f"L {x:.2f} {y:.2f}" for x, y in pts[1:])
        + " Z"
    )


# The mark, and a chunkier cut for the menu bar. At 16 px the full mark's hem
# collapses into mush, so the tray gets shallower lobes and no trail — the same
# reason Apple ships different artwork per size inside a single .icns.
MARK = ghost(125, 195, 352, 88, trail=0.55, notch=0.86)
TRAY = ghost(140, 210, 330, 62, notch=0.50)


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------


def rsvg(svg_path, png_path, w, h=None):
    subprocess.run(
        ["rsvg-convert", "-w", str(w), "-h", str(h or w), str(svg_path), "-o", str(png_path)],
        check=True,
    )


def ink_bbox(path_d, box=512, sample=1024):
    """Tight bounding box of a filled path, measured from rendered alpha."""
    from PIL import Image

    with tempfile.TemporaryDirectory() as td:
        s, p = Path(td) / "a.svg", Path(td) / "a.png"
        s.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {box} {box}">'
            f'<path d="{path_d}" fill="#000"/></svg>'
        )
        rsvg(s, p, sample)
        bbox = Image.open(p).getchannel("A").getbbox()
    k = box / sample
    return tuple(v * k for v in bbox)


GRADS = """
    <linearGradient id="mark" x1="0.12" y1="0" x2="0.82" y2="1">
      <stop offset="0%" stop-color="#FDFCFF"/>
      <stop offset="40%" stop-color="#DDD6FE"/>
      <stop offset="100%" stop-color="#A78BFA"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="#26164B"/>
      <stop offset="55%" stop-color="#120C24"/>
      <stop offset="100%" stop-color="#08080C"/>
    </linearGradient>
    <radialGradient id="aura" cx="0.5" cy="0.28" r="0.62">
      <stop offset="0%" stop-color="#7C3AED" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#7C3AED" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#7C3AED" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.20"/>
      <stop offset="42%" stop-color="#FFFFFF" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.46" r="0.5">
      <stop offset="0%" stop-color="#A78BFA" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="#A78BFA" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="#A78BFA" stop-opacity="0"/>
    </radialGradient>
"""


def write_mark_svg(dest):
    """The mark alone, tight viewBox, `currentColor` so it themes in-app."""
    x0, y0, x1, y1 = ink_bbox(MARK)
    pad = 2.0
    vb = f"{x0 - pad:.1f} {y0 - pad:.1f} {x1 - x0 + pad * 2:.1f} {y1 - y0 + pad * 2:.1f}"
    dest.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" fill="none">\n'
        f'  <path d="{MARK}" fill="currentColor"/>\n'
        "</svg>\n"
    )
    return (x0, y0, x1, y1)


def write_icon_svg(dest, bbox):
    """macOS app icon: 1024 canvas, 824 body on Apple's grid."""
    sq = squircle(512, 512, 412)
    x0, y0, x1, y1 = bbox
    scale = 530.0 / (y1 - y0)
    tx = 512 - ((x0 + x1) / 2) * scale
    ty = 506 - ((y0 + y1) / 2) * scale
    dest.write_text(
        f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
  <defs>{GRADS}    <clipPath id="body"><path d="{sq}"/></clipPath>
  </defs>
  <path d="{sq}" fill="url(#bg)"/>
  <g clip-path="url(#body)">
    <rect width="1024" height="1024" fill="url(#aura)"/>
    <path d="{sq}" fill="url(#rim)"/>
    <g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.4f})">
      <ellipse cx="{(x0 + x1) / 2:.1f}" cy="{(y0 + y1) / 2:.1f}" rx="230" ry="250" fill="url(#glow)"/>
      <path d="{MARK}" fill="url(#mark)"/>
    </g>
  </g>
  <path d="{sq}" fill="none" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="2"/>
</svg>
"""
    )


def write_tray_svg(dest, state):
    """Menu-bar glyph, 64x64.

    Rendered by macOS as a template image: only alpha is read, so colour is
    irrelevant and *coverage* is everything. Badged states knock a transparent
    moat out of the ghost rather than drawing on top of it — at the ~18 px the
    menu bar actually displays, a badge touching the silhouette merges into it
    and the state becomes unreadable.
    """
    badge = state != "idle"
    x0, y0, x1, y1 = ink_bbox(TRAY)
    height = 42.0 if badge else 48.0
    scale = height / (y1 - y0)
    cx, cy = (25.0, 30.0) if badge else (32.0, 32.0)
    tx = cx - ((x0 + x1) / 2) * scale
    ty = cy - ((y0 + y1) / 2) * scale

    # Badge geometry, deliberately large: a small badge is a smudge at 18 px.
    if state == "recording":
        shape = '<circle cx="47" cy="46" r="13"/>'
        moat = '<circle cx="47" cy="46" r="17" fill="#000"/>'
    else:  # transcribing — a level meter, chunky enough to survive downscaling
        shape = "".join(
            f'<rect x="{35 + i * 10}" y="{56 - h}" width="7" height="{h}" rx="3.5"/>'
            for i, h in enumerate((12, 24, 17))
        )
        moat = '<rect x="31" y="28" width="34" height="32" rx="10" fill="#000"/>'

    # `maskContentUnits` defaults to the *referencing element's* user space, so
    # the mask has to hang off an untransformed wrapper — put it on the scaled
    # group and the moat coordinates land in design units and erase everything.
    mask = (
        '  <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
        f'<rect width="64" height="64" fill="#fff"/>{moat}</mask>\n'
        if badge
        else ""
    )
    ghost = (
        f'  <path transform="translate({tx:.2f} {ty:.2f}) scale({scale:.4f})" '
        f'd="{TRAY}" fill="#fff"/>\n'
    )
    if badge:
        ghost = f'  <g mask="url(#cut)">\n  {ghost}  </g>\n'
    dest.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n'
        f"{mask}{ghost}"
        + (f'  <g fill="#fff">{shape}</g>\n' if badge else "")
        + "</svg>\n"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    icons = ROOT / "src-tauri" / "icons"
    res = ROOT / "src-tauri" / "resources"
    assets = ROOT / "src" / "assets"
    icons.mkdir(parents=True, exist_ok=True)

    bbox = write_mark_svg(assets / "ghostly-mark.svg")
    icon_svg = icons / "Ghostly-icon.svg"
    write_icon_svg(icon_svg, bbox)

    # Rasterised app icon
    for name, size in [
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 1024),
    ]:
        rsvg(icon_svg, icons / name, size)

    # .icns — every size Finder, the Dock and Get Info ask for
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            rsvg(icon_svg, iconset / f"icon_{base}x{base}.png", base)
            rsvg(icon_svg, iconset / f"icon_{base}x{base}@2x.png", base * 2)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(icons / "icon.icns")],
            check=True,
        )

    # Menu-bar glyphs. `set_icon_as_template(true)` means macOS recolours from
    # alpha, so the light/dark pairs are byte-identical by design.
    with tempfile.TemporaryDirectory() as td:
        for state in ("idle", "recording", "transcribing"):
            svg = Path(td) / f"{state}.svg"
            write_tray_svg(svg, state)
            png = res / f"tray_{state}.png"
            rsvg(svg, png, 64)
            shutil.copyfile(png, res / f"tray_{state}_dark.png")
            shutil.copyfile(png, res / ("ghostly.png" if state == "idle" else f"{state}.png"))

    print("Generated:")
    print(f"  {assets / 'ghostly-mark.svg'}")
    print(f"  {icon_svg} + png/icns")
    print(f"  {res}/tray_*.png")


if __name__ == "__main__":
    main()
