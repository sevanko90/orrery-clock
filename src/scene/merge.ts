import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Cut draw calls by merging static leaf meshes. Under each node, direct
 * child meshes that share a material (and shadow and render settings) are
 * baked into one mesh in that node's space. Only leaves are touched: the
 * groups the scene animates (pivots, rigs) are left in place, so anything
 * fixed relative to its parent group merges and everything that moves keeps
 * moving. Meshes in `keep`, or carrying userData (picking tags), are left alone.
 *
 * Returns how many meshes were merged away.
 */
export function mergeStaticMeshes(root: THREE.Object3D, keep: Set<THREE.Object3D> = new Set()): number {
  let saved = 0;
  const parents: THREE.Object3D[] = [];
  root.traverse((o) => parents.push(o));
  for (const parent of parents) {
    const buckets = new Map<string, THREE.Mesh[]>();
    for (const child of parent.children) {
      const m = child as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) continue;
      if (m.children.length || keep.has(m) || Object.keys(m.userData).length || Array.isArray(m.material)) continue;
      if (!m.visible || Object.keys(m.geometry.morphAttributes).length || m.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) continue;
      const g = m.geometry;
      const attrs = Object.keys(g.attributes).sort().join(',');
      const key = [m.material.uuid, m.castShadow, m.receiveShadow, m.renderOrder, m.frustumCulled, attrs].join('|');
      const list = buckets.get(key);
      if (list) list.push(m);
      else buckets.set(key, [m]);
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      const geos = list.map((m) => {
        m.updateMatrix();
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        g.applyMatrix4(m.matrix);
        // A mirrored mesh (negative scale) needs its winding flipped back.
        if (m.matrix.determinant() < 0) flipWinding(g);
        return g;
      });
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const first = list[0];
      const mesh = new THREE.Mesh(merged, first.material);
      mesh.castShadow = first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.renderOrder = first.renderOrder;
      mesh.frustumCulled = first.frustumCulled;
      mesh.name = `${parent.name || 'merged'}-merged`;
      for (const m of list) parent.remove(m);
      parent.add(mesh);
      saved += list.length - 1;
    }
  }
  return saved;
}

function flipWinding(g: THREE.BufferGeometry) {
  for (const attr of Object.values(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k);
        a.setComponent(i + 1, k, a.getComponent(i + 2, k));
        a.setComponent(i + 2, k, t);
      }
    }
  }
}
