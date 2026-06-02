// Quad-mode board: four visually distinct color swatches, one of which is
// the correct color. Distractors come from a curated cartoon palette. To
// keep the round from being too easy, one distractor is a "plausible near
// miss" (e.g. red for a pink correct) and the other two are pulled from
// further around the hue wheel — but every swatch must still read as a
// different tone family, so the player never sees two pinks or two blues.

import { hexToHsl, hslToHex } from './grid.js';

// Saturated, recognizable cartoon colors spread around the hue wheel,
// plus neutrals. Three distractors are picked from this list per round.
const QUAD_PALETTE = [
  '#E63946', // red
  '#F39C12', // orange
  '#F4D03F', // yellow
  '#6FB04A', // green
  '#2A9D8F', // teal
  '#4A90D9', // blue
  '#5B5BB8', // indigo
  '#8B5FBF', // purple
  '#E63B97', // magenta
  '#FF8FB3', // pink
  '#7B4F2C', // brown
  '#1A1A1A', // black
  '#FFFFFF', // white
  '#9B9B9B', // gray
];

// Themed palettes restrict distractors to colors that "make sense" in the
// universe of the answer — e.g. for Power Rangers items, only the canonical
// suit colors should appear so distractors never include a fuchsia or teal
// that no ranger ever wore. Same idea for Powerpuff Girls items: distractors
// come from the trio's canonical color scheme so the player chooses between
// "is this Blossom's red, Bubbles' blue, or Buttercup's green?" rather than
// hunting through a generic rainbow.
const PALETTES = {
  // Mighty Morphin suit colors. Blue, green, and black are the exact hex
  // values of the matching Ranger items in items.json so the correct swatch
  // and the palette agree pixel-for-pixel; the rest are widely-cited fan refs
  // for the other six suits.
  'power-rangers': [
    '#C8102E', // red ranger
    '#FFCD00', // yellow ranger
    '#0B0C0D', // black ranger
    '#0A71C1', // blue ranger
    '#2C8335', // green ranger
    '#FFFFFF', // white ranger
    '#F46DB7', // pink ranger
  ],
  'powerpuff': [
    '#E63946', // Blossom red bow
    '#4A90D9', // Bubbles blue
    '#2ECC71', // Buttercup green
    '#F371AC', // Powerpuff dress pink
  ],
  // Brock's vest is green — pair it with the other primary cartoon hues
  // (blue, orange, red) so the player picks between four canonical colors
  // and never sees gray as an option.
  'brock-vest': [
    '#88C038', // Brock vest green (correct)
    '#4A90D9', // blue
    '#F39C12', // orange
    '#E63946', // red
  ],
  // Didi Pickles's glasses are an olive-green. Distractors are clearly
  // different hue families — a red, a purple, and a blue — so the player
  // never sees a near-green that could be confused with the correct shade.
  'didi-glasses': [
    '#8FA256', // Didi glasses green (correct)
    '#E63946', // red
    '#8B5FBF', // purple
    '#4A90D9', // blue
  ],
  // Phoebe's sweater is a muted slate-blue. Distractors come from clearly
  // different hue families so the player can't fall for a near-blue.
  'phoebe-sweater': [
    '#57749A', // Phoebe sweater blue (correct)
    '#6FB04A', // green
    '#FF8FB3', // pink
    '#F4D03F', // yellow
  ],
  // Vince's jersey is a saturated grass green. Distractors are red, blue,
  // and a golden yellow.
  'vince-jersey': [
    '#5C9F31', // Vince jersey green (correct)
    '#E63946', // red
    '#4A90D9', // blue
    '#DAA520', // golden yellow
  ],
  // Anxiety is orange. Distractors are purple, black, and yellow — three
  // chromatic-and-neutral options that read as clearly different.
  'anxiety': [
    '#E26E2D', // Anxiety orange (correct)
    '#8B5FBF', // purple
    '#1A1A1A', // black
    '#F4D03F', // yellow
  ],
  // Ninja Turtle mask colors. The four canonical turtle hues — purple
  // (Donatello), blue (Leonardo), red (Raphael), orange (Michelangelo).
  // Used for Donatello's mask; the photo identifies the turtle by name so
  // the player picks the right mask color from the team's palette.
  'tmnt': [
    '#8B5FBF', // Donatello purple
    '#2A6FB5', // Leonardo blue
    '#C8102E', // Raphael red
    '#F37614', // Michelangelo orange
  ],
  // Phineas's hair is the orange of the Flynn-Fletcher household. Pair it
  // with Ferb's iconic green (the obvious "wrong sibling" trap) plus two
  // other family hair colors so the round is grounded in show lore.
  // All distractors sit >=14 ΔE from canonical in OKLab so none of them
  // can be confused with Phineas's orange.
  'phineas-hair': [
    '#E94E1B', // Phineas Hair Orange (correct, mirrors items.json)
    '#32B336', // Ferb Hair Green (mirrors items.json)
    '#4A2A1A', // Lawrence's dark brown (Ferb's dad)
    '#7E4624', // Linda's muted red-brown (Phineas's mom)
  ],
  // Nigel Thornberry's hair is his signature deep red-orange. Distractors
  // come from the rest of the family: Marianne/Eliza blonde, Debbie
  // black, and a Donnie pale red-orange that's kept far enough from
  // Nigel's canonical (>12 ΔE in OKLab) to never confuse for the answer.
  'nigel-hair': [
    '#D14528', // Nigel Hair Red (correct, mirrors items.json)
    '#E8C880', // Marianne / Eliza blonde
    '#1A1410', // Debbie black
    '#F08C5C', // Donnie's pale reddish-orange (>12 ΔE from canonical)
  ],
  // Jonny Quest is a blond boy. Distractors are the other common cartoon
  // hair colors — brown, red, and a blueish-green that sits far from
  // canonical so a player can't confuse it for blonde.
  'johnny-quest-hair': [
    '#F0C84B', // Jonny Quest blonde (correct, mirrors items.json)
    '#7B4F2C', // brown
    '#E63946', // red
    '#2A9D8F', // blueish-green / teal
  ],
  // Velma's sweater is the orange of the Mystery Inc. wardrobe. Distractors
  // are purple, green, and teal — three distinct hue families that bracket
  // the orange without bleeding into yellow or red shades.
  'velma-sweater': [
    '#DD7B30', // Velma sweater orange (correct, mirrors items.json)
    '#8B5FBF', // purple
    '#6FB04A', // green
    '#2A9D8F', // teal
  ],
  // Mandy's shirt flower is bright yellow. Distractors are green, red, and
  // rose pink — distinct hues from across the wheel.
  'mandy-flower': [
    '#F4E03A', // Mandy flower yellow (correct, mirrors items.json)
    '#6FB04A', // green
    '#E63946', // red
    '#E63B97', // rose pink
  ],
  // Daphne's iconic purple dress. Distractors are orange, white, and a
  // muted navy blue — three clearly different tones that don't bleed into
  // purple.
  'daphne-dress': [
    '#7C3FAF', // Daphne dress purple (correct, mirrors items.json)
    '#F39C12', // orange
    '#FFFFFF', // white
    '#5B7B9D', // muted / light navy blue
  ],
  // Mac's red shirt from Foster's. Distractors are green, baby blue, and
  // lilac purple so the round picks between four distinct hues.
  'mac-shirt': [
    '#D2292A', // Mac shirt red (correct, mirrors items.json)
    '#6FB04A', // green
    '#89CFF0', // baby blue
    '#C8A2C8', // lilac purple
  ],
  // CatDog — Dog's nose is a deep indigo. The "near miss" distractor is a
  // clearly lighter purple-blue (well above the canonical's lightness so it
  // never reads as the same colour), paired with a green and a yellow from
  // unrelated hue families.
  'catdog-nose': [
    '#2D2080', // Dog nose indigo (correct, mirrors items.json)
    '#7B73D1', // lighter purple-blue near-miss
    '#6FB04A', // green
    '#F4D03F', // yellow
  ],
  // Arthur's yellow sweater. Distractors are red, teal blue, and a dark
  // burnt orange — three saturated hue families clearly apart from yellow.
  'arthur-sweater': [
    '#F3D949', // Arthur sweater yellow (correct, mirrors items.json)
    '#E63946', // red
    '#1B6E8A', // teal blue
    '#B8651C', // dark orange
  ],
  // Fred Flintstone's tunic is orange. Distractors are sky blue, a clearly
  // green-leaning green (not a teal that could half-read as blue), and a
  // lighter peach near-miss synthesized from the canonical orange.
  'fred-flintstone': [
    '#E97B36', // Fred tunic orange (correct, mirrors items.json)
    '#87CEEB', // sky blue
    '#3CB371', // medium sea green (greener than a teal)
    '#F4B186', // lighter peach orange (near-miss)
  ],
  // Eddy's yellow shirt. Distractors are blue, orange, and green — four
  // canonical cartoon hues for a clean colour-family pick.
  'eddy-shirt': [
    '#F2C94C', // Eddy shirt yellow (correct, mirrors items.json)
    '#4A90D9', // blue
    '#E97B36', // orange
    '#6FB04A', // green
  ],
  // Krumm's lips read as a slate blue in canon. Distractors are red (the
  // "Krumm's lips are surely red, right?" trap), a yellow, and a green —
  // each from a clearly distinct hue family.
  'krumm-lips': [
    '#5780B5', // Krumm lip blue (correct, mirrors items.json)
    '#E63946', // red
    '#F4D03F', // yellow
    '#6FB04A', // green
  ],
  // Kyle's hair is red. Distractors are blonde (the obvious other "kid
  // hair" colour), a green, and a blue — distinct hues so no near-red can
  // muddy the round.
  'kyle-hair': [
    '#C13524', // Kyle hair red (correct, mirrors items.json)
    '#F0C84B', // blonde
    '#6FB04A', // green
    '#4A90D9', // blue
  ],
  // Aladdin's vest is a deep eggplant purple. Distractors are picked from
  // the warmer half of the wheel — light ruby red, sunset orange-yellow,
  // and sky blue — so the round reads as a clean pick between four
  // distinct hue families.
  'aladdin-vest': [
    '#4D2880', // Aladdin vest purple (correct, mirrors items.json)
    '#D94661', // light ruby red
    '#FFA94D', // sunset yellow
    '#87CEEB', // sky blue
  ],
  // Lard Lad's donut wears the iconic pink frosting. Distractors lean into
  // donut-shop fare: chocolate brown, blueberry-frosting blue, and the
  // plain-cake donut yellow.
  'lard-lad-donut': [
    '#D8318B', // Lard Lad donut pink (correct, mirrors items.json)
    '#5D2E0E', // chocolate brown
    '#3953A4', // blueberry blue
    '#E1C699', // plain donut yellow
  ],
  // Russell's neckerchief is the Wilderness Explorers' orange. Distractors
  // are uniform-adjacent colours from clearly different hue families —
  // deep red, grass green, and a sun yellow.
  'russell-neckerchief': [
    '#F65A16', // Russell neckerchief orange (correct, mirrors items.json)
    '#8B0000', // deep red
    '#4A7C2E', // grass green
    '#FFD700', // sun yellow
  ],
  // Kids Next Door — Sector V's canonical uniform colours. Numbuh 4's
  // orange and Numbuh 1's red sit close on the hue wheel, which is the
  // point: the round is harder because the player picks between
  // teammates rather than rainbow distractors. Green (Numbuh 3) and blue
  // (Numbuh 2) round out the team with clearly distinct families.
  'kids-next-door': [
    '#E2780B', // Numbuh 4 orange hoodie (mirrors items.json)
    '#CA0D41', // Numbuh 1 red shirt (mirrors items.json)
    '#3D9127', // Numbuh 3 Kuki green sweater (mirrors items.json)
    '#2D6BAA', // Numbuh 2 Hoagie blue Hawaiian shirt
  ],
  // Numbuh 5's red cap. Numbuh 1's red is deliberately kept OUT of this
  // palette — the two reds (#CD1241 vs #CA0D41) are near-identical and would
  // make for an unfair near-duplicate swatch. Distractors are the other
  // teammates' clearly-distinct hue families (orange, green, blue) instead.
  'numbuh-5-hat': [
    '#CD1241', // Numbuh 5 red hat (correct, mirrors items.json)
    '#E2780B', // Numbuh 4 orange
    '#3D9127', // Numbuh 3 green
    '#2D6BAA', // Numbuh 2 blue
  ],
  // Barney Rubble's tan caveman tunic. Distractors are orange, light blue,
  // and a grass green — three clearly distinct hue families that bracket the
  // warm brown without offering a near-shade.
  'barney-rubble-shirt': [
    '#B48257', // Barney shirt brown (correct, mirrors items.json)
    '#F39C12', // orange
    '#87CEEB', // light blue
    '#5C9F31', // grass green
  ],
  // Aang's air-nomad arrow tattoo reads as a soft steel blue. Distractors are
  // purple, white, and a fire red — pulling the Fire Nation red in as the
  // thematic "wrong element" trap while staying clearly off the blue.
  'aang-arrow': [
    '#80A1CA', // Aang arrow blue (correct, mirrors items.json)
    '#8B5FBF', // purple
    '#FFFFFF', // white
    '#E8412E', // fire red
  ],
  // Roger Klotz's spiky orange hair. Distractors are lime green, purple, and
  // a light teal blue — distinct families so no near-orange muddies the pick.
  'roger-klotz-hair': [
    '#F27A2A', // Roger Klotz orange (correct, mirrors items.json)
    '#9ACD32', // lime green
    '#8B5FBF', // purple
    '#4FB6CC', // light teal blue
  ],
  // Fred Jones's orange ascot from Mystery Inc. Distractors are a soft green,
  // a bright yellow, and a brown — warm-adjacent hues kept clear of the orange.
  'fred-jones-ascot': [
    '#DE6228', // Fred ascot orange (correct, mirrors items.json)
    '#7FB069', // soft green
    '#F4D03F', // bright yellow
    '#7B4F2C', // brown
  ],
  // Dick Dastardly's deep purple coat. Distractors are red, dark green, and a
  // tan brown — three saturated/earthy families well off the purple.
  'dick-dastardly-coat': [
    '#4B2E66', // Dastardly coat purple (correct, mirrors items.json)
    '#C8102E', // red
    '#2C6E3F', // dark green
    '#A9794B', // tan brown
  ],
  // Jade Chan's orange hoodie. Distractors are fire-engine red, teal green,
  // and black — the red is the warm near-family trap, the others clearly cold.
  'jade-hoodie': [
    '#EB8217', // Jade hoodie orange (correct, mirrors items.json)
    '#D72631', // fire engine red
    '#2A9D8F', // teal green
    '#1A1A1A', // black
  ],
  // Penny Proud's rose-pink cardigan. Distractors are lilac purple, blueberry
  // blue, and pumpkin orange — distinct families bracketing the pink.
  'penny-proud-cardigan': [
    '#CE5679', // Penny cardigan pink (correct, mirrors items.json)
    '#B57EDC', // lilac purple
    '#3953A4', // blueberry blue
    '#F0801A', // pumpkin orange
  ],
  // D.W.'s pink jumper dress from Arthur. Distractors are yellow, red, and a
  // soft sky blue — three clearly different tones from the pink.
  'dw-dress': [
    '#F671AB', // D.W. dress pink (correct, mirrors items.json)
    '#F4D03F', // yellow
    '#E63946', // red
    '#87CEEB', // soft sky blue
  ],
  // T.J. Detweiler's deep forest-green bomber jacket. Distractors are ruby
  // red, sky blue, and a leather brown — three clearly distinct families that
  // bracket the green without offering a near-shade.
  'tj-detweiler-jacket': [
    '#34604E', // T.J. jacket green (correct, mirrors items.json)
    '#9B111E', // ruby red
    '#87CEEB', // sky blue
    '#8B5A2B', // leather brown
  ],
  // Buster Bunny's red-orange T-shirt. Distractors are baby blue, apple
  // green, and a burnt orange — the orange is the warm near-family trap, the
  // others clearly cold/distinct.
  'buster-bunny-shirt': [
    '#FA422B', // Buster shirt red (correct, mirrors items.json)
    '#89CFF0', // baby blue
    '#8DB600', // apple green
    '#CC5500', // burnt orange
  ],
  // Billy's blue T-shirt stripe. Distractors are red, daisy yellow, and a
  // grass green — three saturated hue families clearly apart from the blue.
  'billy-shirt-stripe': [
    '#047CC0', // Billy stripe blue (correct, mirrors items.json)
    '#E63946', // red
    '#FFD93D', // daisy yellow
    '#6FB04A', // green
  ],
  // Butters's teal-green jacket. Distractors are orange, black, and red —
  // three chromatic-and-neutral options that read as clearly different.
  'butters-jacket': [
    '#51B491', // Butters jacket teal (correct, mirrors items.json)
    '#F39C12', // orange
    '#1A1A1A', // black
    '#E63946', // red
  ],
  // Gerald's red "33" basketball jersey. Distractors are blue, an egg-shell
  // off-white, and a grass green — three clearly distinct families well off
  // the red.
  'gerald-shirt': [
    '#B91F03', // Gerald jersey red (correct, mirrors items.json)
    '#4A90D9', // blue
    '#F0EAD6', // egg shell white
    '#6FB04A', // green
  ],
  // Freakazoid's red superhero suit. Distractors are blue, gray, and purple —
  // distinct families so no near-red muddies the pick.
  'freakazoid-suit': [
    '#D4260D', // Freakazoid suit red (correct, mirrors items.json)
    '#4A90D9', // blue
    '#9B9B9B', // gray
    '#8B5FBF', // purple
  ],
  // Cosmo's Mom's mint-teal hair. Distractors are a grass green, pink, and a
  // deep purple — the grass green is the cool near-family trap, kept clearly
  // darker/more saturated than her pale mint.
  'cosmo-mom-hair': [
    '#91F5AC', // Cosmo's Mom teal (correct, mirrors items.json)
    '#6FB04A', // green
    '#FF8FB3', // pink
    '#5B2C8C', // deep purple
  ],
  // The Mystery Machine's orange-red logo lettering. Distractors are blue, a
  // soft black, and yellow — three clearly different families from the warm
  // orange-red.
  'mystery-machine-text': [
    '#D5331E', // Mystery Machine orange-red (correct, mirrors items.json)
    '#4A90D9', // blue
    '#2B2B2B', // soft black
    '#F4D03F', // yellow
  ],
  // Dora's pink T-shirt. Distractors are yellow, green, and a very light pink
  // near-miss kept far lighter than her saturated pink so it never reads as
  // the same shade.
  'dora-shirt': [
    '#F371AC', // Dora shirt pink (correct, mirrors items.json)
    '#F4D03F', // yellow
    '#6FB04A', // green
    '#FBD3E0', // very light pink
  ],
  // Bobby Hill's slate-blue T-shirt. Distractors are tan, black, and a soft
  // green — three earthy/neutral families clearly apart from the muted slate.
  'bobby-hill-shirt': [
    '#567277', // Bobby shirt slate (correct, mirrors items.json)
    '#D2B48C', // tan
    '#1A1A1A', // black
    '#7FB069', // soft green
  ],
};

