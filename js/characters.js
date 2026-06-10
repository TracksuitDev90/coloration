// Loads characters.json + items.json and merges them into a single pool.
// `color.hex` is the canonical base color — we never sample pixels off the
// photo to override it. Photos are dominated by clothing, shadows, and
// backgrounds, which is the wrong signal for "what is this color".
//
// Each entry has a `type`:
//   "grid"  — full-character color, played on the 5x5 shade gradient (3 guesses)
//   "item"  — specific item from a scene, played on a 4-swatch quad (1 guess)

export async function loadCharacters() {
  const [chars, items] = await Promise.all([
    fetchJson('data/characters.json'),
    fetchJson('data/items.json').catch(() => []),
  ]);
  validate(chars, 'characters.json');
  validate(items, 'items.json', /*allowEmpty*/ true);
  const merged = [
    ...chars.map(c => ({ ...c, type: c.type || 'grid' })),
    ...items.map(c => ({ ...c, type: 'item' })),
  ];
  return merged.map(c => ({
    ...c,
    imageSrc: resolveImage(c),
    // Original PNG kept as a fallback for the rare browser without WebP
    // support; the <img> swaps to it via onerror (see js/main.js).
    imageFallback: c.image || null,
    // Last-resort art if both the WebP and the PNG fail to load — the same
    // initials card used for entries that ship without a photo at all.
    imagePlaceholder: placeholderDataUri(c),
  }));
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function validate(list, label, allowEmpty = false) {
  if (!Array.isArray(list) || (!allowEmpty && list.length === 0)) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const c of list) {
    if (!c.id || !c.name || !c.color?.hex) {
      throw new Error(`Invalid entry in ${label}: ${JSON.stringify(c)}`);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(c.color.hex)) {
      throw new Error(`Bad hex for ${c.id}: ${c.color.hex}`);
    }
    if (c.combo) validateCombo(c, label);
  }
}

// Combo boards are built straight from this data with no palette sampling
// (see buildComboQuad in js/quad.js), so a malformed entry would crash the
// round at play time. Catch it here at load instead, with a message that
// names the offending entry.
const COMBO_MIN_DISTRACTORS = 3;
function validateCombo(c, label) {
  const isPair = p => Array.isArray(p) && p.length === 2 &&
    p.every(h => /^#[0-9a-fA-F]{6}$/.test(h));
  const { correct, distractors } = c.combo;
  if (!isPair(correct)) {
    throw new Error(`${label}: ${c.id} combo.correct must be a pair of hex colors`);
  }
  if (!Array.isArray(distractors) || distractors.length < COMBO_MIN_DISTRACTORS) {
    throw new Error(`${label}: ${c.id} combo needs at least ${COMBO_MIN_DISTRACTORS} distractor pairs`);
  }
  const key = p => p.map(h => h.toUpperCase()).join('/');
  for (const pair of distractors) {
    if (!isPair(pair)) {
      throw new Error(`${label}: ${c.id} combo distractor must be a pair of hex colors`);
    }
    if (key(pair) === key(correct)) {
      throw new Error(`${label}: ${c.id} combo distractor duplicates the correct pair`);
    }
  }
}

function resolveImage(c) {
  if (c.image) return preferWebp(c.image);
  return placeholderDataUri(c);
}

// Photos ship as optimized WebP alongside the source PNG (see
// scripts/optimize_photos.py) — typically ~90% smaller, so they load fast on
// slow or congested connections without a visible quality drop. Point the
// runtime at the WebP; the PNG remains the fallback for browsers that can't
// decode WebP.
function preferWebp(src) {
  return src.replace(/\.png$/i, '.webp');
}

// SVG card: dark neutral background, character initials inside a soft circle,
// character name beneath. The grayscale CSS filter is a no-op on this neutral
// art, but the reveal animation still pulses on success.
function placeholderDataUri(c) {
  const initials = c.name
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const safeName = escapeXml(c.name);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1f2530"/>
      <stop offset="1" stop-color="#11151c"/>
    </linearGradient>
    <radialGradient id="ring" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.6" stop-color="#2a3340"/>
      <stop offset="1" stop-color="#1a2030"/>
    </radialGradient>
  </defs>
  <rect width="800" height="600" fill="url(#bg)"/>
  <circle cx="400" cy="260" r="170" fill="url(#ring)" stroke="#3a4456" stroke-width="3"/>
  <text x="400" y="295" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="140" font-weight="700" fill="#cfd6e2" letter-spacing="-3">${initials}</text>
  <text x="400" y="500" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="44" font-weight="600" fill="#e6ebf2" letter-spacing="0.5">${safeName}</text>
  <text x="400" y="548" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="18" fill="#7c8699" letter-spacing="2">PLACEHOLDER</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
