// Vercel serverless function: GET /api/places?lat=..&lon=..&name=..
// Same-origin, so no CORS needed. Stateless per invocation -> concurrent users
// are fully isolated. Key comes from the GEMINI_API_KEY env var (Vercel dashboard).

import { getSpots } from "../server/gemini-places.mjs";

export default async function handler(req, res) {
  const { lat, lon, name } = req.query || {};
  if (!lat || !lon || !name) {
    return res.status(400).json({ error: "lat, lon, name required" });
  }
  try {
    const out = await getSpots(name, lat, lon);
    res.setHeader("Cache-Control", "public, s-maxage=43200, stale-while-revalidate=86400");
    return res.status(200).json(out);
  } catch (err) {
    // browser falls back to Overpass on non-200
    return res.status(502).json({ error: err.message, source: "none" });
  }
}
