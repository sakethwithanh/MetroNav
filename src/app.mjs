// Layer 6: web UI (Maps-style skin). Live data + the reference "MetroNav" look.
// Accent + leg colors follow the metro line color of the route.

import { buildAdjacency, findRoute } from "./route.mjs";
import { geocode, suggest, nearestStations, planTrip } from "./geo.mjs";
import { nextTrains } from "./schedule.mjs";
import { getNearbyPlaces } from "./places.mjs";

const $ = (id) => document.getElementById(id);
const results = $("results");

let metro, adj;
let map, tileLayer;
let routeLayers = [];
let stationMarkers = [];
let endpointMarkers = [];
let popoverEl = null;
let selectedStationId = null;
let lastPlan = null;
let theme = "dark";

// resolved endpoint coords from autocomplete: {lat,lon,label} or null
const picked = { from: null, to: null };

// ---------- helpers ----------

// lighten a #hex toward white by amt (0..1) — keeps line colors legible on dark.
function lighten(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex || "#8ab4f8";
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
// line color adapted to current theme (vivid; for map lines + chip backgrounds)
function lineColor(lineId) {
  const base = metro.lines[lineId]?.color || "#888888";
  return theme === "dark" ? lighten(base, 0.35) : base;
}
// mix a #hex toward black(0)/white(255) by amt
function mix(hex, target, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex || "#888888";
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (target - r) * amt);
  g = Math.round(g + (target - g) * amt);
  b = Math.round(b + (target - b) * amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
// relative luminance 0..1
function relLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
// black or white text that reads on top of `bg`
function readableText(bg) {
  return relLum(bg) > 0.5 ? "#202124" : "#ffffff";
}
// line color nudged until legible as TEXT on the current panel background
function accentFor(rawHex) {
  let c = rawHex;
  for (let i = 0; i < 12; i++) {
    if (theme === "light" && relLum(c) > 0.45) c = mix(c, 0, 0.18);
    else if (theme === "dark" && relLum(c) < 0.5) c = mix(c, 255, 0.18);
    else break;
  }
  return c;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const ICON = {
  walk: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M9 22l3-7-2-4 4-3 4 2 3 4M9 14l-2 2"/></svg>',
  train: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l2-3M16 21l-2-3"/></svg>',
  sun: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  moon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z"/></svg>',
};

// ---------- boot ----------

async function boot() {
  metro = await fetch("./data/metro.json").then((r) => r.json());
  adj = buildAdjacency(metro);

  map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true })
    .setView([28.6139, 77.2295], 11);
  applyTiles();

  $("themeBtn").innerHTML = theme === "dark" ? ICON.sun : ICON.moon;

  // events
  $("goBtn").addEventListener("click", run);
  $("locBtn").addEventListener("click", useMyLocation);
  $("meTool").addEventListener("click", useMyLocation);
  $("swapBtn").addEventListener("click", swap);
  $("themeBtn").addEventListener("click", toggleTheme);
  $("zoomIn").addEventListener("click", () => map.setZoom(map.getZoom() + 1));
  $("zoomOut").addEventListener("click", () => map.setZoom(map.getZoom() - 1));
  wireAutocomplete("from", "acFrom");
  wireAutocomplete("to", "acTo");
  setupSheet();
  $("to").addEventListener("keydown", (e) => e.key === "Enter" && run());

  map.on("move zoom", repositionPopover);

  // deep link: #from=...&to=...&theme=light -> prefill + auto-run (shareable routes)
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("theme") === "light" || h.get("theme") === "dark") {
    theme = h.get("theme");
    document.documentElement.setAttribute("data-theme", theme);
    $("themeBtn").innerHTML = theme === "dark" ? ICON.sun : ICON.moon;
    applyTiles();
  }
  if (h.get("from") && h.get("to")) {
    $("from").value = h.get("from");
    $("to").value = h.get("to");
    run();
  }
  // deep link: #station=<id> -> open that station's spots popover
  if (h.get("station") && metro.stations[h.get("station")]) {
    const s = metro.stations[h.get("station")];
    map.setView([s.lat, s.lon], 14);
    openPopover(h.get("station"));
  }
}

function applyTiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  const url = theme === "dark"
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
  tileLayer = L.tileLayer(url, { maxZoom: 19, subdomains: "abcd", attribution: "&copy; OSM &copy; CARTO" });
  tileLayer.addTo(map);
}

function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  $("themeBtn").innerHTML = theme === "dark" ? ICON.sun : ICON.moon;
  applyTiles();
  if (lastPlan) renderPlan(lastPlan); // recolor route for new theme
}

// ---------- autocomplete ----------

function wireAutocomplete(inputId, acId) {
  const input = $(inputId);
  const ac = $(acId);
  let timer = null;
  const which = inputId === "from" ? "from" : "to";

  input.addEventListener("input", () => {
    picked[which] = null; // typing invalidates a prior pick
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 3 || /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(q)) { ac.classList.remove("open"); return; }
    timer = setTimeout(async () => {
      try {
        const hits = await suggest(q, { limit: 5 });
        if (!hits.length) { ac.innerHTML = `<div class="ac-empty">No NCR match for "${esc(q)}"</div>`; ac.classList.add("open"); return; }
        ac.innerHTML = hits
          .map((h, i) => `<div class="ac-item" data-i="${i}"><span>${esc(h.short)}</span></div>`)
          .join("");
        ac.classList.add("open");
        [...ac.querySelectorAll(".ac-item")].forEach((el, i) => {
          el.addEventListener("click", () => {
            picked[which] = hits[i];
            input.value = hits[i].short;
            ac.classList.remove("open");
          });
        });
      } catch { ac.classList.remove("open"); }
    }, 350);
  });
  input.addEventListener("blur", () => setTimeout(() => ac.classList.remove("open"), 150));
}

// ---------- geolocation ----------

