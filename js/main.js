import { loadCharacters } from './characters.js';
import { createDailyGame, onceStorageWriteFailed } from './game.js';
import {
  getUtcDateKey,
  pickFreshDailyCharacters,
  msUntilNextUtcDay,
  formatCountdown,
} from './daily.js';
import {
  renderShareCard,
  renderCombinedShareCard,
  shareCanvas,
  shareText,
  combinedShareText,
  shareLinkUrl,
  decodeSharePayload,
  snapshotFromPayload,
} from './share.js';
import { initTitleBlob } from './blob.js';

initTitleBlob();

const COL_LABELS = ['A', 'B', 'C', 'D'];
const GRID_SIZE = 4;
const ROUNDS_PER_DAY = 999;

// Per-mode localStorage keys. Seen records the IDs the player has already
// encountered (so each day surfaces fresh entries until the roster wraps).
// Lock pins today's selection so refreshing the page returns the same trio
// even after the IDs were already moved into the seen record.
const STORAGE_SEEN = { items: 'wcat:v2:seen:items', grid: 'wcat:v2:seen:grid' };
const STORAGE_LOCK = { items: 'wcat:v2:daily-lock:items', grid: 'wcat:v2:daily-lock:grid' };
// Last UTC date the player opened the app. Compared to today's key on init
// to surface a "fresh puzzles" prompt and to detect midnight rollovers
// while the page is backgrounded.
const STORAGE_LAST_VISIT = 'wcat:v2:last-visit';

function selectDailyFresh(pool, key, mode) {
  if (!pool.length) return [];
  const byId = new Map(pool.map(c => [c.id, c]));

  const lock = readJson(STORAGE_LOCK[mode]);
  if (lock && lock.date === key && Array.isArray(lock.ids)) {
    const restored = lock.ids.map(id => byId.get(id)).filter(Boolean);
    if (restored.length === Math.min(ROUNDS_PER_DAY, pool.length)) {
      return restored;
    }
  }

  let seen = new Set(readJson(STORAGE_SEEN[mode]) || []);
  // Drop stale IDs that no longer exist in the roster so a shrunk pool
  // can't permanently lock the player out of a fresh cycle.
  for (const id of [...seen]) if (!byId.has(id)) seen.delete(id);

  let result = pickFreshDailyCharacters(pool, key, seen, mode, ROUNDS_PER_DAY);
  if (result.exhausted) {
    seen = new Set();
    result = pickFreshDailyCharacters(pool, key, seen, mode, ROUNDS_PER_DAY);
  }
  for (const c of result.picks) seen.add(c.id);
  writeJson(STORAGE_SEEN[mode], [...seen]);
  writeJson(STORAGE_LOCK[mode], { date: key, ids: result.picks.map(c => c.id) });
  return result.picks;
}

