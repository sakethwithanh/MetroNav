// Layer 1: turn raw Overpass dump into a clean metro graph.
// Input:  data/raw-overpass.json
// Output: data/metro.json  { lines, stations, edges }
//
// Each route=subway relation is one direction of one line. We:
//   1. derive a canonical line name (strip the "(A -> B)" direction suffix)
//   2. merge stop nodes that share a normalized name into one logical station
//   3. add an undirected edge between consecutive stops on every relation
//   4. flag a station as interchange when it serves >1 line

import { readFile, writeFile } from "node:fs/promises";

const NAMED_COLORS = {
  gray: "#838996",
  grey: "#838996",
  aqua: "#00B7C3",
};

// Which operator each line belongs to -> lets the UI group / focus DMRC.
function systemOf(tags) {
  const op = (tags.operator || "").toLowerCase();
  const net = (tags.network || "").toLowerCase();
  if (op.includes("rapid metrorail gurgaon") || net.includes("rapid metro"))
    return "Rapid Metro Gurgaon";
  if (net.includes("noida") || /aqua/i.test(tags.name)) return "Noida Metro";
  if (/rrts|rapidx/i.test(tags.name)) return "RRTS";
  if (/meerut/i.test(tags.name)) return "Meerut Metro";
  return "Delhi Metro";
}

// "Blue Line (Noida... -> Dwarka...)" / "Aqua Line: A -> B" -> "Blue Line"
function canonicalLineName(name = "") {
  return name
    .split(/\s*[\(:]\s*/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

function normColor(c) {
  if (!c) return "#888888";
  const lc = c.toLowerCase();
  if (NAMED_COLORS[lc]) return NAMED_COLORS[lc];
  return c.startsWith("#") ? c.toUpperCase() : c;
}

// strip OSM line-disambiguator suffix: "Inderlok (Red Line)" -> "Inderlok"
function cleanStationName(name = "") {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// merge key for stations: lowercase, strip punctuation/spaces
function stationKey(name = "") {
  return cleanStationName(name)
    .toLowerCase()
    .replace(/[‐-―]/g, "-") // unicode dashes -> hyphen
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function haversineKm(a, b) {
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

async function main() {
  const raw = JSON.parse(await readFile("data/raw-overpass.json", "utf8"));
  const nodeById = new Map(
    raw.elements.filter((e) => e.type === "node").map((n) => [n.id, n])
  );
  const relations = raw.elements.filter((e) => e.type === "relation");

  const lines = {}; // lineId -> {id,name,color,system,stations:Set}
  const stations = {}; // key  -> {id,name,lat,lon,_n, lines:Set}
  const edgeSet = new Map(); // "a|b" -> {a,b,lines:Set,dist}

  function upsertStation(node) {
    const rawName = node.tags?.name;
    if (!rawName || node.lat == null) return null;
    const name = cleanStationName(rawName);
    const key = stationKey(rawName);
    if (!stations[key]) {
      stations[key] = {
        id: slug(name),
        name,
        lat: 0,
        lon: 0,
        _n: 0,
        lines: new Set(),
      };
    }
    const s = stations[key];
    // running average of platform coords -> station centroid
    s.lat = (s.lat * s._n + node.lat) / (s._n + 1);
    s.lon = (s.lon * s._n + node.lon) / (s._n + 1);
    s._n++;
    return key;
  }

  for (const rel of relations) {
    const lineName = canonicalLineName(rel.tags.name);
    if (!lineName) continue;
    const lineId = slug(lineName);
    if (!lines[lineId]) {
      lines[lineId] = {
        id: lineId,
        name: lineName,
        color: normColor(rel.tags.colour || rel.tags.color),
        system: systemOf(rel.tags),
        stations: new Set(),
      };
    }
    const line = lines[lineId];

    // ordered stop keys for this relation
    const stopKeys = [];
    for (const m of rel.members) {
      if (!m.role || !m.role.startsWith("stop")) continue;
      const node = nodeById.get(m.ref);
      if (!node) continue;
      const key = upsertStation(node);
      if (!key) continue;
      stations[key].lines.add(lineId);
      line.stations.add(key);
      stopKeys.push(key);
    }

    // undirected edges between consecutive distinct stops
    for (let i = 0; i + 1 < stopKeys.length; i++) {
      const a = stopKeys[i];
      const b = stopKeys[i + 1];
      if (a === b) continue;
      const ek = [a, b].sort().join("|");
      if (!edgeSet.has(ek)) {
        edgeSet.set(ek, {
          a: stations[a].id,
          b: stations[b].id,
          _ka: a,
          _kb: b,
          lines: new Set(),
        });
      }
      edgeSet.get(ek).lines.add(lineId);
    }
  }

  // finalize stations
  const stationOut = {};
  for (const key of Object.keys(stations)) {
    const s = stations[key];
    stationOut[s.id] = {
      id: s.id,
      name: s.name,
      lat: +s.lat.toFixed(6),
      lon: +s.lon.toFixed(6),
      lines: [...s.lines],
      interchange: s.lines.size > 1,
    };
  }

  // finalize edges with distance
  const edgeOut = [];
  for (const e of edgeSet.values()) {
    const sa = stations[e._ka];
    const sb = stations[e._kb];
    edgeOut.push({
      a: e.a,
      b: e.b,
      lines: [...e.lines],
      distKm: +haversineKm(sa, sb).toFixed(3),
    });
  }

  // finalize lines
  const lineOut = {};
  for (const id of Object.keys(lines)) {
    const l = lines[id];
    lineOut[id] = {
      id: l.id,
      name: l.name,
      color: l.color,
      system: l.system,
      stationCount: l.stations.size,
      stations: [...l.stations].map((k) => stations[k].id),
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    counts: {
      lines: Object.keys(lineOut).length,
      stations: Object.keys(stationOut).length,
      edges: edgeOut.length,
      interchanges: Object.values(stationOut).filter((s) => s.interchange)
        .length,
    },
    lines: lineOut,
    stations: stationOut,
    edges: edgeOut,
  };

  await writeFile("data/metro.json", JSON.stringify(out, null, 2));
  console.log("Saved data/metro.json");
  console.log(out.counts);
  console.log(
    "Lines:",
    Object.values(lineOut)
      .map((l) => `${l.name} [${l.system}] (${l.stationCount})`)
      .join("\n       ")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
