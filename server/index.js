import express from "express";
import { WebSocketServer } from "ws";
import { AIRPORT, CFG } from "./config.js";

const PORT = process.env.PORT || 8080;

// --- Helpers géo ---
const toRad = d => (d * Math.PI) / 180;
const toDeg = r => (r * 180) / Math.PI;
const KM_PER_DEG_LAT = 111.32;
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function angDiff(a, b) { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }
const msToKts = v => v == null ? null : v * 1.9438444924;
const mToFt = m => m == null ? null : m * 3.280839895;
const msToFpm = v => v == null ? null : v * 196.8503937; // m/s -> ft/min

// --- Stock en mémoire ---
const state = {
  flights: new Map(),
  alerts: new Map(),
  acked: new Map()
};
function flightKey(obj) {
  return obj.hex || obj.callsign || `unk-${obj.id || Math.random().toString(36).slice(2)}`;
}

// --- Auth OpenSky OAuth2 ---
let _osToken = null;
let _osTokenExp = 0; // epoch ms
async function getOpenSkyToken() {
  const now = Date.now();
  if (_osToken && now < _osTokenExp - 60_000) return _osToken;

  const cid = process.env.OPENSKY_CLIENT_ID;
  const csec = process.env.OPENSKY_CLIENT_SECRET;
  if (!cid || !csec) throw new Error("OPENSKY_CLIENT_ID/SECRET manquants");

  const res = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cid,
      client_secret: csec
    })
  });
  if (!res.ok) throw new Error("OpenSky OAuth token HTTP " + res.status);
  const j = await res.json();
  _osToken = j.access_token;
  _osTokenExp = Date.now() + (j.expires_in || 1800) * 1000;
  return _osToken;
}

// --- Détection approche ---
function isApproach(ac) {
  const d_km = haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
  if (d_km > CFG.RADIUS_KM) return false;
  if (ac.alt_ft == null || ac.alt_ft > CFG.ALT_MAX_FT) return false;
  if (ac.vs_fpm != null && ac.vs_fpm > 0) return false; // monte → pas approche
  if (ac.track_deg != null) {
    const brg = bearingDeg(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
    if (angDiff(ac.track_deg, brg) > CFG.BEARING_MAX_DEG) return false;
  }
  if (ac.gs_kts != null && ac.gs_kts > 20) {
    const eta_min = (d_km / (ac.gs_kts * 1.852)) * 60;
    if (eta_min > CFG.ETA_MAX_MIN) return false;
  }
  return true;
}

// --- Fetch OpenSky avec Bearer ---
async function fetchOpenSky() {
  const dLat = CFG.RADIUS_KM / KM_PER_DEG_LAT;
  const dLon = CFG.RADIUS_KM / (KM_PER_DEG_LAT * Math.cos(toRad(AIRPORT.lat)));
  const lamin = AIRPORT.lat - dLat;
  const lamax = AIRPORT.lat + dLat;
  const lomin = AIRPORT.lon - dLon;
  const lomax = AIRPORT.lon + dLon;

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin.toFixed(4)}&lomin=${lomin.toFixed(4)}&lamax=${lamax.toFixed(4)}&lomax=${lomax.toFixed(4)}`;

  const token = await getOpenSkyToken();
  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const data = await res.json();

  const out = [];
  if (!data || !Array.isArray(data.states)) return out;
  for (const s of data.states) {
    const [icao24, callsign, , , last_contact, lon, lat, baro_altitude,
           , velocity, true_track, vertical_rate, , geo_altitude] = s;
    if (lat == null || lon == null) continue;
    out.push({
      hex: icao24?.toUpperCase(),
      callsign: (callsign || "").trim() || null,
      lat, lon,
      gs_kts: msToKts(velocity),
      alt_ft: mToFt(geo_altitude ?? baro_altitude),
      track_deg: true_track ?? null,
      vs_fpm: msToFpm(vertical_rate),
      last_ts: last_contact ?? Date.now()/1000
    });
  }
  return out;
}

// --- Poll ---
async function poll() {
  try {
    const items = await fetchOpenSky();
    for (const ac of items) {
      state.flights.set(flightKey(ac), ac);
      if (isApproach(ac)) {
        const key = flightKey(ac);
        if (!state.acked.has(key)) {
          const first = state.alerts.get(key)?.first_seen ?? Date.now();
          state.alerts.set(key, { ack:false, first_seen:first, snapshot:ac });
          broadcast({
            type:"APPROACH_ALERT",
            key,
            callsign:ac.callsign,
            hex:ac.hex,
            distance_km: haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon),
            eta_min: ac.gs_kts ? (haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon) / (ac.gs_kts*1.852)) * 60 : null
          });
        }
      }
    }
  } catch (e) {
    console.error("poll error:", e.message);
  } finally {
    setTimeout(poll, CFG.POLL_MS);
  }
}

// --- Web ---
const app = express();
app.use(express.static("public"));
const server = app.listen(PORT, () =>
  console.log(`HTTP on :${PORT} — REAL traffic with OAuth2`)
);

// --- WS ---
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
        const prev = state.alerts.get(msg.key);
        if (prev) state.alerts.delete(msg.key);
        state.acked.set(msg.key, { ack:true, acked_at:Date.now(), snapshot: prev?.snapshot });
        ws.send(JSON.stringify({ type:"ACK_OK", key: msg.key }));
      }
    } catch {}
  });
  const alerts = [...state.alerts.entries()].map(([key, v]) => ({ key, callsign: v.snapshot.callsign, hex: v.snapshot.hex }));
  const acked = [...state.acked.entries()].map(([key, v]) => ({ key, callsign: v.snapshot?.callsign, hex: v.snapshot?.hex }));
  ws.send(JSON.stringify({ type:"INIT", alerts, acked }));
});

// Kickoff
poll();
