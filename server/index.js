import express from "express";
import { WebSocketServer } from "ws";
import { AIRPORT, CFG } from "./config.js";

const SIMULATE = process.env.SIMULATE === "true";
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
  flights: new Map(),     // key: flightKey -> last snapshot
  alerts: new Map(),      // flightKey -> { ack:false, first_seen:ts }
  acked: new Map()        // flightKey -> { ack:true, acked_at:ts }
};

function flightKey(obj) { return obj.hex || obj.callsign || `unk-${obj.id || Math.random().toString(36).slice(2)}`; }

function isApproach(ac) {
  const d_km = haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
  if (d_km > CFG.RADIUS_KM) return false;
  if (ac.alt_ft == null || ac.alt_ft > CFG.ALT_MAX_FT) return false;
  if (ac.vs_fpm != null && ac.vs_fpm > 0) return false; // monte → pas approche
  // Cap vs relèvement vers AD
  if (ac.track_deg != null) {
    const brg = bearingDeg(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
    if (angDiff(ac.track_deg, brg) > CFG.BEARING_MAX_DEG) return false;
  }
  // ETA grossier
  if (ac.gs_kts != null && ac.gs_kts > 20) {
    const eta_min = (d_km / (ac.gs_kts * 1.852)) * 60; // kts -> km/min
    if (eta_min > CFG.ETA_MAX_MIN) return false;
  }
  return true;
}

async function fetchOpenSky() {
  // Bounding box approx à partir du centre + rayon en km
  const dLat = CFG.RADIUS_KM / KM_PER_DEG_LAT;
  const dLon = CFG.RADIUS_KM / (KM_PER_DEG_LAT * Math.cos(toRad(AIRPORT.lat)));
  const lamin = AIRPORT.lat - dLat;
  const lamax = AIRPORT.lat + dLat;
  const lomin = AIRPORT.lon - dLon;
  const lomax = AIRPORT.lon + dLon;

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin.toFixed(4)}&lomin=${lomin.toFixed(4)}&lamax=${lamax.toFixed(4)}&lomax=${lomax.toFixed(4)}`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  if (!data || !Array.isArray(data.states)) return out;
  for (const s of data.states) {
    const [icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_altitude,
           on_ground, velocity, true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source, category] = s;
    if (lat == null || lon == null) continue;
    const gs_kts = msToKts(velocity);
    const alt_ft = mToFt(geo_altitude ?? baro_altitude);
    const vs_fpm = msToFpm(vertical_rate);
    const ac = {
      hex: icao24?.toUpperCase(),
      callsign: (callsign || "").trim() || null,
      lat, lon,
      gs_kts: gs_kts ?? null,
      alt_ft: alt_ft ?? null,
      track_deg: true_track ?? null,
      vs_fpm: vs_fpm ?? null,
      last_ts: last_contact ?? Date.now()/1000
    };
    out.push(ac);
  }
  return out;
}

function simulateSwarm() {
  // Génère 0–3 trafics qui se rapprochent de LFOB
  const n = Math.floor(Math.random()*4);
  const list = [];
  for (let i=0; i<n; i++) {
    const r = Math.random()*CFG.RADIUS_KM; // km
    const theta = Math.random()*2*Math.PI;
    const dLat = (r / KM_PER_DEG_LAT) * Math.cos(theta);
    const dLon = (r / (KM_PER_DEG_LAT*Math.cos(toRad(AIRPORT.lat)))) * Math.sin(theta);
    const lat = AIRPORT.lat + dLat;
    const lon = AIRPORT.lon + dLon;
    const brgToAD = bearingDeg(lat, lon, AIRPORT.lat, AIRPORT.lon);
    const track = brgToAD + (Math.random()*20 - 10); // à peu près vers l’AD
    const gs_kts = 120 + Math.random()*80;
    const alt_ft = 8000 + Math.random()*1500; // sous 10kft
    const vs_fpm = -(300 + Math.random()*800);
    list.push({ hex: Math.random().toString(16).slice(2,8), callsign: `SIM${100+Math.floor(Math.random()*900)}`, lat, lon, gs_kts, alt_ft, track_deg: (track+360)%360, vs_fpm, last_ts: Date.now()/1000 });
  }
  return list;
}

async function poll() {
  try {
    const items = SIMULATE ? simulateSwarm() : await fetchOpenSky();
    for (const ac of items) {
      state.flights.set(flightKey(ac), ac);
      if (isApproach(ac)) {
        const key = flightKey(ac);
        if (!state.acked.has(key)) {
          const first = state.alerts.get(key)?.first_seen ?? Date.now();
          state.alerts.set(key, { ack:false, first_seen:first, snapshot:ac });
          broadcast({ type:"APPROACH_ALERT", key, callsign:ac.callsign, hex:ac.hex, distance_km: haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon), eta_min: ac.gs_kts ? (haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon) / (ac.gs_kts*1.852)) * 60 : null });
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
const server = app.listen(PORT, () => console.log(`HTTP on :${PORT} — SIMULATE=${SIMULATE}`));

// --- WS ---
const wss = new WebSocketServer({ server });
function broadcast(obj) { const s = JSON.stringify(obj); wss.clients.forEach(c => { try { c.send(s); } catch {} }); }

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
  // Envoi l’état initial (alertes en cours + ackés)
  const alerts = [...state.alerts.entries()].map(([key, v]) => ({ key, callsign: v.snapshot.callsign, hex: v.snapshot.hex }));
  const acked = [...state.acked.entries()].map(([key, v]) => ({ key, callsign: v.snapshot?.callsign, hex: v.snapshot?.hex }));
  ws.send(JSON.stringify({ type:"INIT", alerts, acked }));
});

// Kickoff
poll();
