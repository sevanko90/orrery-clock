import * as THREE from 'three/webgpu';

/**
 * Real surfaces to set the tabletop orrery down on: the room's horizontal
 * planes from WebXR plane detection (on Quest, the tables, desks and floor
 * from Space Setup), in the room's space (the rig's, metres).
 */
export interface Surface {
  /** Plane space → room (its Y axis is the plane's normal, up or down: see surfacesFrom). */
  matrix: THREE.Matrix4;
  /** Outline in plane space (x, z). */
  polygon: { x: number; z: number }[];
  /** What Space Setup called it ('floor', 'table', ...), if anything. */
  label?: string;
}


/** The detected planes facing up, from this frame (empty without plane detection). */
export function surfacesFrom(frame: XRFrame | null, space: XRReferenceSpace | null): Surface[] {
  const planes = (frame as (XRFrame & { detectedPlanes?: Set<XRPlaneLike> }) | null)?.detectedPlanes;
  if (!frame || !space || !planes) return [];
  const out: Surface[] = [];
  for (const plane of planes) {
    if (plane.orientation !== 'horizontal') continue;
    const pose = frame.getPose(plane.planeSpace, space);
    if (!pose) continue;
    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
    // Level, and not the ceiling. (Not by the normal's direction: Quest gives
    // floors, tables and couches a plane Y axis pointing down, the ceiling up.)
    if (Math.abs(matrix.elements[5]) < 0.9 || plane.semanticLabel === 'ceiling') continue;
    out.push({ matrix, polygon: plane.polygon.map((p) => ({ x: p.x, z: p.z })), label: plane.semanticLabel });
  }
  return out;
}

/** Every detected plane, unfiltered, for telemetry: orientation, label, height, normal's y, size. */
export function planesReport(frame: XRFrame | null, space: XRReferenceSpace | null) {
  const planes = (frame as (XRFrame & { detectedPlanes?: Set<XRPlaneLike> }) | null)?.detectedPlanes;
  if (!frame || !space || !planes) return null;
  const r = (v: number) => Math.round(v * 100) / 100;
  return [...planes].map((p) => {
    const m = frame.getPose(p.planeSpace, space)?.transform.matrix;
    const xs = p.polygon.map((q) => q.x),
      zs = p.polygon.map((q) => q.z);
    return {
      o: p.orientation,
      label: p.semanticLabel ?? null,
      y: m ? r(m[13]) : null,
      up: m ? r(m[5]) : null,
      size: [r(Math.max(...xs) - Math.min(...xs)), r(Math.max(...zs) - Math.min(...zs))],
    };
  });
}

/** The parts of an XRPlane used here (not yet in the DOM typings). */
interface XRPlaneLike {
  semanticLabel?: string;
  orientation: 'horizontal' | 'vertical';
  planeSpace: XRSpace;
  polygon: DOMPointReadOnly[];
}

const local = new THREE.Vector3();
const inv = new THREE.Matrix4();

/**
 * The height (room y) of the highest surface under `p` (room metres) that it
 * is between `below` metres under and `above` metres over, or null.
 */
export function surfaceUnder(surfaces: Surface[], p: THREE.Vector3, above: number, below: number): number | null {
  let best: number | null = null;
  for (const s of surfaces) {
    local.copy(p).applyMatrix4(inv.copy(s.matrix).invert());
    if (!inside(local.x, local.z, s.polygon)) continue;
    // How far p is above the plane, in the room (the plane's own Y may point either way).
    const y = s.matrix.elements[13];
    const over = p.y - y;
    if (over > above || over < -below) continue;
    if (best === null || y > best) best = y;
  }
  return best;
}

/** Point in polygon (even-odd). */
function inside(x: number, z: number, poly: { x: number; z: number }[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}
