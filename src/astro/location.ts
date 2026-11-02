export interface Place {
  lat: number;
  lon: number;
  /** true when guessed from the timezone rather than measured. */
  approximate: boolean;
  label: string;
}

// Representative coordinates for common IANA zones. Used only to estimate
// sunrise/sunset without asking for geolocation permission.
const ZONES: Record<string, [number, number]> = {
  'Europe/London': [51.51, -0.13],
  'Europe/Dublin': [53.35, -6.26],
  'Europe/Lisbon': [38.72, -9.14],
  'Europe/Paris': [48.86, 2.35],
  'Europe/Brussels': [50.85, 4.35],
  'Europe/Amsterdam': [52.37, 4.9],
  'Europe/Berlin': [52.52, 13.4],
  'Europe/Madrid': [40.42, -3.7],
  'Europe/Rome': [41.9, 12.5],
  'Europe/Zurich': [47.38, 8.54],
  'Europe/Vienna': [48.21, 16.37],
  'Europe/Prague': [50.08, 14.44],
  'Europe/Warsaw': [52.23, 21.01],
  'Europe/Stockholm': [59.33, 18.07],
  'Europe/Oslo': [59.91, 10.75],
  'Europe/Copenhagen': [55.68, 12.57],
  'Europe/Helsinki': [60.17, 24.94],
  'Europe/Athens': [37.98, 23.73],
  'Europe/Istanbul': [41.01, 28.98],
  'Europe/Kyiv': [50.45, 30.52],
  'Europe/Moscow': [55.76, 37.62],
  'America/New_York': [40.71, -74.01],
  'America/Toronto': [43.65, -79.38],
  'America/Chicago': [41.88, -87.63],
  'America/Denver': [39.74, -104.99],
  'America/Phoenix': [33.45, -112.07],
  'America/Los_Angeles': [34.05, -118.24],
  'America/Vancouver': [49.28, -123.12],
  'America/Anchorage': [61.22, -149.9],
  'America/Mexico_City': [19.43, -99.13],
  'America/Bogota': [4.71, -74.07],
  'America/Lima': [-12.05, -77.04],
  'America/Santiago': [-33.45, -70.67],
  'America/Sao_Paulo': [-23.55, -46.63],
  'America/Argentina/Buenos_Aires': [-34.6, -58.38],
  'Pacific/Honolulu': [21.31, -157.86],
  'Pacific/Auckland': [-36.85, 174.76],
  'Australia/Sydney': [-33.87, 151.21],
  'Australia/Melbourne': [-37.81, 144.96],
  'Australia/Brisbane': [-27.47, 153.03],
  'Australia/Adelaide': [-34.93, 138.6],
  'Australia/Perth': [-31.95, 115.86],
  'Asia/Tokyo': [35.68, 139.69],
  'Asia/Seoul': [37.57, 126.98],
  'Asia/Shanghai': [31.23, 121.47],
  'Asia/Hong_Kong': [22.32, 114.17],
  'Asia/Taipei': [25.03, 121.57],
  'Asia/Singapore': [1.35, 103.82],
  'Asia/Bangkok': [13.76, 100.5],
  'Asia/Jakarta': [-6.21, 106.85],
  'Asia/Manila': [14.6, 120.98],
  'Asia/Kolkata': [28.61, 77.21],
  'Asia/Calcutta': [28.61, 77.21],
  'Asia/Karachi': [24.86, 67.0],
  'Asia/Dubai': [25.2, 55.27],
  'Asia/Tehran': [35.69, 51.39],
  'Asia/Jerusalem': [31.77, 35.21],
  'Africa/Cairo': [30.04, 31.24],
  'Africa/Lagos': [6.52, 3.38],
  'Africa/Nairobi': [-1.29, 36.82],
  'Africa/Johannesburg': [-26.2, 28.05],
  'Africa/Casablanca': [33.57, -7.59],
};

const REGION_LAT: Record<string, number> = {
  Europe: 50,
  America: 38,
  Asia: 30,
  Africa: 5,
  Australia: -30,
  Pacific: -15,
  Atlantic: 35,
  Indian: -10,
  Antarctica: -75,
};

/** Estimate the visitor's location from their timezone. No permission needed. */
export function placeFromTimezone(now = new Date()): Place {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const known = ZONES[tz];
  const city = tz.split('/').pop()?.replace(/_/g, ' ') ?? 'UTC';
  if (known) return { lat: known[0], lon: known[1], approximate: true, label: city };

  // Fall back to the standard (non-DST) UTC offset for longitude.
  const year = now.getFullYear();
  const jan = new Date(year, 0, 1).getTimezoneOffset();
  const jul = new Date(year, 6, 1).getTimezoneOffset();
  const stdOffsetMin = Math.max(jan, jul);
  const lon = (-stdOffsetMin / 60) * 15;
  const lat = REGION_LAT[tz.split('/')[0]] ?? 0;
  return { lat, lon, approximate: true, label: city };
}

/** Ask the browser for the real location. Only call from a user gesture. */
export function requestPreciseLocation(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation is not available in this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          approximate: false,
          label: `${pos.coords.latitude.toFixed(2)}°, ${pos.coords.longitude.toFixed(2)}°`,
        }),
      (err) => reject(new Error(err.message || 'Location unavailable')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 3_600_000 },
    );
  });
}
