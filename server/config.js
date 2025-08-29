export const AIRPORT = {
  icao: "LFPG",
  name: "Paris Charles-de-Gaulle",
  lat: 49.0097,
  lon: 2.5479
};

export const CFG = {
  RADIUS_KM: 80 * 1.852,   // 80 NM → 148.16 km
  ALT_MAX_FT: 15000,       // un peu plus haut car rayon plus large
  ETA_MAX_MIN: 40,         // élargi pour capter plus loin
  BEARING_MAX_DEG: 35,     // (non utilisé si on filtre par pistes)
  POLL_MS: 12000           // 12 s pour rester “soft”
};

// Axes de piste CDG (08/26, parallèles)
export const RUNWAY_HEADINGS = [84, 264];
export const RUNWAY_TOL = 25; // ±25°
