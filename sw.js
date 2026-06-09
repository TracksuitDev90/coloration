// Minimal service worker so the installed (standalone) app still opens
// offline. Strategy keeps deploys painless:
//   - navigations, JSON, JS, CSS → network-first, falling back to cache, so a
//     fresh deploy is picked up on the next online load with no version dance
//   - assets/ (photos, icons)    → cache-first with runtime fill; they're
//     content-addressed by filename in practice and never change in place
// Bump VERSION to drop every cached entry on the next activate.
const VERSION = 'v1';
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
  event.respondWith(cacheFirst ? fromCacheFirst(req) : fromNetworkFirst(req));
});

async function fromNetworkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy));
    }
    return res;
  } catch (err) {
    // Offline. Navigations ignore the query string so a stale share link
    // (?s=...) still boots the cached shell.
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match('index.html');
      if (shell) return shell;
    }
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
