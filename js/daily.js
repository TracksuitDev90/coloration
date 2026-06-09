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

// Global daily rotation. The schedule is a pure function of the roster, the
// UTC date, and the mode — no localStorage, no per-browser state — so every
// player worldwide is surfaced the exact same entries on the same day.
//
// How it works: the roster (sorted by id so JSON order doesn't matter) is
// dealt out as an endless stream of whole-roster permutations — cycle 0 is
// one seeded shuffle of every entry, cycle 1 the next, and so on. Day N takes
// stream positions [N*count, N*count + count). Because each cycle is a full
// permutation, nothing repeats until every entry in the pool has been
// surfaced, and the stream never runs dry.
//
// Each cycle's permutation is re-rolled (by bumping a salt in the seed) until
// its head avoids the previous cycle's tail, so a day's slice that straddles
// a cycle boundary can't contain the same entry twice, and an entry shown at
// the very end of one pass doesn't bounce right back at the start of the next.
//
// The day's picks are then re-interleaved by hue family so the order never
// strings together same-family colors (e.g. two pinks back to back). That
// reorder stays inside the day's slice, so the no-repeat guarantee holds.
const CYCLE_OVERLAP_GUARD = CHARACTERS_PER_DAY * 2;

export function dailyRotation(pool, dateKey, mode = '', count = CHARACTERS_PER_DAY) {
  if (!pool?.length) return [];
  const sorted = pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;
  const take = Math.min(count, n);
  const spreadSeed = hashString(`spread:${mode}:${dateKey}`);
  if (take >= n) return spreadByHueFamily(sorted, spreadSeed);

  const dayIndex = Math.max(0, daysBetween(ROTATION_EPOCH, dateKey));
  const start = dayIndex * take;

  // Cycle permutations are chained (each one's seed search depends on the
  // previous one's tail), so build them in order from cycle 0. A year of
  // four-a-day rotation over a 100-entry roster is ~15 shuffles — trivial.
  const perms = [];
  const permFor = (cycle) => {
    while (perms.length <= cycle) {
      perms.push(cyclePermutation(sorted, mode, perms.length, perms[perms.length - 1] || null));
    }
    return perms[cycle];
  };

  const picks = [];
  for (let pos = start; picks.length < take; pos++) {
    const cand = permFor(Math.floor(pos / n))[pos % n];
    // The overlap guard makes duplicates impossible for healthy pool sizes;
    // this check only matters for tiny pools where the guard had to give up.
    if (!picks.some(p => p.id === cand.id)) picks.push(cand);
  }
  return spreadByHueFamily(picks, spreadSeed);
}

// Seeded whole-roster shuffle for one rotation cycle. Bumps a salt until the
// permutation's first `guard` entries are disjoint from the previous cycle's
// last `guard` entries (see dailyRotation). The salt walk is deterministic,
// so every player lands on the same permutation. Capped so a pathologically
// small pool can't loop forever — at that size some adjacency is unavoidable.
function cyclePermutation(sorted, mode, cycle, prevPerm) {
  const guard = Math.min(CYCLE_OVERLAP_GUARD, Math.floor(sorted.length / 2));
  const tail = prevPerm && guard > 0
    ? new Set(prevPerm.slice(prevPerm.length - guard).map(c => c.id))
    : null;
  for (let salt = 0; ; salt++) {
    const perm = shuffleSeeded(sorted, hashString(`rotation:${mode}:${cycle}:${salt}`));
    if (!tail || salt >= 32 || !perm.slice(0, guard).some(c => tail.has(c.id))) {
      return perm;
    }
  }
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
