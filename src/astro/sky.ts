import { DAY_MS, DEG, J2000, julianDate, norm360 } from './time';

export interface MoonPhase {
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  phase: number;
  /** Illuminated fraction 0..1. */
  illumination: number;
  name: string;
  waxing: boolean;
}

/** Low-precision Sun and Moon longitudes (Meeus, truncated). Good to ~0.3°. */
export function moonPhase(date: Date): MoonPhase {
  const T = (julianDate(date) - J2000) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = (297.8501921 + 445267.1114034 * T) * DEG;
  const M = (357.5291092 + 35999.0502909 * T) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T) * DEG;
  const F = (93.272095 + 483202.0175233 * T) * DEG;

  const moonLon =
    Lp +
    6.289 * Math.sin(Mp) -
    1.274 * Math.sin(2 * D - Mp) +
    0.658 * Math.sin(2 * D) +
    0.214 * Math.sin(2 * Mp) -
    0.186 * Math.sin(M) -
    0.114 * Math.sin(2 * F);

  const L0 = 280.46646 + 36000.76983 * T;
  const C =
    (1.914602 - 0.004817 * T) * Math.sin(M) + 0.019993 * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const sunLon = L0 + C;

  const elong = norm360(moonLon - sunLon);
  const phase = elong / 360;
  const illumination = (1 - Math.cos(elong * DEG)) / 2;
  const names = [
    'New Moon',
    'Waxing Crescent',
    'First Quarter',
    'Waxing Gibbous',
    'Full Moon',
    'Waning Gibbous',
    'Last Quarter',
    'Waning Crescent',
  ];
  const name = names[Math.round(phase * 8) % 8];
  return { phase, illumination, name, waxing: phase < 0.5 };
}

/** Greenwich mean sidereal time, degrees. */
export function gmstDeg(date: Date): number {
  const jd = julianDate(date);
  const T = (jd - J2000) / 36525;
  return norm360(280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * T * T - (T * T * T) / 38710000);
}

/** Local mean sidereal time in hours for an east-positive longitude. */
export function localSiderealHours(date: Date, lonDeg: number): number {
  return norm360(gmstDeg(date) + lonDeg) / 15;
}

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
  /** 'normal' | 'polar-day' | 'polar-night' */
  kind: 'normal' | 'polar-day' | 'polar-night';
}

// Sunrise/sunset after the algorithm used by SunCalc (V. Agafonkin, BSD-2).
const J1970 = 2440588;
const J0 = 0.0009;
const OBLIQUITY = 23.4397 * DEG;

const toDays = (d: Date) => d.getTime() / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS);
const solarMeanAnomaly = (d: number) => DEG * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M: number) => {
  const C = DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + DEG * 102.9372 + Math.PI;
};
const approxTransit = (Ht: number, lw: number, n: number) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds: number, M: number, L: number) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

export function sunTimes(date: Date, latDeg: number, lonDeg: number): SunTimes {
  const lw = DEG * -lonDeg;
  const phi = DEG * latDeg;
  const d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
  const Jnoon = solarTransitJ(ds, M, L);

  const h0 = -0.833 * DEG;
  const cosW = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosW < -1) return { sunrise: null, sunset: null, kind: 'polar-day' };
  if (cosW > 1) return { sunrise: null, sunset: null, kind: 'polar-night' };
  const w = Math.acos(cosW);
  const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), kind: 'normal' };
}
