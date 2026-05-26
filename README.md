# MetroNav — ad-free Delhi Metro

Type any two places in Delhi NCR. Get the fastest metro route, fare,
next-train estimate, and top spots near each station. No ads. All data from
free, keyless sources (OpenStreetMap / Nominatim / Overpass).

## Run (local)

```bash
npm install
npm run dev          # static app at http://localhost:5173

# optional: Gemini nearby-places proxy (free key from aistudio.google.com/apikey)
cp .env.example .env # put your key in it
npm run proxy        # http://localhost:8787
```

Open http://localhost:5173, enter From / To (or tap **📍 Me**), Find route.

Because the app now defaults the places endpoint to `/api/places` (for Vercel),
local use of the standalone proxy needs a one-time browser override — run this
in the DevTools console once:

```js
localStorage.setItem("metroProxy", "http://localhost:8787/places")
```

(Or run `vercel dev` instead of `npm run dev` + `npm run proxy` — it serves the
static app **and** `/api/places` on one port, matching production.)

## Deploy (Vercel)

Static frontend + one serverless function. Concurrent users are isolated:
routing runs in each browser; `/api/places` is stateless per request.

```bash
npm i -g vercel
vercel                       # link + preview deploy
vercel env add GEMINI_API_KEY   # paste your key (Production + Preview)
vercel --prod                # production deploy
```

- `api/places.js` — the Gemini places function (Maps→Search grounding).
- `server/gemini-places.mjs` — shared core (used by the function + local proxy).
- `vercel.json` — sets the function `maxDuration` to 30s (Gemini calls).
- Key lives in the Vercel env var, never in the browser.
- Shared ceiling = Gemini free-tier quota; on quota/error the browser auto-falls
  back to free Overpass.

## Architecture (built layer by layer)

| Layer | File | What |
|------|------|------|
| 1 Data | `scripts/fetch-stations.mjs`, `scripts/build-graph.mjs` → `data/metro.json` | Delhi Metro network from OSM Overpass: 297 stations, 13 lines, 31 interchanges, real coords |
| 2 Route | `src/route.mjs` | Dijkstra over (station, line); interchange penalty; fare + time |
| 3 Geo | `src/geo.mjs` | Nominatim geocode → nearest stations → door-to-door plan |
| 4 Next train | `src/schedule.mjs` | Headway-based arrival estimate in IST (no public live feed exists) |
| 5 Places | `src/places.mjs` | Overpass POIs → top 5 spots per station |
| 6 UI | `index.html`, `src/app.mjs` | Leaflet map (free OSM tiles), search, route render, station spots |

## Refresh network data

```bash
npm run fetch:data && npm run build:graph
```

## Free APIs used (no keys, no cost)

- **OpenStreetMap tiles** — map display
- **Nominatim** — geocoding (≤1 req/sec, throttled in `geo.mjs`)
- **Overpass** — station network + nearby places

## Known limits

- **Next-train is an estimate**, not live GPS. DMRC has no public realtime API.
  Modeled from published headways; tune `HEADWAY_TABLE` in `schedule.mjs`.
- Long-haul ride times run ~15% high; tune `COST.AVG_SPEED_KMH` in `route.mjs`.
- Places ranked by category weight + proximity (OSM has no popularity signal).