const BOX_COUNT = 4;

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

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// Distance score used to rank candidates. Hue still dominates, but
// saturation mismatch matters too — without that weight, white and gray
// (s = 0, h = 0) read as "close" to a saturated pink at h ≈ 330 simply
// because of the hue wraparound, and could leak into the plausible slot.
function colorDistance(a, b) {
  const hd = hueDistance(a.h, b.h) / 180;        // 0..1
  const ld = Math.abs(a.l - b.l) / 100;          // 0..1
  const sd = Math.abs(a.s - b.s) / 100;          // 0..1
  return hd * 0.5 + ld * 0.2 + sd * 0.4;
}

// Two colors register as the same tone family when their hue is too close
// (think two pinks or two blues sitting next to each other). Neutrals
// (white/gray/black) collapse to the same hue at h=0, so for those we use
// lightness to tell them apart. A neutral paired with a chromatic color
// always reads as different tones.
const HUE_GAP_MIN = 25;
const NEUTRAL_SAT = 15;
const NEUTRAL_LIGHT_GAP = 18;
export function distinctTone(a, b) {
  const aNeutral = a.s < NEUTRAL_SAT;
  const bNeutral = b.s < NEUTRAL_SAT;
  if (aNeutral && bNeutral) {
    return Math.abs(a.l - b.l) > NEUTRAL_LIGHT_GAP;
  }
  if (aNeutral !== bNeutral) return true;
  return hueDistance(a.h, b.h) >= HUE_GAP_MIN;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Default-palette gray is intentionally rare. It's still in the rotation so
// the occasional gray-tinged distractor turns up, but most rounds drop it
// before scoring so the typical board reads as four chromatic colors.
const RARE_HEX = '#9B9B9B';
const RARE_KEEP_CHANCE = 0.2;

// Same-family "near miss" tuning. The plausible distractor is synthesized
// from the correct color by keeping its hue and shoving its lightness far
// enough that it reads as "clearly a different shade of the same color"
// rather than "almost the right shade". Lower bound prevents a flat tonal
// duplicate; upper bound prevents the swatch from collapsing into pure
// white/black for mid-saturation hues.
const SHADE_SHIFT_MIN = 28;
const SHADE_SHIFT_MAX = 42;
// How close a candidate's hue must be to share a "family" with the correct
// color for the synthesized-shade purposes. Wider than HUE_GAP_MIN so two
// adjacent hues (e.g. red ↔ pink, yellow ↔ orange) are treated as
// potentially-too-close and benefit from the shade-shift behaviour.
const SAME_FAMILY_HUE = 35;

// Build a same-family but clearly-different-shade distractor by keeping the
// correct hue and shoving lightness toward whichever extreme has more room.
// Saturation jitters slightly so the synthesized swatch doesn't feel like a
// mathematical mirror of the correct cell. Neutral correct colors (white,
// black, gray) skip this — there is no chromatic family to anchor to.
function synthesizeShadeShifted(correctHsl, rng) {
  if (correctHsl.s < 12) return null;
  const upRoom = 92 - correctHsl.l;
  const downRoom = correctHsl.l - 10;
  let direction;
  if (upRoom < 18) direction = -1;
  else if (downRoom < 18) direction = 1;
  else direction = rng() < 0.5 ? -1 : 1;
  const shift = SHADE_SHIFT_MIN + rng() * (SHADE_SHIFT_MAX - SHADE_SHIFT_MIN);
  const newL = Math.max(10, Math.min(92, correctHsl.l + direction * shift));
  const newS = Math.max(20, Math.min(100, correctHsl.s - 8 + rng() * 16));
  return { h: correctHsl.h, s: newS, l: newL };
}

export function buildQuad(correctHex, { seed = 0, palette, correctIndex: forcedIndex = null } = {}) {
  const correct = hexToHsl(correctHex);
  const rng = mulberry32(seed * 2654435761 + 31);

  // Themed palettes (e.g. Power Rangers) constrain distractors to a small
  // set of canonical colors. Fall back to the general cartoon palette if the
  // named palette doesn't exist. `isThemed` is captured BEFORE the gray-strip
  // step because that step returns a new filtered array — comparing against
  // QUAD_PALETTE by reference after the strip would mis-classify the default
  // palette as a themed one and skip the distinctTone filter.
  const requestedPalette = (typeof palette === 'string' ? PALETTES[palette] : palette);
  const isThemed = !!requestedPalette;
  let source = requestedPalette || QUAD_PALETTE;

  // Gray rarely belongs alongside the saturated cartoon hues the game centres
  // on. Strip it from the default palette most rounds — the dice roll lives
  // off the seeded rng so the decision is stable per round.
  if (!isThemed && rng() > RARE_KEEP_CHANCE) {
    source = source.filter(hex => hex.toUpperCase() !== RARE_HEX);
  }
  // The general palette spans the hue wheel and includes near-shades the
  // distinctTone filter is meant to weed out. Themed palettes are already
  // hand-curated to be visually distinct (every Power Ranger color is canon),
  // so skipping the filter ensures plausible options like Red + Pink can both
  // appear on the board.

  const scored = source
    .filter(hex => hex.toUpperCase() !== correctHex.toUpperCase())
    .map(hex => ({ hex: hex.toUpperCase(), hsl: hexToHsl(hex) }))
    .map(p => ({ ...p, dist: colorDistance(correct, p.hsl) }));

  const chosen = [{ hex: correctHex.toUpperCase(), hsl: correct }];
  const distinctFromChosen = (cand) =>
    isThemed || chosen.every(c => distinctTone(cand.hsl, c.hsl));
  const alreadyPicked = (cand) =>
    chosen.some(c => c.hex === cand.hex);

  // Sort all candidates closest-first, dropping anything that reads as the
  // same tone family as the correct color (so we never offer a near-shade
  // that's effectively "the same color"). Themed palettes skip this filter.
  const ranked = [...scored]
    .sort((a, b) => a.dist - b.dist)
    .filter(c => isThemed || distinctTone(c.hsl, correct));

  // Plausible "near miss". For themed palettes we still pick the closest
  // canonical color (Pink Ranger when the answer is Red Ranger, etc.). For
  // the general palette we synthesize a same-hue but clearly different-
  // lightness swatch instead — that produces a "light/dark version of the
  // same color" distractor without ever being only a few shades off.
  if (isThemed) {
    const closeBucket = ranked.slice(0, 3);
    shuffle(closeBucket, rng);
    if (closeBucket.length) chosen.push(closeBucket[0]);
  } else {
    const shifted = synthesizeShadeShifted(correct, rng);
    if (shifted) {
      chosen.push({
        hex: hslToHex(shifted.h, shifted.s, shifted.l).toUpperCase(),
        hsl: shifted,
      });
    } else if (ranked.length) {
      // Neutral correct: there is no chromatic family to shade-shift, so
      // fall back to the closest distinct palette pick the way themed
      // palettes do.
      const closeBucket = ranked.slice(0, 3);
      shuffle(closeBucket, rng);
      chosen.push(closeBucket[0]);
    }
  }

  // Two further-away distractors. Pull from the next slice of the ranked
  // list — colors that are clearly different from correct, but still
  // recognizable cartoon hues a player might consider. Skipping the very
  // tail keeps neutrals like white/gray/black from dominating chromatic
  // rounds (they should appear sometimes, not every time).
  const midBucket = ranked.slice(3, 8);
  shuffle(midBucket, rng);
  for (const cand of midBucket) {
    if (chosen.length >= BOX_COUNT) break;
    if (alreadyPicked(cand)) continue;
    if (distinctFromChosen(cand)) chosen.push(cand);
  }

  // Backstop: if the mid pool was thin (e.g. small palette after filtering),
  // fall back to the rest of the ranked list to fill any remaining slots so
  // the board always has four entries.
  for (const cand of ranked) {
    if (chosen.length >= BOX_COUNT) break;
    if (alreadyPicked(cand)) continue;
    if (distinctFromChosen(cand)) chosen.push(cand);
  }
  for (const cand of ranked) {
    if (chosen.length >= BOX_COUNT) break;
    if (alreadyPicked(cand)) continue;
    chosen.push(cand);
  }

  // Last-resort safety net: a very small custom palette (fewer than four
  // distinct colors once the correct one is filtered out) could leave us short
  // of three distractors, which would crash the box assembly below. Top up
  // from the general cartoon palette so the board always has four entries.
  if (chosen.length < BOX_COUNT) {
    for (const hex of QUAD_PALETTE) {
      if (chosen.length >= BOX_COUNT) break;
      const up = hex.toUpperCase();
      if (up === correctHex.toUpperCase()) continue;
      if (chosen.some(c => c.hex === up)) continue;
      chosen.push({ hex: up, hsl: hexToHsl(hex) });
    }
  }

  // Callers (the daily game) pass in a deterministic index that walks around
  // the four positions each round so the same item on a later day lands on
  // a different swatch. Fall back to a seeded pick when not provided.
  const correctIndex = Number.isInteger(forcedIndex) && forcedIndex >= 0 && forcedIndex < BOX_COUNT
    ? forcedIndex
    : Math.floor(rng() * BOX_COUNT);
  const distractors = chosen.slice(1);
  shuffle(distractors, rng);
  const boxes = [];
  let di = 0;
  for (let i = 0; i < BOX_COUNT; i++) {
    if (i === correctIndex) {
      boxes.push({ index: i, hex: correctHex.toUpperCase(), isCorrect: true });
    } else {
      boxes.push({ index: i, hex: distractors[di++].hex, isCorrect: false });
    }
  }

  return { kind: 'quad', boxes, correctIndex, count: BOX_COUNT };
}

export const QUAD_BOX_COUNT = BOX_COUNT;
