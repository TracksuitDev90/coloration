"""Pre-process character source photos into a uniform, high-quality
4:3 frame.

For each source photo we:
  1. Detect the character's bounding box (transparency or color delta from
     a corner-sampled background).
  2. Clip out any printed watermark band on the bottom of the gallery prints.
  3. Add a small breathing-room margin so the figure isn't kissing the edge.
  4. Expand the crop box to a 4:3 aspect ratio centred on the character,
     extending the original image when there's room and only padding with
     the sampled background colour as a last resort.
  5. Save the result at the original (or higher) resolution as a PNG so we
     keep every pixel sharp on retina displays.

The output goes to assets/photos/ and is referenced from characters.json.
The originals stay in assets/ for the record.
"""

from pathlib import Path
from PIL import Image, ImageChops, ImageFilter

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "assets"
OUT_DIR = REPO_ROOT / "assets" / "photos"
OUT_DIR.mkdir(parents=True, exist_ok=True)

TARGET_RATIO = 4 / 3
PADDING_FRAC = 0.12

# Per-image overrides: extra crop on a specific side (in fraction of source
# image dimension) to remove watermarks or empty borders before bbox detection.
PRECROP = {
    "IMG_0384.webp": {"bottom": 0.10},   # Scooby - GalleryPops watermark
    "IMG_0390.webp": {"bottom": 0.08},   # Winnie - GalleryPops watermark
    "IMG_0388.png":  {"left": 0.04, "right": 0.04},  # Sonic - jpeg edge artefacts
    "IMG_0399.jpeg": {"bottom": 0.07},   # Speed Racer - "SPEED RACER" watermark
    "IMG_0446.jpeg": {"bottom": 0.10},   # Stitch - GalleryPops watermark
    # New additions
    "IMG_0489.webp": {"bottom": 0.26, "left": 0.14},  # The Brain - WB watermark
    "IMG_0496.jpeg": {"bottom": 0.05},                 # Charlie Brown - "Alamy" watermark
    "IMG_0447.jpeg": {"bottom": 0.32},                 # Cookie Monster - drop cookies/plate so head fits
    # Him sits small on a wide couch — peel back the empty couch back/sides
    # so he actually fills the 4:3 frame.
    "IMG_0520.webp": {"top": 0.13, "bottom": 0.03, "left": 0.08, "right": 0.08},
    # Boo Boo source has a 1px black border baked into the PNG — strip a
    # thin sliver from each side so the cover-crop doesn't preserve it.
    "IMG_0395.png": {"top": 0.01, "bottom": 0.01, "left": 0.01, "right": 0.01},
    # New Pikachu source - GalleryPops watermark band along the bottom.
    "IMG_0560.webp": {"bottom": 0.14},
    # Genie source is widescreen with thin black letterbox bars top/bottom —
    # strip them so the cover_crop fills the entire 4:3 frame with content.
    "IMG_0468.jpeg": {"top": 0.02, "bottom": 0.02},
    # Anxiety - Inside Out 2 ensemble shot is too wide; pull the sides in so
    # the orange guy is unambiguously the subject instead of one of five
    # emotions in a group photo.
    "IMG_0599.webp": {"left": 0.28, "right": 0.24, "top": 0.0, "bottom": 0.05},
    # Blue / Black Rangers are full-body action poses with legs splayed wide,
    # which shrinks the head + suit emblems in the final 4:3 frame. Trim a
    # chunk off the bottom so the eventual cover_crop centres on the head and
    # torso (priority: waist-up with the full head + suit triangle visible).
    "IMG_0555.webp": {"bottom": 0.40},
    "IMG_0558.webp": {"bottom": 0.40},
    # Aang is gliding across a wide sky shot — pull the sides/sky in so the
    # crop centres on his head and the blue arrow tattoo (the item) instead of
    # the whole hang-glider. Leaves his full head + arrow in frame.
    "IMG_0683.webp": {"left": 0.30, "right": 0.18, "top": 0.04, "bottom": 0.18},
    # Roger Klotz strikes a full-body dance pose; the item is his orange hair.
    # Drop the legs so the framing is head-to-lower-waist. Paired with a
    # Y_ANCHOR of 1.0 below, his waistline sits flush at the bottom of the 4:3
    # frame instead of floating mid-box with the waist clipped off.
    "IMG_0685.webp": {"bottom": 0.40},
}

