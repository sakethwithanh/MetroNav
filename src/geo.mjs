// Layer 3: geo. Address -> coords -> nearest stations -> full door-to-door plan.
// Uses Nominatim (OpenStreetMap) for geocoding. Free, no key.
// Nominatim usage policy: <=1 req/sec, send a User-Agent. We throttle here.

import { findRoute } from "./route.mjs";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = "metro-nav/0.1 (personal Delhi Metro app)";
const WALK_SPEED_KMH = 4.8; // average pedestrian
const NCR_VIEWBOX = "76.75,28.95,77.65,28.30"; // lon,lat bias to Delhi NCR

let lastCall = 0;
async function throttle() {
  const wait = 1000 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Geocode a free-text address. Returns {lat, lon, label} or null.
// bounded=1 restricts results to the NCR viewbox so we never jump out of Delhi.
export async function geocode(query, { fetchImpl = fetch } = {}) {
  const hits = await suggest(query, { limit: 1, fetchImpl });
  return hits[0] || null;
}

// Autocomplete: up to `limit` NCR matches for a partial query.
// Returns [{lat, lon, label}]. Empty for short/blank queries.
export async function suggest(query, { limit = 5, fetchImpl = fetch } = {}) {
  const q = (query || "").trim();
  if (q.length < 3) return [];
  await throttle();
  const url =
    `${NOMINATIM}?format=jsonv2&limit=${limit}&countrycodes=in&addressdetails=1` +
    `&viewbox=${NCR_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
  const res = await fetchImpl(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const arr = await res.json();
  return arr.map((hit) => ({
    lat: +hit.lat,
    lon: +hit.lon,
    label: hit.display_name,
    short: shortLabel(hit),
  }));
}

// Compact label: "name, suburb, city" from Nominatim address parts.
function shortLabel(hit) {
  const a = hit.address || {};
  const head = hit.name || a.amenity || a.road || (hit.display_name || "").split(",")[0];
  const area = a.suburb || a.neighbourhood || a.city_district || a.city || a.town || "";
  return [head, area].filter(Boolean).join(", ") || hit.display_name;
}

// k nearest stations to a coord, with straight-line + walking-time estimate.
// walkMultiplier (~1.3) turns crow-flies into a rough street distance.
export function nearestStations(metro, coord, { k = 3, walkMultiplier = 1.3 } = {}) {
  const out = [];
  for (const s of Object.values(metro.stations)) {
    const crowKm = haversineKm(coord, s);
    const walkKm = crowKm * walkMultiplier;
    out.push({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      lines: s.lines,
      crowKm: +crowKm.toFixed(3),
      walkKm: +walkKm.toFixed(2),
      walkMin: Math.round((walkKm / WALK_SPEED_KMH) * 60),
    });
  }
  out.sort((a, b) => a.crowKm - b.crowKm);
  return out.slice(0, k);
}

// Door-to-door plan: geocode both ends, try the nearest-station pairs,
// pick the combo with the smallest total time (walk + ride + walk).
// `adj` is prebuilt adjacency from route.buildAdjacency(metro).
export async function planTrip(
  metro,
  adj,
  originQuery,
  destQuery,
  { k = 3, geocodeImpl = geocode } = {}
) {
  const [origin, dest] = await Promise.all([
    typeof originQuery === "string" ? geocodeImpl(originQuery) : originQuery,
    typeof destQuery === "string" ? geocodeImpl(destQuery) : destQuery,
  ]);
  if (!origin) throw new Error(`could not locate origin: ${originQuery}`);
  if (!dest) throw new Error(`could not locate destination: ${destQuery}`);

  const originStations = nearestStations(metro, origin, { k });
  const destStations = nearestStations(metro, dest, { k });

  let best = null;
  for (const os of originStations) {
    for (const ds of destStations) {
      if (os.id === ds.id) continue;
      const route = findRoute(metro, adj, os.id, ds.id);
      if (!route) continue;
      const total = os.walkMin + route.totalMin + ds.walkMin;
      if (!best || total < best.totalMin) {
        best = {
          origin,
          dest,
          board: os,
          alight: ds,
          route,
          walkToMin: os.walkMin,
          walkFromMin: ds.walkMin,
          totalMin: total,
        };
      }
    }
  }
  if (!best) throw new Error("no metro route connects these locations");
  return best;
}