function readJson(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const els = {
  img: document.getElementById('character-img'),
  name: document.getElementById('character-name'),
  photoFrame: document.getElementById('photo-frame'),
  board: document.getElementById('board'),
  grid: document.getElementById('grid'),
  colHeaders: document.getElementById('col-headers'),
  rowHeaders: document.getElementById('row-headers'),
  quad: document.getElementById('quad'),
  status: document.getElementById('status'),
  next: document.getElementById('next-btn'),
  skip: document.getElementById('skip-btn'),
  share: document.getElementById('share-btn'),
  link: document.getElementById('link-btn'),
  copyResult: document.getElementById('copy-btn'),
  shareSlot: document.getElementById('share-slot'),
  shareActions: document.getElementById('share-actions'),
  countdown: document.getElementById('countdown'),
  characterCard: document.getElementById('character-card'),
  roundChip: document.getElementById('round-chip'),
  streakChip: document.getElementById('streak-chip'),
  bestChip: document.getElementById('best-chip'),
  guessesChip: document.getElementById('guesses-chip'),
  skipsChip: document.getElementById('skips-chip'),
  tabItems: document.getElementById('tab-items'),
  tabGrid: document.getElementById('tab-grid'),
  tabs: document.getElementById('tabs'),
  stage: document.getElementById('stage'),
};

// Each tab is a separate experience: items use the 4-swatch quad and
// characters use the 5x5 shade grid. The two games run in parallel; switching
// tabs swaps which one is being played without touching the other's progress.
const games = { items: null, grid: null };
let mode = 'items';
let game;
let dateKey;
let focusRow = 0;
let focusCol = 0;
let countdownTimer = null;
let cachedShareCanvas = null;
// Pending "finished, show share card after 1.1s" timer. Stashed so a tab
// switch can cancel it — without that, the timer fires against whichever
// game is current at firing time and can blow away an in-progress UI.
let finishedAnnounceTimer = null;
let finishedAnnounceGame = null;
// armDateRolloverReload is defined far below, but init() pokes at the
// teardown handle synchronously on entry — so the bindings have to exist
// before the `init()` call below to avoid a TDZ ReferenceError.
let dateRolloverArmed = false;
let dateRolloverTeardown = null;

init();

async function init() {
  // Tear down any rollover registration from a prior init() attempt so the
  // retry path re-arms against a fresh `dateKey` (which may have rolled
  // over while the user sat on the error screen) instead of leaving the
  // previous closures bound to the old date.
  dateRolloverTeardown?.();
  cancelFinishedAnnounce();
  showLoading();
  try {
    const chars = await loadCharacters();
    dateKey = getUtcDateKey();

    // Read-only "view someone else's results" mode — kicked off when the
    // page loads with ?s=<encoded share>. Skip the rest of game setup so
    // we never overwrite the visitor's own progress with the shared one.
    const params = new URLSearchParams(window.location.search);
    const sharedParam = params.get('s');
    if (sharedParam) {
      const ok = await tryRenderSharedView(sharedParam, chars);
      if (ok) {
        // Still record today's visit and arm the midnight-rollover reload
        // for shared views — leaving the tab open past UTC midnight should
        // refresh into the new day rather than sit on stale shared data.
        writeJson(STORAGE_LAST_VISIT, dateKey);
        armDateRolloverReload();
        return;
      }
      // Decode failed (corrupt/expired link). Strip the param so it doesn't
      // stick around on refresh, surface a one-time toast, then fall through
      // to the normal daily game.
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('s');
      window.history.replaceState({}, '', cleanUrl.toString());
      toast("That share link couldn't be read — showing today's puzzle instead.");
    }

    const itemPool = chars.filter(c => c.type === 'item');
    const gridPool = chars.filter(c => c.type !== 'item');
    const itemDaily = selectDailyFresh(itemPool, dateKey, 'items');
    const gridDaily = selectDailyFresh(gridPool, dateKey, 'grid');
    games.items = itemDaily.length
      ? createDailyGame(itemDaily, dateKey, { mode: 'items' })
      : null;
    games.grid = gridDaily.length
      ? createDailyGame(gridDaily, dateKey, { mode: 'grid' })
      : null;
    renderHeaders();
    applyTabAvailability();
    if (!games.items && !games.grid) {
      throw new Error('No puzzles available — both rosters are empty.');
    }
    setMode(games.items ? 'items' : 'grid');
    onceStorageWriteFailed(() => {
      toast("Your progress won't be saved in this browsing mode.");
    });

    // New-day awareness. If the player has visited before and the UTC date has
    // ticked over since their last visit, surface a friendly nudge so they
    // know the daily roster (items + characters) is freshly rotated. Always
    // record today's visit so future returns can compare.
    const lastVisit = readJson(STORAGE_LAST_VISIT);
    if (typeof lastVisit === 'string' && lastVisit !== dateKey) {
      // Defer slightly so the toast doesn't collide with the loading-state swap.
      setTimeout(() => toast('A new day — fresh items and characters await!'), 600);
    }
    writeJson(STORAGE_LAST_VISIT, dateKey);
    armDateRolloverReload();
  } catch (err) {
    showInitError(err);
  }
}

function showLoading() {
  els.stage?.classList.remove('stage--finished');
  els.characterCard.hidden = true;
  els.board.hidden = true;
  els.quad.hidden = true;
  els.status.innerHTML = '<span class="spinner" aria-hidden="true"></span>Loading today\'s puzzle…';
}

function showInitError(err) {
  els.stage?.classList.remove('stage--finished');
  els.characterCard.hidden = true;
  els.board.hidden = true;
  els.quad.hidden = true;
  els.status.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = "Couldn't load today's puzzle. ";
  els.status.appendChild(msg);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn--ghost btn--inline';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => { init(); });
  els.status.appendChild(retry);
  if (err?.message) {
    const detail = document.createElement('div');
    detail.className = 'status-detail';
    detail.textContent = err.message;
    els.status.appendChild(detail);
  }
}

async function tryRenderSharedView(s, allCharacters) {
  const payload = decodeSharePayload(s);
  if (!payload) return false;
  const snap = snapshotFromPayload(payload, allCharacters);
  if (!snap) return false;
  // Read-only view: rip out the live UI so the player's own progress is
  // never touched, and so the share-action button listeners (which expect a
  // running game) never fire.
  document.querySelector('.tabs')?.setAttribute('hidden', '');
  els.characterCard.hidden = true;
  els.board.hidden = true;
  els.quad.hidden = true;
  els.skip.hidden = true;
  els.next.hidden = true;
  els.name.textContent = '';
  const wins = snap.rounds.filter(r => r.won).length;
  els.status.textContent = `Shared result · ${snap.date} · ${wins} of ${snap.rounds.length} solved`;
  els.stage?.classList.add('stage--finished');
  els.shareSlot.hidden = false;
  const canvas = await renderShareCard(snap);
  canvas.classList.add('share-card');
  els.shareSlot.replaceChildren(canvas);
  // Drop the original share-action buttons entirely and replace with a
  // single "Play today" CTA. Replacing the contents removes the stale
  // listeners so we don't accidentally fire them.
  els.shareActions.hidden = false;
  els.shareActions.innerHTML = '';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'btn btn--primary';
  playBtn.textContent = 'Play today\'s puzzle';
  playBtn.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    window.location.href = url.toString();
  });
  els.shareActions.appendChild(playBtn);
  return true;
}

function setMode(next) {
  if (next !== 'items' && next !== 'grid') return;
  if (!games[next]) return;
  const changing = next !== mode;
  mode = next;
  game = games[mode];
  if (els.tabs) els.tabs.dataset.active = mode;
  els.tabItems.classList.toggle('tab--active', mode === 'items');
  els.tabItems.setAttribute('aria-selected', mode === 'items' ? 'true' : 'false');
  // tabindex: only the active tab is in the Tab-key order; arrow keys cycle
  // between tabs while inside the tablist. Matches the ARIA tab pattern.
  els.tabItems.tabIndex = mode === 'items' ? 0 : -1;
  els.tabGrid.classList.toggle('tab--active', mode === 'grid');
  els.tabGrid.setAttribute('aria-selected', mode === 'grid' ? 'true' : 'false');
  els.tabGrid.tabIndex = mode === 'grid' ? 0 : -1;
  if (els.stage) {
    els.stage.setAttribute('aria-labelledby', mode === 'items' ? 'tab-items' : 'tab-grid');
  }
  // Don't pre-clear the share slot here. If the destination tab is also
  // finished, showFinished() will swap the canvas in place — clearing first
  // would briefly flash an empty slot during the async re-render.
  // renderRound() handles its own hideShareSlot() when entering an in-progress
  // round, so unfinished destinations are still cleaned up.
  const apply = () => {
    if (game.snapshot().finished) {
      showFinished();
    } else {
      renderRound();
    }
  };
  // Any deferred announce from the previous mode is now stale — its
  // showFinished() would read the wrong game's snapshot and clobber the
  // freshly rendered round.
  if (changing) cancelFinishedAnnounce();
  if (changing && els.stage) {
    crossfadeStage(apply);
  } else {
    apply();
  }
}

