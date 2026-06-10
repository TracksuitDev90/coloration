"""Audit curated character colors against their photos. Report-only.

For each grid entry in characters.json with an image, samples the photo's
dominant body-color cluster and reports how far it sits from the curated
``color.hex``. The curated hexes are the game's sole source of truth — this
script never writes to characters.json and is never read by game code. Its
job is to surface entries worth a second human look, sorted by disagreement.

How clothing/background pixels are kept out of the sample:
  1. transparent pixels (alpha < 200), near-white backgrounds, near-black
     outlines, and extreme low-saturation shadow pixels are dropped (same
     heuristics as sample_colors.py);
  2. the survivors are clustered with k-means (k=6) in OKLab;
  3. the winning cluster is scored by ``weight * exp(-dE(centroid, curated)/18)``
     — anchoring to the curated hex means a clothing or scenery cluster
     scores near zero because it's far from the user's color, while the
     photo refines the shade within the right family;
  4. anything still > 25 dE from curated is flagged loudest: either the
     photo has no skin-colored region (combo art, prop shots) or the
     curated hex genuinely disagrees with the photo — both worth eyes.

Usage:
    python3 scripts/audit_colors.py            # whole grid roster
    python3 scripts/audit_colors.py pikachu …  # specific ids
"""

import json
import math
import sys
import warnings
from pathlib import Path

from PIL import Image

# Image.getdata is deprecated for Pillow 14 (2027); the replacement isn't in
# older Pillows yet, so keep the call and silence the nag in the report.
warnings.filterwarnings("ignore", category=DeprecationWarning)

REPO_ROOT = Path(__file__).resolve().parent.parent
CHARS_JSON = REPO_ROOT / "data" / "characters.json"

KMEANS_K = 6
KMEANS_ITERATIONS = 10
ANCHOR_DE_SCALE = 18.0
FLAG_DE = 25.0
# Sample at most this many pixels per image (uniform stride) — k-means on a
# few thousand points is plenty for a dominant-color estimate.
MAX_SAMPLES = 8000


def srgb_to_linear(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c):
    c = max(0.0, min(1.0, c))
    s = 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
    return round(max(0.0, min(1.0, s)) * 255)


def rgb_to_oklab(r, g, b):
    lr, lg, lb = srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)
    l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
    l_, m_, s_ = l ** (1 / 3), m ** (1 / 3), s ** (1 / 3)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def oklab_to_rgb(L, a, b):
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return (linear_to_srgb(lr), linear_to_srgb(lg), linear_to_srgb(lb))


def hex_to_oklab(hex_str):
    h = hex_str.lstrip("#")
    return rgb_to_oklab(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def oklab_to_hex(lab):
    return "#{:02X}{:02X}{:02X}".format(*oklab_to_rgb(*lab))


def delta_e(a, b):
    """Euclidean distance in OKLab x100 (conventional dE axis, ~2 = JND)."""
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b))) * 100


def usable_pixels(path: Path):
    """Photo pixels that plausibly belong to the character's body.

    Same filtering heuristics as sample_colors.py, plus the alpha mask for
    transparent-background art.
    """
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    has_alpha = any(a < 200 for *_xs, a in img.getdata()) if w * h < 2_000_000 else (
        img.getextrema()[3][0] < 200
    )
    if not has_alpha:
        # Opaque photo: crop to the inner 80% to reduce border/letterbox noise.
        mx, my = int(w * 0.10), int(h * 0.10)
        img = img.crop((mx, my, w - mx, h - my))

    pixels = list(img.getdata())
    stride = max(1, len(pixels) // MAX_SAMPLES)
    out = []
    for px in pixels[::stride]:
        r, g, b, a = px
        if a < 200:
            continue
        # Drop near-white background
        if r > 235 and g > 235 and b > 235:
            continue
        # Drop near-black outlines
        if r < 25 and g < 25 and b < 25:
            continue
        # Drop very dark / very light desaturated pixels (shadows, neutral
        # backgrounds) — mid-gray bodies must survive.
        mx_, mn_ = max(r, g, b), min(r, g, b)
        if mx_ - mn_ < 14 and (mx_ > 220 or mx_ < 50):
            continue
        out.append(rgb_to_oklab(r, g, b))
    return out


def kmeans(points, k=KMEANS_K, iterations=KMEANS_ITERATIONS):
    """Tiny deterministic k-means in OKLab. Seeds from a coarse histogram's
    top buckets so the starting centroids already sit on dense regions."""
    if not points:
        return []
    buckets = {}
    for p in points:
        key = tuple(round(v * 16) for v in p)
        buckets.setdefault(key, []).append(p)
    seeds = sorted(buckets.values(), key=len, reverse=True)[:k]
    centroids = [
        tuple(sum(v[i] for v in grp) / len(grp) for i in range(3))
        for grp in seeds
    ]
    for _ in range(iterations):
        groups = [[] for _ in centroids]
        for p in points:
            best = min(range(len(centroids)),
                       key=lambda i: sum((p[j] - centroids[i][j]) ** 2 for j in range(3)))
            groups[best].append(p)
        centroids = [
            tuple(sum(v[i] for v in grp) / len(grp) for i in range(3)) if grp else c
            for grp, c in zip(groups, centroids)
        ]
    total = len(points)
    return [
        (c, len(grp) / total)
        for c, grp in zip(centroids, [g for g in groups])
        if grp
    ]


def main():
    chars = json.loads(CHARS_JSON.read_text())
    target_ids = set(sys.argv[1:])
    rows = []
    for c in chars:
        if c.get("type") == "item":
            continue
        if target_ids and c["id"] not in target_ids:
            continue
        img = c.get("image")
        if not img:
            continue
        path = REPO_ROOT / img
        if not path.exists():
            rows.append((float("inf"), c["id"], c["color"]["hex"], None, "MISSING PHOTO", []))
            continue
        points = usable_pixels(path)
        if not points:
            rows.append((float("inf"), c["id"], c["color"]["hex"], None, "NO USABLE PIXELS", []))
            continue
        curated = hex_to_oklab(c["color"]["hex"])
        clusters = kmeans(points)
        scored = sorted(
            clusters,
            key=lambda cw: cw[1] * math.exp(-delta_e(cw[0], curated) / ANCHOR_DE_SCALE),
            reverse=True,
        )
        winner, weight = scored[0]
        de = delta_e(winner, curated)
        note = "FLAG: photo disagrees" if de > FLAG_DE else ""
        swatches = [f"{oklab_to_hex(cc)}({w * 100:.0f}%)" for cc, w in clusters[:4]]
        rows.append((de, c["id"], c["color"]["hex"], oklab_to_hex(winner), note, swatches))

    rows.sort(key=lambda r: -r[0])
    print(f"{'ΔE':>6}  {'id':24s} {'curated':8s} {'sampled':8s}  clusters")
    for de, cid, curated_hex, sampled_hex, note, swatches in rows:
        de_str = "  —  " if math.isinf(de) else f"{de:5.1f}"
        sampled = sampled_hex or "—"
        suffix = f"  {note}" if note else ""
        print(f"{de_str:>6}  {cid:24s} {curated_hex:8s} {sampled:8s}  {' '.join(swatches)}{suffix}")
    flagged = sum(1 for r in rows if r[4])
    print(f"\n{len(rows)} entries audited, {flagged} flagged. "
          "Report only — characters.json was not modified.")


if __name__ == "__main__":
    main()
