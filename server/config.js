export const AIRPORT = {
  icao: "LFOB",
  name: "Paris Beauvais–Tillé",
  lat: 49.45444, // WGS84
  lon: 2.11278
};

export const CFG = {
  RADIUS_KM: 80,         // demandé
  ALT_MAX_FT: 10000,     // altitude max pour déclencher
  BEARING_MAX_DEG: 35,   // tolérance de cap vs relèvement vers l’AD
  ETA_MAX_MIN: 25,       // ETA (grossière) max
  POLL_MS: 10000         // OpenSky public -> toutes les 10 s
};