function useMyLocation() {
  if (!navigator.geolocation) return alert("Geolocation not supported by this browser.");
  if (!window.isSecureContext) {
    return alert(
      "Location blocked: insecure origin.\nOpen via http://localhost:5173 or http://127.0.0.1:5173 (not a 192.168.x.x address)."
    );
  }
  const onOk = (pos) => {
    const { latitude, longitude } = pos.coords;
    picked.from = { lat: latitude, lon: longitude, label: "My location" };
    $("from").value = "My location";
    map.setView([latitude, longitude], 14);
  };

  const fail = (err) => {
    if (err.code === 1) {
      alert("Location permission denied. Allow location for this site in the browser, then retry.");
    } else {
      // code 2 (unavailable) / 3 (timeout): common on desktops with no GPS/location service
      alert(
        "Couldn't get your location (your device/browser has no location source).\n" +
          "Type your starting point in the From box instead — autocomplete will find it."
      );
      $("from").focus();
    }
  };

  // try GPS-grade first; on unavailable/timeout, retry network/IP-based (more likely on desktop)
  navigator.geolocation.getCurrentPosition(onOk, (err) => {
    if (err.code === 1) return fail(err); // permission denied -> no point retrying
    navigator.geolocation.getCurrentPosition(onOk, fail, {
      enableHighAccuracy: false,
      timeout: 15000,
      maximumAge: 600000,
    });
  }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}

function swap() {
  const f = $("from"), t = $("to");
  [f.value, t.value] = [t.value, f.value];
  [picked.from, picked.to] = [picked.to, picked.from];
}

// ---------- resolve + run ----------

async function resolve(which) {
  const input = $(which);
  const v = input.value.trim();
  if (picked[which]) return picked[which];
  const m = v.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
  if (m) return { lat: +m[1], lon: +m[2], label: v };
  const g = await geocode(v);
  if (!g) throw new Error(`Could not find "${v}" in Delhi NCR.`);
  return g;
}

async function run() {
  // close autocomplete dropdowns + dismiss the mobile keyboard
  $("acFrom").classList.remove("open");
  $("acTo").classList.remove("open");
  document.activeElement?.blur?.();

  if (!$("from").value.trim() || !$("to").value.trim()) {
    results.innerHTML = `<div class="err-box">Enter both a start and destination.</div>`;
    return;
  }
  results.innerHTML = `<div class="hint" style="margin:16px"><div>Locating & routing…</div></div>`;
  if (results.scrollTo) results.scrollTo(0, 0);
  try {
    const origin = await resolve("from");
    const dest = await resolve("to");
    const plan = await planTrip(metro, adj, origin, dest, { k: 3 });
    lastPlan = plan;
    renderPlan(plan);
  } catch (e) {
    results.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
  }
}

// ---------- render panel ----------

function renderPlan(plan) {
  const { board, alight, route } = plan;
  // primary line = longest transit leg -> drives the global accent
  const primary = route.legs.reduce((a, b) => (b.distKm > (a?.distKm ?? -1) ? b : a), null);
  if (primary) {
    const c = accentFor(metro.lines[primary.line].color);
    document.documentElement.style.setProperty("--accent", c);
    document.documentElement.style.setProperty("--accent-ink", c);
  }

  const viaName = primary ? metro.lines[primary.line].name : "";
  let html = `
    <div class="summary">
      <div class="time">
        <span class="big">${plan.totalMin}<small>min</small></span>
        <span class="badge">est.</span>
      </div>
      <div class="sub">
        <span><b>${route.totalKm} km</b> via ${esc(viaName)}</span>
        <span class="sep">·</span><span>fare <b>₹${route.fare}</b></span>
        <span class="sep">·</span><span><b>${route.totalStops}</b> stops</span>
        <span class="sep">·</span><span><b>${route.interchanges.length}</b> changes</span>
      </div>
    </div>
    <div class="itinerary">`;

  // walk to board
  html += legWalk(`Walk to <b>${esc(board.name)}</b>`, `${board.walkKm} km · ${board.walkMin} min`);

  // transit legs
  route.legs.forEach((leg, i) => {
    html += legTransit(leg, i);
    const ix = route.interchanges[i];
    if (ix) html += `<div class="leg walk" style="--leg-color:var(--route-walk)">
        <span class="leg-icon">${ICON.walk}</span>
        <div class="leg-title">Change at <b>${esc(ix.stationName)}</b></div>
        <div class="leg-meta">${esc(ix.fromLine)} → ${esc(ix.toLine)}</div></div>`;
  });

  // walk from alight
  html += legWalk(`Walk to destination from <b>${esc(alight.name)}</b>`, `${alight.walkKm} km · ${alight.walkMin} min`);

  html += `<div class="hint">${ICON_pin()}<div><b>Tip:</b> tap any station dot on the map for the top 5 nearby spots.</div></div></div>`;
  results.innerHTML = html;
  wireStopToggles();

  drawRoute(plan);
}

function ICON_pin() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-7.5-7-12a7 7 0 1 1 14 0c0 4.5-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>';
}

function legWalk(title, meta) {
  return `<div class="leg walk" style="--leg-color:var(--route-walk)">
    <span class="leg-icon">${ICON.walk}</span>
    <div class="leg-title">${title}</div>
    <div class="leg-meta">${meta}</div></div>`;
}

