"""Generate optimized WebP copies of every character/item photo.

The game ships full-resolution PNGs (some over 8 MB), which load slowly on
congested or low-bandwidth connections. WebP encodes the same photo at a
fraction of the bytes with no perceptible quality loss, so we ship a `.webp`
alongside each `.png` and the runtime prefers it (falling back to the PNG on
the rare browser without WebP support — see js/characters.js + js/main.js).

What this does per photo:
  1. Downscale so the long edge is at most MAX_EDGE px. The photo frame tops
     out at 480px tall (≈640px wide), so even at a 2.5× retina cap there's no
     visible detail to gain from the multi-thousand-pixel originals — only
     bytes to lose. Images already under the cap are left at native size.
  2. Re-encode to WebP at QUALITY (method 6 = slowest/smallest). Alpha is
     preserved so transparent-corner photos still composite cleanly over the
     dark frame.

The originals stay in assets/photos/ as the fallback and the source of truth;
this script only ever writes the matching `.webp`. It's idempotent — a webp
that's already newer than its png is skipped — so it's safe to re-run after
adding new photos.

Usage:  python3 scripts/optimize_photos.py
Requires Pillow with WebP support (`pip install Pillow`).
"""

from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
PHOTO_DIR = REPO_ROOT / "assets" / "photos"

# Long-edge ceiling. The 4:3 frame renders at most ~640×480 CSS px; 1600 keeps
# a comfortable retina margin while still shrinking the 2000–3000px sources.
MAX_EDGE = 1600
# Visually lossless for photographic content; well below this starts to show
# ringing on the flat cartoon colour fields the game cares about.
QUALITY = 82


def optimize(png_path: Path) -> tuple[int, int] | None:
    webp_path = png_path.with_suffix(".webp")

    # Idempotent: skip if an up-to-date webp already exists.
    if webp_path.exists() and webp_path.stat().st_mtime >= png_path.stat().st_mtime:
        return None

    img = Image.open(png_path)
    # Normalize to a mode WebP can encode directly while keeping any alpha.
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")

    w, h = img.size
    long_edge = max(w, h)
    if long_edge > MAX_EDGE:
        scale = MAX_EDGE / long_edge
        img = img.resize(
            (round(w * scale), round(h * scale)),
            Image.LANCZOS,
        )

    img.save(webp_path, "WEBP", quality=QUALITY, method=6)
    return png_path.stat().st_size, webp_path.stat().st_size


def main() -> None:
    pngs = sorted(PHOTO_DIR.glob("*.png"))
    if not pngs:
        print(f"No PNGs found in {PHOTO_DIR}")
        return

    before_total = after_total = 0
    written = skipped = 0
    for png in pngs:
        result = optimize(png)
        if result is None:
            skipped += 1
            # Still count its size so the totals reflect the whole shipped set.
            before_total += png.stat().st_size
            after_total += png.with_suffix(".webp").stat().st_size
            continue
        before, after = result
        before_total += before
        after_total += after
        written += 1
        print(
            f"  {png.name:<32} {before/1e6:6.2f}MB -> "
            f"{after/1e6:5.2f}MB  ({100 * (1 - after / before):4.1f}% smaller)"
        )

    saved = before_total - after_total
    print(
        f"\n{written} encoded, {skipped} up-to-date. "
        f"PNG {before_total/1e6:.1f}MB -> WebP {after_total/1e6:.1f}MB "
        f"({100 * saved / before_total:.1f}% smaller, {saved/1e6:.1f}MB saved)."
    )


if __name__ == "__main__":
    main()
