// Shared Gemini "nearby places" core. Used by both the local standalone proxy
// (server/places-proxy.mjs) and the Vercel serverless function (api/places.js).
//
// Provider chain: Gemini Maps grounding -> Gemini Search grounding -> throw
// (the browser falls back to Overpass on throw / non-200).
//
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional, default gemini-2.5-flash).

import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// lazy client so importing this module never crashes when key is absent
let _ai = null;
function client() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  if (!_ai) _ai = new GoogleGenAI({ apiKey: key });
  return _ai;
}

// best-effort cache. Persists only within a warm instance (serverless: partial
// hit rate; swap for Vercel KV if you need cross-invocation caching).
const cache = new Map();
const TTL = 1000 * 60 * 60 * 12; // 12h

const PROMPT = (name, lat, lon) =>
  `List the top 5 places worth visiting near ${name} metro station ` +
  `(coordinates ${lat}, ${lon}) in Delhi NCR, India. Mix of attractions, ` +
  `markets, food/cafes, pubs or bars, parks, temples or heritage — whatever ` +
  `is genuinely notable nearby. Reply with ONLY a JSON array, no prose, no code fences:\n` +
  `[{"name":"...","kind":"one or two words","dist":"approx walk e.g. 300m or 1.2km","note":"3-6 word highlight"}]`;

export function parseSpots(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s === -1 || e === -1) return null;
  try {
    const arr = JSON.parse(t.slice(s, e + 1));
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((x) => x && x.name)
      .slice(0, 5)
      .map((x) => ({
        name: String(x.name),
        kind: String(x.kind || "spot"),
        dist: String(x.dist || ""),
        note: String(x.note || ""),
      }));
  } catch {
    return null;
  }
}

async function viaMaps(name, lat, lon) {
  const res = await client().models.generateContent({
    model: MODEL,
    contents: PROMPT(name, lat, lon),
    config: {
      tools: [{ googleMaps: {} }],
      toolConfig: { retrievalConfig: { latLng: { latitude: +lat, longitude: +lon } } },
    },
  });
  const spots = parseSpots(res.text);
  if (!spots?.length) throw new Error("maps: no spots parsed");
  const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  for (const sp of spots) {
    const hit = chunks.find(
      (c) => c.maps?.title && c.maps.title.toLowerCase().includes(sp.name.toLowerCase().slice(0, 8))
    );
    if (hit?.maps?.uri) sp.uri = hit.maps.uri;
  }
  return { spots, source: "gemini-maps" };
}

async function viaSearch(name, lat, lon) {
  const res = await client().models.generateContent({
    model: MODEL,
    contents: PROMPT(name, lat, lon),
    config: { tools: [{ googleSearch: {} }] },
  });
  const spots = parseSpots(res.text);
  if (!spots?.length) throw new Error("search: no spots parsed");
  return { spots, source: "gemini-search" };
}

// Top-5 spots for a station. Throws if both Gemini providers fail.
export async function getSpots(name, lat, lon) {
  const c = cache.get(name);
  if (c && Date.now() - c.t < TTL) return { spots: c.spots, source: c.source };
  let out;
  try {
    out = await viaMaps(name, lat, lon);
  } catch (e1) {
    out = await viaSearch(name, lat, lon); // may throw -> caller handles
  }
  cache.set(name, { ...out, t: Date.now() });
  return out;
}

export const MODEL_NAME = MODEL;
