import * as THREE from 'three/webgpu';
import { lodChain, type LodLevel } from './lod';
import { LOD_HYSTERESIS } from '../xr/scrunch';

/** Layer the batched originals move to: kept for their transforms, never drawn themselves. */
export const BATCHED_LAYER = 6;

interface Entry {
  mesh: THREE.Mesh;
  batch: THREE.BatchedMesh;
  id: number;
  /** Bounding sphere radius in the mesh's own space, for culling small details. */
  radius: number;
  centre: THREE.Vector3;
  /** With LODs: each level's geometry id in the batch and its switch distance; and the level drawn. */
  lods?: { id: number; from: number }[];
  level: number;
}

export interface BatcherOptions {
  /** Skip these meshes (left drawn on their own). */
  skip?: (m: THREE.Mesh) => boolean;
  /** Use registered distance LODs (lod.ts) for geometries that have them (VR scrunch only). */
  lod?: boolean;
}

/**
 * Draws many meshes as a few. Every opaque mesh under a root is grouped with
 * the others sharing its material (and shadow settings and attribute layout)
 * into one BatchedMesh, drawn in a single call per group. The original meshes
 * stay where they are as invisible handles: the scene's animation code keeps
 * moving and hiding them as before, and each frame `sync()` copies their world
 * matrices and visibility into the batches. Same geometry, same materials,
 * same look; far fewer draw calls, which is what a headset's CPU runs out of.
 *
 * Transparent meshes stay separate (they need sorting against each other),
 * as do invisible pick proxies, multi-material, instanced and skinned meshes.
 */
export class Batcher {
  readonly batches: THREE.BatchedMesh[] = [];
  private entries: Entry[] = [];
  private tmp = new THREE.Vector3();

