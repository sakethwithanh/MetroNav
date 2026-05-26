// Layer 1: pull raw Delhi Metro network from OpenStreetMap via Overpass API.
// Free, no API key. Output: data/raw-overpass.json
//
// Strategy: grab every route=subway relation in the Delhi NCR bounding box.
// Each relation = one metro service (a line direction). Members tagged with a
// "stop" role are the ordered stations. We keep relations + their member nodes
// so build-graph.mjs can assemble the network offline.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Delhi NCR bounding box (south, west, north, east).
// Covers DMRC reach into Noida, Gurugram, Faridabad, Ghaziabad, Bahadurgarh.
const BBOX = "28.30,76.75,28.95,77.65";

const QUERY = `
[out:json][timeout:300];
(
  relation["route"="subway"](${BBOX});
);
out body;
>;
out body qt;
`;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function fetchOverpass() {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      console.log(`Querying ${url} ...`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "metro-nav/0.1 (personal Delhi Metro app)",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(QUERY),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.elements?.length) throw new Error("empty result");
      return json;
    } catch (err) {
      console.warn(`  failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw new Error(`all Overpass endpoints failed: ${lastErr?.message}`);
}

async function main() {
  const json = await fetchOverpass();
  const rels = json.elements.filter((e) => e.type === "relation").length;
  const nodes = json.elements.filter((e) => e.type === "node").length;
  console.log(`Got ${rels} subway relations, ${nodes} nodes.`);

  const out = "data/raw-overpass.json";
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(json));
  console.log(`Saved ${out}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
