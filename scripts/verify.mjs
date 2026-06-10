import { readFileSync } from 'node:fs';
import { buildGrid, deltaE, oklchFromHex } from '../js/grid.js';
import { buildQuad, QUAD_BOX_COUNT } from '../js/quad.js';

const chars = JSON.parse(readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'));
const items = JSON.parse(readFileSync(new URL('../data/items.json', import.meta.url), 'utf8'));
console.log('characters:', chars.length, ' items:', items.length);

let errors = 0;

// --- Grid characters: 5x5 ordered-gradient invariants -------------------
//
// Hard failures (exit non-zero): the answer hex must be preserved, every
// cell must carry dE/ring metadata, and no two cells may be perceptually
// near-identical. Soft findings (reported, tolerated in small numbers):
// adjacent pairs under the target ΔE floor and small monotonicity
// inversions — both can occur at gamut corners where the dedup pass nudges
// an otherwise-flat region apart.
const ROWS = 5;
const COLS = 5;
const SEEDS = [1, 12345, 987654321];
const ANY_PAIR_HARD_MIN = 0.95;
const ADJACENT_HARD_MIN = 1.0;
// A grid is reported "soft" when its weakest seam falls clearly below the
// design target (not merely a hair under it — gamut corners legitimately
// compress a seam or two, and a single 1.9 ΔE seam among forty isn't a
// playability problem).
const ADJACENT_SOFT_FRACTION = 0.75;
const MONO_TOLERANCE = 0.004;
const SORE_THUMB_REPORT_RATIO = 2.0;

console.log('\n— grid characters (5x5, all 25 forced positions, 3 seeds) —');
let gridCount = 0;
let softAdjacent = 0;
let softMono = 0;
let softSore = 0;
let worstAdjacent = Infinity;

for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  if (!/^#[0-9A-Fa-f]{6}$/.test(c.color.hex)) {
    console.error('BAD HEX', c.id, c.color.hex);
    errors++; continue;
  }
  const want = c.color.hex.toUpperCase();
  const base = oklchFromHex(want);
  // Mirrors adjacentFloorFor in grid.js: the raised low-chroma floor only
  // applies at mid lightness, where the family has room to spread.
  const midL = base.L >= 0.35 && base.L <= 0.80;
  const adjacentFloor = base.C < 0.09 && midL ? 2.8 : 2.0;
  let charSoft = 0;

  for (let pos = 0; pos < ROWS * COLS; pos++) {
    for (const seed of SEEDS) {
      const g = buildGrid(want, {
        rows: ROWS, cols: COLS, seed,
        correctRow: Math.floor(pos / COLS), correctCol: pos % COLS,
      });
      gridCount++;

      const cc = g.cells[g.correctRow][g.correctCol];
      if (cc.hex !== want || !cc.isCorrect) {
        console.error(`MISMATCH ${c.id} pos ${pos} seed ${seed}: want ${want}, got ${cc.hex}`);
        errors++;
      }

      const flat = g.cells.flat();
      for (const cell of flat) {
        if (!Number.isFinite(cell.dE) || !Number.isInteger(cell.ring)) {
          console.error(`MISSING dE/ring ${c.id} pos ${pos} seed ${seed} cell ${cell.row},${cell.col}`);
          errors++;
          break;
        }
      }

      // Pairwise distinctness: every cell must be tellable from every other.
      let anyMin = Infinity;
      for (let a = 0; a < flat.length; a++) {
        for (let b = a + 1; b < flat.length; b++) {
          const d = deltaE(flat[a].hex, flat[b].hex);
          if (d < anyMin) anyMin = d;
        }
      }
      if (anyMin < ANY_PAIR_HARD_MIN) {
        console.error(`NEAR-DUPLICATE ${c.id} pos ${pos} seed ${seed}: min pair ΔE ${anyMin.toFixed(2)}`);
        errors++;
      }

      // Adjacent-pair floor: hard minimum + soft report against the target.
      // Tracked per axis for the sore-thumb comparison below (vertical
      // lightness steps are legitimately larger than horizontal ones).
      const adjacentH = [];
      const adjacentV = [];
      for (let r = 0; r < ROWS; r++) {
        for (let col = 0; col < COLS; col++) {
          if (col + 1 < COLS) adjacentH.push(deltaE(g.cells[r][col].hex, g.cells[r][col + 1].hex));
          if (r + 1 < ROWS) adjacentV.push(deltaE(g.cells[r][col].hex, g.cells[r + 1][col].hex));
        }
      }
      const adjMin = Math.min(...adjacentH, ...adjacentV);
      if (adjMin < worstAdjacent) worstAdjacent = adjMin;
      if (adjMin < ADJACENT_HARD_MIN) {
        console.error(`ADJACENT TOO CLOSE ${c.id} pos ${pos} seed ${seed}: ${adjMin.toFixed(2)}`);
        errors++;
      } else if (adjMin < adjacentFloor * ADJACENT_SOFT_FRACTION) {
        softAdjacent++; charSoft++;
      }

      // Per-column lightness monotonicity (pale top → deep bottom), with a
      // small tolerance for dedup nudges in gamut-flattened regions.
      let monoOk = true;
      for (let col = 0; col < COLS; col++) {
        for (let r = 1; r < ROWS; r++) {
          const above = oklchFromHex(g.cells[r - 1][col].hex).L;
          const below = oklchFromHex(g.cells[r][col].hex).L;
          if (below > above + MONO_TOLERANCE) monoOk = false;
        }
      }
      if (!monoOk) { softMono++; charSoft++; }

      // Sore-thumb: each of the answer's seams vs the SAME seam position in
      // the parallel lines. Step sizes legitimately vary by position (a
      // bigger gap between rows 3 and 4 appears in every column at once and
      // tells the player nothing) — only a seam that's bigger at the
      // answer's line than at the same position elsewhere is exploitable.
      const median = ds => {
        const sorted = ds.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      let sore = false;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const r = g.correctRow + dr;
        const col = g.correctCol + dc;
        if (r < 0 || r >= ROWS || col < 0 || col >= COLS) continue;
        const d = deltaE(cc.hex, g.cells[r][col].hex);
        const parallel = [];
        if (dr === 0) {
          // Horizontal seam between correctCol and col — same pair in other rows.
          for (let rr = 0; rr < ROWS; rr++) {
            if (rr === g.correctRow) continue;
            parallel.push(deltaE(g.cells[rr][g.correctCol].hex, g.cells[rr][col].hex));
          }
        } else {
          // Vertical seam between correctRow and r — same pair in other columns.
          for (let cc2 = 0; cc2 < COLS; cc2++) {
            if (cc2 === g.correctCol) continue;
            parallel.push(deltaE(g.cells[g.correctRow][cc2].hex, g.cells[r][cc2].hex));
          }
        }
        const m = median(parallel);
        if (m > 0 && d > m * SORE_THUMB_REPORT_RATIO) sore = true;
      }
      if (sore) { softSore++; charSoft++; }
    }
  }
  const note = charSoft ? `  soft findings: ${charSoft}` : '';
  console.log(`#${String(i + 1).padStart(2, '0')} ${c.name.padEnd(24)} ${want}${note}`);
}

