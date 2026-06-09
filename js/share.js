// Renders the end-of-day share card to a canvas. Layout per round:
//   portrait · name + color swatch · N outcome boxes
// Boxes mirror the emoji vocabulary in the text share — dark for
// unused/skipped, green for a correct guess, red for a wrong guess.
// N varies per row (3 for grid, 1 for quad).

import { maxGuessesFor } from './game.js';

const W = 1080;
const H = 1080;
const PADDING = 64;

// Portraits render 10% larger than the row's inner height. The extra size is
// absorbed by the row's vertical padding (and re-centred), so rows don't grow
// or collide — the character photo just reads a touch bigger on the card.
const PORTRAIT_SCALE = 1.1;

const BOX_COLORS = {
  empty: '#1a1d24',
  emptyStroke: '#2c333f',
  correct: '#3ccb7f',   // 🟩
  wrong: '#e04a4a',     // 🟥
};

const CARD_BG = '#171c25';
const CARD_STROKE = '#262d38';
const TEXT_PRIMARY = '#e6ebf2';
const TEXT_SECONDARY = '#a4afc1';
const TEXT_MUTED = '#7b8597';

// Each rendered share card gets a randomly-hued main colour theme, so two
// people sharing the same day's result don't post the exact same image. Only
// the accent/glow/background tint changes — the data (portraits, outcomes,
// score) is identical for the day. The dark base keeps every hue legible.
function makeTheme(hue) {
  return {
    accent: `hsl(${hue}, 62%, 62%)`,
    glow: (a) => `hsla(${hue}, 72%, 56%, ${a})`,
    pillFillTop: `hsla(${hue}, 62%, 58%, 0.24)`,
    pillFillBottom: `hsla(${hue}, 62%, 58%, 0.10)`,
    pillStroke: `hsla(${hue}, 62%, 62%, 0.55)`,
    bgTop: `hsl(${hue}, 26%, 15%)`,
    bgMid: `hsl(${hue}, 22%, 9%)`,
    bgBottom: `hsl(${hue}, 28%, 5%)`,
  };
}

// ~168° reproduces the original teal accent; used as a stable fallback.
let theme = makeTheme(168);
function pickRandomTheme() {
  theme = makeTheme(Math.floor(Math.random() * 360));
}

const PIXEL_RATIO = Math.max(2, Math.min(3, window.devicePixelRatio || 2));

// Above this count, the per-round portrait layout would crush rows below the
// minimum readable size. We switch to a compact tile grid (one filled square
// per round) so a long marathon still produces a clean share image.
const COMPACT_GRID_THRESHOLD = 8;

export async function renderShareCard(snapshot) {
  // Fresh random main colour theme per render so shared cards vary.
  pickRandomTheme();
  // Preload all portraits up-front so the draw path can pull them
  // synchronously from cache. The in-game prefetch usually has them already.
  await preloadAllPortraits(snapshot.characters || []);
  // Cormorant Garamond is used for the wordmark — canvas2d won't wait for
  // remote fonts, so trigger and await its load before drawing.
  await ensureFontsReady();

  const canvas = document.createElement('canvas');
  canvas.width = W * PIXEL_RATIO;
  canvas.height = H * PIXEL_RATIO;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);

  drawBackground(ctx);
  drawHeader(ctx, snapshot);

  // Only count rounds the player actually played — unfinished rounds clutter
  // the layout and aren't part of the result they'd want to share.
  const playedRounds = snapshot.rounds
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.won || r.lost || r.skipped);

  const bodyTop = 280;
  const bodyBottom = H - 110;
  const bodyLeft = PADDING;
  const bodyRight = W - PADDING;

  if (playedRounds.length === 0) {
    // Defensive: nothing to draw, just skip the body.
  } else if (playedRounds.length > COMPACT_GRID_THRESHOLD) {
    drawCompactGrid(ctx, snapshot, playedRounds, bodyLeft, bodyTop, bodyRight, bodyBottom);
  } else {
    drawPortraitRows(ctx, snapshot, playedRounds, bodyLeft, bodyTop, bodyRight, bodyBottom);
  }

  drawFooter(ctx);
  return canvas;
}