function scheduleFinishedAnnounce() {
  cancelFinishedAnnounce();
  finishedAnnounceGame = game;
  finishedAnnounceTimer = setTimeout(() => {
    finishedAnnounceTimer = null;
    // Bail if the player switched tabs while we were waiting — `game`
    // would now point at the other mode.
    if (finishedAnnounceGame !== game) return;
    finishedAnnounceGame = null;
    showFinished();
  }, 1100);
}

function cancelFinishedAnnounce() {
  if (finishedAnnounceTimer) {
    clearTimeout(finishedAnnounceTimer);
    finishedAnnounceTimer = null;
  }
  finishedAnnounceGame = null;
}

// Two-frame opacity dip on the stage. Fade out, swap content on the next
// frame, then fade back in — the tab indicator's CSS transition runs in
// parallel so the whole swap reads as one motion.
function crossfadeStage(apply) {
  els.stage.classList.add('stage--switching');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      apply();
      els.stage.classList.remove('stage--switching');
    });
  });
}

// Cheap idle-time prefetch so the next character's photo is in the HTTP
// cache by the time the player taps "Next round".
function prefetchImage(src) {
  if (!src || src.startsWith('data:')) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
}

function applyTabAvailability() {
  // Hide tabs whose roster ended up empty. Clicking a no-op tab and seeing
  // nothing happen is more confusing than just not showing it. If only one
  // mode is available we hide the whole tablist — there's nothing to
  // switch between, and the sliding pill is built assuming both halves
  // exist. init() throws when neither mode is available so the error UI
  // takes over in that case.
  const pairs = [['items', els.tabItems], ['grid', els.tabGrid]];
  for (const [m, btn] of pairs) {
    btn.hidden = !games[m];
  }
  if (els.tabs) {
    const count = (games.items ? 1 : 0) + (games.grid ? 1 : 0);
    els.tabs.hidden = count < 2;
  }
}

function renderHeaders() {
  els.colHeaders.innerHTML = COL_LABELS
    .map((l, i) => `<span class="hdr" data-col="${i}">${l}</span>`).join('');
  els.rowHeaders.innerHTML = Array.from({ length: GRID_SIZE }, (_, i) =>
    `<span class="hdr" data-row="${i}">${i + 1}</span>`).join('');
}

function clearHints() {
  for (const h of document.querySelectorAll('.hdr--hint-negative')) {
    h.classList.remove('hdr--hint-negative');
  }
}

// After two wrong guesses, mark one row OR column as "not the answer". The
// player goes from 16 → 12 candidates without the previous behavior's
// failure mode where a row-match and column-match together pinpointed the
// exact cell. Choice of which axis and which row/col is seeded so it stays
// stable across reloads.
function applyNegativeHint() {
  const s = game.snapshot();
  if (s.board.kind !== 'grid') return;
  const { correctRow, correctCol, rows, cols } = s.board;
  const rng = hintRng(s);

  // Candidate axes: a row/col is eligible if it is not the correct
  // row/col. We prefer rows/cols the player hasn't guessed in yet —
  // they're strictly new information. Fall back to any non-correct
  // row/col if every non-correct one already has a wrong guess.
  const guessedRows = new Set(s.wrongGuesses.map(w => w.row));
  const guessedCols = new Set(s.wrongGuesses.map(w => w.col));
  const fresh = (size, correct, guessed) => {
    const all = [];
    const preferred = [];
    for (let i = 0; i < size; i++) {
      if (i === correct) continue;
      all.push(i);
      if (!guessed.has(i)) preferred.push(i);
    }
    return preferred.length ? preferred : all;
  };
  const rowCandidates = fresh(rows, correctRow, guessedRows);
  const colCandidates = fresh(cols, correctCol, guessedCols);

  if (!rowCandidates.length && !colCandidates.length) return;
  const useRow = !colCandidates.length
    ? true
    : !rowCandidates.length
      ? false
      : rng() < 0.5;
  if (useRow) {
    const r = rowCandidates[Math.floor(rng() * rowCandidates.length)];
    els.rowHeaders
      .querySelector(`.hdr[data-row="${r}"]`)
      ?.classList.add('hdr--hint-negative');
  } else {
    const c = colCandidates[Math.floor(rng() * colCandidates.length)];
    els.colHeaders
      .querySelector(`.hdr[data-col="${c}"]`)
      ?.classList.add('hdr--hint-negative');
  }
}

