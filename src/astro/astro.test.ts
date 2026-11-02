import { describe, expect, it } from 'vitest';
import { cometPosition, planetPosition, solveKepler } from './orbits';
import { localSiderealHours, moonPhase, sunTimes } from './sky';
import { COMETS } from './bodies';

const deg = (rad: number) => (rad * 180) / Math.PI;
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('orbits', () => {
  it('solves Kepler for high eccentricity', () => {
    const e = 0.967;
    for (const M of [-3, -1, -0.01, 0.01, 0.5, 2.9]) {
      const E = solveKepler(M, e);
      expect(E - e * Math.sin(E)).toBeCloseTo(M, 9);
    }
  });

  it('puts Earth at the right heliocentric longitude at J2000', () => {
    // Sun's geocentric longitude at J2000.0 is ~280.37°, so Earth is ~100.37°.
    const p = planetPosition('earth', new Date(Date.UTC(2000, 0, 1, 12)));
    expect(angleDiff(deg(p.lon), 100.37)).toBeLessThan(0.3);
    expect(p.r).toBeCloseTo(0.983, 2);
  });

  it('matches a known Mars opposition (2020-10-13)', () => {
    const d = new Date(Date.UTC(2020, 9, 13, 23));
    const earth = planetPosition('earth', d);
    const mars = planetPosition('mars', d);
    expect(angleDiff(deg(earth.lon), deg(mars.lon))).toBeLessThan(1.5);
  });

  it('puts Halley near perihelion in Feb 1986', () => {
    const p = cometPosition(COMETS[0].elements, new Date(Date.UTC(1986, 1, 9, 11)));
    expect(p.r).toBeCloseTo(0.587, 2);
  });
});

describe('sky', () => {
  it('detects a full moon (2024-04-23 23:49 UTC)', () => {
    const m = moonPhase(new Date(Date.UTC(2024, 3, 23, 23, 49)));
    expect(m.illumination).toBeGreaterThan(0.99);
    expect(m.name).toBe('Full Moon');
  });

  it('detects a new moon (2024-04-08 18:21 UTC, eclipse day)', () => {
    const m = moonPhase(new Date(Date.UTC(2024, 3, 8, 18, 21)));
    expect(m.illumination).toBeLessThan(0.01);
  });

  it('computes London midsummer sunrise within a few minutes', () => {
    // Actual: 2024-06-21 sunrise 04:43 BST = 03:43 UTC; sunset 21:21 BST = 20:21 UTC.
    const t = sunTimes(new Date(Date.UTC(2024, 5, 21, 12)), 51.5074, -0.1278);
    expect(t.kind).toBe('normal');
    const rise = t.sunrise!.getUTCHours() * 60 + t.sunrise!.getUTCMinutes();
    const set = t.sunset!.getUTCHours() * 60 + t.sunset!.getUTCMinutes();
    expect(Math.abs(rise - (3 * 60 + 43))).toBeLessThanOrEqual(3);
    expect(Math.abs(set - (20 * 60 + 21))).toBeLessThanOrEqual(3);
  });

  it('reports polar day', () => {
    const t = sunTimes(new Date(Date.UTC(2024, 5, 21, 12)), 78.2, 15.6);
    expect(t.kind).toBe('polar-day');
  });

  it('computes sidereal time at Greenwich', () => {
    // GMST at 2000-01-01 12:00 UT ≈ 18.697 h.
    expect(localSiderealHours(new Date(Date.UTC(2000, 0, 1, 12)), 0)).toBeCloseTo(18.697, 2);
  });
});