console.log(`\ngrids built: ${gridCount}`);
console.log(`worst adjacent ΔE: ${worstAdjacent.toFixed(2)}`);
console.log(`soft findings — adjacent under target floor: ${softAdjacent}, monotonicity nudges: ${softMono}, sore-thumb ratio: ${softSore}`);
// Soft findings are tolerated at gamut corners but must stay rare.
const softTotal = softAdjacent + softMono + softSore;
if (softTotal > gridCount * 0.05) {
  console.error(`TOO MANY SOFT FINDINGS: ${softTotal} over ${gridCount} grids (> 5%)`);
  errors++;
}

console.log('\n— quad items —');
for (let i = 0; i < items.length; i++) {
  const c = items[i];
  if (!/^#[0-9A-Fa-f]{6}$/.test(c.color.hex)) {
    console.error('BAD HEX', c.id, c.color.hex);
    errors++; continue;
  }
  const q = buildQuad(c.color.hex, { seed: i + 1, palette: c.quadPalette, combo: c.combo });
  if (q.boxes.length !== QUAD_BOX_COUNT) {
    console.error(`BAD BOX COUNT ${c.id}: ${q.boxes.length}`);
    errors++;
  }
  const correctBox = q.boxes[q.correctIndex];
  const want = c.color.hex.toUpperCase();
  if (!correctBox.isCorrect || correctBox.hex !== want) {
    console.error(`MISMATCH ${c.id}: want ${want}, got ${correctBox.hex} (isCorrect=${correctBox.isCorrect})`);
    errors++;
  }
  // All four hexes must be unique — no two boxes the same color
  const hexes = q.boxes.map(b => b.hex);
  const unique = new Set(hexes);
  if (unique.size !== QUAD_BOX_COUNT) {
    console.error(`DUPLICATE BOXES ${c.id}: ${hexes.join(' ')}`);
    errors++;
  }
  console.log(`#${String(i + 1).padStart(2, '0')} ${(c.name + ' (' + (c.show || '') + ')').padEnd(54)} ${want}  correct@${q.correctIndex}  boxes=[${hexes.join(' ')}]`);
}

console.log(errors ? `\nFAIL ${errors}` : '\nALL OK');
process.exit(errors ? 1 : 0);
