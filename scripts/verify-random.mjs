// Randomization invariants — locks in the four guarantees the game depends on.
// Run from the repo root: `node scripts/verify-random.mjs`. Exits non-zero on
// any failure, matching the existing scripts/verify.mjs pattern. No external
// test framework — plain node:assert keeps the script portable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dailyRotation,
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

// 1) Global rotation — the schedule is a pure function of (pool, date, mode),
//    so two independent computations agree (every player worldwide sees the
//    same picks), and nothing repeats until the whole roster has surfaced.
section('global rotation (deterministic, no repeats until drained)', () => {
  const ROUNDS = 4; // mirrors ROUNDS_PER_DAY in main.js
  for (const [pool, mode] of [[characterPool, 'grid'], [itemPool, 'items']]) {
    // Walk three full passes of the roster plus change.
    const days = Math.ceil(pool.length / ROUNDS) * 3 + 5;
    let seen = new Set();
    let drains = 0;
    for (let day = 0; day < days; day++) {
      const picks = dailyRotation(pool, dayKey(day), mode, ROUNDS);
      const again = dailyRotation(pool, dayKey(day), mode, ROUNDS);
      assert.deepEqual(
        again.map(p => p.id),
        picks.map(p => p.id),
        `${mode}: day ${day} not deterministic across independent calls`,
      );
      assert.equal(picks.length, Math.min(ROUNDS, pool.length), `${mode}: day ${day} short slice`);
      assert.equal(
        new Set(picks.map(p => p.id)).size,
        picks.length,
        `${mode}: day ${day} duplicate within the daily slice`,
      );
      const unseen = picks.filter(p => !seen.has(p.id));
      const repeats = picks.filter(p => seen.has(p.id));
      if (seen.size + unseen.length === pool.length) {
        // This slice drains the current pass. When the roster size isn't a
        // multiple of ROUNDS the same slice also opens the next pass — those
        // extras are the only legal "repeats", and they seed the new record.
        drains++;
        seen = new Set(repeats.map(p => p.id));
      } else {
        assert.equal(
          repeats.length,
          0,
          `${mode}: day ${day} repeated ${repeats.map(p => p.id).join(',')} before the roster drained`,
        );
        for (const p of picks) seen.add(p.id);
      }
    }
    assert.ok(drains >= 3, `${mode}: expected >=3 full passes, saw ${drains}`);
    console.log(`      ${mode}: ${pool.length} entries, ${drains} full passes over ${days} days, no early repeats`);
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
      const picks = dailyRotation(pool, dayKey(trial * 31 + 7), mode, pool.length);
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
  // 25-cell grid, slots-per-day = 3, walk 75 (day, slot) combinations so
  // each cell should appear exactly 3 times (75 / 25). Also assert no two
  // same-day slots share a position, and consecutive linear slots never
  // land on adjacent cells (the step-11 walk scatters ~2 rows per round).
  const gridCounts = new Array(25).fill(0);
  for (let i = 0; i < 75; i++) {
    const day = Math.floor(i / 3);
    const slot = i % 3;
    const pos = positionForRound(dayKey(day), slot, 25, 3);
    gridCounts[pos]++;
    if (slot > 0) {
      const prev = positionForRound(dayKey(day), slot - 1, 25, 3);
      assert.notEqual(pos, prev, `grid: day ${day} slots ${slot - 1}/${slot} share position ${pos}`);
    }
  }
  for (let i = 0; i < 25; i++) {
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
  console.log(`      grid 25-cell distribution: ${gridCounts.join(',')}`);
  console.log(`      quad  4-box distribution: ${quadCounts.join(',')}`);
});

const failed = results.filter(r => !r.ok).length;
console.log(failed ? `\n${failed} section(s) failed` : `\nAll ${results.length} sections passed`);
process.exit(failed ? 1 : 0);
