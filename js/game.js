// Daily-mode game state. An endless run keyed to the UTC date: the player
// works through the roster a round at a time. State persists per UTC day in
// localStorage so refreshing mid-puzzle resumes where the player left off;
// rolling over to a new UTC day starts fresh. Each mode (items / grid) gets
// its own independent slot.
//
// Two board kinds, mixed within the same daily run:
//   grid — 4x4 shade picker, 3 guesses, axis hints after the 2nd miss
//   quad — 4 distinct color swatches, 1 guess, no hints
//
// Skips: a skipped round is neither won nor lost — it just advances the run.
// The skip budget (MAX_SKIPS_PER_MODE) is normally two per mode per day, and
// the UI shows the remaining count.
//
// Streaks are day-based, not guess-based: consecutive days of finishing the
// daily run, tracked in main.js. There is no per-guess streak here.

import { buildGrid } from './grid.js';
import { buildQuad } from './quad.js';
import { positionForRound, seedForRound } from './daily.js';

const STORAGE_KEYS = {
  // In-progress daily run. Bumped v4 -> v5 alongside the seen/lock keys in
  // main.js so today's puzzle resets fresh instead of resuming the pre-reset
  // rounds (which referenced the old open-ended daily selection).
  daily: 'wcat:v5:daily',
};

const GRID_MAX_GUESSES = 3;
const QUAD_MAX_GUESSES = 1;
const GRID_SIZE = 4;
// TEMP: skip limit lifted for accuracy verification so every round can be
// flipped through freely. The chip and skip button already collapse to plain
// "Skip" labels for values >= 10. Restore to 2 to re-enable the daily budget.
export const MAX_SKIPS_PER_MODE = Infinity;

// All 16 positions on the 4x4 grid, ordered row-major. The answer
// rotates through these across rounds and days, and the grid ramp
// reorients around whichever cell holds the answer — so a corner
// answer pulls the gradient diagonally across the board, and a centre
// answer fans the ramp outward. Corners are safe now that the
// generator's asymmetric ramp logic handles edge positions cleanly.
const GRID_POSITIONS = [
  [0, 0], [0, 1], [0, 2], [0, 3],
  [1, 0], [1, 1], [1, 2], [1, 3],
  [2, 0], [2, 1], [2, 2], [2, 3],
  [3, 0], [3, 1], [3, 2], [3, 3],
];

export function maxGuessesFor(character) {
  return character?.type === 'item' ? QUAD_MAX_GUESSES : GRID_MAX_GUESSES;
}

