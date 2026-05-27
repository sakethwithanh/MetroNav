# MetroNav — ad-free Delhi Metro

Type any two places in Delhi NCR. Get the fastest metro route, fare,
next-train estimate, and top spots near each station. No ads. All data from
free, keyless sources (OpenStreetMap / Nominatim / Overpass).

## Run (local)

```bash
npm run dev          # static app at http://localhost:5173
```

Open http://localhost:5173, enter From / To (or tap **📍 Me**), Find route.
Fully static — no API keys, no backend.

## Deploy (Vercel)

Pure static site. Concurrent users are isolated — all routing runs in each
browser; geocoding and nearby-places call free public APIs directly.

```bash
npm i -g vercel
vercel              # link + preview deploy
vercel --prod       # production deploy
```

Or connect the GitHub repo in the Vercel dashboard for auto-deploy on push.
No environment variables needed.

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
