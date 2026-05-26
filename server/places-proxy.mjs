// Local dev standalone proxy. Keeps the Gemini key server-side; the browser
// fetches GET /places?lat=..&lon=..&name=.. -> top-5 nearby spots.
// Production (Vercel) uses api/places.js instead — both share gemini-places.mjs.
//
// Run:  npm run proxy   (reads GEMINI_API_KEY from .env)
// Key:  free from https://aistudio.google.com/apikey

import { createServer } from "node:http";
import { getSpots, MODEL_NAME } from "./gemini-places.mjs";

// Load .env (GEMINI_API_KEY, optional GEMINI_MODEL). Node 20.12+.
try {
  process.loadEnvFile();
} catch {
  /* no .env — fall back to real env vars */
}

const PORT = process.env.PLACES_PORT || 8787;
if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
  console.error("Missing GEMINI_API_KEY. Get a free key: https://aistudio.google.com/apikey");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/places") return res.writeHead(404).end("not found");

  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");
  const name = url.searchParams.get("name");
  if (!lat || !lon || !name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "lat, lon, name required" }));
  }

  try {
    const out = await getSpots(name, lat, lon);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (err) {
    console.error("places error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message, source: "none" }));
  }
});

server.listen(PORT, () => console.log(`places proxy on http://localhost:${PORT}  (model ${MODEL_NAME})`));