// Seeded so the negative hint is identical across reloads within a round.
function hintRng(s) {
  const round = s.rounds[s.roundIndex];
  let a = ((round?.seed ?? 0) ^ 0x9E3779B9) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function isItemRound(s) {
  return s?.character?.type === 'item';
}

function renderRound() {
  hideShareSlot();
  els.stage?.classList.remove('stage--finished');
  const s = game.snapshot();
  const c = s.character;
  const round = s.rounds[s.roundIndex];

  els.characterCard.hidden = false;
  // Drop `revealed` before swapping src so the next paint always shows the
  // new image already grayscale — no momentary color flash between rounds.
  els.photoFrame.classList.remove('revealed', 'swipe-hint');
  // Clear any leftover transform/opacity from a swipe-advance.
  els.photoFrame.style.transform = '';
  els.photoFrame.style.opacity = '';
  els.photoFrame.style.transition = '';
  els.img.decoding = 'async';
  els.img.fetchPriority = 'high';
  // Force a fresh load. Without removing the attribute first, switching tabs
  // mid-round can leave the previous mode's photo visible until the next
  // image's bytes arrive — items and characters are separate experiences.
  if (els.img.getAttribute('src') !== c.imageSrc) {
    els.img.removeAttribute('src');
    els.img.src = c.imageSrc;
  }
  els.img.alt = isItemRound(s)
    ? `Scene from ${c.show || c.name} (grayscale until revealed)`
    : `Cartoon character (grayscale until revealed)`;
  // Warm the next character's photo while this one is being played.
  const nextChar = s.characters[s.roundIndex + 1];
  if (nextChar) prefetchImage(nextChar.imageSrc);

  // Title slot doubles as the question (centered above the colour grid)
  // and as the reveal for both modes. Item rounds embed the item name in
  // the question since the photo doesn't give it away; character rounds
  // stay coy with a generic prompt so the name remains the answer.
  els.name.textContent = isItemRound(s)
    ? promptText(c)
    : 'What color are they?';

  els.next.hidden = true;
  els.share.hidden = true;
  els.shareActions.hidden = true;
  if (els.copyResult) els.copyResult.hidden = true;
  els.status.textContent = isItemRound(s)
    ? 'Pick the correct color.'
    : 'Pick a shade to guess.';
  clearHints();

  if (s.board.kind === 'quad') {
    renderQuadBoard(s);
  } else {
    renderGridBoard(s);
  }

  // Replay any saved guesses for this round so refreshing mid-puzzle keeps state.
  for (const g of round.guesses) {
    const btn = guessButton(s, g);
    if (!btn) continue;
    btn.classList.add(g.correct ? 'cell--correct' : 'cell--wrong');
  }

  if (s.revealed) {
    revealRound(/*announce*/ false, /*skipped*/ round.skipped);
  } else if (s.board.kind === 'grid' && s.wrongGuesses.length >= 2) {
    applyNegativeHint();
  }

  updateChips();
  updateSkipButton();

  if (!s.revealed && s.skipsLeft > 0) {
    setTimeout(triggerSwipeHint, 600);
  }
}

function promptText(c) {
  return `What color is ${c.name}?`;
}

function revealText(c) {
  if (c.type === 'item' && c.show) {
    // For Power Rangers items the unrevealed name is the generic "Ranger's
    // suit" so the player has to guess the color; once it's revealed, prepend
    // the actual color ranger so the answer reads "Blue Ranger's suit" etc.
    if (c.quadPalette === 'power-rangers') {
      const colorWord = String(c.id).split('-')[0];
      const cap = colorWord.charAt(0).toUpperCase() + colorWord.slice(1);
      return `${cap} ${c.name} — ${c.show}`;
    }
    return `${c.name} — ${c.show}`;
  }
  return c.name;
}

function renderGridBoard(s) {
  els.board.hidden = false;
  els.quad.hidden = true;
  // If keyboard focus was inside the board (e.g. after a wrong guess re-renders
  // it), the cleared cells would drop focus to <body>. Remember so we can move
  // focus into the rebuilt board — but only then, so we never steal focus on
  // the initial page load.
  const hadFocus = els.grid.contains(document.activeElement);
  els.grid.innerHTML = '';
  for (let r = 0; r < s.board.rows; r++) {
    for (let col = 0; col < s.board.cols; col++) {
      const cell = s.board.cells[r][col];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.style.background = cell.hex;
      btn.dataset.row = r;
      btn.dataset.col = col;
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `Row ${r + 1} column ${COL_LABELS[col]}`);
      btn.tabIndex = (r === 0 && col === 0) ? 0 : -1;
      const row = r, column = col;
      attachArmedTap(btn, () => submitGuess({ row, col: column }, btn));
      btn.addEventListener('keydown', onGridKeyDown);
      els.grid.appendChild(btn);
    }
  }
  focusRow = 0;
  focusCol = 0;
  if (hadFocus) cellButton(0, 0)?.focus();
}

function renderQuadBoard(s) {
  els.board.hidden = true;
  els.quad.hidden = false;
  els.quad.innerHTML = '';
  for (const box of s.board.boxes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell quad-cell';
    btn.style.background = box.hex;
    btn.dataset.index = box.index;
    btn.setAttribute('aria-label', `Color choice ${box.index + 1}`);
    btn.tabIndex = box.index === 0 ? 0 : -1;
    const index = box.index;
    attachArmedTap(btn, () => submitGuess({ index }, btn));
    btn.addEventListener('keydown', onQuadKeyDown);
    els.quad.appendChild(btn);
  }
}

function guessButton(s, g) {
  if (s.board.kind === 'quad') {
    return els.quad.querySelector(`.quad-cell[data-index="${g.index}"]`);
  }
  return cellButton(g.row, g.col);
}

function cellButton(row, col) {
  return els.grid.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
}

function quadButton(index) {
  return els.quad.querySelector(`.quad-cell[data-index="${index}"]`);
}

