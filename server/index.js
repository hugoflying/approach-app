import express from "express";
import { WebSocketServer } from "ws";
import { AIRPORT, CFG, RUNWAY_HEADINGS, RUNWAY_TOL } from "./config.js";

const SIMULATE = process.env.SIMULATE === "true";
const PORT = process.env.PORT || 8080;

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
function angDiff(a, b) { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }
const msToKts = v => v == null ? null : v * 1.9438444924;
const mToFt = m => m == null ? null : m * 3.280839895;
const msToFpm = v => v == null ? null : v * 196.8503937;

const state = { alerts: new Map(), acked: new Map(), landed: new Map() };
function flightKey(obj) { return obj.hex || obj.callsign || `unk-${Math.random().toString(36).slice(2)}`; }
function isAlignedRunway(track) { if (track == null) return true; return RUNWAY_HEADINGS.some(hdg => angDiff(track, hdg) <= RUNWAY_TOL); }

function isApproach(ac) {
  const d_km = haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
  if (d_km > CFG.RADIUS_KM) return false;
  if (ac.alt_ft == null || ac.alt_ft > CFG.ALT_MAX_FT) return false;
  if (ac.vs_fpm != null && ac.vs_fpm > 0) return false;
  if (!isAlignedRunway(ac.track_deg)) return false;
  if (ac.gs_kts != null && ac.gs_kts > 20) {
    const eta_min = (d_km / (ac.gs_kts * 1.852)) * 60;
    if (eta_min > CFG.ETA_MAX_MIN) return false;
  }
  return true;
}

async function fetchOpenSky() {
  const dLat = CFG.RADIUS_KM / 111.32;
  const dLon = CFG.RADIUS_KM / (111.32 * Math.cos(toRad(AIRPORT.lat)));
  const lamin = AIRPORT.lat - dLat, lamax = AIRPORT.lat + dLat;
  const lomin = AIRPORT.lon - dLon, lomax = AIRPORT.lon + dLon;
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error("OpenSky HTTP " + res.status);
  const data = await res.json();
  const out = [];
  if (!data || !Array.isArray(data.states)) return out;
  for (const s of data.states) {
    const [icao24, callsign, , , last_contact, lon, lat, baro_altitude, , velocity, true_track, vertical_rate, , geo_altitude] = s;
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

function simulateSwarm() {
  const n = Math.floor(Math.random()*3)+1, list = [];
  for (let i=0;i<n;i++){
    const r = Math.random()*CFG.RADIUS_KM, th = Math.random()*2*Math.PI;
    const lat = AIRPORT.lat + (r / 111.32) * Math.cos(th);
    const lon = AIRPORT.lon + (r / (111.32*Math.cos(toRad(AIRPORT.lat)))) * Math.sin(th);
    const hdg = RUNWAY_HEADINGS[Math.floor(Math.random()*RUNWAY_HEADINGS.length)];
    list.push({ hex: Math.random().toString(16).slice(2,8), callsign:`SIM${100+Math.floor(Math.random()*900)}`, lat, lon, gs_kts:120+Math.random()*80, alt_ft:8000-Math.random()*7000, track_deg:hdg, vs_fpm:-(200+Math.random()*700) });
  }
  return list;
}

async function poll() {
  try {
    const items = SIMULATE ? simulateSwarm() : await fetchOpenSky();
    for (const ac of items) {
      const key = flightKey(ac);
      if (ac.alt_ft != null && ac.alt_ft < 200 && ac.gs_kts != null && ac.gs_kts < 50) {
        state.alerts.delete(key); state.acked.delete(key);
        state.landed.set(key, { landed_at: Date.now(), snapshot: ac });
        broadcast({ type:"LANDED", key, callsign: ac.callsign, hex: ac.hex }); continue;
      }
      if (isApproach(ac)) {
        if (!state.acked.has(key) && !state.landed.has(key)) {
          state.alerts.set(key, { snapshot: ac });
          broadcast({ type:"APPROACH_ALERT", key, callsign: ac.callsign, hex: ac.hex });
        }
      }
    }
  } catch (e) { console.error("poll error:", e.message); }
  finally { setTimeout(poll, CFG.POLL_MS); }
}

const app = express();
app.use((req,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization"); if(req.method==="OPTIONS")return res.sendStatus(200); next(); });
app.get("/api/flight",(req,res)=>res.json({ok:true}));
app.use(express.static("public"));
const server = app.listen(PORT, ()=>console.log(`HTTP on :${PORT} — SIMULATE=${SIMULATE}`));

const wss = new WebSocketServer({ server });
function broadcast(obj){ const s=JSON.stringify(obj); wss.clients.forEach(c=>{ try{ c.send(s);}catch{} }); }
wss.on("connection", ws => {
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ACK" && msg.key) {
        if (state.alerts.has(msg.key)) {
          const ac = state.alerts.get(msg.key).snapshot;
          state.alerts.delete(msg.key);
          state.acked.set(msg.key, { acked_at: Date.now(), snapshot: ac });
          ws.send(JSON.stringify({ type:"ACK_OK", key: msg.key }));
        }
      }
    } catch {}
  });
});

poll();