function legTransit(leg, idx) {
  const chipBg = lineColor(leg.line); // vivid line color for the chip background
  const c = accentFor(metro.lines[leg.line].color); // legible accent for border/icon/text
  const short = leg.lineName.replace(/ Line$/, "");
  const nt = nextTrains(metro.lines[leg.line]);
  let chips = "";
  if (nt.operating) {
    chips = nt.arrivals
      .map((a, i) => i === 0
        ? `<span class="train-chip now"><span class="dot"></span> ~${a.inMin} min</span>`
        : `<span class="train-chip">~${a.inMin} min</span>`)
      .join("");
    chips += `<span class="train-chip" style="border-style:dashed;color:var(--ink-quiet)">every ~${nt.headwayMin} min</span>`;
  } else {
    chips = `<span class="train-chip" style="border-style:dashed;color:var(--ink-quiet)">${esc(nt.note)}</span>`;
  }

  const toward = leg.towards ? ` toward <b>${esc(leg.towards)}</b>` : "";
  const stopRows = leg.stations
    .map((sid, i) => {
      const s = metro.stations[sid];
      const ix = s?.interchange ? ` <em style="color:var(--ink-faint);font-style:normal"> · interchange</em>` : "";
      return `<div class="stop"><span class="ring"></span><span>${i + 1}. ${esc(s?.name || sid)}${ix}</span></div>`;
    })
    .join("");

  return `<div class="leg transit" style="--leg-color:${c}">
    <span class="leg-icon">${ICON.train}</span>
    <div class="leg-title">
      <span class="line-chip" style="background:${chipBg};color:${readableText(chipBg)}"><span class="line-pip"></span>${esc(short)}</span>${toward}
    </div>
    <div class="leg-meta">Board at ${esc(leg.fromName)} · ride <b>${leg.stops} stops</b> (${leg.distKm} km, ~${leg.rideMin} min) · alight at ${esc(leg.toName)}</div>
    <div class="next-trains">${chips}</div>
    <div class="stop-list" data-leg="${idx}">
      <button class="toggle" data-action="show">Show all ${leg.stations.length} stops ▾</button>
      <div class="stops-inner" style="display:none">${stopRows}<button class="toggle" data-action="hide">Hide stops</button></div>
    </div>
  </div>`;
}

function wireStopToggles() {
  results.querySelectorAll(".stop-list").forEach((sl) => {
    const showBtn = sl.querySelector('[data-action="show"]');
    const inner = sl.querySelector(".stops-inner");
    const hideBtn = sl.querySelector('[data-action="hide"]');
    showBtn?.addEventListener("click", () => { inner.style.display = "block"; showBtn.style.display = "none"; });
    hideBtn?.addEventListener("click", () => { inner.style.display = "none"; showBtn.style.display = "block"; });
  });
}

// ---------- map render ----------

function clearRoute() {
  routeLayers.forEach((l) => map.removeLayer(l));
  routeLayers = [];
  stationMarkers.forEach((m) => map.removeLayer(m));
  stationMarkers = [];
  endpointMarkers.forEach((m) => map.removeLayer(m));
  endpointMarkers = [];
  removePopover();
}

function endpointIcon(label, color) {
  return L.divIcon({
    className: "",
    html: `<div class="pin-endpoint"><div class="label">${esc(label)}</div>
      <svg width="28" height="36" viewBox="0 0 28 36" fill="none">
        <path d="M14 35C14 35 26 22 26 13.5C26 6.6 20.6 1 14 1C7.4 1 2 6.6 2 13.5C2 22 14 35 14 35Z" fill="${color}" stroke="white" stroke-width="2"/>
        <circle cx="14" cy="13.5" r="5" fill="white"/><circle cx="14" cy="13.5" r="2.5" fill="${color}"/>
      </svg></div>`,
    iconSize: [28, 36], iconAnchor: [14, 35],
  });
}

