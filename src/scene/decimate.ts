import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Resolves once the simplifier (WebAssembly) can be used. */
export const simplifierReady: Promise<void> = MeshoptSimplifier.ready;

const done = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * A lighter copy of a geometry (headset): about `ratio` of its triangles,
 * keeping its silhouette within `error` of its size and its seams (UV and
 * normal borders stay where they are). Shared geometries are simplified once.
 * Returns the original when it's small or barely simplifies.
 */
export function decimated(geo: THREE.BufferGeometry, ratio = 0.35, error = 0.02, minTriangles = 500): THREE.BufferGeometry {
  const hit = done.get(geo);
  if (hit) return hit;
  let out = geo;
  if (MeshoptSimplifier.supported) {
    const g = geo.index ? geo : mergeVertices(geo, 1e-6);
    const index = g.index!;
    if (index.count / 3 >= minTriangles) {
      const indices = new Uint32Array(index.array as ArrayLike<number>);
      const pos = g.attributes.position;
      const positions = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
      const target = Math.floor((indices.length * ratio) / 3) * 3;
      const [kept] = MeshoptSimplifier.simplify(indices, positions, 3, target, error, ['LockBorder']);
      if (kept.length < indices.length * 0.85) {
        out = g.clone();
        out.setIndex(new THREE.BufferAttribute(kept, 1));
        out.computeBoundingSphere();
      }
    }
  }
  done.set(geo, out);
  return out;
}

/** Simplify every mesh under `root` (see decimated), except those `skip` says. Returns the triangles before and after. */
export function decimateTree(root: THREE.Object3D, ratio?: number, error?: number, skip: (m: THREE.Mesh) => boolean = () => false) {
  let before = 0,
    after = 0;
  const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Object.keys(m.geometry.morphAttributes).length || skip(m)) return;
    before += tris(m.geometry);
    m.geometry = decimated(m.geometry, ratio, error);
    after += tris(m.geometry);
  });
  return { before, after };
}
