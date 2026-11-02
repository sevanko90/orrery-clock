import { DEG, J2000, julianDate, norm180 } from './time';

/**
 * Keplerian elements with linear rates per Julian century, from
 * E.M. Standish, "Keplerian Elements for Approximate Positions of the Major
 * Planets" (JPL), table valid 1800–2050 AD.
 * Angles in degrees, a in AU. L = mean longitude, peri = longitude of
 * perihelion (ϖ), node = longitude of ascending node (Ω).
 */
export interface PlanetElements {
  a: [number, number];
  e: [number, number];
  I: [number, number];
  L: [number, number];
  peri: [number, number];
  node: [number, number];
}

export type PlanetId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'pluto';

export const PLANET_ELEMENTS: Record<PlanetId, PlanetElements> = {
  mercury: {
    a: [0.38709927, 0.00000037],
    e: [0.20563593, 0.00001906],
    I: [7.00497902, -0.00594749],
    L: [252.2503235, 149472.67411175],
    peri: [77.45779628, 0.16047689],
    node: [48.33076593, -0.12534081],
  },
  venus: {
    a: [0.72333566, 0.0000039],
    e: [0.00677672, -0.00004107],
    I: [3.39467605, -0.0007889],
    L: [181.9790995, 58517.81538729],
    peri: [131.60246718, 0.00268329],
    node: [76.67984255, -0.27769418],
  },
  earth: {
    a: [1.00000261, 0.00000562],
    e: [0.01671123, -0.00004392],
    I: [-0.00001531, -0.01294668],
    L: [100.46457166, 35999.37244981],
    peri: [102.93768193, 0.32327364],
    node: [0, 0],
  },
  mars: {
    a: [1.52371034, 0.00001847],
    e: [0.0933941, 0.00007882],
    I: [1.84969142, -0.00813131],
    L: [-4.55343205, 19140.30268499],
    peri: [-23.94362959, 0.44441088],
    node: [49.55953891, -0.29257343],
  },
  jupiter: {
    a: [5.202887, -0.00011607],
    e: [0.04838624, -0.00013253],
    I: [1.30439695, -0.00183714],
    L: [34.39644051, 3034.74612775],
    peri: [14.72847983, 0.21252668],
    node: [100.47390909, 0.20469106],
  },
  saturn: {
    a: [9.53667594, -0.0012506],
    e: [0.05386179, -0.00050991],
    I: [2.48599187, 0.00193609],
    L: [49.95424423, 1222.49362201],
    peri: [92.59887831, -0.41897216],
    node: [113.66242448, -0.28867794],
  },
  uranus: {
    a: [19.18916464, -0.00196176],
    e: [0.04725744, -0.00004397],
    I: [0.77263783, -0.00242939],
    L: [313.23810451, 428.48202785],
    peri: [170.9542763, 0.40805281],
    node: [74.01692503, 0.04240589],
  },
  neptune: {
    a: [30.06992276, 0.00026291],
    e: [0.00859048, 0.00005105],
    I: [1.77004347, 0.00035372],
    L: [-55.12002969, 218.45945325],
    peri: [44.96476227, -0.32241464],
    node: [131.78422574, -0.00508664],
  },
  pluto: {
    a: [39.48211675, -0.00031596],
    e: [0.2488273, 0.0000517],
    I: [17.14001206, 0.00004818],
    L: [238.92903833, 145.20780515],
    peri: [224.06891629, -0.04062942],
    node: [110.30393684, -0.01183482],
  },
};

/** Heliocentric ecliptic position (J2000 ecliptic), AU. */
export interface HelioPosition {
  x: number;
  y: number;
  z: number;
  /** Distance from the Sun, AU. */
  r: number;
  /** Ecliptic longitude, radians in [0, 2π). */
  lon: number;
}

/** Solve Kepler's equation M = E − e·sin E (radians). */
export function solveKepler(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** Position from classical elements. Angles in degrees. */
export function positionFromElements(
  a: number,
  e: number,
  inclDeg: number,
  nodeDeg: number,
  argPeriDeg: number,
  meanAnomalyDeg: number,
): HelioPosition {
  const M = norm180(meanAnomalyDeg) * DEG;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  const w = argPeriDeg * DEG;
  const O = nodeDeg * DEG;
  const I = inclDeg * DEG;
  const cw = Math.cos(w),
    sw = Math.sin(w),
    cO = Math.cos(O),
    sO = Math.sin(O),
    cI = Math.cos(I),
    sI = Math.sin(I);

  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = sw * sI * xp + cw * sI * yp;
  const r = Math.hypot(x, y, z);
  let lon = Math.atan2(y, x);
  if (lon < 0) lon += 2 * Math.PI;
  return { x, y, z, r, lon };
}

export function planetPosition(id: PlanetId, date: Date): HelioPosition {
  const el = PLANET_ELEMENTS[id];
  const T = (julianDate(date) - J2000) / 36525;
  const v = (p: [number, number]) => p[0] + p[1] * T;
  const a = v(el.a),
    e = v(el.e),
    I = v(el.I),
    L = v(el.L),
    peri = v(el.peri),
    node = v(el.node);
  return positionFromElements(a, e, I, node, peri - node, L - peri);
}

/** Sidereal orbital period in days, from the semi-major axis. */
export function orbitalPeriodDays(aAU: number): number {
  return 365.256898 * Math.pow(aAU, 1.5);
}

/** Comet / small-body elements referenced to a time of perihelion passage. */
export interface CometElements {
  q: number; // perihelion distance, AU
  e: number;
  i: number; // deg
  node: number; // deg
  argPeri: number; // deg
  perihelionJD: number;
}

export function cometPosition(c: CometElements, date: Date): HelioPosition {
  const a = c.q / (1 - c.e);
  const n = 0.9856076686 / Math.pow(a, 1.5); // deg/day
  const M = n * (julianDate(date) - c.perihelionJD);
  return positionFromElements(a, c.e, c.i, c.node, c.argPeri, M);
}

/** Sample a closed orbit as points (AU), evenly in eccentric anomaly. */
export function sampleOrbit(
  a: number,
  e: number,
  i: number,
  node: number,
  argPeri: number,
  segments = 256,
): HelioPosition[] {
  const pts: HelioPosition[] = [];
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * 2 * Math.PI;
    const M = (E - e * Math.sin(E)) / DEG;
    pts.push(positionFromElements(a, e, i, node, argPeri, M));
  }
  return pts;
}