function drawRoute(plan) {
  clearRoute();
  const { origin, dest, board, alight, route } = plan;
  const walkColor = theme === "dark" ? "#9aa0a6" : "#5f6368";
  const allPts = [];

  // walk: origin -> board
  routeLayers.push(L.polyline([[origin.lat, origin.lon], [board.lat, board.lon]],
    { color: walkColor, weight: 4, opacity: 0.85, dashArray: "2 8", lineCap: "round" }).addTo(map));

  // transit legs: white casing + colored core
  for (const leg of route.legs) {
    const pts = leg.stations.map((sid) => {
      const s = metro.stations[sid];
      allPts.push([s.lat, s.lon]);
      return [s.lat, s.lon];
    });
    routeLayers.push(L.polyline(pts, { color: "#ffffff", weight: 8, opacity: theme === "dark" ? 0.25 : 0.9, lineCap: "round", lineJoin: "round" }).addTo(map));
    routeLayers.push(L.polyline(pts, { color: lineColor(leg.line), weight: 5, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(map));
  }

  // walk: alight -> dest
  routeLayers.push(L.polyline([[alight.lat, alight.lon], [dest.lat, dest.lon]],
    { color: walkColor, weight: 4, opacity: 0.85, dashArray: "2 8", lineCap: "round" }).addTo(map));

  // station dots (clickable)
  const onRoute = [...new Set(route.legs.flatMap((l) => l.stations))];
  for (const sid of onRoute) addStationDot(sid);

  // endpoint pins
  endpointMarkers.push(L.marker([origin.lat, origin.lon], { icon: endpointIcon("A · " + truncate(origin.label), "#1a73e8") }).addTo(map));
  endpointMarkers.push(L.marker([dest.lat, dest.lon], { icon: endpointIcon("B · " + truncate(dest.label), "#e94235") }).addTo(map));

  const bounds = L.latLngBounds([[origin.lat, origin.lon], [dest.lat, dest.lon], ...allPts]).pad(0.18);
  if (isMobile()) {
    // sheet covers the bottom ~66vh -> keep route in the visible top strip
    map.fitBounds(bounds, { paddingTopLeft: [30, 80], paddingBottomRight: [30, Math.round(window.innerHeight * 0.66) + 20] });
  } else {
    map.fitBounds(bounds, { paddingTopLeft: [440, 60], paddingBottomRight: [40, 40] });
  }
}

function isMobile() {
  return window.innerWidth <= 720;
}

// Draggable bottom sheet (phones). Snap points: peek / half / full.
// Drag the handle to resize; tap it to cycle snaps.
function setupSheet() {
  const panel = document.querySelector(".panel");
  const handle = $("sheetHandle");
  if (!panel || !handle) return;

  const snaps = () => {
    const vh = window.innerHeight;
    return [Math.round(vh * 0.28), Math.round(vh * 0.55), Math.round(vh * 0.9)];
  };
  let snapIndex = 1;

  const apply = () => {
    if (!isMobile()) {
      panel.style.height = ""; // desktop uses CSS full-height
      return;
    }
    panel.style.height = snaps()[snapIndex] + "px";
  };
  apply();
  window.addEventListener("resize", apply);

  let startY = 0, startH = 0, dragging = false, moved = false;

  handle.addEventListener("pointerdown", (e) => {
    if (!isMobile()) return;
    dragging = true; moved = false;
    startY = e.clientY; startH = panel.offsetHeight;
    panel.classList.add("dragging");
    handle.setPointerCapture?.(e.pointerId);
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY; // drag up => taller
    if (Math.abs(dy) > 4) moved = true;
    const s = snaps();
    const nh = Math.max(s[0] - 40, Math.min(s[2] + 30, startH + dy));
    panel.style.height = nh + "px";
  });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    const s = snaps();
    if (!moved) {
      snapIndex = (snapIndex + 1) % 3; // tap cycles
    } else {
      const cur = panel.offsetHeight; // snap to nearest
      let best = 0, bd = Infinity;
      s.forEach((v, i) => { const d = Math.abs(v - cur); if (d < bd) { bd = d; best = i; } });
      snapIndex = best;
    }
    apply();
  });
}

