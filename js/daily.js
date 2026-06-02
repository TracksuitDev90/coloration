// Daily-puzzle helpers. The set of three characters and each round's grid
// seed are derived from the UTC date, so every player worldwide sees the
// same puzzle until UTC midnight rolls over to the next day.

import { hexToHsl } from './grid.js';

// Four fresh entries per UTC day. This is both the default daily slice size
// and the `slotsPerDay` stride the cross-day position rotation advances by, so
// each day surfaces a new quartet and the answer position keeps rotating
// cleanly.
const CHARACTERS_PER_DAY = 4;

// Day 0 of the rotation. Day index 0 picks the first slice of the pool;
// each subsequent day advances by CHARACTERS_PER_DAY so every entry surfaces
// once before any repeat. New characters appended later don't disturb the
// already-played schedule — they only show up on later days.
//
// Exported so the verify scripts can derive their day-keys from the same
// source of truth instead of hardcoding a duplicate date that would
// silently drift if this constant ever changes.
export const ROTATION_EPOCH = '2026-06-02';

export function getUtcDateKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// FNV-1a — small, stable, plenty for seeding.
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

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

function parseUtcDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return Date.UTC(2026, 5, 2);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function daysBetween(fromKey, toKey) {
  const ms = parseUtcDateKey(toKey) - parseUtcDateKey(fromKey);
  return Math.floor(ms / 86400000);
}

function shuffleSeeded(items, seed) {
  const out = items.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Picks `count` entries the player hasn't seen yet, deterministically
// seeded by date so refreshing the page returns the same trio. When the
// unseen pool runs short of `count`, the caller is told the roster wrapped
// so it can clear its seen-record before the next call.
//
// After the seeded shuffle the picks are re-interleaved by hue family so the
// daily order never strings together a run of same-family colors (e.g. four
// pinks in a row). The interleave is deterministic per date+mode.
//
// Returns { picks, exhausted } — `exhausted` is true when the unseen pool
// could not satisfy the request and we fell back to the full pool.
export function pickFreshDailyCharacters(allCharacters, dateKey, seenIds, mode = '', count = CHARACTERS_PER_DAY) {
  if (!allCharacters?.length) return { picks: [], exhausted: false };
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  const unseen = allCharacters.filter(c => !seen.has(c.id));
  const exhausted = unseen.length < count;
  const pool = exhausted ? allCharacters : unseen;
  const ordered = shuffleSeeded(pool, hashString(`fresh:${mode}:${dateKey}`));
  const sliced = pickSpacedSlice(ordered, Math.min(count, pool.length));
  const spread = spreadByHueFamily(sliced, hashString(`spread:${mode}:${dateKey}`));
  return { picks: spread, exhausted };
}

// Choose `count` entries from the already-shuffled pool while holding any one
// hue family to at most ceil(count/2) of the slice. That ceiling is the most
// a family can occupy and still admit an ordering with no two same-family
// rounds adjacent — so spreadByHueFamily below can always separate the colors
// and the day never surfaces the same general color back to back. (Two oranges
// in a four-round day is fine; two oranges *in a row* is not.)
//
// Entries are taken in the pool's existing seeded, unseen-first order so the
// daily rotation and determinism are untouched; the cap only defers a third
// same-family entry to a later day. If the pool is too homogeneous to fill the
// slice under the cap, the deferred overflow tops it up (still in seeded order)
// so the slice always reaches `count` and coverage of the roster is preserved.
function pickSpacedSlice(ordered, count) {
  if (ordered.length <= count) return ordered.slice();
  const cap = Math.ceil(count / 2);
  const famCount = new Map();
  const picked = [];
  const deferred = [];
  for (const c of ordered) {
    if (picked.length >= count) break;
    const fam = hueFamily(c.color?.hex);
    const n = famCount.get(fam) ?? 0;
    if (n < cap) {
      picked.push(c);
      famCount.set(fam, n + 1);
    } else {
      deferred.push(c);
    }
  }
  for (const c of deferred) {
    if (picked.length >= count) break;
    picked.push(c);
  }
  return picked;
}

// Round-robin draws one character at a time from each hue-family bucket so
// the final order alternates families. Inside each bucket entries keep their
// already-shuffled order, so the daily set stays the same — only the position
// of each character moves to avoid runs of the same color. When the only
// remaining queues match the just-emitted family the loop falls back to the
// largest pool to keep progress; some clustering is unavoidable when a single
// family dominates the pool.
function spreadByHueFamily(list, seed) {
  if (list.length <= 2) return list.slice();
  const buckets = new Map();
  for (const c of list) {
    const fam = hueFamily(c.color?.hex);
    if (!buckets.has(fam)) buckets.set(fam, []);
    buckets.get(fam).push(c);
  }
  // Seeded shuffle of bucket order so family-presentation rotates day to day,
  // then a stable size sort so the largest pool always leads each pass and
  // tail clusters don't form.
  const queues = [...buckets.values()].map(arr => arr.slice());
  const rng = mulberry32(seed);
  for (let i = queues.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [queues[i], queues[j]] = [queues[j], queues[i]];
  }
  queues.sort((a, b) => b.length - a.length);

  const out = [];
  let lastFam = null;
  while (out.length < list.length) {
    queues.sort((a, b) => b.length - a.length);
    // Largest non-empty queue whose head isn't the same family we just emitted.
    let pick = queues.find(q => q.length && hueFamily(q[0].color?.hex) !== lastFam);
    if (!pick) pick = queues.find(q => q.length);
    if (!pick) break;
    const next = pick.shift();
    out.push(next);
    lastFam = hueFamily(next.color?.hex);
  }
  return out;
}

// Bucket a hex into a coarse perceived hue family. Saturation + lightness
// gate the chromatic-vs-neutral split so very light/dark or grayish colors
// don't get lumped in with vivid hues that happen to share their angle.
export function hueFamily(hex) {
  if (!hex) return 'unknown';
  const { h, s, l } = hexToHsl(hex);
  if (s < 14 || l < 12 || l > 92) {
    if (l < 25) return 'black';
    if (l > 80) return 'white';
    return 'gray';
  }
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 65) return 'yellow';
  if (h < 95) return 'lime';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 240) return 'blue';
  if (h < 280) return 'indigo';
  if (h < 320) return 'purple';
  return 'pink';
}

