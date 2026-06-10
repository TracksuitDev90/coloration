// Shade-grid generator. Builds a 5x5 (or arbitrary) board of shades around
// a correct hex color, laid out as a fully ordered 2D gradient:
//
//   rows    — lightness, monotonic: palest at the top, deepest at the bottom
//   columns — vividness/warmth, monotonic: muted/cool on the left,
//             vivid/warm on the right
//
// The correct cell hides somewhere inside that ordered field (its position
// rotates daily, see daily.js). Because the board is ordered, every guess
// teaches the player something — "too dark and too dull" means move up and
// right — so the game plays as navigation rather than lucky taps.
//
// The grid is generated in OKLab/OKLCH (perceptually uniform) so neighbor
// difficulty is consistent across hues — a chroma step on Tweety yellow
// looks about as different as the same step on a dusty pink.
//
// Two competing constraints shape the ramps:
//   - cells must stay distinguishable (a ΔE floor between neighbors), and
//   - the correct cell must NOT stick out — its steps to its own neighbors
//     have to look like every other step on the board (asymmetry cap +
//     sore-thumb validation below).
//
// Decoys stay inside the same color family: the hue sweep is capped at a
// fraction of the hue-specific JND and chroma is floored, so no green
// Pikachu and no purple Shrek.

// --- Legacy HSL helpers (still used by quad.js and daily.js) ------------