// Swatch tap gesture. Arms the cell on pointerdown, commits on pointerup
// only if the finger barely moved, the page didn't scroll, and the press
// was short. A scroll initiated on a swatch (which fires pointercancel as
// the browser takes over) leaves no commit behind, so accidental taps
// while scrolling on mobile are silently dropped instead of locking in a
// guess. Mouse clicks satisfy the guard trivially (zero drift, zero
// scroll) and feel instant.
const ARM_MOVE_PX = 10;
const ARM_SCROLL_PX = 4;
const ARM_MAX_MS = 500;

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function spawnRipple(btn, e) {
  if (prefersReducedMotion.matches) return;
  const rect = btn.getBoundingClientRect();
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.left = (e.clientX - rect.left) + 'px';
  span.style.top = (e.clientY - rect.top) + 'px';
  btn.appendChild(span);
  span.addEventListener('animationend', () => span.remove(), { once: true });
  setTimeout(() => { if (span.parentNode) span.remove(); }, 600);
}

function attachArmedTap(btn, commit) {
  let armed = null;

  const disarm = () => {
    if (!armed) return;
    btn.classList.remove('cell--armed');
    try { btn.releasePointerCapture(armed.pointerId); } catch {}
    armed = null;
  };

  btn.addEventListener('pointerdown', (e) => {
    if (btn.classList.contains('cell--wrong') || btn.classList.contains('cell--correct')) return;
    if (armed) disarm();
    armed = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      scrollY: window.scrollY,
      t: performance.now(),
    };
    btn.classList.add('cell--armed');
    try { btn.setPointerCapture(e.pointerId); } catch {}
    spawnRipple(btn, e);
  });

  btn.addEventListener('pointermove', (e) => {
    if (!armed || e.pointerId !== armed.pointerId) return;
    const dx = Math.abs(e.clientX - armed.x);
    const dy = Math.abs(e.clientY - armed.y);
    if (dx + dy > ARM_MOVE_PX) disarm();
  });

  btn.addEventListener('pointerup', (e) => {
    if (!armed || e.pointerId !== armed.pointerId) {
      disarm();
      return;
    }
    const dScroll = Math.abs(window.scrollY - armed.scrollY);
    const elapsed = performance.now() - armed.t;
    const shouldCommit = dScroll <= ARM_SCROLL_PX && elapsed <= ARM_MAX_MS;
    disarm();
    if (shouldCommit) {
      commit();
      navigator.vibrate?.(10);
    }
  });

  btn.addEventListener('pointercancel', disarm);
  btn.addEventListener('lostpointercapture', disarm);
}

function onGridKeyDown(e) {
  const r = Number(e.currentTarget.dataset.row);
  const c = Number(e.currentTarget.dataset.col);
  switch (e.key) {
    case 'ArrowRight': moveGridFocus(r, Math.min(GRID_SIZE - 1, c + 1)); break;
    case 'ArrowLeft':  moveGridFocus(r, Math.max(0, c - 1)); break;
    case 'ArrowDown':  moveGridFocus(Math.min(GRID_SIZE - 1, r + 1), c); break;
    case 'ArrowUp':    moveGridFocus(Math.max(0, r - 1), c); break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      submitGuess({ row: r, col: c }, e.currentTarget);
      break;
    case 'n':
    case 'N':
      if (!els.next.hidden) els.next.click();
      break;
    case 's':
    case 'S':
      if (!els.skip.hidden && !els.skip.disabled) els.skip.click();
      break;
    default: return;
  }
  e.preventDefault();
}

function onQuadKeyDown(e) {
  // Indices are laid out as a 2x2: 0 1 / 2 3.
  // Horizontal flip: idx XOR 1. Vertical flip: idx XOR 2.
  const idx = Number(e.currentTarget.dataset.index);
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowLeft':  moveQuadFocus(idx ^ 1); break;
    case 'ArrowDown':
    case 'ArrowUp':    moveQuadFocus(idx ^ 2); break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      submitGuess({ index: idx }, e.currentTarget);
      break;
    case 'n':
    case 'N':
      if (!els.next.hidden) els.next.click();
      break;
    case 's':
    case 'S':
      if (!els.skip.hidden && !els.skip.disabled) els.skip.click();
      break;
    default: return;
  }
  e.preventDefault();
}

function moveGridFocus(r, c) {
  focusRow = r;
  focusCol = c;
  for (const btn of els.grid.querySelectorAll('.cell')) {
    const br = Number(btn.dataset.row);
    const bc = Number(btn.dataset.col);
    btn.tabIndex = (br === r && bc === c) ? 0 : -1;
  }
  cellButton(r, c)?.focus();
}

function moveQuadFocus(idx) {
  for (const btn of els.quad.querySelectorAll('.quad-cell')) {
    btn.tabIndex = Number(btn.dataset.index) === idx ? 0 : -1;
  }
  quadButton(idx)?.focus();
}

function submitGuess(pos, btn) {
  if (btn.classList.contains('cell--wrong') || btn.classList.contains('cell--correct')) return;
  const result = game.guess(pos);
  if (result.kind === 'correct') {
    btn.classList.add('cell--correct');
    revealRound();
  } else if (result.kind === 'wrong') {
    btn.classList.add('cell--wrong');
    flash(els.photoFrame, 'shake');
    els.status.textContent = `Not quite. ${result.guessesLeft} guess${result.guessesLeft === 1 ? '' : 'es'} left.`;
    if (result.guessesLeft === 1) applyNegativeHint();
    updateChips();
  } else if (result.kind === 'exhausted') {
    btn.classList.add('cell--wrong');
    revealRound();
  }
}