export function createDailyGame(dailyCharacters, dateKey, options = {}) {
  if (!dailyCharacters?.length) throw new Error('createDailyGame: no characters');
  const mode = options.mode || (dailyCharacters[0].type === 'item' ? 'items' : 'grid');
  const charIds = dailyCharacters.map(c => c.id);

  const all = readDaily();
  const sameDay = all && all.date === dateKey;
  const stored = sameDay ? all[mode] : null;

  let rounds, currentIndex, skipsUsed;
  if (stored && Array.isArray(stored.rounds) && arrayEqual(stored.charIds, charIds)) {
    rounds = dailyCharacters.map((c, i) => {
      const sr = stored.rounds[i] || {};
      return {
        charId: c.id,
        guesses: Array.isArray(sr.guesses) ? sr.guesses.slice() : [],
        won: !!sr.won,
        lost: !!sr.lost,
        skipped: !!sr.skipped,
        seed: Number.isFinite(sr.seed) ? sr.seed : null,
      };
    });
    currentIndex = clampInt(stored.currentIndex, 0, rounds.length - 1);
    skipsUsed = clampInt(stored.skipsUsed, 0, MAX_SKIPS_PER_MODE);
  } else {
    rounds = dailyCharacters.map(c => ({
      charId: c.id,
      guesses: [],
      won: false,
      lost: false,
      skipped: false,
      seed: null,
    }));
    currentIndex = 0;
    skipsUsed = 0;
  }

  const state = {
    date: dateKey,
    mode,
    characters: dailyCharacters,
    rounds,
    currentIndex,
    skipsUsed,
    board: null,
    revealed: false,
  };

  loadCurrent();

  function loadCurrent() {
    const c = state.characters[state.currentIndex];
    const round = state.rounds[state.currentIndex];
    // Per-round seed is derived deterministically from the date, mode, and
    // round slot, so the board is identical for every player and stable across
    // refreshes — no localStorage write is required to keep the answer put.
    // Older saved games may carry a random seed; honour it so in-progress
    // boards don't shift, but fresh rounds use the deterministic value.
    if (round.seed == null) {
      round.seed = seedForRound(state.date, mode, state.currentIndex);
    }
    if (c.type === 'item') {
      const correctIndex = positionForRound(state.date, state.currentIndex, 4);
      state.board = buildQuad(c.color.hex, {
        seed: round.seed,
        palette: c.quadPalette,
        combo: c.combo,
        correctIndex,
      });
    } else {
      const pos = positionForRound(state.date, state.currentIndex, GRID_POSITIONS.length);
      const [correctRow, correctCol] = GRID_POSITIONS[pos];
      state.board = {
        kind: 'grid',
        ...buildGrid(c.color.hex, {
          rows: GRID_SIZE, cols: GRID_SIZE, seed: round.seed,
          correctRow, correctCol,
        }),
      };
    }
    state.revealed = isRoundDone(round);
  }

  function currentMaxGuesses() {
    return maxGuessesFor(state.characters[state.currentIndex]);
  }

  function guess(pos) {
    if (state.revealed || isComplete()) return { kind: 'noop' };
    const round = state.rounds[state.currentIndex];
    if (isRoundDone(round)) return { kind: 'noop' };
    const cell = cellAt(pos);
    if (!cell) return { kind: 'noop' };
    round.guesses.push({ ...pos, correct: cell.isCorrect });
    if (cell.isCorrect) {
      round.won = true;
      state.revealed = true;
      persist();
      return { kind: 'correct', cell };
    }
    if (round.guesses.length >= currentMaxGuesses()) {
      round.lost = true;
      state.revealed = true;
      persist();
      return { kind: 'exhausted', correctCell: correctCell() };
    }
    persist();
    return { kind: 'wrong', cell, guessesLeft: currentMaxGuesses() - round.guesses.length };
  }

  function skip() {
    if (isComplete()) return { kind: 'noop' };
    if (state.skipsUsed >= MAX_SKIPS_PER_MODE) return { kind: 'no-skips' };
    const round = state.rounds[state.currentIndex];
    if (isRoundDone(round)) return { kind: 'noop' };
    round.skipped = true;
    state.skipsUsed += 1;
    state.revealed = true;
    persist();
    return {
      kind: 'skipped',
      skipsLeft: MAX_SKIPS_PER_MODE - state.skipsUsed,
      correctCell: correctCell(),
    };
  }

  function next() {
    let nextIndex = state.currentIndex + 1;
    while (nextIndex < state.rounds.length && isRoundDone(state.rounds[nextIndex])) {
      nextIndex++;
    }
    if (nextIndex >= state.characters.length) {
      return { kind: 'finished' };
    }
    state.currentIndex = nextIndex;
    loadCurrent();
    persist();
    return { kind: 'round', round: state.currentIndex };
  }

  function cellAt(pos) {
    if (state.board.kind === 'quad') return state.board.boxes[pos.index];
    return state.board.cells[pos.row]?.[pos.col];
  }

  function correctCell() {
    if (state.board.kind === 'quad') return state.board.boxes[state.board.correctIndex];
    return state.board.cells[state.board.correctRow][state.board.correctCol];
  }

  function isComplete() {
    return state.rounds.every(isRoundDone);
  }

  function snapshot() {
    const round = state.rounds[state.currentIndex];
    const max = currentMaxGuesses();
    return {
      date: state.date,
      mode: state.mode,
      characters: state.characters,
      character: state.characters[state.currentIndex],
      rounds: state.rounds,
      roundIndex: state.currentIndex,
      totalRounds: state.characters.length,
      guessesLeft: max - round.guesses.length,
      revealed: state.revealed,
      finished: isComplete(),
      wrongGuesses: round.guesses.filter(g => !g.correct),
      board: state.board,
      maxGuesses: max,
      skipsUsed: state.skipsUsed,
      skipsLeft: MAX_SKIPS_PER_MODE - state.skipsUsed,
      maxSkips: MAX_SKIPS_PER_MODE,
    };
  }

  function persist() {
    const existing = readDaily();
    const base = existing && existing.date === dateKey ? existing : { date: dateKey };
    base[mode] = {
      charIds,
      rounds: state.rounds.map(r => ({
        charId: r.charId,
        guesses: r.guesses,
        won: r.won,
        lost: r.lost,
        skipped: r.skipped,
        seed: r.seed,
      })),
      currentIndex: state.currentIndex,
      skipsUsed: state.skipsUsed,
    };
    writeJson(STORAGE_KEYS.daily, base);
  }

  return { guess, next, skip, snapshot };
}

function isRoundDone(r) {
  return !!(r && (r.won || r.lost || r.skipped));
}

function arrayEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readDaily() {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.daily);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { reportStorageWriteFailure(); }
}

// Surface storage write failures to the UI exactly once per session so private-
// browsing visitors learn their progress won't persist, without a recurring
// nag every time persist() runs.
let storageWriteFailed = false;
let storageFailureListener = null;
function reportStorageWriteFailure() {
  if (storageWriteFailed) return;
  storageWriteFailed = true;
  if (storageFailureListener) {
    try { storageFailureListener(); } catch { /* ignore */ }
  }
}
export function onceStorageWriteFailed(listener) {
  if (typeof listener !== 'function') return;
  storageFailureListener = listener;
  if (storageWriteFailed) listener();
}

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