export function hexToHsl(hex) {
  const m = hex.replace('#', '');
  const n = m.length === 3
    ? m.split('').map(c => c + c).join('')
    : m;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToHex(h, s, l) {
  const sat = clamp(s, 0, 100) / 100;
  const lig = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hh = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs(hh % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lig - c / 2;
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// --- OKLab / OKLCH utilities --------------------------------------------
// Reference: Björn Ottosson, https://bottosson.github.io/posts/oklab/

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToLinearRgb(hex) {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  return [
    srgbToLinear(parseInt(n.slice(0, 2), 16) / 255),
    srgbToLinear(parseInt(n.slice(2, 4), 16) / 255),
    srgbToLinear(parseInt(n.slice(4, 6), 16) / 255),
  ];
}

function linearRgbToOklab([r, g, b]) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function oklabToLinearRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

export function oklchFromHex(hex) {
  const [L, a, b] = linearRgbToOklab(hexToLinearRgb(hex));
  const C = Math.sqrt(a * a + b * b);
  let H = Math.atan2(b, a) * 180 / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

function inGamut(L, C, H) {
  const hRad = H * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const [lr, lg, lb] = oklabToLinearRgb([L, a, b]);
  return lr >= 0 && lr <= 1 && lg >= 0 && lg <= 1 && lb >= 0 && lb <= 1;
}

// Binary-search the highest chroma at this (L, H) that stays inside sRGB.
function maxChromaAt(L, H) {
  let lo = 0, hi = 0.45;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, H)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Convert OKLCH back to an sRGB hex. If the requested chroma is outside
// gamut at this (L, H), reduce chroma toward the gamut boundary (preserving
// L and H — chroma is the dimension we're willing to compromise).
export function hexFromOklch(L, C, H) {
  let chroma = Math.max(0, C);
  if (!inGamut(L, chroma, H)) {
    chroma = maxChromaAt(L, H);
  }
  const hRad = H * Math.PI / 180;
  const a = chroma * Math.cos(hRad);
  const b = chroma * Math.sin(hRad);
  return linearRgbToHex(oklabToLinearRgb([L, a, b]).map(v => clamp(v, 0, 1)));
}

function linearRgbToHex([lr, lg, lb]) {
  const to = v => {
    const s = linearToSrgb(clamp(v, 0, 1));
    return Math.round(s * 255).toString(16).padStart(2, '0');
  };
  return `#${to(lr)}${to(lg)}${to(lb)}`.toUpperCase();
}

// --- Seeded PRNG --------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// --- Grid generation ----------------------------------------------------

// OKLab is perceptually uniform on average but human vision is hue-anisotropic:
// a 0.035 lightness step on a yellow doesn't read the same as on a deep blue,
// and 8° of hue shift is invisible on a saturated red but reads as "different
// color" on a pale yellow. The JND_TABLE assigns hue-specific step sizes so
// difficulty stays roughly constant across characters. Values are interpolated
// linearly between bins on the OKLCH hue circle.
const JND_TABLE = [
  { h:   0, stepL: 0.035, stepC: 0.027, stepH: 9 },  // red — wider chroma sweep
  { h:  30, stepL: 0.035, stepC: 0.025, stepH: 8 },  // red-orange
  { h:  60, stepL: 0.037, stepC: 0.022, stepH: 7 },  // orange
  { h:  90, stepL: 0.040, stepC: 0.022, stepH: 5 },  // yellow — hue invisible, lean on L
  { h: 120, stepL: 0.038, stepC: 0.022, stepH: 6 },  // yellow-green
  { h: 150, stepL: 0.035, stepC: 0.022, stepH: 8 },  // green
  { h: 180, stepL: 0.033, stepC: 0.022, stepH: 9 },  // cyan
  { h: 210, stepL: 0.033, stepC: 0.022, stepH: 9 },  // sky
  { h: 240, stepL: 0.033, stepC: 0.023, stepH: 10 }, // blue
  { h: 270, stepL: 0.033, stepC: 0.022, stepH: 10 }, // violet
  { h: 300, stepL: 0.034, stepC: 0.024, stepH: 9 },  // magenta
  { h: 330, stepL: 0.035, stepC: 0.025, stepH: 9 },  // pink
];

// Per-gap jitter on the ramps (±10%) so consecutive rounds don't reuse the
// exact same gradient magnitudes. Applied to gap sizes only — never to the
// ordering — so monotonicity is preserved by construction.
const GAP_JITTER_LO = 0.9;
const GAP_JITTER_HI = 1.1;

// Neutrals (chroma below this) have no chroma family to ramp through, so
// their column axis becomes a literal temperature ramp: a cool (bluish)
// cast left of the answer, a warm (amber) cast right of it. That's how
// designers make gray palettes readable, and it keeps the "muted/cool →
// vivid/warm" column story true even for grays.
const NEUTRAL_CHROMA_THRESHOLD = 0.03;
const NEUTRAL_COOL_HUE = 250;
const NEUTRAL_WARM_HUE = 55;
const NEUTRAL_TEMP_STEP = 0.016;
const NEUTRAL_TEMP_MAX = 0.05;

// Low-chroma (but not fully neutral) colors — browns, dusty pastels — get a
// wider forced spread. They can't drift out of their family no matter how
// far the ramp walks, so bigger steps are pure clarity with no risk.
const LOW_CHROMA_THRESHOLD = 0.09;

// Lightness bounds. The floor is well above OKLab's black point: below
// L ≈ 0.14 the sRGB gamut collapses to a handful of near-black pixels, so
// ramp steps and dedup nudges all quantize onto the same hex down there.
// Keeping cells out of that dead zone matters more than reaching pure black
// — the feasibility snap pins very dark answers near the bottom rows
// instead.
const L_MIN = 0.14;
const L_MAX = 0.95;

// Smallest acceptable lightness gap between adjacent rows (≈ 2.2 ΔE). Used
// both to size ramps and to decide which answer rows are feasible for a
// given base color (see snapToFeasible).
const STEP_L_FLOOR = 0.022;

// "No sore thumb" guard: the steps on either side of the answer row/column
// may differ (a pale character has little room above), but never by more
// than this ratio — a visible kink in the gradient at the answer's row
// would give the position away.
const STEP_RATIO_CAP = 2.5;

// Constant per-column lightness tilt. This is the structural guarantee that
// columns stay distinguishable even when the chroma ramp collapses (palest
// row of a vivid character, neutral grays): every column carries its own
// small L offset. Constant per column, so each column remains strictly
// monotonic in L down the rows. The inflate cap lets the retry loop lean on
// the tilt when chroma and hue have no room left (saturated yellows at the
// gamut ceiling).
const TILT_STEP = 0.008;
const TILT_INFLATE_CAP = 4;

// Column hue sweep: rotated toward the warm pole on the right, away on the
// left, at a fraction of the hue JND per column and hard-capped so the
// vivid columns never leave the answer's color family.
const WARM_POLE_HUE = 70;
const COL_HUE_FACTOR = 0.6;
const COL_HUE_SWEEP_CAP = 1.5;

// Column chroma ramp works in chroma-fraction space (C / maxChromaAt) so the
// ramp survives gamut variation across rows. The floor keeps decoys in the
// same family (a saturated red never fades to gray); the ceiling stops short
// of the gamut edge where everything clips to the same color.
const F_FLOOR_OF_BASE = 0.30;
const F_FLOOR_MIN = 0.04;
const F_CEIL = 0.97;

// ΔE invariants enforced on every generated grid. Values are on the
// conventional ΔE scale where ~2 is a just-noticeable difference.
//
// An ordered grid only needs its *neighbors* distinguishable (the whole
// board legitimately spans 20-30 ΔE corner to corner — the corners ARE the
// pale/deep/vivid/muted family variants), so the strong floor applies to
// adjacent pairs and a weak floor to all pairs. Low-chroma boards get a
// raised adjacent floor — neutrals can't leave their family, so a wider
// spread is pure clarity and prevents "every shade looks the same".
const DELTA_E_ADJACENT_MIN = 2.0;
const DELTA_E_ADJACENT_MIN_LOW_CHROMA = 2.8;
const DELTA_E_ANY_MIN = 1.0;

// Sore-thumb guard: each of the answer's 4-neighbors must sit within
// NEIGHBOR_MAX_RATIO × the adjacent floor — the steps around the answer
// must not be wildly bigger than steps elsewhere. (The relative kink at
// the answer is bounded separately by STEP_RATIO_CAP in the ramps.)
const NEIGHBOR_MAX_RATIO = 3.2;

const MAX_ATTEMPTS = 8;
const INFLATE_PER_ATTEMPT = 1.25;

// Linearly interpolate hue-specific JND steps for the given OKLCH base.
function jndStepsFor({ H }) {
  const hue = ((H % 360) + 360) % 360;
  const bin = 360 / JND_TABLE.length;
  const i = Math.floor(hue / bin);
  const next = (i + 1) % JND_TABLE.length;
  const t = (hue - i * bin) / bin;
  const a = JND_TABLE[i];
  const b = JND_TABLE[next];
  return {
    stepL: a.stepL + (b.stepL - a.stepL) * t,
    stepC: a.stepC + (b.stepC - a.stepC) * t,
    stepH: a.stepH + (b.stepH - a.stepH) * t,
  };
}

// Euclidean distance in OKLab, scaled by 100 to land on the conventional
// ΔE axis (~2 = just noticeable). Exported for the verify scripts.
export function deltaE(hex1, hex2) {
  const [L1, a1, b1] = linearRgbToOklab(hexToLinearRgb(hex1));
  const [L2, a2, b2] = linearRgbToOklab(hexToLinearRgb(hex2));
  const dL = L1 - L2;
  const da = a1 - a2;
  const db = b1 - b2;
  return Math.sqrt(dL * dL + da * da + db * db) * 100;
}

// For pale or low-chroma colors the ramp is allowed (and encouraged) to
// span a much wider slice of the family — "other shades of brown" rather
// than "other near-identical tans". Boost the lightness step so the first
// attempt already produces a visible spread.
function lowChromaBoostFor(C) {
  if (C < 0.05) return 1.8;
  if (C < 0.08) return 1.5;
  if (C < 0.12) return 1.2;
  return 1.0;
}

function adjacentFloorFor(base) {
  // The raised floor is for mid-lightness browns and grays, where the whole
  // family is available to spread through. Pale pastels and very dark muted
  // colors are ALSO low-chroma but sit against the gamut edge — demanding
  // the wide spread there just leaves the retry loop chasing an impossible
  // target.
  const midL = base.L >= 0.35 && base.L <= 0.80;
  return base.C < LOW_CHROMA_THRESHOLD && midL
    ? DELTA_E_ADJACENT_MIN_LOW_CHROMA
    : DELTA_E_ADJACENT_MIN;
}

// The daily rotation can force the answer onto any cell, but a near-white
// character has no room for paler rows above it (and a near-black none
// below). Snap the forced index to the nearest feasible one — the largest
// row count that still fits floor-sized lightness gaps in each direction.
// Pure function of the base color, so it stays deterministic and identical
// for every player.
function snapToFeasible(idx, n, roomUp, roomDown, floorStep) {
  const maxAbove = Math.floor(roomUp / floorStep);
  const maxBelow = Math.floor(roomDown / floorStep);
  const lo = Math.max(0, (n - 1) - maxBelow);
  const hi = Math.min(n - 1, maxAbove);
  if (lo > hi) {
    // Pathological color with almost no lightness room at all — pin to the
    // edge with more room rather than failing.
    return roomUp >= roomDown ? Math.min(n - 1, Math.max(0, maxAbove)) : Math.max(0, (n - 1) - Math.max(0, maxBelow));
  }
  return clamp(idx, lo, hi);
}

// Step sizes on either side of the answer index: as close to baseStep as
// the available room allows, never below floorStep when the room can fit
// it. With `capRatio` the two sides are also kept within STEP_RATIO_CAP of
// each other (the row-axis sore-thumb guard). The column axis skips the
// cap: at the gamut edge the vivid side's room is structurally ~zero, and
// capping the muted side to match would flatten the whole chroma ramp —
// the hue sweep + lightness tilt hide the seam, and the sore-thumb
// validation still checks the result.
function fitSteps(baseStep, nNeg, nPos, roomNeg, roomPos, floorStep, capRatio = true) {
  let stepNeg = nNeg > 0 ? Math.min(baseStep, roomNeg / nNeg) : 0;
  let stepPos = nPos > 0 ? Math.min(baseStep, roomPos / nPos) : 0;
  if (floorStep > 0) {
    if (nNeg > 0) stepNeg = Math.max(Math.min(floorStep, roomNeg / nNeg), stepNeg);
    if (nPos > 0) stepPos = Math.max(Math.min(floorStep, roomPos / nPos), stepPos);
  }
  if (capRatio && nNeg > 0 && nPos > 0 && stepNeg > 0 && stepPos > 0) {
    const hi = Math.max(stepNeg, stepPos);
    const lo = Math.min(stepNeg, stepPos);
    if (hi / lo > STEP_RATIO_CAP) {
      if (stepNeg > stepPos) stepNeg = stepPos * STEP_RATIO_CAP;
      else stepPos = stepNeg * STEP_RATIO_CAP;
    }
  }
  return { stepNeg, stepPos };
}

// Per-column lightness tilts. Normally linear: the paler side of the
// answer column points toward the roomier lightness direction, with
// per-side step sizes (each side uses the room it actually has, ratio-
// capped so the kink at the answer column stays invisible). When one side
// has essentially no room (near-white or near-black answers), the tilt
// folds: every column tilts toward the roomy direction, magnitude growing
// with distance from the answer column. Returns the tilt array plus the
// room each lightness direction consumes, so the row ramp can reserve it.
const MIN_TILT = 0.012;
function columnTilts(cols, correctCol, availUp, availDown, inflate) {
  const want = TILT_STEP * Math.min(inflate, TILT_INFLATE_CAP);
  const posCols = cols - 1 - correctCol;
  const negCols = correctCol;
  const maxAbsCol = Math.max(posCols, negCols);
  const dirTilt = availUp >= availDown ? 1 : -1;
  const upCols = dirTilt > 0 ? posCols : negCols;
  const downCols = dirTilt > 0 ? negCols : posCols;
  let stepUp = upCols > 0 ? Math.min(want, Math.max(0, availUp) / upCols) : 0;
  let stepDown = downCols > 0 ? Math.min(want, Math.max(0, availDown) / downCols) : 0;

  // Fold when the cramped side can't carry meaningful movement — both
  // sides walk toward the roomy direction instead of one side sitting
  // nearly flat (a flat side produces duplicate or illegibly-close
  // swatches for gamut-edge answers).
  const tilt = new Array(cols).fill(0);
  if (upCols > 0 && stepUp < MIN_TILT && availDown > availUp) {
    const step = maxAbsCol > 0 ? Math.min(want, Math.max(0, availDown) / maxAbsCol) : 0;
    for (let j = 0; j < cols; j++) tilt[j] = -Math.abs(j - correctCol) * step;
    return { tilt, upExtent: 0, downExtent: step * maxAbsCol };
  }
  if (downCols > 0 && stepDown < MIN_TILT && availUp > availDown) {
    const step = maxAbsCol > 0 ? Math.min(want, Math.max(0, availUp) / maxAbsCol) : 0;
    for (let j = 0; j < cols; j++) tilt[j] = Math.abs(j - correctCol) * step;
    return { tilt, upExtent: step * maxAbsCol, downExtent: 0 };
  }

  // Linear: bound the side asymmetry (sore-thumb guard at the answer col).
  if (stepUp > 0 && stepDown > 0) {
    const hi = Math.max(stepUp, stepDown);
    const lo = Math.min(stepUp, stepDown);
    if (hi / lo > STEP_RATIO_CAP) {
      if (stepUp > stepDown) stepUp = stepDown * STEP_RATIO_CAP;
      else stepDown = stepUp * STEP_RATIO_CAP;
    }
  }
  for (let j = 0; j < cols; j++) {
    const dj = j - correctCol;
    if (dj === 0) continue;
    const paler = (dj > 0) === (dirTilt > 0);
    tilt[j] = (paler ? 1 : -1) * Math.abs(dj) * (paler ? stepUp : stepDown);
  }
  return { tilt, upExtent: stepUp * upCols, downExtent: stepDown * downCols };
}

// Strictly ascending offsets for one axis: 0 at `idx`, negative below it,
// positive above. Gap sizes are jittered (±10%) but ordering never changes,
// so monotonicity holds by construction. Gaps are rescaled down if jitter
// would overflow the available room.
function monotonicOffsets(rng, n, idx, stepNeg, stepPos, roomNeg, roomPos) {
  const gen = (count, step, room) => {
    const gaps = [];
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const g = step * (GAP_JITTER_LO + rng() * (GAP_JITTER_HI - GAP_JITTER_LO));
      gaps.push(g);
      sum += g;
    }
    if (sum > room && sum > 0) {
      const s = room / sum;
      for (let k = 0; k < gaps.length; k++) gaps[k] *= s;
    }
    return gaps;
  };
  const below = gen(idx, stepNeg, roomNeg);
  const above = gen(n - 1 - idx, stepPos, roomPos);
  const offsets = new Array(n).fill(0);
  let acc = 0;
  for (let k = idx - 1; k >= 0; k--) {
    acc += below[idx - 1 - k];
    offsets[k] = -acc;
  }
  acc = 0;
  for (let k = idx + 1; k < n; k++) {
    acc += above[k - idx - 1];
    offsets[k] = acc;
  }
  return offsets;
}

// Single attempt at building a grid. The retry loop in `buildGrid` calls
// this with increasing `inflate` until the ΔE invariants are met. The
// correct-cell position is fixed by `seed` + the feasibility snap (NOT
// mixed with attempt) so the player doesn't see the answer jump position
// between retries on the same round.
function generateGridOnce(correctHex, opts, inflate) {
  const { rows, cols, baseSeed, forcedRow, forcedCol, attempt } = opts;
  const base = oklchFromHex(correctHex);
  // Position RNG uses the stable seed; step/jitter RNG mixes in attempt
  // so each retry produces a genuinely different spread.
  const posRng = mulberry32(baseSeed * 2654435761 + 17);
  const stepRng = mulberry32(baseSeed * 2654435761 + 17 + attempt * 0x9E3779B9);

  let correctRow = Number.isInteger(forcedRow) && forcedRow >= 0 && forcedRow < rows
    ? forcedRow
    : Math.floor(posRng() * rows);
  const correctCol = Number.isInteger(forcedCol) && forcedCol >= 0 && forcedCol < cols
    ? forcedCol
    : Math.floor(posRng() * cols);

  const isNeutral = base.C < NEUTRAL_CHROMA_THRESHOLD;
  // Effective lightness bounds: never tighter than the base color itself.
  // If base.L sits above L_MAX (e.g. pure white) or below L_MIN, the fixed
  // clamp would collapse multiple cells onto the same value.
  const effLMin = Math.min(L_MIN, base.L);
  const effLMax = Math.max(L_MAX, base.L);
  const steps = jndStepsFor(base);
  const boost = lowChromaBoostFor(base.C);

  const rawUp = effLMax - base.L;
  const rawDown = base.L - effLMin;

  // Feasibility snap uses the un-inflated tilt extents so the answer
  // position is stable across retry attempts (columnTilts' layout choice
  // only depends on the room split, which doesn't change with inflate).
  const snapTilts = columnTilts(cols, correctCol, rawUp, rawDown, 1);
  correctRow = snapToFeasible(
    correctRow, rows,
    Math.max(0, rawUp - snapTilts.upExtent),
    Math.max(0, rawDown - snapTilts.downExtent),
    STEP_L_FLOOR,
  );

  // The tilt budget is what's left after reserving floor-sized lightness
  // gaps for the rows on each side of the (now snapped) answer row — so a
  // forced edge answer can pour the unused side's room into the tilt.
  const tiltAvailUp = Math.max(0, rawUp - correctRow * STEP_L_FLOOR);
  const tiltAvailDown = Math.max(0, rawDown - (rows - 1 - correctRow) * STEP_L_FLOOR);
  const { tilt, upExtent, downExtent } = columnTilts(cols, correctCol, tiltAvailUp, tiltAvailDown, inflate);
  const roomUp = Math.max(0, rawUp - upExtent);
  const roomDown = Math.max(0, rawDown - downExtent);

  // Row axis: lightness, palest at row 0. Offsets ascend with the row
  // index, so L(i) = base.L - offset(i) descends monotonically. The step is
  // capped just under the sore-thumb neighbor ceiling (with margin for the
  // per-gap jitter) — without the cap, edge-snapped answers with lots of
  // spare room produce one giant step that the validator then rejects,
  // leaving the retry loop oscillating instead of converging.
  const adjacentFloor = adjacentFloorFor(base);
  const maxRowStep = (adjacentFloor * NEIGHBOR_MAX_RATIO * 0.85) / 100;
  const baseRowStep = Math.min(steps.stepL * boost * inflate, maxRowStep);
  const rowFit = fitSteps(
    baseRowStep,
    correctRow, rows - 1 - correctRow,
    roomUp, roomDown,
    STEP_L_FLOOR,
  );
  const rowOffsets = monotonicOffsets(
    stepRng, rows, correctRow,
    rowFit.stepNeg, rowFit.stepPos,
    roomUp, roomDown,
  );

  // Column axis: chroma fraction (muted left → vivid right) + a hue sweep
  // toward the warm pole + the per-column lightness tilt.
  let colFractions = null;
  let colHueDelta = null;
  let neutralC = null;
  let neutralH = null;
  if (isNeutral) {
    // Temperature ramp: cool cast left of the answer, warm cast right. The
    // family cap is applied by rescaling the step (so the farthest column
    // lands exactly on the cap) rather than clamping per cell — clamping
    // would collapse all the outer columns onto the same chroma.
    const maxAbsSide = Math.max(correctCol, cols - 1 - correctCol);
    let tempStep = NEUTRAL_TEMP_STEP * inflate;
    if (maxAbsSide > 0) {
      tempStep = Math.min(tempStep, Math.max(0, NEUTRAL_TEMP_MAX - base.C) / maxAbsSide);
    }
    neutralC = new Array(cols);
    neutralH = new Array(cols);
    for (let j = 0; j < cols; j++) {
      const dj = j - correctCol;
      neutralC[j] = dj === 0 ? base.C : base.C + Math.abs(dj) * tempStep;
      neutralH[j] = dj < 0 ? NEUTRAL_COOL_HUE : dj > 0 ? NEUTRAL_WARM_HUE : base.H;
    }
  } else {
    const cMaxBase = Math.max(1e-6, maxChromaAt(base.L, base.H));
    const fBase = clamp(base.C / cMaxBase, 0, 1);
    const fFloor = Math.min(fBase, Math.max(fBase * F_FLOOR_OF_BASE, F_FLOOR_MIN));
    const roomRight = Math.max(0, F_CEIL - fBase);
    const roomLeft = Math.max(0, fBase - fFloor);
    // Cap the chroma step at ~1.75× the adjacent floor. When the vivid side
    // is gamut-pinned, inflation would otherwise pour everything into the
    // muted side and put a visible kink right at the answer column.
    const maxColStepF = (adjacentFloor * 1.75) / 100 / cMaxBase;
    const baseColStep = Math.min((steps.stepC / cMaxBase) * inflate, maxColStepF);
    // No floor and no feasibility snap on the column axis: when a saturated
    // answer leaves no chroma headroom, the hue sweep + lightness tilt keep
    // the columns distinguishable (validated below), and not snapping
    // avoids leaking the answer column for saturated characters.
    const colFit = fitSteps(baseColStep, correctCol, cols - 1 - correctCol, roomLeft, roomRight, 0, /*capRatio*/ false);
    const fOffsets = monotonicOffsets(
      stepRng, cols, correctCol,
      colFit.stepNeg, colFit.stepPos,
      roomLeft, roomRight,
    );
    colFractions = fOffsets.map(o => clamp(fBase + o, 0, 1));

    // Hue rotates toward the warm pole (OKLCH ≈ 70°) on the right, away on
    // the left, taking the short way around the circle. Deliberately NOT
    // inflated — widening hue past its JND just rotates decoys out of the
    // color family (SpongeBob yellow → mint green).
    const warmDelta = (((WARM_POLE_HUE - base.H) % 360) + 540) % 360 - 180;
    const hueSign = warmDelta >= 0 ? 1 : -1;
    // Rescale (don't clamp) when the full sweep would exceed the family
    // cap — clamping would zero the hue difference between outer columns.
    let stepHCol = steps.stepH * COL_HUE_FACTOR;
    const hueCap = steps.stepH * COL_HUE_SWEEP_CAP;
    const maxAbsCol = Math.max(correctCol, cols - 1 - correctCol);
    if (maxAbsCol * stepHCol > hueCap) stepHCol = hueCap / maxAbsCol;
    colHueDelta = new Array(cols);
    for (let j = 0; j < cols; j++) {
      colHueDelta[j] = hueSign * (j - correctCol) * stepHCol;
    }
  }

  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      if (r === correctRow && c === correctCol) {
        row.push({
          row: r,
          col: c,
          hex: correctHex.toUpperCase(),
          isCorrect: true,
          source: 'correct',
        });
        continue;
      }
      const L = clamp(base.L - rowOffsets[r] + tilt[c], effLMin, effLMax);
      let C, H;
      if (isNeutral) {
        C = neutralC[c];
        H = neutralH[c];
      } else {
        H = base.H + colHueDelta[c];
        C = colFractions[c] * maxChromaAt(L, H);
      }
      row.push({
        row: r,
        col: c,
        L, C, H,
        hex: hexFromOklch(L, C, H),
        isCorrect: false,
        source: 'ramp',
      });
    }
    cells.push(row);
  }

  // Final dedup pass: pathological cases (near-white answers with zero
  // chroma headroom, dark colors where the gamut clamp flattens whole
  // regions, diagonal row-step/tilt cancellations) can still produce two
  // cells with nearly-identical perceptual color. Walk the cells and nudge
  // L by a small per-cell salt until each cell is perceptibly distinct
  // (>1 ΔE) from every prior cell. The nudges are small (≤ 0.04 L) and only
  // fire in regions where the ramp is already flat, so the ordered-gradient
  // read survives — duplicate or near-duplicate cells would break the game
  // outright.
  const SEP_MIN = 1.0;
  const NUDGE_STEP = 0.006;
  const NUDGE_MAX = 0.06;
  const flat = cells.flat();
  const correctCell = flat.find(c => c.isCorrect);
  const accepted = correctCell ? [correctCell] : [];
  for (const cell of flat) {
    if (cell === correctCell) continue;
    let nudge = 0;
    let bump = 0;
    const tooClose = () => accepted.some(p => deltaE(p.hex, cell.hex) < SEP_MIN);
    while (tooClose() && nudge <= NUDGE_MAX) {
      bump++;
      // Walk nudge magnitude outward, alternating direction so the
      // dedup explores both lighter and darker than the original L.
      nudge = Math.ceil(bump / 2) * NUDGE_STEP;
      const dir = (bump % 2 === 1) ? -1 : 1;
      const newL = clamp(cell.L + dir * nudge, effLMin, effLMax);
      cell.hex = hexFromOklch(newL, cell.C, cell.H);
    }
    accepted.push(cell);
  }
  for (const cell of flat) {
    delete cell.L;
    delete cell.C;
    delete cell.H;
  }

  return { cells, correctRow, correctCol, rows, cols };
}

// Inspect an ordered grid against the ΔE invariants. Reports separately
// whether the ramp is too tight (floor violated: neighbors too similar) or
// the answer sticks out (ceiling violated: the steps around the answer are
// out of scale with the rest of the board). The retry loop uses this signal
// to decide whether to inflate or deflate the step magnitudes.
//
// `score` is the total magnitude of violations: smaller is better. Used to
// pick the best-of-attempts grid when no attempt passes cleanly.
function inspectOrderedGrid(grid, adjacentFloor) {
  const { cells, correctRow, correctCol, rows, cols } = grid;
  // Precompute OKLab per cell — 25 cells get compared a few hundred times.
  const lab = cells.map(row => row.map(c => linearRgbToOklab(hexToLinearRgb(c.hex))));
  const dist = (a, b) => {
    const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dL * dL + da * da + db * db) * 100;
  };

  let floorViolation = 0;
  let ceilingViolation = 0;

  // Strong floor on adjacent pairs (the steps the player actually
  // compares), tracked per axis — vertical (lightness) steps are
  // legitimately larger than horizontal (vividness) ones, so the
  // sore-thumb comparison below must stay within an axis.
  const adjacentH = [];
  const adjacentV = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) {
        const d = dist(lab[r][c], lab[r][c + 1]);
        adjacentH.push(d);
        if (d < adjacentFloor) floorViolation += adjacentFloor - d;
      }
      if (r + 1 < rows) {
        const d = dist(lab[r][c], lab[r + 1][c]);
        adjacentV.push(d);
        if (d < adjacentFloor) floorViolation += adjacentFloor - d;
      }
    }
  }

  // Weak floor on every pair — a duplicate swatch anywhere breaks the game.
  const flat = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) flat.push(lab[r][c]);
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const d = dist(flat[i], flat[j]);
      if (d < DELTA_E_ANY_MIN) floorViolation += DELTA_E_ANY_MIN - d;
    }
  }

  // Sore-thumb ceiling around the answer: an absolute cap on how big the
  // steps to the answer's own neighbors may be. The *relative* kink at the
  // answer is already bounded structurally — both ramps cap the asymmetry
  // of their two sides at STEP_RATIO_CAP — so no scale-invariant ratio
  // check is needed here (one was tried; it just fights the floor).
  const neighborMax = adjacentFloor * NEIGHBOR_MAX_RATIO;
  const correctLab = lab[correctRow][correctCol];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const r = correctRow + dr;
    const c = correctCol + dc;
    if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
    const d = dist(correctLab, lab[r][c]);
    if (d > neighborMax) ceilingViolation += d - neighborMax;
  }

  return {
    ok: floorViolation === 0 && ceilingViolation === 0,
    floorViolation,
    ceilingViolation,
    score: floorViolation + ceilingViolation,
  };
}