// Combined share card for the "finished both experiences" celebration. Same
// 1080x1080 footprint as the single-mode card — the body splits into two
// columns (Items on the left, Characters on the right) so the player can
// brag about both runs in one image without the card changing size.
export async function renderCombinedShareCard({ items, grid }) {
  // Fresh random main colour theme per render so shared cards vary.
  pickRandomTheme();
  // Preload portraits from both runs up-front; the in-game cache usually
  // already has them but the share view is sometimes hit from a cold start.
  const allChars = [...(items?.characters || []), ...(grid?.characters || [])];
  await preloadAllPortraits(allChars);
  await ensureFontsReady();

  const canvas = document.createElement('canvas');
  canvas.width = W * PIXEL_RATIO;
  canvas.height = H * PIXEL_RATIO;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);

  drawBackground(ctx);
  drawCombinedHeader(ctx, { items, grid });

  const bodyTop = 280;
  const bodyBottom = H - 110;
  const bodyLeft = PADDING;
  const bodyRight = W - PADDING;
  const columnGap = 28;
  const columnWidth = (bodyRight - bodyLeft - columnGap) / 2;

  // Two equal-width columns: Items left, Characters right.
  drawColumn(
    ctx,
    items,
    'Items',
    bodyLeft,
    bodyTop,
    columnWidth,
    bodyBottom - bodyTop,
  );
  drawColumn(
    ctx,
    grid,
    'Characters',
    bodyLeft + columnWidth + columnGap,
    bodyTop,
    columnWidth,
    bodyBottom - bodyTop,
  );

  drawFooter(ctx);
  return canvas;
}

function drawCombinedHeader(ctx, { items, grid }) {
  ctx.textBaseline = 'top';

  const dateLabel = items?.date || grid?.date || '';
  ctx.fillStyle = theme.accent;
  ctx.font = '800 22px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('DAILY · ' + dateLabel, PADDING, 64);

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = '700 80px "Cormorant Garamond", "Iowan Old Style", Georgia, "Times New Roman", serif';
  ctx.fillText('Coloration', PADDING, 100);

  // Subhead celebrates the double clear; the score pill shows the combined
  // result so a quick glance reads the day in one number.
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = '600 28px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Items + Characters', PADDING, 188);

  const wonCount =
    (items?.rounds || []).filter(r => r.won).length +
    (grid?.rounds || []).filter(r => r.won).length;
  const total = (items?.rounds?.length || 0) + (grid?.rounds?.length || 0);
  drawScorePill(ctx, `${wonCount} / ${total}`, W - PADDING, 178);
}

function drawColumn(ctx, snapshot, label, x, y, w, h) {
  // Column "card" — soft surface tying the rows together so each side reads
  // as its own bracket without dominating the canvas.
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 24);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const colPad = 18;
  const headerH = 64;
  const innerLeft = x + colPad;
  const innerRight = x + w - colPad;
  const innerWidth = innerRight - innerLeft;

  // Mode label (left) + score pill (right) form the column header.
  ctx.textBaseline = 'top';
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = '800 26px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(label, innerLeft, y + colPad);

  const rounds = snapshot?.rounds || [];
  const wins = rounds.filter(r => r.won).length;
  drawSmallScorePill(ctx, `${wins} / ${rounds.length}`, innerRight, y + colPad - 2);

  // Played rows fill the rest of the column.
  const playedRounds = rounds
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.won || r.lost || r.skipped);

  if (playedRounds.length === 0) {
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = '600 18px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('No rounds played.', innerLeft, y + headerH + colPad);
    return;
  }

  const rowsTop = y + headerH + colPad;
  const rowsBottom = y + h - colPad;
  const rowGap = 14;
  const rowH = Math.min(
    150,
    (rowsBottom - rowsTop - rowGap * (playedRounds.length - 1)) / playedRounds.length,
  );
  for (let k = 0; k < playedRounds.length; k++) {
    const ry = rowsTop + k * (rowH + rowGap);
    drawColumnRow(
      ctx,
      snapshot,
      playedRounds[k].i,
      innerLeft,
      ry,
      innerWidth,
      rowH,
    );
  }
}

function drawSmallScorePill(ctx, text, right, top) {
  const font = '900 22px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.font = font;
  const padX = 14;
  const padY = 6;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padX * 2;
  const h = 22 + padY * 2;
  const x = right - w;
  const y = top;

  ctx.save();
  const grd = ctx.createLinearGradient(x, y, x, y + h);
  grd.addColorStop(0, theme.pillFillTop);
  grd.addColorStop(1, theme.pillFillBottom);
  ctx.fillStyle = grd;
  ctx.strokeStyle = theme.pillStroke;
  ctx.lineWidth = 1.25;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.textBaseline = 'top';
  ctx.font = font;
  ctx.fillText(text, x + padX, y + padY);
}