function revealRound(announce = true, skipped = false) {
  const s = game.snapshot();
  const c = s.character;
  els.photoFrame.classList.add('revealed');
  els.name.textContent = revealText(c);

  if (s.board.kind === 'quad') {
    const correctBtn = quadButton(s.board.correctIndex);
    correctBtn?.classList.add('cell--correct');
    for (const btn of els.quad.querySelectorAll('.quad-cell')) {
      if (!btn.classList.contains('cell--wrong') && !btn.classList.contains('cell--correct')) {
        btn.classList.add('cell--dim');
      }
    }
  } else {
    const correctBtn = cellButton(s.board.correctRow, s.board.correctCol);
    correctBtn?.classList.add('cell--correct');
    for (const btn of els.grid.querySelectorAll('.cell')) {
      if (!btn.classList.contains('cell--wrong') && !btn.classList.contains('cell--correct')) {
        btn.classList.add('cell--dim');
      }
    }
  }

  els.status.textContent = skipped ? 'Skipped — here\'s the answer.' : '';
  els.skip.hidden = true;
  const hasNext = s.roundIndex < s.totalRounds - 1;
  if (!hasNext) {
    els.next.hidden = true;
    if (s.finished && announce) {
      scheduleFinishedAnnounce();
    }
  } else {
    els.next.hidden = false;
    els.next.focus();
    if (announce) setTimeout(triggerSwipeHint, 800);
  }
  updateChips();
}

function updateChips() {
  const s = game.snapshot();
  // Hide the "/ N" suffix when N is effectively unlimited — it would just
  // read as noise (e.g. "Round 1 / 999"). Same for skips.
  // Drop the "/ N" suffix when the daily run is open-ended — surfacing "1 of
  // 57" reads as a slog rather than an invitation, even though the pool
  // technically has that many entries.
  els.roundChip.textContent = s.totalRounds >= 10
    ? `Round ${s.roundIndex + 1}`
    : `Round ${s.roundIndex + 1} / ${s.totalRounds}`;
  els.streakChip.textContent = `Streak ${s.streak}`;
  els.bestChip.textContent = `Best ${s.bestStreak}`;
  els.guessesChip.textContent = `Guesses ${s.guessesLeft}`;
  els.skipsChip.textContent = s.maxSkips >= 10
    ? 'Skip available'
    : `Skips ${s.skipsLeft}`;
  els.skipsChip.classList.toggle('chip--depleted', s.skipsLeft === 0);
}

function updateSkipButton() {
  const s = game.snapshot();
  const canSkip = !s.revealed && !s.finished && s.skipsLeft > 0;
  els.skip.hidden = !canSkip;
  els.skip.disabled = !canSkip;
  // Drop the "X of Y left" suffix when skips are effectively unlimited — the
  // count would just read as noise (e.g. "Skip (998 of 999)").
  els.skip.textContent = s.maxSkips >= 10
    ? 'Skip'
    : `Skip (${s.skipsLeft} of ${s.maxSkips} left)`;
}

els.tabItems.addEventListener('click', () => setMode('items'));
els.tabGrid.addEventListener('click', () => setMode('grid'));

// ARIA tablist keyboard pattern: Left/Right (and Home/End) move focus AND
// activate the tab. Tab key continues to escape the tablist into the rest
// of the page — handled by the tabindex flipping in setMode().
const TAB_ORDER = ['items', 'grid'];
function onTabKeyDown(e) {
  const currentIdx = TAB_ORDER.indexOf(e.currentTarget === els.tabItems ? 'items' : 'grid');
  if (currentIdx < 0) return;
  let nextIdx = -1;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      nextIdx = (currentIdx + 1) % TAB_ORDER.length;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIdx = (currentIdx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
      break;
    case 'Home': nextIdx = 0; break;
    case 'End':  nextIdx = TAB_ORDER.length - 1; break;
    default: return;
  }
  e.preventDefault();
  // Skip to the next available tab if the chosen one has no game (e.g.
  // items roster failed to load). One hop is enough — there are only two.
  const targetMode = games[TAB_ORDER[nextIdx]] ? TAB_ORDER[nextIdx] : TAB_ORDER[(nextIdx + 1) % TAB_ORDER.length];
  if (!games[targetMode] || targetMode === mode) return;
  setMode(targetMode);
  const btn = targetMode === 'items' ? els.tabItems : els.tabGrid;
  btn.focus();
}
els.tabItems.addEventListener('keydown', onTabKeyDown);
els.tabGrid.addEventListener('keydown', onTabKeyDown);

function advanceRound() {
  const r = game.next();
  if (r.kind === 'finished' || game.snapshot().finished) {
    showFinished();
  } else {
    renderRound();
  }
}

function performSkip(viaSwipe = false) {
  const result = game.skip();
  if (result.kind === 'no-skips' || result.kind === 'noop') return false;
  if (viaSwipe) {
    // Swipe is the "fast" path — just advance, no reveal pause.
    advanceRound();
  } else {
    // Button is the "deliberate" path — reveal so the player learns the
    // answer, then they tap or swipe to advance. If skipping was the
    // final unfinished round, auto-roll into the share screen.
    renderRound();
    if (game.snapshot().finished) {
      scheduleFinishedAnnounce();
    }
  }
  return true;
}

els.next.addEventListener('click', advanceRound);
els.skip.addEventListener('click', () => performSkip(false));

// Swipe-to-advance / swipe-to-skip. Once a round is revealed, a horizontal
// swipe advances to the next round. While a round is still in progress, a
// swipe consumes a skip and advances. If skips are exhausted we snap back.
attachSwipeToAdvance(els.photoFrame);