# Vertical anchor for isolated-subject crops. 0.5 (default) centers the
# subject in the 4:3 frame; 1.0 pins the bottom of the subject's bbox to the
# bottom of the frame so all the slack ends up above the head. Used when a
# character's shirt/feet should sit flush at the frame edge instead of
# floating with bg padding below.
Y_ANCHOR = {
    "IMG_0379.png": 1.0,  # Squidward - anchor shirt bottom to frame bottom
    # Roger Klotz - pin his lower waist to the bottom of the frame so he doesn't
    # float mid-box with the waistline clipped off.
    "IMG_0685.webp": 1.0,
}

# After precrop + cover_crop strategy is selected, shift the centred crop
# window. 0.5 keeps the existing centred behaviour; values <0.5 keep more of
# the top/left, >0.5 keep more of the bottom/right. Used to nudge framing
# when the subject sits off-centre in the source.
COVER_OFFSET = {
    # Keep more of the top so Anxiety's tall flame-shaped hair survives the
    # 4:3 trim after the side-tightening precrop.
    "IMG_0599.webp": {"y": 0.35},
}

# Pad the source with the sampled background colour before any other
# processing. Each value is a fraction of the source dimension to add to
# that side. Useful for "zooming out" on a subject that sits too tight in
# its source crop.
EXPAND = {
}

# Bypass the is_solid_background heuristic and always cover-crop the source.
# Use for full-bleed scene shots whose corners happen to be uniformly
# coloured (eg. Him on a pink couch) — without this they get treated as
# isolated subjects and end up with a coloured pad band around them.
FORCE_COVER = {
    "IMG_0520.webp",  # Him - all four corners pink
    "IMG_0468.jpeg",  # Genie - dark blue scene, fill the 4:3 frame
    # Cartoon scene crops where the subject sits centred against a flat-ish
    # bg. Without FORCE_COVER they'd be detected as isolated subjects, get a
    # tight bbox, then get padded back out to 4:3 with the bg colour — so the
    # subject ends up small inside a wide coloured band. cover_crop instead
    # keeps the source full-bleed and just trims to 4:3.
    "IMG_0395.png",   # Boo Boo - light gray scene
    "IMG_0464.png",   # Fred Flintstone - khaki scene
    "IMG_0438.jpeg",  # Danny Phantom - teal locker scene
    # Brock source is ~2:1 — isolated_subject pads top/bottom with white
    # which leaves Brock floating in a small portion of the 4:3 frame.
    # cover_crop trims the wider source to 4:3 so Brock fills the frame.
    "IMG_0550.webp",  # Brock vest
    # Anxiety - corners are similar teal-ish but the scene is full-bleed;
    # without cover_crop the precropped frame gets padded again.
    "IMG_0599.webp",  # Anxiety
    # Power Ranger sources: after the bottom precrop they're wider than 4:3,
    # so cover_crop just trims the sides to land a tight upper-body framing
    # instead of padding back out to a wide frame around a small subject.
    "IMG_0555.webp",  # Blue Ranger
    "IMG_0558.webp",  # Black Ranger
    # Shrek source is 16:9 with hands stretched to the edges — isolated path
    # pads back out to 4:3 with white space above/below. cover_crop fills the
    # whole frame; the trade-off is the outer edge of each hand gets clipped.
    "IMG_0378.jpeg",  # Shrek
    # Aang - sky/wing scene; after the side precrop it's still a full-bleed
    # scene, so cover_crop trims to 4:3 around his head + arrow.
    "IMG_0683.webp",  # Aang's arrow
}

# Per-image override of the bbox padding fraction used by isolated_subject.
# Default is PADDING_FRAC; lowering it lets a tall, headshot-style subject
# fill more of the eventual 4:3 frame instead of getting a sash of bg colour
# above and below.
PADDING_OVERRIDE = {
    "IMG_0385.jpeg": 0.01,  # Kermit - tighten so he fills the frame vertically
}

