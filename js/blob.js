// Animates the title blob as a lava-lamp metaball. The SVG has five overlapping
// circles inside a gooey filter; we drift four of them with sums of sine waves
// whose period ratios are irrational, so the silhouette never lands on the same
// shape twice. The fifth circle is the "drop" — it sits inside the mass most of
// the time but periodically pulls outward in a random direction, separates from
// the mass for a beat, then snaps back, mimicking a lava-lamp drip.
//
// All coordinates are in the SVG's viewBox space (0..100).

const CENTER = 50;

// Per-circle drivers. Two sine pairs per axis with frequencies (Hz) that share
// no small-integer ratio, so the apparent period of each circle is effectively
// infinite at human timescales. Amplitudes are scoped so the circles never
// drift so far apart that the gooey filter can't fuse them.
const DRIVERS = [
  { ampX: 5, ampY: 5, fx: [0.041, 0.073], fy: [0.053, 0.089], px: [0.0, 1.7], py: [3.1, 0.5] },
  { ampX: 8, ampY: 7, fx: [0.067, 0.103], fy: [0.083, 0.127], px: [1.0, 2.5], py: [4.3, 0.8] },
  { ampX: 7, ampY: 8, fx: [0.059, 0.131], fy: [0.071, 0.109], px: [2.3, 0.6], py: [1.2, 4.1] },
  { ampX: 9, ampY: 9, fx: [0.079, 0.149], fy: [0.061, 0.113], px: [5.2, 3.0], py: [0.4, 2.9] },
];

// Drop tuning. Each drop event lasts DROP_LIFE seconds: the small circle eases
// outward, holds at peak, then returns. Idle distance keeps the drop tucked
// inside the main mass between events.
const DROP_IDLE = 4;
const DROP_PEAK = 36;
const DROP_LIFE = 2.6;
const DROP_GAP_MIN = 2.4;
const DROP_GAP_VAR = 4.5;

// Redraw cap. Every update re-rasterizes the SVG goo filter (a blur plus a
// colour matrix), and the drift is slow — well under a pixel per frame at the
// header's size — so ~30 updates a second looks identical to 60/120 while
// halving (or quartering, on 120Hz phones) the paint work over a session.
const FRAME_MS = 1000 / 30;

export function initTitleBlob() {
  const svg = document.querySelector('.title-blob');
  if (!svg) return;

  const circles = Array.from(svg.querySelectorAll('.title-blob-shape'));
  if (circles.length < 5) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;

  const TAU = Math.PI * 2;
  let start = performance.now();

  // Drop state — the next drop fires after a short warm-up so the page doesn't
  // open mid-detach.
  let dropStart = 1.8;
  let dropAngle = Math.random() * TAU;
  let nextDropAt = dropStart + DROP_LIFE + DROP_GAP_MIN + Math.random() * DROP_GAP_VAR;

  let lastPaint = -Infinity;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    // 1ms of slack so a 60Hz display lands on every other frame rather than
    // drifting between 2 and 3.
    if (now - lastPaint < FRAME_MS - 1) return;
    lastPaint = now;
    const t = (now - start) / 1000;

    for (let i = 0; i < 4; i++) {
      const d = DRIVERS[i];
      const c = circles[i];
      const x = CENTER
        + d.ampX * Math.sin(t * d.fx[0] * TAU + d.px[0])
        + d.ampX * 0.55 * Math.sin(t * d.fx[1] * TAU + d.px[1]);
      const y = CENTER
        + d.ampY * Math.sin(t * d.fy[0] * TAU + d.py[0])
        + d.ampY * 0.55 * Math.sin(t * d.fy[1] * TAU + d.py[1]);
      c.setAttribute('cx', x.toFixed(2));
      c.setAttribute('cy', y.toFixed(2));
    }

    // Drop: bell-curve pull-out, then a random pause before the next event.
    // Re-rolling angle + gap each cycle keeps the rhythm and direction from
    // settling into a recognizable pattern.
    if (t >= nextDropAt) {
      dropStart = nextDropAt;
      dropAngle = Math.random() * TAU;
      nextDropAt = dropStart + DROP_LIFE + DROP_GAP_MIN + Math.random() * DROP_GAP_VAR;
    }
    const phase = (t - dropStart) / DROP_LIFE;
    let pull = 0;
    if (phase >= 0 && phase <= 1) {
      // sin(πx) raised to 1.4 gives a steeper hold near the peak — looks more
      // like a deliberate detach-and-snap-back than a smooth in-out.
      pull = Math.pow(Math.sin(phase * Math.PI), 1.4);
    }
    const dist = DROP_IDLE + pull * (DROP_PEAK - DROP_IDLE);
    const wobbleX = Math.sin(t * 0.51 + 0.3) * 1.6;
    const wobbleY = Math.cos(t * 0.43 + 1.1) * 1.6;
    const dx = CENTER + Math.cos(dropAngle) * dist + wobbleX;
    const dy = CENTER + Math.sin(dropAngle) * dist + wobbleY;
    circles[4].setAttribute('cx', dx.toFixed(2));
    circles[4].setAttribute('cy', dy.toFixed(2));
  }

  let raf = requestAnimationFrame(tick);

  // Pause when the tab is hidden — saves CPU and avoids time-jumps when the
  // page is restored. Picks up where it left off via the same `start` baseline
  // minus the hidden interval.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      hiddenAt = performance.now();
    } else if (!raf) {
      // Shift the start baseline forward so `t` continues smoothly across the
      // pause instead of teleporting circles to where they "should" be now.
      start += performance.now() - hiddenAt;
      raf = requestAnimationFrame(tick);
    }
  });
}