// Annotate every cell with its ΔE from the answer (drives the proximity
// glow) and its Chebyshev ring distance (drives proximity scoring), so the
// game and UI never need to re-import color math.
function annotate(grid, correctHex) {
  const { cells, correctRow, correctCol } = grid;
  for (const row of cells) {
    for (const cell of row) {
      cell.dE = cell.isCorrect ? 0 : deltaE(cell.hex, correctHex);
      cell.ring = Math.max(Math.abs(cell.row - correctRow), Math.abs(cell.col - correctCol));
    }
  }
  return grid;
}

export function buildGrid(
  correctHex,
  {
    rows = 5,
    cols = 5,
    seed = 0,
    correctRow: forcedRow = null,
    correctCol: forcedCol = null,
  } = {},
) {
  const opts = { rows, cols, baseSeed: seed, forcedRow, forcedCol, attempt: 0 };
  const base = oklchFromHex(correctHex);
  const adjacentFloor = adjacentFloorFor(base);
  let inflate = 1.0;
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    opts.attempt = attempt;
    const grid = generateGridOnce(correctHex, opts, inflate);
    const insp = inspectOrderedGrid(grid, adjacentFloor);
    if (insp.ok) return annotate(grid, correctHex);
    if (insp.score < bestScore) {
      best = grid;
      bestScore = insp.score;
    }
    // Adjust inflate toward whichever bound is more violated. If only the
    // floor is violated → spread cells wider. If only the ceiling →
    // contract. If both, the floor wins (better to over-spread than to
    // have invisible neighbors).
    if (insp.floorViolation > 0 && insp.floorViolation >= insp.ceilingViolation) {
      inflate *= INFLATE_PER_ATTEMPT;
    } else if (insp.ceilingViolation > 0) {
      inflate /= INFLATE_PER_ATTEMPT;
    }
  }
  return annotate(best, correctHex);
}
