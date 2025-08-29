import express from "express";
import { WebSocketServer } from "ws";
import { AIRPORT, CFG, RUNWAY_HEADINGS, RUNWAY_TOL } from "./config.js";

const PORT = process.env.PORT || 8080;

// ---------- Helpers ----------
const toRad = d => (d * Math.PI) / 180;
const KM_PER_DEG_LAT = 111.32;
const msToKts = v => v == null ? null : v * 1.9438444924;
const mToFt   = m => m == null ? null : m * 3.280839895;
const msToFpm = v => v == null ? null : v * 196.8503937;
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

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
const state = { alerts: new Map(), acked: new Map(), landed: new Map() };
const flightKey = obj => obj.hex || obj.callsign || `unk-${Math.random().toString(36).slice(2)}`;

const isAlignedRunway = (track, d_km) => {
  // Appliquer l’axe piste seulement proche terrain (≤30 km) — évite de rater des arrivées en éloignement/attente
  if (track == null || d_km > 30) return true;
  return RUNWAY_HEADINGS.some(hdg => angDiff(track, hdg) <= RUNWAY_TOL);
};

function isApproach(ac) {
  const d_km = haversineKm(ac.lat, ac.lon, AIRPORT.lat, AIRPORT.lon);
  if (d_km > CFG.RADIUS_KM) return false;
  if (ac.alt_ft == null || ac.alt_ft > CFG.ALT_MAX_FT) return false;
  if (ac.vs_fpm != null && ac.vs_fpm > 0) return false;     // monte
  if (!isAlignedRunway(ac.track_deg, d_km)) return false;   // pas dans l’axe 12/30 (proche terrain)
  if (ac.gs_kts != null && ac.gs_kts > 20) {
    const eta_min = (d_km / (ac.gs_kts * 1.852)) * 60;
    if (eta_min > CFG.ETA_MAX_MIN) return false;
  }
  return true;
}

// ---------- OpenSky OAuth2 (client_credentials) ----------
let _osToken = null;
let _osTokenExp = 0; // ms epoch

async function getOpenSkyToken() {
  const now = Date.now();
  if (_osToken && now < _osTokenExp - 60_000) return _osToken;

  const cid = process.env.OPENSKY_CLIENT_ID;
  const csec = process.env.OPENSKY_CLIENT_SECRET;
  if (!cid || !csec) throw new Error("OPENSKY_CLIENT_ID/SECRET manquants");

  const tokenRes = await fetch(
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cid,
        client_secret: csec
      })
    }
  );
  if (!tokenRes.ok) throw new Error("OpenSky OAuth token HTTP " + tokenRes.status);
  const j = await tokenRes.json();
  _osToken = j.access_token;
  _osTokenExp = Date.now() + (j.expires_in || 1800) * 1000;
  return _osToken;
}

function parseOpenSky(data){
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

async function fetchOpenSky() {
  // bbox 80 km autour de LFOB
  const dLat = CFG.RADIUS_KM / KM_PER_DEG_LAT;
  const dLon = CFG.RADIUS_KM / (KM_PER_DEG_LAT * Math.cos(toRad(AIRPORT.lat)));
  const lamin = AIRPORT.lat - dLat;
  const lamax = AIRPORT.lat + dLat;
  const lomin = AIRPORT.lon - dLon;
  const lomax = AIRPORT.lon + dLon;

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  const token = await getOpenSkyToken();
  const headers = {
    "accept": "application/json",
    "authorization": `Bearer ${token}`,
    "user-agent": "approach-app/1.0"
  };

  let res = await fetchWithRetry(url, { headers });
  if (res.status === 401) {
    // Token expiré/invalidé → refresh 1 fois
    _osToken = null; _osTokenExp = 0;
    const token2 = await getOpenSkyToken();
    res = await fetch(url, { headers: { ...headers, authorization: `Bearer ${token2}` } });
  }
  if (!res.ok) throw new Error("OpenSky HTTP " + res.status);
  const data = await res.json();
  return parseOpenSky(data);
}

// ---------- Fallback optionnel : ADS-B Exchange via RapidAPI ----------
async function fetchADSBxRapid() {
  if (!process.env.RAPIDAPI_KEY) return [];           // pas de fallback si pas de clé
  const distNm = 80;                                // 80 km
  const url = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${AIRPORT.lat}/lon/${AIRPORT.lon}/dist/${distNm}`;
  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": "adsbexchange-com1.p.rapidapi.com",
      "accept": "application/json"
    }
  });
  if (!res.ok) throw new Error(`ADSBx RapidAPI HTTP ${res.status}`);
  const data = await res.json();
  const list = data.ac || data.aircraft || [];
  const out = [];
  for (const a of list) {
    const lat = a.lat ?? a.latitude;
    const lon = a.lon ?? a.longitude;
    if (lat == null || lon == null) continue;
    out.push({
      hex: (a.hex || a.icao || "").toUpperCase() || null,
      callsign: (a.call || a.callsign || "").trim() || null,
      lat, lon,
      gs_kts: a.gs ?? a.spd ?? null,
      alt_ft: a.alt_baro ?? a.alt_geom ?? a.alt ?? null,
      track_deg: a.trak ?? a.track ?? null,
      vs_fpm: a.baro_rate ?? a.vert_rate ?? null,
      last_ts: a.seen_pos ? (Date.now()/1000 - a.seen_pos) : Date.now()/1000
    });
  }
  return out;
}

// ---------- Orchestrateur de source (OpenSky d’abord, fallback si vide) ----------
let consecutiveOpenSkyEmpty = 0;
const OPEN_SKY_EMPTY_LIMIT = 3; // après 3 polls vides → fallback 2 min
let fallbackUntil = 0;          // timestamp ms

async function fetchTraffic() {
  const now = Date.now();
  const inFallback = now < fallbackUntil;

  if (!inFallback) {
    const os = await fetchOpenSky().catch(() => []);
    if (os.length > 0) {
      consecutiveOpenSkyEmpty = 0;
      return os;
    }
    consecutiveOpenSkyEmpty++;
    if (consecutiveOpenSkyEmpty >= OPEN_SKY_EMPTY_LIMIT) {
      fallbackUntil = now + 2 * 60 * 1000; // 2 minutes
    }
  }

  // Repli (si clé dispo). Si pas de clé → retournera [] et on réessaiera OpenSky au cycle suivant.
  const bx = await fetchADSBxRapid().catch(() => []);
  return bx;
}

// ---------- Boucle de poll ----------
async function poll() {
  try {
    const items = await fetchTraffic();
    for (const ac of items) {
      const key = flightKey(ac);

      // Posé → "AU SOL"
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
    const jitter = 1000 - Math.floor(Math.random() * 2000); // [-1000,+1000]
    setTimeout(poll, Math.max(5000, CFG.POLL_MS + jitter));
  }
}

// ---------- Serveur Web ----------
const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.get("/api/flight", (req, res) => res.json({ ok: true })); // placeholder pour futures intégrations
app.use(express.static("public"));

const server = app.listen(PORT, () =>
  console.log(`HTTP on :${PORT} — REAL TRAFFIC (no simulate)`)
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
          state.alerts.delete(key);
          state.acked.set(msg.key, { acked_at: Date.now(), snapshot: ac });
          ws.send(JSON.stringify({ type: "ACK_OK", key: msg.key }));
        }
      }
    } catch {}
  });
  ws.send(JSON.stringify({ type: "INIT" }));
});

// Démarrage
poll();
