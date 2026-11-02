import type { PlanetId } from '../astro/orbits';
import { TABLE_TOP, tubeRadius } from '../mechanism/heights';

/**
 * World layout of the instrument (world units, y up). The movement lives in a
 * walnut cabinet whose top is at TABLE_TOP; the planet arms ride above it.
 * Ecliptic longitude θ maps to (cos θ, −sin θ) on (x, z): counter-clockwise
 * seen from above.
 */
export { TABLE_TOP };
export const TABLE_RADIUS = 19.5;
export const ARM_BASE = TABLE_TOP + 0.38;
export const ARM_STEP = 0.3;
export const PLANE_Y = ARM_BASE + 7 * ARM_STEP + 1.95;
export const SUN_RADIUS = 1.55;

export interface ArmSpec {
  id: Exclude<PlanetId, 'pluto'>;
  /** Display orbit radius. */
  radius: number;
  /** Planet sphere radius. */
  size: number;
  /** Height of the arm. */
  armY: number;
  tubeRadius: number;
}

const ORDER: ArmSpec['id'][] = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const RADII = [3.1, 4.3, 5.5, 6.7, 10.1, 12.6, 14.9, 16.9];
const SIZES = [0.2, 0.32, 0.34, 0.26, 0.95, 0.8, 0.52, 0.5];

export const ARMS: ArmSpec[] = ORDER.map((id, i) => ({
  id,
  radius: RADII[i],
  size: SIZES[i],
  // Outer planets ride the lowest, widest tubes; inner planets the highest, thinnest.
  armY: ARM_BASE + (ORDER.length - 1 - i) * ARM_STEP,
  tubeRadius: tubeRadius(i),
}));

export const PLUTO_SIZE = 0.24;

// Anchors for mapping true heliocentric distance (AU) to display radius.
const AU_ANCHORS: [number, number][] = [
  [0, SUN_RADIUS + 0.3],
  [0.387, RADII[0]],
  [0.723, RADII[1]],
  [1.0, RADII[2]],
  [1.524, RADII[3]],
  [2.2, 7.8],
  [3.3, 8.9],
  [5.203, RADII[4]],
  [9.537, RADII[5]],
  [19.19, RADII[6]],
  [30.07, RADII[7]],
  [39.48, 18.6],
];

/** Compress a true heliocentric distance (AU) into display units. */
export function displayRadius(au: number): number {
  for (let i = 1; i < AU_ANCHORS.length; i++) {
    const [a1, d1] = AU_ANCHORS[i];
    if (au <= a1) {
      const [a0, d0] = AU_ANCHORS[i - 1];
      return d0 + ((au - a0) / (a1 - a0)) * (d1 - d0);
    }
  }
  const [aL, dL] = AU_ANCHORS[AU_ANCHORS.length - 1];
  return dL + (au - aL) * 0.09;
}

/** Map a heliocentric ecliptic position (AU) into world space. */
export function toWorld(x: number, y: number, z: number, out: { x: number; y: number; z: number }) {
  const r = Math.hypot(x, y, z);
  const k = r > 0 ? displayRadius(r) / r : 0;
  out.x = x * k;
  out.y = PLANE_Y + z * k;
  out.z = -y * k;
  return out;
}
