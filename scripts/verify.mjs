import { readFileSync } from 'node:fs';
import { buildGrid } from '../js/grid.js';
import { buildQuad, QUAD_BOX_COUNT } from '../js/quad.js';

const chars = JSON.parse(readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'));
const items = JSON.parse(readFileSync(new URL('../data/items.json', import.meta.url), 'utf8'));
console.log('characters:', chars.length, ' items:', items.length);

let errors = 0;

console.log('\n— grid characters —');
for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  if (!/^#[0-9A-Fa-f]{6}$/.test(c.color.hex)) {
    console.error('BAD HEX', c.id, c.color.hex);
    errors++; continue;
  }
  const g = buildGrid(c.color.hex, { rows: 4, cols: 4, seed: i + 1 });
  const cc = g.cells[g.correctRow][g.correctCol];
  const want = c.color.hex.toUpperCase();
  if (cc.hex !== want) {
    console.error(`MISMATCH ${c.id}: want ${want}, got ${cc.hex}`);
    errors++;
  }
  // Sanity: at least one neighbor should be different
  const dr = g.correctRow > 0 ? -1 : 1;
  const neighbor = g.cells[g.correctRow + dr][g.correctCol];
  if (neighbor.hex === cc.hex) {
    console.error(`NEIGHBOR EQUAL ${c.id}`);
    errors++;
  }
  console.log(`#${String(i + 1).padStart(2, '0')} ${c.name.padEnd(24)} ${want}  correct@(r${g.correctRow},c${g.correctCol})`);
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
