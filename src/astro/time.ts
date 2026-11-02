export const DAY_MS = 86_400_000;
export const J2000 = 2451545.0;
export const DEG = Math.PI / 180;

/** Julian Date (UT) for a JS Date. Close enough to TT for visual purposes. */
export function julianDate(date: Date): number {
  return date.getTime() / DAY_MS + 2440587.5;
}

/** Julian centuries since J2000.0. */
export function centuriesSinceJ2000(date: Date): number {
  return (julianDate(date) - J2000) / 36525;
}

/** Normalise degrees into [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Normalise degrees into (-180, 180]. */
export function norm180(deg: number): number {
  const d = norm360(deg);
  return d > 180 ? d - 360 : d;
}