function attachSwipeToAdvance(target) {
  if (!target) return;
  // Touch needs a much higher commit threshold than mouse — a phone-edge
  // thumb-flick crosses 60px easily while reading, and the swipe should feel
  // intentional, not incidental.
  const COMMIT_TOUCH = 110;
  const COMMIT_MOUSE = 60;
  // Don't lock direction (or hijack the gesture) until the pointer has moved
  // this far. Below this we can't reliably tell scroll from swipe.
  const DIRECTION_LOCK_DISTANCE = 16;
  // Once we have enough motion to decide, dx must exceed dy by this ratio to
  // count as a horizontal swipe. Anything flatter is treated as a scroll and
  // the gesture is released for the rest of this touch.
  const HORIZONTAL_RATIO = 1.5;

  let active = false;
  let locked = null; // null | 'horizontal' | 'vertical'
  let startX = 0;
  let startY = 0;
  let pointerId = null;
  let pointerType = 'mouse';

  const swipeMode = () => {
    const s = game?.snapshot();
    if (!s || s.finished) return 'none';
    if (s.revealed) return 'next';
    if (s.skipsLeft > 0) return 'skip';
    return 'none';
  };

  const reset = (animate) => {
    target.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 220ms ease' : '';
    target.style.transform = '';
    target.style.opacity = '';
    if (animate) {
      setTimeout(() => { target.style.transition = ''; }, 240);
    }
  };

  target.addEventListener('pointerdown', (e) => {
    if (swipeMode() === 'none') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    target.classList.remove('swipe-hint');
    active = true;
    locked = null;
    pointerId = e.pointerId;
    pointerType = e.pointerType || 'mouse';
    startX = e.clientX;
    startY = e.clientY;
    target.style.transition = '';
  });

  target.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (locked === null) {
      // Wait for enough motion to make a confident decision. Below the lock
      // distance, do nothing — no transform, no pointer capture, so vertical
      // scrolling stays smooth.
      if (Math.hypot(dx, dy) < DIRECTION_LOCK_DISTANCE) return;
      if (adx > ady * HORIZONTAL_RATIO) {
        locked = 'horizontal';
        try { target.setPointerCapture(pointerId); } catch { /* ignore */ }
      } else {
        // Page scroll wins — bail out for the rest of this touch.
        locked = 'vertical';
        active = false;
        return;
      }
    }

    if (locked !== 'horizontal') return;
    e.preventDefault();
    // Slight non-linear curve — feels softer near the start, firmer past the threshold.
    const eased = dx * (1 - Math.min(0.25, adx / 1200));
    target.style.transform = `translateX(${eased}px) rotate(${eased * 0.018}deg)`;
    const commit = pointerType === 'mouse' ? COMMIT_MOUSE : COMMIT_TOUCH;
    const fade = Math.min(1, adx / (commit * 2.2));
    target.style.opacity = String(1 - fade * 0.4);
  });

  const finish = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    const wasHorizontal = locked === 'horizontal';
    locked = null;
    const dx = e.clientX - startX;
    try { target.releasePointerCapture(pointerId); } catch { /* ignore */ }
    const m = swipeMode();
    const commit = pointerType === 'mouse' ? COMMIT_MOUSE : COMMIT_TOUCH;
    if (wasHorizontal && m !== 'none' && Math.abs(dx) >= commit) {
      const dir = dx > 0 ? 1 : -1;
      target.style.transition = 'transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 220ms ease';
      target.style.transform = `translateX(${dir * window.innerWidth}px) rotate(${dir * 8}deg)`;
      target.style.opacity = '0';
      setTimeout(() => {
        reset(false);
        if (m === 'skip') {
          performSkip(true);
        } else {
          advanceRound();
        }
      }, 220);
    } else {
      reset(true);
    }
  };

  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', finish);
}

if (els.share) {
  els.share.addEventListener('click', async () => {
    if (!cachedShareCanvas) return;
    els.share.disabled = true;
    try {
      const result = await shareCanvas(cachedShareCanvas, game.snapshot());
      if (result?.kind === 'shared') {
        toast('Shared!');
      } else if (result?.kind === 'downloaded') {
        toast('Image saved');
      }
    } catch (err) {
      toast(`Could not share: ${err.message}`);
    } finally {
      els.share.disabled = false;
    }
  });
}

if (els.link) {
  els.link.addEventListener('click', async () => {
    const itemsSnap = games.items?.snapshot();
    const gridSnap = games.grid?.snapshot();
    const both = !!(itemsSnap?.finished && gridSnap?.finished);
    const url = shareLinkUrl(game.snapshot());
    const text = both
      ? combinedShareText({ items: itemsSnap, grid: gridSnap })
      : shareText(game.snapshot());
    // Prefer the native share sheet so users on phones can fling the URL
    // straight into Messages / Mail. Falls back to clipboard otherwise.
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Color Guesser',
          text,
          url,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      flashLabel(els.link, 'Link copied!', 'Copy link');
    } catch {
      flashLabel(els.link, 'Copy failed', 'Copy link');
    }
  });
}

if (els.copyResult) {
  els.copyResult.addEventListener('click', async () => {
    // If both modes are finished, the on-screen card is the combined view —
    // mirror that in the emoji text so the copy matches what the user sees.
    const itemsSnap = games.items?.snapshot();
    const gridSnap = games.grid?.snapshot();
    const text = (itemsSnap?.finished && gridSnap?.finished)
      ? combinedShareText({ items: itemsSnap, grid: gridSnap })
      : shareText(game.snapshot());
    try {
      await navigator.clipboard.writeText(text);
      flashLabel(els.copyResult, 'Copied!', 'Copy emoji');
    } catch {
      flashLabel(els.copyResult, 'Copy failed', 'Copy emoji');
    }
  });
}