# Mapping of every character/item ID to its source file. Character entries
# come from characters.json (full-body, played as 5x5 grid). Item entries
# come from items.json (scene + specific item, played as 4-swatch quad).
ASSIGNMENTS = {
    # ---- Characters (grid mode) ----
    "spongebob-squarepants": "IMG_0359.webp",
    "pikachu":               "IMG_0560.webp",
    "garfield":              "IMG_0363.jpeg",
    "grimace":               "IMG_0366.webp",
    "tweety":                "IMG_0368.png",
    "mr-krabs":              "IMG_0371.png",
    "crash-bandicoot":       "IMG_0502.webp",
    "bugs-bunny":            "IMG_0373.png",
    "squirtle":              "IMG_0374.webp",
    "smurfs":                "IMG_0375.png",
    "charizard":             "IMG_0376.webp",
    "barney":                "IMG_0377.jpeg",
    "shrek":                 "IMG_0378.jpeg",
    "squidward":             "IMG_0379.png",
    "elmo":                  "IMG_0380.jpeg",
    "patrick-star":          "IMG_0381.jpeg",
    "yoshi":                 "IMG_0383.png",
    "scooby-doo":            "IMG_0384.webp",
    "kermit":                "IMG_0385.jpeg",
    "sonic":                 "IMG_0388.png",
    "sulley":                "IMG_0389.webp",
    "winnie-the-pooh":       "IMG_0390.webp",
    "tigger":                "IMG_0392.png",
    "kirby":                 "IMG_0393.png",
    # ---- Items (quad mode), 60s/90s cartoons ----
    "yogi-bears-tie":         "IMG_0394.png",
    "boo-boos-bowtie":        "IMG_0395.png",
    "snagglepuss-fur":        "IMG_0396.jpeg",
    "magilla-gorilla-bowtie": "IMG_0397.png",
    "speed-racer-emblem":     "IMG_0399.jpeg",
    "penelope-pitstop-suit":  "IMG_0400.png",
    "shaggy-shirt":           "IMG_0402.jpeg",
    "velma-sweater":          "IMG_0403.png",
    "daphne-dress":           "IMG_0404.png",
    "arnolds-hat":            "IMG_0405.webp",
    "helga-bow":              "IMG_0406.jpeg",
    "tommy-pickles-shirt":    "IMG_0407.jpeg",
    "chuckie-hair":           "IMG_0409.png",
    "doug-funnie-sweater":    "IMG_0410.webp",
    "daria-jacket":           "IMG_0411.webp",
    "dexter-gloves":          "IMG_0412.jpeg",
    "dee-dee-tutu":           "IMG_0413.webp",
    "eddy-shirt":             "IMG_0414.jpeg",
    "johnny-bravo-shirt":     "IMG_0415.jpeg",
    "blossom-bow":            "IMG_0416.jpeg",
    "buttercup-dress":        "IMG_0417.png",
    "stimpy-body":            "IMG_0418.webp",
    "heffer-hair":            "IMG_0419.jpeg",
    "reggie-shirt":           "IMG_0420.jpeg",
    # ---- Items (quad mode), 2000s cartoons ----
    "nigel-hair":             "IMG_0456.jpeg",
    "darkwing-mask":          "IMG_0458.png",
    "lois-shirt":             "IMG_0460.png",
    "fred-flintstone-shirt":  "IMG_0464.png",
    "johnny-quest-hair":      "IMG_0465.webp",
    "captain-planet-hair":    "IMG_0466.jpeg",
    "muriel-apron":           "IMG_0422.jpeg",
    "mac-shirt":              "IMG_0424.jpeg",
    "dora-shirt":             "IMG_0425.jpeg",
    "boots-stomach":          "IMG_0426.jpeg",
    "cosmo-mom-hair":         "IMG_0427.jpeg",
    "timmy-turner-hat":       "IMG_0428.webp",
    "aang-arrow":             "IMG_0683.webp",
    "inspector-gadget-coat":  "IMG_0430.jpeg",
    "arthur-sweater":         "IMG_0431.webp",
    "ferb-hair":              "IMG_0432.jpeg",
    "phineas-hair":           "IMG_0433.jpeg",
    "kim-possible-hair":      "IMG_0434.jpeg",
    "numbuh-1-shirt":         "IMG_0435.webp",
    "numbuh-4-hoodie":        "IMG_0436.webp",
    "krumm-lips":             "IMG_0437.webp",
    "danny-phantom-eyes":     "IMG_0438.jpeg",
    # Scooby collar reuses the same source as the full-body Scooby photo.
    "scooby-doo-collar":      "IMG_0384.webp",
    # ---- Items (quad mode), more cartoons ----
    "brock-vest":             "IMG_0550.webp",
    "catdog-nose":            "IMG_0443.webp",
    "finn-hair":              "IMG_0444.jpeg",
    "mabel-shirt":            "IMG_0455.webp",
    # ---- Characters (grid mode), additional ----
    "stitch":                 "IMG_0446.jpeg",
    "cookie-monster":         "IMG_0447.jpeg",
    "beast-boy":              "IMG_0448.jpeg",
    "homer-simpson":          "IMG_0449.webp",
    "jigglypuff":             "IMG_0562.png",
    "jenny-xj9":              "IMG_0451.webp",
    "pink-panther":           "IMG_0523.webp",
    "slimer":                 "IMG_0453.jpeg",
    "perry-the-platypus":     "IMG_0454.jpeg",
    "him":                    "IMG_0520.webp",
    "ice-king":               "IMG_0510.jpeg",
    "blue-ranger":            "IMG_0555.webp",
    "genie":                  "IMG_0468.jpeg",
    "rocko":                  "IMG_0469.webp",
    "ursula":                 "IMG_0475.jpeg",
    "flounder":               "IMG_0476.webp",
    # ---- Items (quad mode), Disney additions ----
    "vanellope-hoodie":         "IMG_0471.jpeg",
    "snow-white-dress-lower":   "IMG_0472.webp",
    "jessica-rabbit-hair":      "IMG_0521.webp",
    "dr-facilier-vest":         "IMG_0474.webp",
    # ---- Newest additions ----
    "mystery-machine-text":     "IMG_0477.jpeg",
    "mojo-jojo":                "IMG_0479.webp",
    "piccolo-cape":             "IMG_0480.webp",
    "jake-the-dog":             "IMG_0481.png",
    "mandy-flower":             "IMG_0482.jpeg",
    "red-guy":                  "IMG_0485.webp",
    "courage":                  "IMG_0486.webp",
    "heathcliff":               "IMG_0530.webp",
    "the-brain":                "IMG_0489.webp",
    "bloo":                     "IMG_0508.webp",
    "the-mask":                 "IMG_0507.jpeg",
    "jerry":                    "IMG_0505.png",
    "charlie-brown-shirt":      "IMG_0496.jpeg",
    "pluto":                    "IMG_0498.webp",
    "strawberry-shortcake-hat": "IMG_0499.jpeg",
    "muscle-man":               "IMG_0500.webp",
    "amethyst":                 "IMG_0501.webp",
    "green-ranger":             "IMG_0557.webp",
    "black-ranger":             "IMG_0558.webp",
    "george-jetsons-belt":      "IMG_0527.webp",
    "astro":                    "IMG_0529.webp",
    # ---- Latest additions ----
    "bobby-hill-shirt":         "IMG_0531.jpeg",
    "kyle-hair":                "IMG_0532.webp",
    "sharingan":                "IMG_0534.webp",
    "leela-hair":               "IMG_0537.jpeg",
    "family-guy-stationwagon":  "IMG_0539.png",
    "chopper":                  "IMG_0541.png",
    "zoro-hair":                "IMG_0544.png",
    "ed-bighead":               "IMG_0545.png",
    "dr-zoidberg":              "IMG_0536.webp",
    # ---- New items / characters ----
    "didi-glasses":             "IMG_0584.png",
    "phoebe-sweater":           "IMG_0588.png",
    "vince-jersey":             "IMG_0590.png",
    "chowder":                  "IMG_0591.webp",
    "lumpy-space-princess":     "IMG_0596.png",
    "doraemon":                 "IMG_0598.webp",
    "anxiety":                  "IMG_0599.webp",
    "darwin":                   "IMG_0600.webp",
    "donatello-mask":           "IMG_0602.webp",
    # ---- Newer additions ----
    "mushu":                    "IMG_0610.webp",
    "aladdin-vest":             "IMG_0614.webp",
    "zim":                      "IMG_0616.webp",
    "lard-lad-donut":           "IMG_0618.webp",
    "skeeter-valentine":        "IMG_0620.webp",
    "share-bear":               "IMG_0622.webp",
    "doc-hudson":               "IMG_0623.webp",
    "russell-neckerchief":      "IMG_0626.webp",
    # ---- Latest characters ----
    "peter-potamus":            "IMG_0628.webp",
    "huckleberry-hound":        "IMG_0629.jpeg",
    "nidoking":                 "IMG_0632.webp",
    # ---- Codename: Kids Next Door additions ----
    "numbuh-3-sweater":         "IMG_0659.webp",
    "numbuh-5-hat":             "IMG_0657.webp",
    # ---- Newest item additions ----
    "barney-rubble-shirt":      "IMG_0681.webp",
    "roger-klotz-hair":         "IMG_0685.webp",
    "fred-jones-ascot":         "IMG_0687.webp",
    "dick-dastardly-coat":      "IMG_0689.webp",
    "jade-hoodie":              "IMG_0691.webp",
    "penny-proud-cardigan":     "IMG_0693.webp",
    "dw-dress":                 "IMG_0694.png",
    # ---- Newest item additions ----
    "tj-detweiler-jacket":      "IMG_0696.webp",
    "buster-bunny-shirt":       "IMG_0701.webp",
    "billy-shirt-stripe":       "IMG_0702.webp",
    "butters-jacket":           "IMG_0704.webp",
    "freakazoid-suit":          "IMG_0705.webp",
}


