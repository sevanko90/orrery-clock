import * as THREE from 'three/webgpu';

/**
 * VR scrunch: what the Disc hides. The orrery's walnut table is a closed,
 * opaque cylinder (the Disc's solid core): a sight line that crosses either
 * of its flat caps passes through it, so anything wholly on the far side of
 * a cap's plane, all of whose sight lines cross the plane inside the cap,
 * can't be seen. From the deck that is the elephants and A'Tuin; from under
 * the Disc, the planets and the instrument above it.
 *
 * The test is conservative (it never hides what could show): for a bounding
 * sphere (c, r), every point p on it crosses the plane y = Y at
 * q = e + t·(p − e), t = (e.y − Y) / (e.y − p.y), so
 * |q_xz| ≤ (1 − t)|e_xz| + t(|c_xz| + r), linear in t, largest at an end of
 * t's range over the sphere. Hidden when that stays inside the cap.
 */
export interface DiscCap {
  y: number;
  radius: number;
}

export function hiddenByCap(cap: DiscCap, eye: THREE.Vector3, c: THREE.Vector3, r: number): boolean {
  const de = eye.y - cap.y;
  const dc = c.y - cap.y;
  // Eye and sphere wholly on opposite sides of the plane.
  if (de === 0 || de * dc >= 0 || Math.abs(dc) <= r) return false;
  const near = Math.abs(dc) - r; // nearest the plane any point of the sphere gets
  const far = Math.abs(dc) + r;
  const a = Math.abs(de);
  const tMax = a / (a + near);
  const tMin = a / (a + far);
  const e = Math.hypot(eye.x, eye.z);
  const p = Math.hypot(c.x, c.z) + r;
  const at = (t: number) => (1 - t) * e + t * p;
  return Math.max(at(tMin), at(tMax)) <= cap.radius;
}

/** Hidden behind either cap of the table (each shrunk by `margin`, e.g. for the eyes' spread). */
export function hiddenByDisc(caps: readonly DiscCap[], eye: THREE.Vector3, c: THREE.Vector3, r: number, margin = 0): boolean {
  // (An eye inside the solid sees nothing of it: no occlusion then.)
  const lo = Math.min(...caps.map((k) => k.y)),
    hi = Math.max(...caps.map((k) => k.y));
  if (eye.y > lo && eye.y < hi && Math.hypot(eye.x, eye.z) < Math.max(...caps.map((k) => k.radius))) return false;
  for (const cap of caps) if (hiddenByCap({ y: cap.y, radius: cap.radius - margin }, eye, c, r)) return true;
  return false;
}

/**
 * The table's caps, from the instrument as built: its walnut table is the
 * multi-material closed cylinder of the largest radius (world space).
 */
export function discCapsOf(root: THREE.Object3D): { table: THREE.Mesh; caps: DiscCap[] } | null {
  let table: THREE.Mesh | null = null;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const g = m.geometry as THREE.CylinderGeometry | undefined;
    if (!m.isMesh || g?.type !== 'CylinderGeometry' || g.parameters.openEnded || !Array.isArray(m.material)) return;
    if (!table || g.parameters.radiusTop > (table.geometry as THREE.CylinderGeometry).parameters.radiusTop) table = m;
  });
  if (!table) return null;
  const t = table as THREE.Mesh;
  const p = (t.geometry as THREE.CylinderGeometry).parameters;
  const at = new THREE.Vector3().setFromMatrixPosition(t.matrixWorld);
  const s = new THREE.Vector3().setFromMatrixScale(t.matrixWorld);
  // An axis-aligned, centred, unrotated table only (as built): otherwise no occlusion.
  if (Math.hypot(at.x, at.z) > 1e-3 || Math.abs(s.x - s.z) > 1e-6) return null;
  return {
    table: t,
    caps: [
      { y: at.y + (p.height / 2) * s.y, radius: p.radiusTop * s.x },
      { y: at.y - (p.height / 2) * s.y, radius: p.radiusBottom * s.x },
    ],
  };
}
