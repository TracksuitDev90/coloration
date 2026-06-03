// Randomization invariants — locks in the four guarantees the game depends on.
// Run from the repo root: `node scripts/verify-random.mjs`. Exits non-zero on
// any failure, matching the existing scripts/verify.mjs pattern. No external
// test framework — plain node:assert keeps the script portable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pickFreshDailyCharacters,
  hueFamily,
  positionForRound,
  ROTATION_EPOCH,
  getUtcDateKey,
} from '../js/daily.js';
import { buildQuad, distinctTone, QUAD_BOX_COUNT } from '../js/quad.js';
import { hexToHsl } from '../js/grid.js';

const characters = JSON.parse(
  readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
);
const items = JSON.parse(
  readFileSync(new URL('../data/items.json', import.meta.url), 'utf8'),
);

// Replicate the loader's tagging so the pools mirror the runtime split.
const characterPool = characters.map(c => ({ ...c, type: c.type || 'grid' }));
const itemPool = items.map(c => ({ ...c, type: 'item' }));

const results = [];
function section(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`FAIL  ${name}`);
    console.error(err);
  }
}

// Derived from the rotation epoch in daily.js so this script can't drift
// out of sync if that constant changes.
const [EPOCH_Y, EPOCH_M, EPOCH_D] = ROTATION_EPOCH.split('-').map(Number);
const EPOCH_MS = Date.UTC(EPOCH_Y, EPOCH_M - 1, EPOCH_D);
function dayKey(offset) {
  return getUtcDateKey(new Date(EPOCH_MS + offset * 86400000));
}

// 1) Pool exhaustion — picks never repeat until the unseen pool is drained,
//    and once drained `exhausted` flips so the caller knows to reset.
section('pool exhaustion (no repeats until drained)', () => {
  for (const [pool, mode] of [[characterPool, 'grid'], [itemPool, 'items']]) {
    const seen = new Set();
    let exhaustedAt = -1;
    let totalPicks = 0;
    // Walk far enough to wrap the roster at least once. The test requests a
    // full-roster slice to exercise the no-repeat-until-drained invariant
    // independently of the production ROUNDS_PER_DAY value.
    for (let day = 0; day < pool.length * 2 + 5; day++) {
      const { picks, exhausted } = pickFreshDailyCharacters(
        pool,
        dayKey(day),
        seen,
        mode,
        pool.length,
      );
      if (exhausted && exhaustedAt < 0) exhaustedAt = day;
      // Within a single draw, every pick must be unseen until we hit
      // exhaustion. After exhaustion the roster wraps and reuse is allowed.
      if (!exhausted) {
        for (const p of picks) {
          assert.ok(!seen.has(p.id), `${mode}: repeat before exhaustion (${p.id} on day ${day})`);
          seen.add(p.id);
        }
      } else {
        for (const p of picks) seen.add(p.id);
      }
      totalPicks += picks.length;
    }
    assert.ok(exhaustedAt > 0, `${mode}: never reported exhausted`);
    // Distinct IDs seen must equal the full pool size — proves every entry
    // surfaced at least once before any forced repeat.
    assert.equal(seen.size, pool.length, `${mode}: seen.size ${seen.size} != pool ${pool.length}`);
    console.log(`      ${mode}: ${pool.length} entries, exhausted on day ${exhaustedAt}, total picks ${totalPicks}`);
  }
});

// 2) No same-family runs across consecutive rounds (within tolerance of
//    family-dominance — if one family contains more than half the pool the
//    pigeonhole forces some clustering, which is acceptable).
section('no same-family runs across consecutive picks', () => {
  for (const [pool, mode] of [[characterPool, 'grid'], [itemPool, 'items']]) {
    const familyCounts = new Map();
    for (const c of pool) {
      const f = hueFamily(c.color.hex);
      familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
    }
    const dominant = Math.max(...familyCounts.values());
    // Maximum cluster size we'll allow: if a family is dominant, runs of
    // that family can be unavoidable. ceil(dominant / (pool - dominant + 1))
    // is a tight upper bound from round-robin scheduling.
    const others = pool.length - dominant;
    const allowedRun = others === 0 ? pool.length : Math.ceil(dominant / (others + 1));
    let maxRun = 0;
    for (let trial = 0; trial < 100; trial++) {
      const { picks } = pickFreshDailyCharacters(
        pool,
        dayKey(trial * 31 + 7),
        new Set(),
        mode,
        pool.length,
      );
      let run = 1;
      let runFam = hueFamily(picks[0]?.color?.hex);
      for (let i = 1; i < picks.length; i++) {
        const fam = hueFamily(picks[i].color.hex);
        if (fam === runFam) run++;
        else { runFam = fam; run = 1; }
        if (run > maxRun) maxRun = run;
      }
    }
    assert.ok(
      maxRun <= allowedRun,
      `${mode}: observed run of ${maxRun} > allowed ${allowedRun} (dominant family ${dominant}/${pool.length})`,
    );
    console.log(`      ${mode}: max consecutive same-family ${maxRun}, allowed ${allowedRun} (dominant ${dominant}/${pool.length})`);
  }
});