function flashLabel(btn, hot, cool) {
  btn.textContent = hot;
  setTimeout(() => { btn.textContent = cool; }, 1800);
}

async function showFinished() {
  cancelFinishedAnnounce();
  const s = game.snapshot();
  // End-of-game is intentionally minimal: just the social share card and the
  // three action buttons. The `stage--finished` class collapses the layout so
  // the photo, title, board, status, countdown, and primary action rows take
  // no space — the share slot and share actions are the only things on screen.
  els.characterCard.hidden = true;
  els.board.hidden = true;
  els.quad.hidden = true;
  els.next.hidden = true;
  els.skip.hidden = true;
  els.status.textContent = '';
  els.name.innerHTML = '&nbsp;';
  if (els.countdown) els.countdown.textContent = '';
  els.stage?.classList.add('stage--finished');
  updateChips();

  els.shareSlot.hidden = false;
  els.shareActions.hidden = false;
  els.share.hidden = false;
  els.share.disabled = false;
  els.share.textContent = 'Save image';
  els.link.hidden = false;
  els.link.textContent = 'Copy link';
  els.copyResult.hidden = false;
  els.copyResult.textContent = 'Copy emoji';

  // If the player has finished BOTH experiences, the share card celebrates the
  // double run in a single 1080x1080 image with two side-by-side columns. If
  // only one mode is done, fall back to the original single-mode card. The
  // dimensions don't change — only the layout — so the slot height stays
  // identical between the two states.
  const itemsSnap = games.items?.snapshot();
  const gridSnap = games.grid?.snapshot();
  const bothDone = !!(itemsSnap?.finished && gridSnap?.finished);
  const newCanvas = bothDone
    ? await renderCombinedShareCard({ items: itemsSnap, grid: gridSnap })
    : await renderShareCard(s);
  newCanvas.classList.add('share-card');
  cachedShareCanvas = newCanvas;
  els.shareSlot.replaceChildren(newCanvas);

  // Countdown is suppressed on the end screen per spec, but we still need its
  // refresh-on-new-UTC-day side effect so the page reloads at midnight and
  // brings the 4:3 box back. Run the tick silently.
  startCountdown({ silent: true });
}

function hideShareSlot() {
  if (els.shareSlot) {
    els.shareSlot.hidden = true;
    els.shareSlot.innerHTML = '';
  }
  if (els.shareActions) els.shareActions.hidden = true;
  cachedShareCanvas = null;
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (els.countdown) els.countdown.textContent = '';
}

function startCountdown({ silent = false } = {}) {
  if (!els.countdown) return;
  // Tab-switching between two finished modes calls showFinished() each
  // time, which calls startCountdown() — without clearing first we'd leak
  // an interval per switch.
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const tick = () => {
    const ms = msUntilNextUtcDay();
    if (!silent) {
      els.countdown.textContent = `Next puzzle in ${formatCountdown(ms)} (UTC)`;
    }
    if (ms <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      window.location.reload();
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// Reload when the UTC day rolls over while the page is open or backgrounded.
// The share-screen countdown already covers the page-visible-and-finished
// case; this catches the player who leaves the tab open across midnight or
// reopens it the next day. `dateKey` is captured at page load — once it no
// longer matches today's UTC key, we reload so the fresh roster is loaded.
//
// Registrations are kept in named refs + a teardown closure so a retry of
// init() (or any future reset path) can rewind cleanly instead of stacking
// listeners and intervals. `dateRolloverArmed` / `dateRolloverTeardown`
// are declared at the top of the module — they're poked from init()
// before this point in module evaluation is reached.
function armDateRolloverReload() {
  if (dateRolloverArmed) return;
  dateRolloverArmed = true;
  const checkRollover = () => {
    if (getUtcDateKey() !== dateKey) {
      window.location.reload();
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') checkRollover();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', checkRollover);
  // Periodic safety net for the "tab left open all night" path — once a
  // minute is enough resolution to catch midnight without burning cycles.
  const intervalId = setInterval(checkRollover, 60_000);
  dateRolloverTeardown = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', checkRollover);
    clearInterval(intervalId);
    dateRolloverArmed = false;
    dateRolloverTeardown = null;
  };
}

function flash(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 500);
}

function triggerSwipeHint() {
  if (prefersReducedMotion.matches) return;
  const el = els.photoFrame;
  el.classList.remove('swipe-hint');
  void el.offsetWidth;
  el.classList.add('swipe-hint');
  el.addEventListener('animationend', () => {
    el.classList.remove('swipe-hint');
  }, { once: true });
}

const hardResetBtn = document.getElementById('hard-reset-btn');
if (hardResetBtn) {
  const idleLabel = 'Hard reset';
  const armedLabel = 'Tap again to confirm';
  let armedTimer = null;
  const disarm = () => {
    hardResetBtn.textContent = idleLabel;
    hardResetBtn.classList.remove('btn--hard-reset-armed');
    armedTimer = null;
  };
  hardResetBtn.addEventListener('click', () => {
    if (!armedTimer) {
      hardResetBtn.textContent = armedLabel;
      hardResetBtn.classList.add('btn--hard-reset-armed');
      armedTimer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armedTimer);
    armedTimer = null;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('wcat:')) localStorage.removeItem(key);
      }
    } catch { /* private mode — nothing to clear */ }
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    window.location.replace(url.toString());
  });
}

let toastTimer = null;
function toast(message) {
  let host = document.getElementById('toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    host.className = 'toast';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  host.textContent = message;
  host.classList.add('toast--visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.classList.remove('toast--visible');
  }, 3200);
}