function drawColumnRow(ctx, snapshot, i, x, y, w, h) {
  const round = snapshot.rounds[i];
  const character = snapshot.characters[i];
  const max = maxGuessesFor(character);

  // Row card — slightly elevated against the column background.
  ctx.save();
  ctx.fillStyle = CARD_BG;
  ctx.strokeStyle = CARD_STROKE;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const innerPad = 10;
  const portraitSize = (h - innerPad * 2) * PORTRAIT_SCALE;
  const portraitX = x + innerPad;
  const portraitY = y + (h - portraitSize) / 2;

  drawPortraitFrame(ctx, portraitX, portraitY, portraitSize);
  drawPortrait(ctx, character, portraitX, portraitY, portraitSize);

  // Guess boxes scaled down so up-to-three slots still fit alongside the name.
  const boxGap = 8;
  const slotSize = Math.min(Math.floor((h - 28)), max === 1 ? 64 : 42);
  const boxesAreaW = slotSize * max + boxGap * Math.max(0, max - 1);

  const textX = portraitX + portraitSize + 14;
  const textRight = x + w - innerPad - boxesAreaW - 12;
  const nameMax = Math.max(0, textRight - textX);

  if (nameMax > 30) {
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = '700 18px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    const name = truncate(ctx, character.name, nameMax);
    ctx.fillText(name, textX, y + h / 2);
    ctx.textBaseline = 'top';
  }

  const boxesLeft = x + w - innerPad - boxesAreaW;
  const boxesY = y + (h - slotSize) / 2;
  for (let b = 0; b < max; b++) {
    const bx = boxesLeft + b * (slotSize + boxGap);
    drawGuessBox(ctx, round, b, bx, boxesY, slotSize);
  }
}

function drawPortraitRows(ctx, snapshot, played, left, top, right, bottom) {
  const rowGap = 18;
  const n = played.length;
  const availH = bottom - top;
  const rowH = Math.min(
    160,
    (availH - rowGap * Math.max(0, n - 1)) / n,
  );
  const totalH = rowH * n + rowGap * Math.max(0, n - 1);
  const startY = top + (availH - totalH) / 2;
  const width = right - left;
  for (let k = 0; k < n; k++) {
    const y = startY + k * (rowH + rowGap);
    drawRow(ctx, snapshot, played[k].i, left, y, width, rowH);
  }
}

function drawCompactGrid(ctx, snapshot, played, left, top, right, bottom) {
  // One square per played round, coloured by outcome. Same emoji vocabulary
  // as the text share (correct=green, wrong=red, skipped=dark) so the visual
  // and text shares feel cohesive.
  const availW = right - left;
  const availH = bottom - top;

  const n = played.length;
  // Choose a grid that roughly matches the available aspect ratio (1:1 here).
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * (availW / availH))));
  const rows = Math.ceil(n / cols);
  const gap = 14;
  const tile = Math.floor(Math.min(
    (availW - gap * (cols - 1)) / cols,
    (availH - gap * (rows - 1)) / rows,
  ));
  const usedW = tile * cols + gap * (cols - 1);
  const usedH = tile * rows + gap * (rows - 1);
  const x0 = left + (availW - usedW) / 2;
  const y0 = top + (availH - usedH) / 2;
  const radius = Math.max(8, Math.floor(tile * 0.18));
  for (let k = 0; k < n; k++) {
    const r = Math.floor(k / cols);
    const c = k % cols;
    const x = x0 + c * (tile + gap);
    const y = y0 + r * (tile + gap);
    const round = played[k].r;
    if (round.won) {
      drawSolidBox(ctx, x, y, tile, radius, BOX_COLORS.correct);
    } else if (round.lost) {
      drawSolidBox(ctx, x, y, tile, radius, BOX_COLORS.wrong);
    } else {
      drawEmptyBox(ctx, x, y, tile, radius);
    }
  }
}

