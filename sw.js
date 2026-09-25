// Minimal service worker so the installed (standalone) app still opens
// offline. Strategy keeps deploys painless:
//   - navigations, JSON, JS, CSS → network-first, falling back to cache, so a
//     fresh deploy is picked up on the next online load with no version dance.
//     A cached copy takes over if the network hasn't answered within
//     NETWORK_TIMEOUT_MS, so a weak "lie-fi" signal doesn't hang the app.
//   - assets/ (photos, icons, fonts) → cache-first with runtime fill; they're
//     content-addressed by filename in practice and never change in place
// Bump VERSION to drop every cached entry on the next activate.
// v2: 5x5 ordered-gradient grid redesign — grid/game/main/share/styles and
// the storage format all changed together; a mixed cache would break.
// v3: self-hosted fonts join the shell; QA pass across main/game/daily/quad/
// share/styles.
const VERSION = 'v3';

// How long a network-first request may take before a cached copy (if there
// is one) answers instead. The network response still lands in the cache
// when it arrives, so the next load is fresh.
const NETWORK_TIMEOUT_MS = 3000;
const CACHE = `coloration-${VERSION}`;

// Pre-cached shell: enough to boot the game offline after the first visit.
// Photos are picked up lazily by the runtime cache as rounds are played.
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/game.js',
  'js/grid.js',
  'js/quad.js',
  'js/share.js',
  'js/daily.js',
  'js/characters.js',
  'js/blob.js',
  'data/characters.json',
  'data/items.json',
  'assets/favicon.svg',
  'assets/fonts/cormorant-garamond-700-latin.woff2',
  'assets/fonts/inter-var-latin.woff2',
  'assets/fonts/outfit-var-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Leave cross-origin requests (Google Fonts) to the browser's own cache.
  if (url.origin !== location.origin) return;

  const cacheFirst = url.pathname.includes('/assets/');
  event.respondWith(cacheFirst ? fromCacheFirst(req) : fromNetworkFirst(req, event));
});

// Navigations ignore the query string so a share link (?s=...) can still boot
// from the cached shell.
async function cachedFor(req) {
  const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (hit) return hit;
  if (req.mode === 'navigate') return caches.match('index.html');
  return undefined;
}

async function fromNetworkFirst(req, event) {
  let cacheWrite = Promise.resolve();
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      cacheWrite = caches.open(CACHE).then(cache => cache.put(req, copy));
    }
    return res;
  });
  // Keep the worker alive until the network copy has landed in the cache,
  // even when a cached copy already answered the page. (Called synchronously
  // from the fetch handler, as FetchEvent.waitUntil requires.)
  event.waitUntil(network.then(() => cacheWrite).catch(() => {}));
  // Resolves to a cached copy once the network has had NETWORK_TIMEOUT_MS to
  // answer; never resolves when there's nothing cached (keep waiting on the
  // network then).
  const slowFallback = new Promise((resolve) => {
    setTimeout(async () => {
      const hit = await cachedFor(req);
      if (hit) resolve(hit);
    }, NETWORK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([network, slowFallback]);
  } catch (err) {
    // Offline (the fetch rejected outright).
    const hit = await cachedFor(req);
    if (hit) return hit;
    throw err;
  }
}

async function fromCacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(cache => cache.put(req, copy));
  }
  return res;
}
