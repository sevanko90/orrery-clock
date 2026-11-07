import * as THREE from 'three/webgpu';

/**
 * VR scrunch: draw double-sided transparent materials in one pass where two
 * passes can't make a difference. The renderer draws a transparent
 * DoubleSide object twice (back faces, then front faces) so a closed shape
 * blends its far side under its near side. That order doesn't matter when
 *  - the blending is additive and depth isn't written (a sum is a sum in any
 *    order): the fiction's gas cones and glows; or
 *  - the shape is flat (a ring, a disc): from any one side only one of its
 *    faces covers a pixel: Saturn's rings, the fiction's ring world.
 * Every mesh using the material must qualify. Returns the materials changed.
 */
export function singlePass(roots: THREE.Object3D[]): THREE.Material[] {
  const users = new Map<THREE.Material, THREE.Mesh[]>();
  for (const root of roots) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      const mat = m.material as THREE.Material;
      if (!mat.transparent || mat.side !== THREE.DoubleSide || mat.forceSinglePass) return;
      const list = users.get(mat);
      if (list) list.push(m);
      else users.set(mat, [m]);
    });
  }
  const changed: THREE.Material[] = [];
  for (const [mat, meshes] of users) {
    const additive = mat.blending === THREE.AdditiveBlending && !mat.depthWrite;
    if (additive || meshes.every((m) => flat(m.geometry))) {
      mat.forceSinglePass = true;
      changed.push(mat);
    }
  }
  return changed;
}

const flatCache = new WeakMap<THREE.BufferGeometry, boolean>();

/** Do all of a geometry's vertices lie in one plane (to a part in a million of its size)? */
export function flat(g: THREE.BufferGeometry): boolean {
  const hit = flatCache.get(g);
  if (hit !== undefined) return hit;
  const p = g.attributes.position;
  let out = false;
  if (p && p.count >= 3) {
    if (!g.boundingSphere) g.computeBoundingSphere();
    const eps = g.boundingSphere!.radius * 1e-6;
    const a = new THREE.Vector3().fromBufferAttribute(p, 0);
    const n = new THREE.Vector3();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    // A normal from the first non-degenerate triangle fan from vertex 0.
    for (let i = 1; i < p.count && n.lengthSq() === 0; i++) {
      u.fromBufferAttribute(p, i).sub(a);
      for (let j = i + 1; j < p.count; j++) {
        v.fromBufferAttribute(p, j).sub(a);
        n.crossVectors(u, v);
        if (n.lengthSq() > eps * eps * 1e6) break;
        n.set(0, 0, 0);
      }
    }
    if (n.lengthSq() > 0) {
      n.normalize();
      out = true;
      for (let i = 0; i < p.count && out; i++) if (Math.abs(u.fromBufferAttribute(p, i).sub(a).dot(n)) > eps) out = false;
    }
  }
  flatCache.set(g, out);
  return out;
}