  constructor(
    root: THREE.Object3D,
    private parent: THREE.Object3D,
    options: BatcherOptions = {},
  ) {
    const skip = options.skip ?? (() => false);
    root.updateMatrixWorld(true);
    const groups = new Map<string, THREE.Mesh[]>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.BatchedMesh).isBatchedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (Array.isArray(m.material)) return;
      const mat = m.material as THREE.Material;
      if (!mat.visible || mat.transparent || skip(m)) return;
      // (Draw groups don't matter with a single material: the whole geometry is drawn.)
      if (Object.keys(m.geometry.morphAttributes).length) return;
      const g = m.geometry;
      const attrs = Object.entries(g.attributes)
        .map(([k, a]) => `${k}:${(a as THREE.BufferAttribute).itemSize}:${(a as THREE.BufferAttribute).normalized}`)
        .sort()
        .join(',');
      const key = [mat.uuid, m.castShadow, m.receiveShadow, m.renderOrder, attrs].join('|');
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    });

    for (const list of groups.values()) {
      if (list.length < 2) continue;
      // Each distinct geometry is stored once; meshes sharing it become instances.
      // A batch is all indexed or all not: give unindexed shapes a plain index when they're mixed.
      const distinct = [...new Set(list.map((m) => m.geometry))];
      const chains = new Map<THREE.BufferGeometry, LodLevel[]>();
      if (options.lod) {
        for (const g of distinct) {
          const c = lodChain(g);
          if (c) chains.set(g, c);
        }
      }
      // With LODs, level 0 is the chain's indexed copy of the original.
      const level0 = (g: THREE.BufferGeometry) => chains.get(g)?.[0].geometry ?? g;
      const extra = [...chains.values()].flatMap((c) => c.slice(1).map((l) => l.geometry));
      const all = [...distinct.map(level0), ...extra];
      const anyIndexed = all.some((g) => g.index);
      const asStored = new Map(all.map((g) => [g, anyIndexed && !g.index ? withIndex(g) : g]));
      const geos = [...asStored.values()];
      const vertices = geos.reduce((n, g) => n + g.attributes.position.count, 0);
      const indices = geos.reduce((n, g) => n + (g.index?.count ?? 0), 0);
      const first = list[0];
      const batch = new THREE.BatchedMesh(list.length, vertices, indices || undefined, first.material as THREE.Material);
      batch.castShadow = first.castShadow;
      batch.receiveShadow = first.receiveShadow;
      batch.renderOrder = first.renderOrder;
      batch.name = `batch-${(first.material as THREE.Material).name || first.name || 'mesh'}`;
      // Instances move every frame; the batch's own bounds would be stale, so cull per instance only.
      batch.frustumCulled = false;
      batch.perObjectFrustumCulled = true;
      // Never hit by rays: picking goes to the originals (see raycastLayers()).
      batch.raycast = () => undefined;
      const stored = new Map<THREE.BufferGeometry, number>();
      for (const [g, s] of asStored) stored.set(g, batch.addGeometry(s));
      const lodIds = new Map(
        [...chains].map(([g, c]) => [g, c.map((l) => ({ id: stored.get(l.geometry)!, from: l.from }))]),
      );
      for (const m of list) {
        const id = batch.addInstance(stored.get(level0(m.geometry))!);
        batch.setMatrixAt(id, m.matrixWorld);
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const s = m.geometry.boundingSphere!;
        this.entries.push({ mesh: m, batch, id, radius: s.radius, centre: s.center.clone(), lods: lodIds.get(m.geometry), level: 0 });
        m.layers.set(BATCHED_LAYER);
      }
      this.batches.push(batch);
      parent.add(batch);
    }
  }

  /** How many meshes are drawn through batches, and in how many batches. */
  get stats() {
    return { meshes: this.entries.length, batches: this.batches.length };
  }

  /**
   * Copy the originals' world matrices and visibility into the batches. Call
   * after the scene's world matrices are up to date. With an eye and an angle,
   * also skip instances smaller than that angle from the eye. With `lodEye`,
   * draw each instance that has LODs at the level its distance from there allows.
   */
  sync(eye?: THREE.Vector3, minAngle = 0, lodEye?: THREE.Vector3) {
    const cull = !!eye && minAngle > 0;
    for (const e of this.entries) {
      let visible = true;
      for (let o: THREE.Object3D | null = e.mesh; o && o !== this.parent; o = o.parent) {
        if (!o.visible) {
          visible = false;
          break;
        }
      }
      if (visible && (cull || (lodEye && e.lods))) {
        const m = e.mesh.matrixWorld.elements;
        const scale = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
        const at = this.tmp.copy(e.centre).applyMatrix4(e.mesh.matrixWorld);
        const r = e.radius * scale;
        if (cull) visible = r > at.distanceTo(eye!) * minAngle;
        if (visible && lodEye && e.lods) {
          // Nearest point of the bounds, in the mesh's own units (errors are measured there).
          const d = Math.max(0, at.distanceTo(lodEye) - r) / scale;
          const lods = e.lods;
          let l = e.level;
          while (l + 1 < lods.length && d >= lods[l + 1].from * (1 + LOD_HYSTERESIS)) l++;
          while (l > 0 && d < lods[l].from * (1 - LOD_HYSTERESIS)) l--;
          if (l !== e.level) {
            e.level = l;
            e.batch.setGeometryIdAt(e.id, lods[l].id);
          }
        }
      }
      e.batch.setVisibleAt(e.id, visible);
      if (visible) e.batch.setMatrixAt(e.id, e.mesh.matrixWorld);
    }
  }

  /** How many instances are drawn at each LOD level (for the readout and telemetry). */
  lodCounts() {
    const counts: number[] = [];
    for (const e of this.entries) if (e.lods) counts[e.level] = (counts[e.level] ?? 0) + 1;
    return Array.from(counts, (c) => c ?? 0);
  }

  /** Every batched original, its batch and instance id, and the LOD level drawn. */
  instances(): readonly { mesh: THREE.Mesh; batch: THREE.BatchedMesh; id: number; level: number }[] {
    return this.entries;
  }

  /** Is this mesh drawn through a batch? */
  has(mesh: THREE.Object3D) {
    return mesh.layers.isEnabled(BATCHED_LAYER) && !mesh.layers.isEnabled(0);
  }
}

/** A copy of an unindexed geometry with a plain 0..n−1 index. */
function withIndex(g: THREE.BufferGeometry) {
  const c = g.clone();
  const n = g.attributes.position.count;
  c.setIndex(Array.from({ length: n }, (_, i) => i));
  return c;
}

/** Make a raycaster also hit batched originals (they sit on their own layer). */
export function raycastLayers(raycaster: THREE.Raycaster) {
  raycaster.layers.enable(BATCHED_LAYER);
  return raycaster;
}