function drawBackground(ctx) {
  // Vertical gradient base — tinted toward the card's random main theme hue.
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, theme.bgTop);
  grd.addColorStop(0.55, theme.bgMid);
  grd.addColorStop(1, theme.bgBottom);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // Soft radial glow top-left to give the card a focal point.
  const glow = ctx.createRadialGradient(220, 160, 20, 220, 160, 700);
  glow.addColorStop(0, theme.glow(0.16));
  glow.addColorStop(1, theme.glow(0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Thin accent rule under the header.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(PADDING, 240, W - PADDING * 2, 1);
}

function drawHeader(ctx, snapshot) {
  ctx.textBaseline = 'top';

  // Title first — matches the page wordmark (Cormorant Garamond 700), bumped
  // +3px so the brand reads a touch larger at the top of the card.
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = '700 83px "Cormorant Garamond", "Iowan Old Style", Georgia, "Times New Roman", serif';
  ctx.fillText('Coloration', PADDING, 48);

  // Date underneath the wordmark.
  ctx.fillStyle = theme.accent;
  ctx.font = '800 22px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('DAILY · ' + snapshot.date, PADDING, 148);

  // Subhead — mode + scoreline, beneath the date.
  const wonCount = snapshot.rounds.filter(r => r.won).length;
  const total = snapshot.rounds.length;
  const modeLabel = snapshot.mode === 'items' ? 'Item Colors' : 'Character Colors';

  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = '600 28px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(modeLabel, PADDING, 180);

  // Score pill on the right, aligned with the date/mode block.
  drawScorePill(ctx, `${wonCount} / ${total}`, W - PADDING, 168);
}

function drawScorePill(ctx, text, right, top) {
  ctx.font = '900 36px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const padX = 22;
  const padY = 12;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padX * 2;
  const h = 36 + padY * 2;
  const x = right - w;
  const y = top - padY + 4;

  ctx.save();
  // Subtle gradient fill on the pill.
  const grd = ctx.createLinearGradient(x, y, x, y + h);
  grd.addColorStop(0, theme.pillFillTop);
  grd.addColorStop(1, theme.pillFillBottom);
  ctx.fillStyle = grd;
  ctx.strokeStyle = theme.pillStroke;
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.textBaseline = 'top';
  ctx.font = '900 36px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(text, x + padX, y + padY);
}

function drawFooter(ctx) {
  // Thin top rule.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(PADDING, H - 96, W - PADDING * 2, 1);

  // Result legend — three small boxes with labels. The "Coloration / Play
  // today's puzzle" wordmark used to sit on the left here but was removed;
  // the header already carries the brand, so the footer is just the key.
  drawLegend(ctx, W - PADDING, H - 70);
}

function drawLegend(ctx, right, top) {
  const items = [
    { color: BOX_COLORS.correct, label: 'Correct' },
    { color: BOX_COLORS.wrong, label: 'Wrong' },
    { color: BOX_COLORS.empty, label: 'Skipped', stroke: BOX_COLORS.emptyStroke },
  ];
  ctx.textBaseline = 'middle';
  ctx.font = '600 18px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const gap = 16;
  // Measure totals so we can right-align the row.
  let totalW = 0;
  const sizes = items.map(({ label }) => {
    const tw = ctx.measureText(label).width;
    return { tw, w: 18 + 8 + tw };
  });
  totalW = sizes.reduce((acc, s, i) => acc + s.w + (i > 0 ? gap : 0), 0);
  let x = right - totalW;
  const y = top + 14;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.stroke) {
      ctx.fillStyle = it.color;
      ctx.strokeStyle = it.stroke;
      ctx.lineWidth = 1.5;
      roundRect(ctx, x, y - 9, 18, 18, 5);
      ctx.fill();
      ctx.stroke();
    } else {
      drawSolidBox(ctx, x, y - 9, 18, 5, it.color);
    }
    ctx.fillStyle = TEXT_SECONDARY;
    ctx.fillText(it.label, x + 18 + 8, y);
    x += sizes[i].w + gap;
  }
  ctx.textBaseline = 'top';
}

