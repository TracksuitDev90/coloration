# Coloration

A daily color guessing game. Each day, the puzzle presents four iconic items and asks you to pick the right shade — one round at a time, the same set for everyone, reset at UTC midnight.

## How to play

- **Items** (live) — a 2×2 swatch picker. Four distinct colors, one guess per round, four rounds per day.
- **Characters** (coming soon) — a 4×4 shade grid centered on the right hue. The tab is visible but parked while the mode is reworked (`CHARACTERS_ENABLED` in `js/main.js`).

Each day allows up to **2 skips**. A skipped round is neutral against your in-day streak but still uses the slot. Progress persists per UTC day in `localStorage`, so refreshing mid-puzzle picks up where you left off; the next UTC midnight starts a fresh set. Finishing the run on consecutive days builds a **day streak**, shown on the end screen and stamped into shares.

When the run ends, you can save a share image, copy a result-link (a read-only view of your day), or copy an emoji-style summary.

## Run locally

This is a static site that uses ES modules, so it must be served — opening `index.html` directly via `file://` won't work.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, `caddy file-server`, etc.).

## Project layout

```
index.html             - shell + meta + intro loader
styles.css             - all styles
sw.js                  - minimal service worker (offline shell + photo cache)
manifest.webmanifest   - PWA metadata
robots.txt             - crawler directives
sitemap.xml            - single-URL sitemap
js/
  main.js              - entry, init, UI wiring, day streak
  game.js              - daily-game state + persistence
  characters.js        - loads + validates data/characters.json and data/items.json
  daily.js             - UTC date keying + daily character selection
  grid.js, quad.js     - board generators
  share.js             - share-card canvas + emoji/url encoding
data/
  characters.json      - character roster
  items.json           - item roster
assets/
  photos/              - per-character photos (referenced from JSON)
  favicon.svg          - source icon (PNG sizes derived from it)
  og-image.png         - social-share preview (1200×630)
scripts/               - one-off Python/Node tooling for asset prep
```

## Deploying

The canonical URL (`https://tracksuitdev90.github.io/coloration`) is baked into `index.html`, `robots.txt`, and `sitemap.xml` — update all three if the site moves. The service worker is network-first for code and data, so deploys are picked up on the next online load; bump `VERSION` in `sw.js` to force-drop cached photos.

## License

See [LICENSE](LICENSE).
