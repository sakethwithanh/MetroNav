// Layer 2: route engine. Dijkstra shortest-time path over the metro graph.
//
// Cost model (minutes):
//   - ride time per edge = distKm / AVG_SPEED_KMH * 60
//   - DWELL_MIN added per intermediate stop (train halts to board/alight)
//   - INTERCHANGE_MIN added when the path switches to a different line
//
// State is (station, arrivingLine) so the interchange penalty only applies
// when the line actually changes. Returns a structured route: ordered legs
// grouped by line, interchange points, totals.

export const COST = {
  AVG_SPEED_KMH: 33, // Delhi Metro effective incl. accel/decel
  DWELL_MIN: 0.5, // halt time per station
  INTERCHANGE_MIN: 5, // walk + wait when changing lines
};

// Build fast adjacency once from metro.json.
export function buildAdjacency(metro) {
  const adj = new Map(); // stationId -> [{to, line, distKm}]
  const add = (from, to, line, distKm) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, line, distKm });
  };
  for (const e of metro.edges) {
    for (const line of e.lines) {
      add(e.a, e.b, line, e.distKm);
      add(e.b, e.a, line, e.distKm);
    }
  }
  return adj;
}

function rideMin(distKm) {
  return (distKm / COST.AVG_SPEED_KMH) * 60 + COST.DWELL_MIN;
}

// Min-heap keyed by cost.
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = 2 * i + 2;
        let s = i;
        if (l < a.length && a[l].cost < a[s].cost) s = l;
        if (r < a.length && a[r].cost < a[s].cost) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

// Dijkstra over (station, line) states. Returns raw path of hops or null.
function dijkstra(metro, adj, fromId, toId) {
  if (fromId === toId) return [];
  const dist = new Map(); // "station|line" -> cost
  const prev = new Map(); // "station|line" -> {pStation, pLine, line, distKm}
  const heap = new Heap();

  // seed: start station with no arriving line (no interchange charged first)
  heap.push({ cost: 0, station: fromId, line: null });
  dist.set(fromId + "|null", 0);

  let endKey = null;
  while (heap.size) {
    const cur = heap.pop();
    const curKey = cur.station + "|" + cur.line;
    if (cur.cost > (dist.get(curKey) ?? Infinity)) continue;
    if (cur.station === toId) {
      endKey = curKey;
      break;
    }
    for (const e of adj.get(cur.station) || []) {
      const changing = cur.line !== null && cur.line !== e.line;
      const step = rideMin(e.distKm) + (changing ? COST.INTERCHANGE_MIN : 0);
      const nKey = e.to + "|" + e.line;
      const nCost = cur.cost + step;
      if (nCost < (dist.get(nKey) ?? Infinity)) {
        dist.set(nKey, nCost);
        prev.set(nKey, {
          pStation: cur.station,
          pLine: cur.line,
          line: e.line,
          distKm: e.distKm,
        });
        heap.push({ cost: nCost, station: e.to, line: e.line });
      }
    }
  }
  if (!endKey) return null;

  // reconstruct hop list (from -> to)
  const hops = [];
  let key = endKey;
  while (prev.has(key)) {
    const p = prev.get(key);
    const [station] = key.split("|");
    hops.push({ from: p.pStation, to: station, line: p.line, distKm: p.distKm });
    key = p.pStation + "|" + p.pLine;
  }
  hops.reverse();
  return hops;
}

// Group consecutive same-line hops into legs; compute totals + interchanges.
function summarize(metro, hops) {
  const nameOf = (id) => metro.stations[id]?.name ?? id;
  const lineOf = (id) => metro.lines[id];

  const legs = [];
  for (const h of hops) {
    const last = legs[legs.length - 1];
    if (last && last.line === h.line) {
      last.stations.push(h.to);
      last.distKm += h.distKm;
    } else {
      legs.push({
        line: h.line,
        lineName: lineOf(h.line)?.name ?? h.line,
        color: lineOf(h.line)?.color ?? "#888",
        from: h.from,
        stations: [h.from, h.to],
        distKm: h.distKm,
      });
    }
  }

  let totalMin = 0;
  let totalKm = 0;
  for (const leg of legs) {
    leg.distKm = +leg.distKm.toFixed(2);
    leg.stops = leg.stations.length - 1;
    leg.fromName = nameOf(leg.stations[0]);
    leg.toName = nameOf(leg.stations[leg.stations.length - 1]);
    // travel direction = terminus this leg heads toward (which platform to use)
    const order = lineOf(leg.line)?.stations || [];
    const bi = order.indexOf(leg.stations[0]);
    const ai = order.indexOf(leg.stations[leg.stations.length - 1]);
    if (bi !== -1 && ai !== -1 && bi !== ai) {
      const termId = ai > bi ? order[order.length - 1] : order[0];
      leg.towards = nameOf(termId);
    } else {
      leg.towards = null;
    }
    leg.rideMin = +(
      (leg.distKm / COST.AVG_SPEED_KMH) * 60 +
      leg.stops * COST.DWELL_MIN
    ).toFixed(1);
    totalKm += leg.distKm;
    totalMin += leg.rideMin;
  }
  const interchanges = legs.slice(1).map((leg) => ({
    station: leg.stations[0],
    stationName: nameOf(leg.stations[0]),
    fromLine: legs[legs.indexOf(leg) - 1].lineName,
    toLine: leg.lineName,
  }));
  totalMin += interchanges.length * COST.INTERCHANGE_MIN;

  return {
    legs,
    interchanges,
    totalStops: hops.length,
    totalKm: +totalKm.toFixed(2),
    totalMin: Math.round(totalMin),
    fare: estimateFare(totalKm),
  };
}

// DMRC distance-slab fare (INR). Sundays & national holidays are one slab
// cheaper. Holidays aren't enumerated here, so only Sunday gets the discount.
export function estimateFare(km, now = new Date()) {
  // day of week in IST (0 = Sunday), independent of host timezone
  const istDay = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCDay();
  const sunday = istDay === 0;
  // [maxKm, fare]
  const slabs = sunday
    ? [[2, 11], [5, 11], [12, 21], [21, 32], [32, 43], [Infinity, 54]]
    : [[2, 11], [5, 21], [12, 32], [21, 43], [32, 54], [Infinity, 64]];
  for (const [max, fare] of slabs) if (km <= max) return fare;
  return slabs[slabs.length - 1][1];
}

// Public: find best route between two station ids.
export function findRoute(metro, adj, fromId, toId) {
  if (!metro.stations[fromId]) throw new Error(`unknown station: ${fromId}`);
  if (!metro.stations[toId]) throw new Error(`unknown station: ${toId}`);
  const hops = dijkstra(metro, adj, fromId, toId);
  if (hops === null) return null; // disconnected
  if (hops.length === 0) return { legs: [], interchanges: [], totalStops: 0, totalKm: 0, totalMin: 0, fare: 0 };
  return summarize(metro, hops);
}
