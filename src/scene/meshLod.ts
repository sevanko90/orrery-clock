import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIVE, LOD_HYSTERESIS, switchDistance } from '../xr/scrunch';

/**
 * Distance LODs for meshes drawn on their own (the planets, the Sun, moons):
 * VR scrunch only. Each registered mesh swaps its geometry for a coarser
 * sphere as it gets further from the eye, at the distance where the coarser
 * one's silhouette error falls under the pixel budget (see scrunch.ts).
 * Same material, same attribute layout, so a swap never compiles a shader.
 */
interface Item {
  mesh: THREE.Mesh;
  levels: { geometry: THREE.BufferGeometry; from: number; error: number }[];
  level: number;
}

/** Segment ladder for spheres, finest first: (width, height) segments. */
const LADDER: [number, number][] = [
  [64, 48],
  [48, 36],
  [32, 24],
  [24, 18],
  [16, 12],
];

/**
 * Worst distance of a w × h segment sphere from the true sphere: the middle
 * of a facet, inset by both the longitude and the latitude chord.
 */
export function sphereError(r: number, w: number, h: number) {
  return r * (1 - Math.cos(Math.PI / w) * Math.cos(Math.PI / (2 * h)));
}

type Level = { geometry: THREE.BufferGeometry; from: number; error: number };
const sphereCache = new Map<string, Level[]>();

/**
 * Coarser spheres for a full SphereGeometry, each with its error and switch
 * distance (in the geometry's units). Shared between meshes with equal spheres.
 */
export function sphereLevels(g: THREE.SphereGeometry): Level[] {
  const { radius, widthSegments: w, heightSegments: h } = g.parameters;
  const key = `${radius}|${w}|${h}`;
  const hit = sphereCache.get(key);
  if (hit) return hit;
  const levels: Level[] = [{ geometry: g, from: 0, error: 0 }];
  // Keep the original's own aspect (h / w) down the ladder.
  for (const [lw] of LADDER) {
    if (lw >= w) continue;
    const lh = Math.max(6, Math.round((lw * h) / w));
    const error = sphereError(radius, lw, lh);
    const geometry = new THREE.SphereGeometry(radius, lw, lh);
    levels.push({ geometry, error, from: Math.max(levels[levels.length - 1].from, switchDistance(error)) });
  }
  sphereCache.set(key, levels);
  return levels;
}

/** Is this a plain, full sphere whose look doesn't depend on its vertex density? */
function lodable(m: THREE.Mesh) {
  const g = m.geometry as THREE.SphereGeometry;
  if (g.type !== 'SphereGeometry' || Array.isArray(m.material)) return false;
  const p = g.parameters;
  if (p.phiLength < Math.PI * 2 - 1e-6 || p.thetaLength < Math.PI - 1e-6 || p.widthSegments <= 16) return false;
  const mat = m.material as THREE.Material & { positionNode?: unknown; visible: boolean };
  // Invisible pick proxies stay as they are; so do shaders that move vertices, and unlit
  // spheres (the Sun): with no shading to soften it, their texture shows the facets' seams.
  return (
    mat.visible !== false &&
    !mat.positionNode &&
    !(m as THREE.InstancedMesh).isInstancedMesh &&
    !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial
  );
}

export class MeshLods {
  private items: Item[] = [];
  private seen = new WeakSet<THREE.Object3D>();
  private tmp = new THREE.Vector3();
  private frame = 0;

  /** Pick up new spheres under these roots (cheap; call now and then: moons are built on first use). */
  scan(roots: THREE.Object3D[]) {
    for (const root of roots) {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || this.seen.has(m)) return;
        this.seen.add(m);
        if (!lodable(m)) return;
        const levels = sphereLevels(m.geometry as THREE.SphereGeometry);
        if (levels.length > 1) this.items.push({ mesh: m, levels, level: 0 });
      });
    }
  }

  /** Choose each mesh's level from its distance to the eye (nearest point of its sphere). */
  update(eye: THREE.Vector3, roots: THREE.Object3D[]) {
    if (this.frame++ % 60 === 0) this.scan(roots);
    for (const it of this.items) {
      const e = it.mesh.matrixWorld.elements;
      const scale = Math.sqrt(
        Math.max(
          e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
          e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
          e[8] * e[8] + e[9] * e[9] + e[10] * e[10],
        ),
      );
      const r = (it.levels[0].geometry as THREE.SphereGeometry).parameters.radius * scale;
      const d = (LIVE.lodBias * Math.max(0, this.tmp.setFromMatrixPosition(it.mesh.matrixWorld).distanceTo(eye) - r)) / (scale || 1);
      let l = it.level;
      while (l + 1 < it.levels.length && d >= it.levels[l + 1].from * (1 + LOD_HYSTERESIS)) l++;
      while (l > 0 && d < it.levels[l].from * (1 - LOD_HYSTERESIS)) l--;
      if (l !== it.level) {
        it.level = l;
        it.mesh.geometry = it.levels[l].geometry;
      }
    }
  }

  /** How many meshes are at each level. */
  counts() {
    const c: number[] = [];
    for (const it of this.items) c[it.level] = (c[it.level] ?? 0) + 1;
    return Array.from(c, (x) => x ?? 0);
  }
}

/**
 * The asteroid-belt rock for VR: an indexed icosahedron (20 faces, 12
 * vertices) in place of a dodecahedron drawn unindexed (36 triangles, 108
 * vertices). The rocks are flat-shaded from screen derivatives, so they need
 * no normals, and most are under a pixel across; the scale minimises the
 * Hausdorff distance to the unit dodecahedron (see scripts/scrunch).
 */
export const ROCK_SCALE = 1.06;
export function beltRock(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(ROCK_SCALE, 0);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const out = mergeVertices(g, 1e-6);
  g.dispose();
  out.computeBoundingSphere();
  return out;
}