// Non-deterministic Fisher-Yates. Used for the live game so every visit
// reshuffles the round order rather than locking everyone to the same daily
// sequence.
export function shuffleCharacters(allCharacters) {
  if (!allCharacters?.length) return [];
  const pool = allCharacters.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// Deterministically walk the correct cell around a board of `totalCells`
// positions so the answer truly rotates round-to-round, day-to-day. Within a
// single day each of the `slotsPerDay` rounds gets a different position, and
// across days the same slot cycles through every cell before any repeat — so
// even the same character/item on a later day lands on a fresh spot.
//
// `step` must be coprime to `totalCells`; that gives a full cycle. The
// defaults below cover the two boards in play (16-cell grid, 4-swatch quad).
export function positionForRound(dateKey, slotIndex, totalCells, slotsPerDay = CHARACTERS_PER_DAY) {
  if (!Number.isInteger(totalCells) || totalCells <= 0) return 0;
  const dayIndex = Math.max(0, daysBetween(ROTATION_EPOCH, dateKey));
  const linear = dayIndex * slotsPerDay + slotIndex;
  const step = totalCells === 16 ? 7 : totalCells === 4 ? 3 : 1;
  return ((linear * step) % totalCells + totalCells) % totalCells;
}

// Deterministic per-round board seed. Keyed off the UTC date, mode, and round
// slot so the exact board (ramp layout + decoys) is identical for every player
// and stable across refreshes — even if a localStorage write fails, reloading
// regenerates the same seed rather than relocating the answer mid-puzzle.
export function seedForRound(dateKey, mode, slotIndex) {
  return hashString(`${dateKey}:${mode}:${slotIndex}`);
}

export function msUntilNextUtcDay(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(0, next - now.getTime());
}

export function formatCountdown(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
