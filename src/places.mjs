// Layer 5: nearby places. "Top spots near each station" — restaurants, cafes,
// pubs/bars, malls, attractions, parks. Data from OpenStreetMap via Overpass.
// Free, no key. No popularity metric in OSM, so we rank by a category weight
// plus proximity, and require a name (named POIs are the notable ones).

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = "metro-nav/0.1 (personal Delhi Metro app)";

// category -> {kind, weight}. Higher weight = more "destination-worthy".
// Balanced for a visitor: attractions still lead, but food/markets/pubs/hotels
// surface too (a diversity cap below keeps the top-5 from being all one kind).
const CATEGORIES = [
  { q: '["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park"]', kind: "attraction", weight: 5 },
  { q: '["historic"]', kind: "heritage", weight: 4 },
  { q: '["shop"~"mall|department_store"]', kind: "mall", weight: 4 },
  { q: '["amenity"="marketplace"]', kind: "market", weight: 4 },
  { q: '["amenity"~"pub|bar|nightclub"]', kind: "pub/bar", weight: 4 },
  { q: '["amenity"~"restaurant|cafe|food_court"]', kind: "food", weight: 4 },
  { q: '["leisure"~"park|garden"]', kind: "park", weight: 3 },
  { q: '["tourism"="hotel"]', kind: "hotel", weight: 3 },
  { q: '["amenity"="place_of_worship"]', kind: "temple", weight: 3 },
];

function haversineM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildQuery(coord, radiusM) {
  const around = `(around:${radiusM},${coord.lat},${coord.lon})`;
  const parts = CATEGORIES.map(
    (c) => `nwr${c.q}${around};`
  ).join("\n");
  return `[out:json][timeout:60];(\n${parts}\n);out center tags;`;
}

function classify(tags) {
  for (const c of CATEGORIES) {
    // cheap re-match against the tag object
    if (c.kind === "attraction" && /attraction|museum|gallery|viewpoint|zoo|theme_park/.test(tags.tourism || "")) return c;
    if (c.kind === "heritage" && tags.historic) return c;
    if (c.kind === "mall" && /mall|department_store/.test(tags.shop || "")) return c;
    if (c.kind === "market" && tags.amenity === "marketplace") return c;
    if (c.kind === "pub/bar" && /pub|bar|nightclub/.test(tags.amenity || "")) return c;
    if (c.kind === "food" && /restaurant|cafe|food_court/.test(tags.amenity || "")) return c;
    if (c.kind === "park" && /park|garden/.test(tags.leisure || "")) return c;
    if (c.kind === "hotel" && tags.tourism === "hotel") return c;
    if (c.kind === "temple" && tags.amenity === "place_of_worship") return c;
  }
  return null;
}

// Top places near a coord. Returns ranked array of {name, kind, distM, lat, lon}.
export async function getNearbyPlaces(
  coord,
  { radiusM = 800, limit = 5, fetchImpl = fetch, timeoutMs = 8000 } = {}
) {
  const body = "data=" + encodeURIComponent(buildQuery(coord, radiusM));
  let json;
  let lastErr;
  for (const url of ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Accept: "application/json",
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
      break;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!json) throw new Error(`places lookup failed: ${lastErr?.message}`);

  const seen = new Set();
  const items = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:en"];
    if (!name) continue; // unnamed POIs are noise
    const cat = classify(tags);
    if (!cat) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const distM = Math.round(haversineM(coord, { lat, lon }));
    // score: category weight, decayed by distance (closer = better)
    const score = cat.weight * (1 - Math.min(distM, radiusM) / (radiusM * 1.5));
    items.push({ name, kind: cat.kind, distM, lat, lon, score });
  }

  items.sort((a, b) => b.score - a.score);

  // diversity cap: at most 2 of any one kind, so the top list spans categories
  // (attraction + food + market + park...) instead of e.g. 5 heritage sites.
  const perKind = {};
  const picked = [];
  for (const it of items) {
    if (picked.length >= limit) break;
    perKind[it.kind] = (perKind[it.kind] || 0) + 1;
    if (perKind[it.kind] > 2) continue;
    picked.push(it);
  }
  // if the cap left us short (sparse area), backfill from what's left
  if (picked.length < limit) {
    for (const it of items) {
      if (picked.length >= limit) break;
      if (!picked.includes(it)) picked.push(it);
    }
  }
  return picked.map(({ score, ...rest }) => rest);
}
