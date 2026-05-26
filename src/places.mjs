// Layer 5: nearby places. "Top spots near each station" — restaurants, cafes,
// pubs/bars, malls, attractions, parks. Data from OpenStreetMap via Overpass.
// Free, no key. No popularity metric in OSM, so we rank by a category weight
// plus proximity, and require a name (named POIs are the notable ones).

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = "metro-nav/0.1 (personal Delhi Metro app)";

// category -> {label, weight}. Higher weight = more "destination-worthy".
const CATEGORIES = [
  { q: '["tourism"~"attraction|museum|gallery|viewpoint|artwork|zoo"]', kind: "attraction", weight: 5 },
  { q: '["historic"]', kind: "heritage", weight: 5 },
  { q: '["amenity"="place_of_worship"]', kind: "temple", weight: 3 },
  { q: '["leisure"~"park|garden"]', kind: "park", weight: 3 },
  { q: '["shop"="mall"]', kind: "mall", weight: 4 },
  { q: '["amenity"~"pub|bar|nightclub"]', kind: "pub/bar", weight: 4 },
  { q: '["amenity"~"restaurant|cafe"]', kind: "food", weight: 2 },
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
    if (c.kind === "attraction" && /attraction|museum|gallery|viewpoint|artwork|zoo/.test(tags.tourism || "")) return c;
    if (c.kind === "heritage" && tags.historic) return c;
    if (c.kind === "temple" && tags.amenity === "place_of_worship") return c;
    if (c.kind === "park" && /park|garden/.test(tags.leisure || "")) return c;
    if (c.kind === "mall" && tags.shop === "mall") return c;
    if (c.kind === "pub/bar" && /pub|bar|nightclub/.test(tags.amenity || "")) return c;
    if (c.kind === "food" && /restaurant|cafe/.test(tags.amenity || "")) return c;
  }
  return null;
}

// Where to reach the Gemini places endpoint.
//   - Vercel / prod: same-origin "/api/places" (default)
//   - Local dev with the standalone proxy: set
//       localStorage.setItem("metroProxy", "http://localhost:8787/places")
function defaultProxy() {
  try {
    const o = localStorage.getItem("metroProxy");
    if (o) return o;
  } catch {}
  return "/api/places";
}

// Gemini-backed places via the proxy/function (Maps/Search grounding).
// Returns { spots:[{name,kind,dist,note,uri?}], source } or throws.
export async function getNearbyPlacesGemini(
  coord,
  name,
  { proxy = defaultProxy(), fetchImpl = fetch, timeoutMs = 6000 } = {}
) {
  const url = `${proxy}?lat=${coord.lat}&lon=${coord.lon}&name=${encodeURIComponent(name)}`;
  // abort if Gemini is too slow -> caller falls back to Overpass
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    const data = await res.json();
    if (data.error || !data.spots?.length) throw new Error(data.error || "no spots");
    return data;
  } finally {
    clearTimeout(timer);
  }
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
  return items.slice(0, limit).map(({ score, ...rest }) => rest);
}
