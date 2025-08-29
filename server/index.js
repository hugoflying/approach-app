import express from "express";
import { WebSocketServer } from "ws";
import { AIRPORT, CFG, RUNWAY_HEADINGS, RUNWAY_TOL } from "./config.js";

const SIMULATE = process.env.SIMULATE === "true";
const PORT = process.env.PORT || 8080;

// ---------- Helpers ----------
const toRad = d => (d * Math.PI) / 180;
const KM_PER_DEG_LAT = 111.32;
const msToKts = v => v == null ? null : v * 1.9438444924;
const mToFt   = m => m == null ? null : m * 3.280839895;
const msToFpm = v => v == null ? null : v * 196.8503937;
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchWithRetry(url, options = {}, tries = 4) {
  let delay = 800; // ms
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...options, redirect: "follow" });
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(delay + Math.floor(Math.random() * 400)); // backoff + jitter
      delay = Math.min(delay * 2, 6000);
    }
  }
}

// ---------- État ----------
const state = {
  alerts: new Map(),
  acked: new Map(),
  landed: new Map()
};
const flightKey = obj => obj.hex || obj.callsign || `unk-${Math.random().toString(36).slice(2)}`;

const isAlignedRunway = track =>
  track == null ? true : RUNWAY_HEADINGS.some(hdg => angDiff(track, hdg) <= RUNWAY_TOL);

function isApproach(ac) {
  const d_km = haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
  if (d_km > CFG.RADIUS_KM) return false;
  if (ac.alt_ft == null || ac.alt_ft > CFG.ALT_MAX_FT) return false;
  if (ac.vs_fpm != null && ac.vs_fpm > 0) return false;          // monte
  if (!isAlignedRunway(ac.track_deg)) return false;              // pas dans l'axe 12/30
  if (ac.gs_kts != null && ac.gs_kts > 20) {                      // ETA max
    const eta_min = (d_km / (ac.gs_kts * 1.852)) * 60;
    if (eta_min > CFG.ETA_MAX_MIN) return false;
  }
  return true;
}

// ---------- OpenSky ----------
async function fetchOpenSky() {
  // bbox ~80 km autour de LFOB
  const dLat = CFG.RADIUS_KM / KM_PER_DEG_LAT;
  const dLon = CFG.RADIUS_KM / (KM_PER_DEG_LAT * Math.cos(toRad(AIRPORT.lat)));
  const lamin = AIRPORT.lat - dLat;
  const lamax = AIRPORT.lat + dLat;
  const lomin = AIRPORT.lon - dLon;
  const lomax = AIRPORT.lon + dLon;

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  const headers = { "accept": "application/json", "user-agent": "approach-app/1.0" };

  // Auth Basic si dispo dans les variables d'env (Render)
  if (process.env.OPENSKY_USER && process.env.OPENSKY_PASS) {
    const token = Buffer.from(`${process.env.OPENSKY_USER}:${process.env.OPENSKY_PASS}`).toString("base64");
    headers["authorization"] = `Basic ${token}`;
  }

  const res = await fetchWithRetry(url, { headers });
  const data = await res.json();
  const out = [];
  if (!data || !Array.isArray(data.states)) return out;

  for (const s of data.states) {
    const [icao24, callsign, , , last_contact, lon, lat, baro_alt, , velocity, true_track, vertical_rate, , geo_alt] = s;
    if (lat == null || lon == null) continue;
    out.push({
      hex: icao24?.toUpperCase() || null,
      callsign: (callsign || "").trim() || null,
      lat, lon,
      gs_kts: msToKts(velocity),
      alt_ft: mToFt(geo_alt ?? baro_alt),
      track_deg: true_track ?? null,
      vs_fpm: msToFpm(vertical_rate),
      last_ts: last_contact ?? Date.now()/1000
    });
  }
  return out;
}

// ---------- Simulateur ----------
function simulateSwarm() {
  const n = Math.floor(Math.random()*3)+1;
  const list = [];
  for (let i=0; i<n; i++) {
    const r = Math.random()*CFG.RADIUS_KM;
    const theta = Math.random()*2*Math.PI;
    const lat = AIRPORT.lat + (r / KM_PER_DEG_LAT) * Math.cos(theta);
    const lon = AIRPORT.lon + (r / (KM_PER_DEG_LAT*Math.cos(toRad(AIRPORT.lat)))) * Math.sin(theta);
    const hdg = RUNWAY_HEADINGS[Math.floor(Math.random()*RUNWAY_HEADINGS.length)];
    list.push({
      hex: Math.random().toString(16).slice(2,8),
      callsign: `SIM${100+Math.floor(Math.random()*900)}`,
      lat, lon,
      gs_kts: 120 + Math.random()*80,
      alt_ft: 8000 - Math.random()*7000,
      track_deg: hdg,
      vs_fpm: -(200 + Math.random()*700)
    });
  }
  return list;
}

// ---------- Boucle de poll ----------
async function poll() {
  try {
    const items = SIMULATE ? simulateSwarm() : await fetchOpenSky();
    for (const ac of items) {
      const key = flightKey(ac);

      // Posé → passe en "landed"
      if (ac.alt_ft != null && ac.alt_ft < 200 && ac.gs_kts != null && ac.gs_kts < 50) {
        state.alerts.delete(key);
        state.acked.delete(key);
        state.landed.set(key, { landed_at: Date.now(), snapshot: ac });
        broadcast({ type: "LANDED", key, callsign: ac.callsign, hex: ac.hex });
        continue;
      }

      if (isApproach(ac)) {
        if (!state.acked.has(key) && !state.landed.has(key)) {
          state.alerts.set(key, { snapshot: ac });
          broadcast({ type: "APPROACH_ALERT", key, callsign: ac.callsign, hex: ac.hex });
        }
      }
    }
  } catch (e) {
    console.error("poll error:", e.message);
  } finally {
    // Jitter ±1 s pour lisser la charge et limiter les ratelimits cloud
    const jitter = 1000 - Math.floor(Math.random() * 2000); // [-1000,+1000]
    setTimeout(poll, Math.max(5000, CFG.POLL_MS + jitter));
  }
}

// ---------- Serveur Web ----------
const app = express();

// CORS permissif (utile si tu sers le front ailleurs)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Endpoint placeholder pour futures API externes (clé cachée côté serveur)
app.get("/api/flight", (req, res) => res.json({ ok: true }));

app.use(express.static("public"));
const server = app.listen(PORT, () =>
  console.log(`HTTP on :${PORT} — SIMULATE=${SIMULATE}`)
);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => { try { c.send(s); } catch {} });
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ACK" && msg.key) {
        if (state.alerts.has(msg.key)) {
          const ac = state.alerts.get(msg.key).snapshot;
          state.alerts.delete(msg.key);
          state.acked.set(msg.key, { acked_at: Date.now(), snapshot: ac });
          ws.send(JSON.stringify({ type: "ACK_OK", key: msg.key }));
        }
      }
    } catch {}
  });

  // (optionnel) on pourrait renvoyer l’état courant ici si on persistait
  ws.send(JSON.stringify({ type: "INIT" }));
});

// Démarrage
poll();
