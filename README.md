# HL Hot Demo

Standalone Hyperliquid hot-score demo for main perps and HIP-3 `xyz:*` assets.

## Local

```bash
node server.js
```

Open `http://localhost:4173`.

## GitHub Pages

Generate a static snapshot first:

```bash
node server.js --build-static
```

This writes `public/data/latest.json`, which the frontend can use on GitHub Pages.

GitHub Pages in this repo is published from `docs/`, which mirrors the static site files.
