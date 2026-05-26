// Layer 4: next-train estimate. No public DMRC realtime feed exists, so we
// model arrivals from published headways (gap between trains) per service
// period. Returns the next few estimated arrival times at a station/line.
//
// Headways are approximate DMRC norms. Tune per line later if needed.
// Times are in IST (Asia/Kolkata, UTC+5:30) regardless of host clock.

const IST_OFFSET_MIN = 330;

// service windows (IST, 24h decimal) -> headway minutes
const HEADWAY_TABLE = {
  "Delhi Metro": [
    { from: 5.0, to: 8.0, headwayMin: 5 }, // early
    { from: 8.0, to: 11.0, headwayMin: 2.5 }, // morning peak
    { from: 11.0, to: 17.0, headwayMin: 4 }, // midday
    { from: 17.0, to: 21.0, headwayMin: 2.5 }, // evening peak
    { from: 21.0, to: 23.5, headwayMin: 6 }, // late
  ],
  "Airport Express Line": [{ from: 4.75, to: 23.67, headwayMin: 10 }],
  "Rapid Metro Gurgaon": [{ from: 6.0, to: 23.0, headwayMin: 5 }],
  "Noida Metro": [{ from: 6.0, to: 22.0, headwayMin: 7 }],
  "RRTS": [{ from: 6.0, to: 22.0, headwayMin: 15 }],
  "Meerut Metro": [{ from: 6.0, to: 22.0, headwayMin: 10 }],
};
const DEFAULT_WINDOWS = HEADWAY_TABLE["Delhi Metro"];

// current time in IST as decimal hours, independent of host timezone
function istDecimalHours(date = new Date()) {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const istMin = (utcMin + IST_OFFSET_MIN) % 1440;
  return istMin / 60;
}

function windowsFor(line) {
  // Airport Express named separately; otherwise group by system.
  if (line?.name === "Airport Express Line") return HEADWAY_TABLE["Airport Express Line"];
  return HEADWAY_TABLE[line?.system] || DEFAULT_WINDOWS;
}

function fmtIST(decHours) {
  let h = Math.floor(decHours) % 24;
  let m = Math.round((decHours - Math.floor(decHours)) * 60);
  if (m === 60) { m = 0; h = (h + 1) % 24; }
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

// Estimate next `count` train arrivals for a line. Returns {operating, headwayMin, arrivals:[{inMin, at}]}.
export function nextTrains(line, { count = 3, now = new Date() } = {}) {
  const windows = windowsFor(line);
  const t = istDecimalHours(now);
  const win = windows.find((w) => t >= w.from && t < w.to);

  if (!win) {
    const first = windows[0].from;
    const last = windows[windows.length - 1].to;
    const closed = t < first || t >= last;
    return {
      operating: false,
      note: closed ? `service runs ~${fmtIST(first)}–${fmtIST(last)}` : "between service windows",
      headwayMin: null,
      arrivals: [],
    };
  }

  // Phase within the current window is unknown (no live data), so assume a
  // uniform random offset: expected wait = headway/2, then full headways.
  const arrivals = [];
  let waited = win.headwayMin / 2;
  for (let i = 0; i < count; i++) {
    const inMin = +waited.toFixed(1);
    arrivals.push({ inMin, at: fmtIST(t + waited / 60) });
    waited += win.headwayMin;
  }
  return { operating: true, headwayMin: win.headwayMin, arrivals, estimated: true };
}