// 3) Distinct swatches inside every quad — every pair of boxes must read
//    as visually different. The runtime intentionally includes a same-hue
//    near-miss distractor, so we accept either of:
//      - the runtime's own distinctTone (hue gap, neutral-light gap, or
//        the neutral-vs-chromatic category split), or
//      - a lightness gap of >= 18 (covers the near-miss case where both
//        swatches share the same hue family).
const LIGHT_GAP_MIN = 18;
function visuallyDistinct(a, b) {
  return distinctTone(a, b) || Math.abs(a.l - b.l) >= LIGHT_GAP_MIN;
}

section('quad boards contain four visually distinct swatches', () => {
  let checked = 0;
  for (let i = 0; i < itemPool.length; i++) {
    const it = itemPool[i];
    const q = buildQuad(it.color.hex, { seed: i + 1, palette: it.quadPalette, combo: it.combo });
    assert.equal(q.boxes.length, QUAD_BOX_COUNT, `${it.id}: bad box count`);
    const hexes = q.boxes.map(b => b.hex);
    assert.equal(new Set(hexes).size, QUAD_BOX_COUNT, `${it.id}: duplicate hexes ${hexes.join(' ')}`);
    // Themed palettes (e.g. Power Rangers) ship hand-picked canonical hues
    // that may sit closer together than the generic gap; the runtime trusts
    // the curation and skips the distinctness filter, so we do too. Combo
    // swatches are likewise hand-curated pairs, so they skip the filter.
    if (it.quadPalette || it.combo) { checked++; continue; }
    const hsls = q.boxes.map(b => hexToHsl(b.hex));
    for (let a = 0; a < hsls.length; a++) {
      for (let b = a + 1; b < hsls.length; b++) {
        assert.ok(
          visuallyDistinct(hsls[a], hsls[b]),
          `${it.id}: swatches ${q.boxes[a].hex} and ${q.boxes[b].hex} too similar`,
        );
      }
    }
    // Sanity: each non-correct distractor that's NOT the near-miss must
    // pass the runtime's own distinctTone vs correct. We can't tell which
    // is the near-miss from the boxes alone, so we require at least two
    // of the three distractors to pass — same guarantee buildQuad enforces.
    const correctHsl = hexToHsl(it.color.hex);
    const distractorHsls = q.boxes.filter(b => !b.isCorrect).map(b => hexToHsl(b.hex));
    const distinctCount = distractorHsls.filter(d => distinctTone(d, correctHsl)).length;
    assert.ok(
      distinctCount >= 2,
      `${it.id}: only ${distinctCount}/3 distractors pass distinctTone vs correct`,
    );
    checked++;
  }
  console.log(`      validated ${checked} quad boards`);
});

// 4) positionForRound — across a full cycle every cell is visited the same
//    number of times. No quadrant favoured.
section('positionForRound uniformly covers the board', () => {
  // 16-cell grid, slots-per-day = 3, walk 48 (day, slot) combinations so each
  // cell should appear exactly 3 times (48 / 16).
  const gridCounts = new Array(16).fill(0);
  for (let i = 0; i < 48; i++) {
    const day = Math.floor(i / 3);
    const slot = i % 3;
    const pos = positionForRound(dayKey(day), slot, 16, 3);
    gridCounts[pos]++;
  }
  for (let i = 0; i < 16; i++) {
    assert.equal(gridCounts[i], 3, `grid cell ${i}: expected 3 visits, got ${gridCounts[i]}`);
  }
  // 4-swatch quad, slots-per-day = 3, walk 12 combinations so each box
  // appears exactly 3 times (12 / 4).
  const quadCounts = new Array(4).fill(0);
  for (let i = 0; i < 12; i++) {
    const day = Math.floor(i / 3);
    const slot = i % 3;
    const pos = positionForRound(dayKey(day), slot, 4, 3);
    quadCounts[pos]++;
  }
  for (let i = 0; i < 4; i++) {
    assert.equal(quadCounts[i], 3, `quad box ${i}: expected 3 visits, got ${quadCounts[i]}`);
  }
  console.log(`      grid 16-cell distribution: ${gridCounts.join(',')}`);
  console.log(`      quad  4-box distribution: ${quadCounts.join(',')}`);
});

const failed = results.filter(r => !r.ok).length;
console.log(failed ? `\n${failed} section(s) failed` : `\nAll ${results.length} sections passed`);
process.exit(failed ? 1 : 0);