def sample_bg(img):
    """Estimate background colour from the four corners. Treats fully or
    mostly transparent corners as white so we don't end up with black bands
    around isolated PNG characters."""
    w, h = img.size
    pts = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    samples = []
    for p in pts:
        px = img.getpixel(p)
        if isinstance(px, tuple):
            if len(px) == 4:
                r, g, b, a = px
                if a < 32:
                    samples.append((255, 255, 255))
                else:
                    samples.append((r, g, b))
            else:
                samples.append(px[:3])
        else:
            samples.append((px, px, px))
    avg = tuple(sum(c[i] for c in samples) // len(samples) for i in range(3))
    return avg


def find_content_bbox(img):
    """Return the bounding box of the foreground content."""
    if img.mode == "RGBA":
        alpha = img.split()[-1]
        # If the alpha is essentially all opaque, the alpha mask covers the
        # whole frame and tells us nothing useful — fall through to the
        # color-difference path so a flat-bg PNG with no real transparency
        # gets the same tight bbox as a JPEG would.
        if alpha.getextrema()[0] >= 250:
            pass
        else:
            # Ignore stray near-transparent pixels — they trip the bbox up
            # on PNG exports that have anti-aliased edges fading to alpha 1.
            mask = alpha.point(lambda v: 255 if v > 60 else 0)
            bbox = mask.getbbox()
            if bbox is not None:
                return bbox
            return alpha.getbbox() or (0, 0, *img.size)

    rgb = img.convert("RGB")
    bg = sample_bg(rgb)
    bg_img = Image.new("RGB", rgb.size, bg)
    diff = ImageChops.difference(rgb, bg_img).convert("L")
    # Some prints (Gallery Pops in particular) have a faint grey border at
    # ~211 on a 255 white field — diff ~44. Anything below 70 we treat as
    # noise/border and drop. If that erases everything fall back to a
    # gentler threshold so we still find soft-shaded subjects.
    for thresh in (70, 40, 16):
        mask = diff.point(lambda v: 255 if v > thresh else 0)
        bbox = mask.getbbox()
        if bbox is None:
            continue
        bw = bbox[2] - bbox[0]
        bh = bbox[3] - bbox[1]
        # Skip a bbox that's effectively the whole frame — that means we
        # caught a print border. Try a stricter threshold.
        if bw > rgb.size[0] * 0.97 and bh > rgb.size[1] * 0.97 and thresh > 16:
            continue
        return bbox
    return (0, 0, *rgb.size)


def precrop(img, name):
    if name not in PRECROP:
        return img
    w, h = img.size
    spec = PRECROP[name]
    left = int(w * spec.get("left", 0))
    top = int(h * spec.get("top", 0))
    right = w - int(w * spec.get("right", 0))
    bottom = h - int(h * spec.get("bottom", 0))
    return img.crop((left, top, right, bottom))


def expand_to_aspect(bbox, ratio, y_anchor=0.5):
    """Pad the bbox out to the target aspect ratio. We always grow rather
    than crop into the subject so the character keeps its head and feet.
    Returns the padded bbox in a virtual coordinate space; callers pad with
    the background colour for any part that falls outside the source.

    `y_anchor` controls where the original bbox sits within the expanded
    height: 0.5 splits the new vertical space evenly above and below
    (centered), 1.0 puts it all above (subject pinned to the bottom of the
    expanded frame), 0.0 puts it all below."""
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0, y1 - y0
    cur = bw / bh

    if cur < ratio:
        target_w = bh * ratio
        extra = target_w - bw
        x0 -= extra / 2
        x1 += extra / 2
    else:
        target_h = bw / ratio
        extra = target_h - bh
        y0 -= extra * y_anchor
        y1 += extra * (1 - y_anchor)

    return (round(x0), round(y0), round(x1), round(y1))


def isolated_subject_to_4_3(img, padding_frac=PADDING_FRAC, y_anchor=0.5):
    """Tightly crop a flat-background subject to its bbox + a small
    breathing margin, then pad with the bg colour out to 4:3. When
    `y_anchor=1.0` the bbox is anchored to the bottom of the 4:3 frame
    (no breathing room below the subject), so callers can pin a
    shirt/feet edge to the frame edge."""
    w, h = img.size
    bbox = find_content_bbox(img)
    bx0, by0, bx1, by1 = bbox
    bw, bh = bx1 - bx0, by1 - by0

    pad_x = bw * padding_frac
    pad_y_top = bh * padding_frac
    pad_y_bottom = 0 if y_anchor >= 0.999 else bh * padding_frac
    bbox = (bx0 - pad_x, by0 - pad_y_top, bx1 + pad_x, by1 + pad_y_bottom)

    target = expand_to_aspect(bbox, TARGET_RATIO, y_anchor=y_anchor)
    tx0, ty0, tx1, ty1 = target
    target_w = tx1 - tx0
    target_h = ty1 - ty0

    base = img if img.mode == "RGBA" else img.convert("RGB")
    bg = sample_bg(base)
    # JPEG export often dulls a "white" background to ~225,225,225. If the
    # bg is in that near-white range, snap to pure white so the padded
    # frame doesn't read as a faint grey border.
    if min(bg) > 210 and max(bg) - min(bg) < 8:
        bg = (255, 255, 255)

    canvas = Image.new("RGB", (target_w, target_h), bg)

    sx0 = max(0, tx0)
    sy0 = max(0, ty0)
    sx1 = min(w, tx1)
    sy1 = min(h, ty1)
    if sx1 > sx0 and sy1 > sy0:
        region = base.crop((sx0, sy0, sx1, sy1))
        if region.mode == "RGBA":
            bg_layer = Image.new("RGB", region.size, bg)
            bg_layer.paste(region, mask=region.split()[-1])
            region = bg_layer
        else:
            region = region.convert("RGB")
        canvas.paste(region, (sx0 - tx0, sy0 - ty0))
    return canvas


def is_solid_background(img):
    """Heuristic: a photo of an isolated character on a flat colour or
    transparent background has corners that all look similar (or are all
    transparent). Real photographs of costumes or scenes have wildly
    different corner colours — we cover-crop those instead."""
    w, h = img.size
    pts = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    rgba = img.convert("RGBA")
    samples = []
    for p in pts:
        r, g, b, a = rgba.getpixel(p)
        if a < 32:
            samples.append((255, 255, 255))
        else:
            samples.append((r, g, b))
    # Per-channel max-min spread. If every channel stays within 25 levels
    # across all four corners, treat it as a solid bg.
    spread = max(
        max(s[c] for s in samples) - min(s[c] for s in samples)
        for c in range(3)
    )
    return spread <= 25


def cover_crop(img, ratio, x_shift=0.5, y_shift=0.5):
    """Crop the source to the target aspect ratio.

    `x_shift` / `y_shift` move the crop window: 0.5 keeps it centred,
    smaller values keep more of the top / left, larger values keep more of
    the bottom / right. Used for full-bleed photographs where the subject
    sits off-centre."""
    w, h = img.size
    cur = w / h
    if abs(cur - ratio) < 1e-3:
        cropped = img
    elif cur > ratio:
        new_w = round(h * ratio)
        x0 = int(round((w - new_w) * x_shift))
        cropped = img.crop((x0, 0, x0 + new_w, h))
    else:
        new_h = round(w / ratio)
        y0 = int(round((h - new_h) * y_shift))
        cropped = img.crop((0, y0, w, y0 + new_h))
    # Flatten transparency over the sampled bg colour. A direct .convert("RGB")
    # would render alpha=0 pixels as black, which leaves a black halo around
    # cut-out subjects (e.g. the Blue Ranger PNG where one opaque corner
    # disqualifies it from the isolated-subject path).
    if cropped.mode == "RGBA":
        bg = sample_bg(cropped)
        bg_layer = Image.new("RGB", cropped.size, bg)
        bg_layer.paste(cropped, mask=cropped.split()[-1])
        return bg_layer
    return cropped.convert("RGB")


def expand_with_bg(img, name):
    """Add a coloured border to each side of the source so the eventual
    crop has more breathing room around the subject. The border colour is
    sampled from the existing image corners so it blends in."""
    if name not in EXPAND:
        return img
    spec = EXPAND[name]
    w, h = img.size
    left = int(w * spec.get("left", 0))
    right = int(w * spec.get("right", 0))
    top = int(h * spec.get("top", 0))
    bottom = int(h * spec.get("bottom", 0))
    if not (left or right or top or bottom):
        return img
    bg = sample_bg(img if img.mode != "P" else img.convert("RGB"))
    new_w = w + left + right
    new_h = h + top + bottom
    if img.mode == "RGBA":
        canvas = Image.new("RGB", (new_w, new_h), bg)
        bg_layer = Image.new("RGB", img.size, bg)
        bg_layer.paste(img, mask=img.split()[-1])
        canvas.paste(bg_layer, (left, top))
        return canvas
    canvas = Image.new("RGB", (new_w, new_h), bg)
    canvas.paste(img.convert("RGB"), (left, top))
    return canvas


def process(src_path, dst_path):
    img = Image.open(src_path)
    if img.mode not in ("RGB", "RGBA"):
        # Palette PNGs can carry transparency as a tRNS chunk rather than an
        # alpha band ("transparency" in info). Convert those to RGBA too, or
        # the cut-out background gets baked in as the palette's (often non-
        # white) fill colour instead of being treated as transparent.
        has_alpha = "A" in img.getbands() or "transparency" in img.info
        img = img.convert("RGBA" if has_alpha else "RGB")

    img = expand_with_bg(img, src_path.name)
    img = precrop(img, src_path.name)

    use_cover = src_path.name in FORCE_COVER or not is_solid_background(img)
    if use_cover:
        offset = COVER_OFFSET.get(src_path.name, {})
        cropped = cover_crop(
            img,
            TARGET_RATIO,
            x_shift=offset.get("x", 0.5),
            y_shift=offset.get("y", 0.5),
        )
    else:
        cropped = isolated_subject_to_4_3(
            img,
            padding_frac=PADDING_OVERRIDE.get(src_path.name, PADDING_FRAC),
            y_anchor=Y_ANCHOR.get(src_path.name, 0.5),
        )

    # Cap at a sensible maximum so retina screens stay sharp without
    # shipping huge PNGs to phones. 3000 covers DPR 3 phones/tablets at the
    # photo's hero size without bloating bytes for typical sources.
    MAX_W = 3000
    if cropped.width > MAX_W:
        new_h = round(cropped.height * MAX_W / cropped.width)
        cropped = cropped.resize((MAX_W, new_h), Image.LANCZOS)

    # Lanczos resampling slightly softens edges; a light unsharp mask
    # restores crispness on outlines/eyes/text without producing visible
    # halos. Tuned conservatively — radius 1 / 80% / threshold 2 keeps
    # smooth gradient regions untouched.
    cropped = cropped.filter(
        ImageFilter.UnsharpMask(radius=1.0, percent=80, threshold=2)
    )

    cropped.save(dst_path, format="PNG", optimize=True)
    return cropped.size


def main():
    for cid, src_name in ASSIGNMENTS.items():
        src = SRC_DIR / src_name
        if not src.exists():
            print(f"MISSING source for {cid}: {src_name}")
            continue
        dst = OUT_DIR / f"{cid}.png"
        size = process(src, dst)
        print(f"{cid:24s} {src_name} -> photos/{dst.name} {size[0]}x{size[1]}")


if __name__ == "__main__":
    main()