function truncate(s, n = 22) { s = (s || "").split(",")[0]; return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function addStationDot(sid) {
  const s = metro.stations[sid];
  if (!s) return;
  const c = lineColor(s.lines[0]);
  const icon = L.divIcon({ className: "", html: `<div class="pin-station" style="--line-color:${c}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  const m = L.marker([s.lat, s.lon], { icon }).addTo(map);
  m.on("click", () => openPopover(sid));
  stationMarkers.push(m);
}

// ---------- station popover (live spots + next trains) ----------

function removePopover() {
  if (popoverEl) { popoverEl.remove(); popoverEl = null; }
  selectedStationId = null;
}

async function openPopover(sid) {
  removePopover();
  selectedStationId = sid;
  const s = metro.stations[sid];
  const c = accentFor(metro.lines[s.lines[0]].color);
  const nt = nextTrains(metro.lines[s.lines[0]]);
  const ntSub = nt.operating ? `Next trains in ~${nt.arrivals.map((a) => a.inMin).join(", ~")} min` : nt.note;

  popoverEl = document.createElement("div");
  popoverEl.className = "popover";
  popoverEl.innerHTML = `
    <div class="pop-head">
      <div class="pop-line" style="color:${c}"><span class="pip"></span>${esc(metro.lines[s.lines[0]].name)}</div>
      <div class="pop-name">${esc(s.name)}</div>
      <div class="pop-sub">${esc(ntSub)}</div>
      <button class="close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="spots-header">Top places to visit</div>
    <div class="spots"><div class="ac-empty">finding spots…</div></div>`;
  document.body.appendChild(popoverEl);
  popoverEl.querySelector(".close").addEventListener("click", removePopover);
  repositionPopover();

  loadSpots(sid, s);
}

// render spots into the open popover (only if it still shows this station)
function renderSpots(sid, spots, source) {
  const body = popoverEl?.querySelector(".spots");
  if (!body || selectedStationId !== sid) return false;
  body.innerHTML = spots.length
    ? spots.map((p, i) => spotRow(p, i)).join("") + sourceTag(source)
    : `<div class="ac-empty">No notable spots nearby.</div>`;
  return true;
}

// Load top-5 nearby spots from OpenStreetMap (Overpass).
async function loadSpots(sid, s) {
  const coord = { lat: s.lat, lon: s.lon };
  try {
    const raw = await getNearbyPlaces(coord, { radiusM: 800, limit: 5 });
    if (selectedStationId !== sid) return;
    renderSpots(sid, raw.map((p) => ({ name: p.name, kind: p.kind, dist: `${p.distM}m` })), "osm");
  } catch {
    const body = popoverEl?.querySelector(".spots");
    if (body && selectedStationId === sid) body.innerHTML = `<div class="ac-empty">Spots unavailable right now.</div>`;
  }
}

function spotRow(p, i) {
  return `<div class="spot"><span class="n">${i + 1}</span><div><div class="name">${esc(p.name)}</div><div class="tag">${esc(p.kind)}</div></div><span class="d">${esc(p.dist || "")}</span></div>`;
}

function sourceTag(source) {
  const label = { osm: "via OpenStreetMap" }[source] || "";
  return label ? `<div class="ac-empty" style="text-align:right;padding-top:6px">${label}</div>` : "";
}

function repositionPopover() {
  if (!popoverEl || !selectedStationId) return;
  const s = metro.stations[selectedStationId];
  if (isMobile()) {
    // CSS pins left/right; just drop it near the top, above the bottom sheet
    popoverEl.style.top = "64px";
    return;
  }
  const pt = map.latLngToContainerPoint([s.lat, s.lon]);
  const popW = 320, popH = popoverEl.offsetHeight || 330;
  const vw = window.innerWidth, vh = window.innerHeight, panelEdge = 436;
  const left = Math.max(panelEdge, Math.min(vw - popW - 16, pt.x - popW / 2));
  const aboveTop = pt.y - 14 - popH, belowTop = pt.y + 14;
  let top = aboveTop > 16 ? aboveTop : (belowTop + popH < vh - 16 ? belowTop : Math.max(16, vh - popH - 16));
  popoverEl.style.left = left + "px";
  popoverEl.style.top = top + "px";
}

boot().catch((e) => { results.innerHTML = `<div class="err-box">Boot failed: ${esc(e.message)}</div>`; });