function drawRow(ctx, snapshot, i, x, y, w, h) {
  const round = snapshot.rounds[i];
  const character = snapshot.characters[i];
  const max = maxGuessesFor(character);

  // Row card background — gives each round its own visual container.
  ctx.save();
  ctx.fillStyle = CARD_BG;
  ctx.strokeStyle = CARD_STROKE;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 22);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const innerPad = 14;
  // Portrait fills the row's full height with only a hair of inset, so it
  // nestles flush into the row's left corners (top-left + bottom-left) instead
  // of floating centred with a gap on every side.
  const portraitPad = 6;
  const portraitSize = h - portraitPad * 2;
  const portraitX = x + portraitPad;
  const portraitY = y + portraitPad;
  // Round the portrait so its left corners follow the row's rounded corners
  // (row radius 22 minus the inset).
  const portraitRadius = 22 - portraitPad;

  drawPortraitFrame(ctx, portraitX, portraitY, portraitSize, portraitRadius);
  drawPortrait(ctx, character, portraitX, portraitY, portraitSize, portraitRadius);

  // Boxes area on the right.
  const boxesArea = boxesAreaWidth(h, max);
  const boxesRight = x + w - innerPad;
  const boxesLeft = boxesRight - boxesArea;

  // Name column fills the gap between the (now larger) portrait and the boxes.
  const textX = portraitX + portraitSize + 20;
  const nameMax = boxesLeft - textX - 12;
  drawCharacterMeta(ctx, character, textX, y, h, nameMax);

  drawGuessRow(ctx, round, max, boxesLeft, y, boxesArea, h);
}

function boxesAreaWidth(rowH, max) {
  const boxGap = 14;
  const slotSize = Math.min(rowH - 28, 110);
  return slotSize * max + boxGap * Math.max(0, max - 1);
}

function drawCharacterMeta(ctx, character, x, rowY, rowH, maxWidth) {
  if (maxWidth <= 40) return;

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = '800 26px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  const name = truncate(ctx, character.name, maxWidth);
  ctx.fillText(name, x, rowY + rowH / 2);
  ctx.textBaseline = 'top';
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = '…';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

function drawGuessRow(ctx, round, max, x, rowY, areaW, rowH) {
  const boxGap = 14;
  const slotSize = Math.min(rowH - 28, 110);
  const totalW = slotSize * max + boxGap * Math.max(0, max - 1);
  const startX = x + (areaW - totalW);
  const y = rowY + (rowH - slotSize) / 2;
  for (let b = 0; b < max; b++) {
    const bx = startX + b * (slotSize + boxGap);
    drawGuessBox(ctx, round, b, bx, y, slotSize);
  }
}

function drawPortraitFrame(ctx, x, y, size, radius = 16) {
  ctx.save();
  ctx.fillStyle = '#0e1218';
  ctx.strokeStyle = '#2a3140';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, size, size, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPortrait(ctx, character, x, y, size, radius = 16) {
  // Synchronous: relies on the in-game preload so the image is already in the
  // browser cache by the time the share card renders. Falls back to initials
  // if the image isn't ready or fails to decode.
  const src = character.imageSrc;
  const cached = portraitCache.get(src);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    ctx.save();
    roundRect(ctx, x, y, size, size, radius);
    ctx.clip();
    const ratio = cached.width / cached.height;
    let dw, dh;
    if (ratio > 1) { dh = size; dw = size * ratio; }
    else { dw = size; dh = size / ratio; }
    const dx = x + (size - dw) / 2;
    const dy = y + (size - dh) / 2;
    drawGrayscaleImage(ctx, cached, dx, dy, dw, dh);
    ctx.restore();
  } else {
    drawInitials(ctx, character.name, x, y, size);
  }
}

// Portraits on the share card are desaturated to match the in-game
// grayscale-until-revealed treatment — sharing a colour-true photo would
// hand the answer to anyone who opens the image.
function drawGrayscaleImage(ctx, img, dx, dy, dw, dh) {
  if (typeof ctx.filter === 'string') {
    const prev = ctx.filter;
    ctx.filter = 'grayscale(1) contrast(1.05)';
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.filter = prev;
    return;
  }
  // Fallback for engines without Canvas2D filter support: paint to an
  // offscreen canvas, walk the pixels, write back. Size the offscreen buffer
  // at device resolution (×PIXEL_RATIO) — sizing it in CSS px downscaled the
  // source then upscaled it back into the retina canvas, which read as blocky.
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.ceil(dw * PIXEL_RATIO));
  off.height = Math.max(1, Math.ceil(dh * PIXEL_RATIO));
  const offCtx = off.getContext('2d');
  offCtx.imageSmoothingEnabled = true;
  offCtx.imageSmoothingQuality = 'high';
  offCtx.drawImage(img, 0, 0, off.width, off.height);
  try {
    const data = offCtx.getImageData(0, 0, off.width, off.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = px[i + 1] = px[i + 2] = y;
    }
    offCtx.putImageData(data, 0, 0);
  } catch {
    // Tainted canvas — give up on desaturation rather than throwing.
  }
  ctx.drawImage(off, dx, dy, dw, dh);
}

function drawInitials(ctx, name, x, y, size) {
  const initials = String(name || '?')
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  ctx.save();
  ctx.fillStyle = '#cfd6e2';
  ctx.font = `900 ${Math.floor(size * 0.4)}px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(initials, x + size / 2, y + size / 2);
  ctx.restore();
  ctx.textAlign = 'start';
  ctx.textBaseline = 'top';
}

function drawGuessBox(ctx, round, idx, x, y, size) {
  const guess = round.guesses[idx];
  const radius = Math.max(10, Math.floor(size * 0.18));
  if (!guess) {
    drawEmptyBox(ctx, x, y, size, radius);
  } else if (guess.correct) {
    drawSolidBox(ctx, x, y, size, radius, BOX_COLORS.correct);
  } else {
    drawSolidBox(ctx, x, y, size, radius, BOX_COLORS.wrong);
  }
}

function drawEmptyBox(ctx, x, y, size, radius) {
  ctx.save();
  ctx.fillStyle = BOX_COLORS.empty;
  ctx.strokeStyle = BOX_COLORS.emptyStroke;
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, size, size, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawSolidBox(ctx, x, y, size, radius, fill) {
  ctx.save();
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, size, size, radius);
  ctx.fill();
  // Inner highlight band for a softer "filled" feel.
  ctx.globalAlpha = 0.22;
  const grd = ctx.createLinearGradient(x, y, x, y + size);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.55, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  roundRect(ctx, x, y, size, size, radius);
  ctx.fill();
  // Subtle inner border for crispness.
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, size - 1, size - 1, Math.max(0, radius - 0.5));
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

async function ensureFontsReady() {
  if (!document.fonts || typeof document.fonts.load !== 'function') return;
  try {
    await Promise.all([
      document.fonts.load('700 80px "Cormorant Garamond"'),
      document.fonts.load('700 26px "Cormorant Garamond"'),
    ]);
  } catch {
    // Fall back to the system serif if the font fails to load.
  }
}

// Portraits go through a small in-module cache so repeated draws don't refetch.
// Each entry is the HTMLImageElement itself (the browser handles decode).
const portraitCache = new Map();
function preloadPortrait(src) {
  if (!src) return Promise.resolve(null);
  const existing = portraitCache.get(src);
  if (existing) {
    if (existing.complete) return Promise.resolve(existing);
    return new Promise((res) => {
      existing.addEventListener('load', () => res(existing), { once: true });
      existing.addEventListener('error', () => res(null), { once: true });
    });
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  portraitCache.set(src, img);
  return new Promise((res) => {
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

// Preload all portraits up-front so the synchronous draw path can read them
// from cache. Returning a promise lets renderShareCard remain async without
// scattering awaits through each row.
async function preloadAllPortraits(characters) {
  await Promise.all(characters.map(c => preloadPortrait(c.imageSrc)));
}

export async function shareCanvas(canvas, snapshot) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not encode share image');
  const filename = `colorguesser-${snapshot.date}.png`;

  if (navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Color Guesser',
          text: shareText(snapshot),
        });
        return { kind: 'shared' };
      }
    } catch (err) {
      if (err?.name === 'AbortError') return { kind: 'cancelled' };
      // fall through to download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { kind: 'downloaded' };
}

// Emoji-only share — black box default, green for correct, red for wrong.
// Matches the user-spec "Color Guesser" header and one line per character.
// Only completed rounds are listed so a partial run doesn't dump empty rows.
// Long runs collapse into a single emoji ribbon so the share text stays
// scannable in a tweet or DM.
const TEXT_COMPACT_THRESHOLD = 12;
export function shareText(snapshot) {
  const played = snapshot.rounds
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.won || r.lost || r.skipped);

  if (played.length > TEXT_COMPACT_THRESHOLD) {
    const ribbon = played.map(({ r }) => {
      if (r.won) return '🟩';
      if (r.lost) return '🟥';
      return '⬛';
    }).join('');
    const wins = played.filter(({ r }) => r.won).length;
    return [
      'Color Guesser',
      `${wins} / ${played.length}`,
      '',
      ribbon,
    ].join('\n');
  }

  const lines = played.map(({ r, i }) => {
    const c = snapshot.characters[i];
    const max = maxGuessesFor(c);
    const cells = Array.from({ length: max }, (_, k) => {
      const g = r.guesses[k];
      if (!g) return '⬛';
      return g.correct ? '🟩' : '🟥';
    }).join('');
    return `${c.name}: ${cells}`;
  });
  return ['Color Guesser', '', ...lines].join('\n');
}

// Combined text share — emoji ribbon for both modes side by side. Used when
// the player has finished both items and characters on the same day so the
// "Copy emoji" affordance reflects what's actually on screen.
export function combinedShareText({ items, grid }) {
  const lines = ['Color Guesser', ''];
  for (const snap of [items, grid]) {
    if (!snap) continue;
    const played = snap.rounds
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.won || r.lost || r.skipped);
    const wins = played.filter(({ r }) => r.won).length;
    const label = snap.mode === 'items' ? 'Items' : 'Characters';
    lines.push(`${label}: ${wins} / ${played.length}`);
    for (const { r, i } of played) {
      const c = snap.characters[i];
      const max = maxGuessesFor(c);
      const cells = Array.from({ length: max }, (_, k) => {
        const g = r.guesses[k];
        if (!g) return '⬛';
        return g.correct ? '🟩' : '🟥';
      }).join('');
      lines.push(`  ${c.name}: ${cells}`);
    }
    lines.push('');
  }
  // Trim trailing blank line.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// Build a shareable URL that encodes today's results into a query param.
// The receiving page detects ?s= and renders a read-only share view.
export function shareLinkUrl(snapshot) {
  // Only encode played rounds — including 900+ untouched slots would balloon
  // the URL past browser/clipboard friendliness with no upside.
  const playedIdx = [];
  for (let i = 0; i < snapshot.rounds.length; i++) {
    const r = snapshot.rounds[i];
    if (r.won || r.lost || r.skipped) playedIdx.push(i);
  }
  const payload = {
    d: snapshot.date,
    m: snapshot.mode,
    c: playedIdx.map(i => snapshot.characters[i].id),
    r: playedIdx.map(i => {
      const r = snapshot.rounds[i];
      return {
        g: r.guesses.map(g => ({
          c: g.correct ? 1 : 0,
          ...(Number.isInteger(g.row) ? { r: g.row, x: g.col } : {}),
          ...(Number.isInteger(g.index) ? { i: g.index } : {}),
        })),
        w: r.won ? 1 : 0,
        l: r.lost ? 1 : 0,
        s: r.skipped ? 1 : 0,
      };
    }),
  };
  const json = JSON.stringify(payload);
  const b64 = b64UrlEncode(json)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const url = new URL(window.location.href);
  // Drop any existing query so we control the params; keep just `s`.
  url.search = '';
  url.searchParams.set('s', b64);
  url.hash = '';
  return url.toString();
}

export function decodeSharePayload(s) {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return JSON.parse(b64UrlDecode(b64 + pad));
  } catch {
    return null;
  }
}

// UTF-8 ↔ base64 via TextEncoder/TextDecoder. Replaces the legacy
// `btoa(unescape(encodeURIComponent(...)))` and `decodeURIComponent(escape(atob(...)))`
// idioms, which rely on the deprecated `escape`/`unescape` globals.
function b64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  // Chunked to avoid blowing the argument limit on long strings. 0x8000 is
  // well under the spec'd cap on all current engines.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
function b64UrlDecode(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Build a synthetic snapshot from a decoded share payload + the loaded
// character list. Used by the read-only share view.
export function snapshotFromPayload(payload, allCharacters) {
  const byId = new Map(allCharacters.map(c => [c.id, c]));
  const characters = payload.c.map(id => byId.get(id)).filter(Boolean);
  if (characters.length !== payload.c.length) return null;
  const rounds = payload.r.map((r, i) => ({
    charId: characters[i].id,
    guesses: (r.g || []).map(g => ({
      correct: !!g.c,
      ...(Number.isInteger(g.r) ? { row: g.r, col: g.x } : {}),
      ...(Number.isInteger(g.i) ? { index: g.i } : {}),
    })),
    won: !!r.w,
    lost: !!r.l,
    skipped: !!r.s,
  }));
  return {
    date: payload.d,
    mode: payload.m || 'grid',
    characters,
    character: characters[0],
    rounds,
    roundIndex: rounds.length - 1,
    totalRounds: rounds.length,
    streak: 0,
    bestStreak: 0,
    finished: true,
    revealed: true,
  };
}
