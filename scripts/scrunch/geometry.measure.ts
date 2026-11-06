/**
 * Geometric fidelity of the VR scrunch LODs (no GPU needed):
 *   docker compose exec app npx vitest run -c scripts/scrunch/vitest.config.ts geometry
 *
 * For every LOD level: triangles and vertex-shader runs before/after, the
 * level's switch distance, and its error against the original, both as the
 * builder's analytic bound and as a sampled symmetric Hausdorff distance and
 * mean surface distance (area-weighted samples on each surface, exact
 * point-to-triangle distance to the other). Errors are given in world units,
 * as a fraction of the bounding diagonal, and in pixels at the level's switch
 * distance on a Quest 3 eye (720 px/rad). Results also go to
 * scripts/scrunch/results/geometry.json.
 */
import { test, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { buildMechanism, design } from '../../src/scene/mechanism3d';
import { gearGeometry } from '../../src/scene/gear';
import { lodChain } from '../../src/scene/lod';
import { sphereLevels, beltRock, ROCK_SCALE } from '../../src/scene/meshLod';
import { QUEST_PX_PER_RAD, LOD_HYSTERESIS } from '../../src/xr/scrunch';

// ---- Surface distance ------------------------------------------------------------

type Tri = Float64Array; // 9 numbers

function triangles(g: THREE.BufferGeometry): Tri[] {
  const p = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const out: Tri[] = [];
  for (let i = 0; i < n; i += 3) {
    const t = new Float64Array(9);
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx.getX(i + k) : i + k;
      t[k * 3] = p.getX(v);
      t[k * 3 + 1] = p.getY(v);
      t[k * 3 + 2] = p.getZ(v);
    }
    out.push(t);
  }
  return out;
}

/** Closest distance from p to triangle t (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTri(px: number, py: number, pz: number, t: Tri): number {
  const ax = t[0], ay = t[1], az = t[2], bx = t[3], by = t[4], bz = t[5], cx = t[6], cy = t[7], cz = t[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const dist = (x: number, y: number, z: number) => Math.hypot(px - x, py - y, pz - z);
  if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist(ax + v * abx, ay + v * aby, az + v * abz);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist(ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Uniform grid over a triangle set for nearest-surface queries. */
class Grid {
  private cells = new Map<number, number[]>();
  private min: THREE.Vector3;
  private h: number;
  private dims: number[];
  constructor(private tris: Tri[]) {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const t of tris) for (let k = 0; k < 3; k++) box.expandByPoint(v.set(t[k * 3], t[k * 3 + 1], t[k * 3 + 2]));
    const size = box.getSize(new THREE.Vector3());
    this.min = box.min.clone();
    this.h = Math.max(size.x, size.y, size.z, 1e-6) / 96;
    this.dims = [size.x, size.y, size.z].map((s) => Math.max(1, Math.ceil(s / this.h) + 1));
    tris.forEach((t, i) => {
      const lo = [0, 1, 2].map((a) => Math.floor((Math.min(t[a], t[3 + a], t[6 + a]) - this.min.getComponent(a)) / this.h));
      const hi = [0, 1, 2].map((a) => Math.floor((Math.max(t[a], t[3 + a], t[6 + a]) - this.min.getComponent(a)) / this.h));
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const k = this.key(x, y, z);
            const c = this.cells.get(k);
            if (c) c.push(i);
            else this.cells.set(k, [i]);
          }
    });
  }
  private key(x: number, y: number, z: number) {
    return (x * this.dims[1] + y) * this.dims[2] + z;
  }
  nearest(px: number, py: number, pz: number): number {
    const c = [px, py, pz].map((p, a) => Math.floor((p - this.min.getComponent(a)) / this.h));
    let best = Infinity;
    const seen = new Set<number>();
    const maxR = Math.max(...this.dims);
    for (let r = 0; r <= maxR; r++) {
      for (let x = c[0] - r; x <= c[0] + r; x++)
        for (let y = c[1] - r; y <= c[1] + r; y++)
          for (let z = c[2] - r; z <= c[2] + r; z++) {
            if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
            if (x < 0 || y < 0 || z < 0 || x >= this.dims[0] || y >= this.dims[1] || z >= this.dims[2]) continue;
            for (const i of this.cells.get(this.key(x, y, z)) ?? []) {
              if (seen.has(i)) continue;
              seen.add(i);
              best = Math.min(best, pointTri(px, py, pz, this.tris[i]));
            }
          }
      // Everything within r·h of the point has been seen.
      if (best <= r * this.h) break;
    }
    return best;
  }
}

/** Seeded area-weighted samples on a surface. */
function samples(tris: Tri[], n: number, seed = 1): number[][] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const areas = tris.map((t) => {
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2], vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  });
  const cum: number[] = [];
  areas.reduce((a, b, i) => (cum[i] = a + b), 0);
  const total = cum[cum.length - 1];
  const out: number[][] = [];
  // Every vertex too (corners carry the worst errors).
  for (const t of tris) for (let k = 0; k < 3; k++) out.push([t[k * 3], t[k * 3 + 1], t[k * 3 + 2]]);
  for (let i = 0; i < n; i++) {
    const x = rnd() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    let a = rnd(), b = rnd();
    if (a + b > 1) [a, b] = [1 - a, 1 - b];
    out.push([0, 1, 2].map((k) => t[k] + a * (t[3 + k] - t[k]) + b * (t[6 + k] - t[k])));
  }
  return out;
}

/** Symmetric Hausdorff and mean surface distance between two surfaces. */
function surfaceDistance(a: THREE.BufferGeometry, b: THREE.BufferGeometry, n = 20000) {
  const ta = triangles(a), tb = triangles(b);
  const ga = new Grid(ta), gb = new Grid(tb);
  let max = 0, sum = 0, cnt = 0;
  for (const [x, y, z] of samples(ta, n, 1)) {
    const d = gb.nearest(x, y, z);
    max = Math.max(max, d);
    sum += d;
    cnt++;
  }
  for (const [x, y, z] of samples(tb, n, 2)) {
    const d = ga.nearest(x, y, z);
    max = Math.max(max, d);
    sum += d;
    cnt++;
  }
  return { hausdorff: max, mean: sum / cnt };
}

const cost = (g: THREE.BufferGeometry) => ({
  tris: (g.index ? g.index.count : g.attributes.position.count) / 3,
  verts: g.attributes.position.count,
});
const diag = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!.getSize(new THREE.Vector3()).length();
};
const px = (e: number, d: number) => (d > 0 ? (e / d) * QUEST_PX_PER_RAD : Infinity);
const r4 = (x: number) => +x.toPrecision(4);

test('scrunch LOD geometric error', () => {
  const rows: Record<string, unknown>[] = [];
  const m = () => new THREE.MeshStandardMaterial();
  const mats = { brass: m(), brassDark: m(), copper: m(), steel: m(), plate: m(), wood: m(), woodEdge: m(), felt: m() };
  const mech = buildMechanism(mats as never);
  // Distinct geometries with chains: the 45 spur gears and 3 plates.
  const geos = new Map<THREE.BufferGeometry, string>();
  for (const g of design.gears) {
    if (g.kind !== 'spur') continue;
    geos.set(gearGeometry({ teeth: g.teeth, module: g.module, thickness: g.thickness, boreRadius: g.bore, spokes: g.spokes ?? 0 }), `gear ${g.id} (${g.teeth}T m${g.module.toFixed(4)})`);
  }
  let plate = 0;
  mech.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.material === mats.plate) geos.set(mesh.geometry, `plate ${plate++}`);
  });

  let worstRatio = 0;
  for (const [geo, name] of geos) {
    const chain = lodChain(geo)!;
    const c0 = cost(geo);
    const dg = diag(geo);
    chain.forEach((l, i) => {
      if (i === 0) {
        const c = cost(l.geometry);
        rows.push({ name, level: 0, tris: c.tris, verts: c.verts, origTris: c0.tris, origVerts: c0.verts, from: 0, bound: 0, hausdorff: 0, mean: 0, note: 'original, indexed (exact)' });
        return;
      }
      const d = surfaceDistance(geo, l.geometry, 15000);
      const c = cost(l.geometry);
      worstRatio = Math.max(worstRatio, d.hausdorff / l.error);
      rows.push({
        name,
        level: i,
        tris: c.tris,
        verts: c.verts,
        origTris: c0.tris,
        origVerts: c0.verts,
        from: r4(l.from),
        bound: r4(l.error),
        hausdorff: r4(d.hausdorff),
        mean: r4(d.mean),
        hausdorffOfDiag: r4(d.hausdorff / dg),
        pxAtSwitch: r4(px(d.hausdorff, l.from)),
        pxAtSwitchWithHysteresis: r4(px(d.hausdorff, l.from * (1 - LOD_HYSTERESIS))),
        meanPxAtSwitch: r4(px(d.mean, l.from)),
      });
    });
  }

  // Spheres: the planets' 64×48 (each size) and the moons' 32×24.
  const spheres: [string, number, number, number][] = [
    ['Sun-sized (not LODed: unlit)', 1.55, 64, 48],
    ['Jupiter 0.95', 0.95, 64, 48],
    ['Saturn 0.8', 0.8, 64, 48],
    ['Uranus 0.52', 0.52, 64, 48],
    ['Earth 0.34', 0.34, 64, 48],
    ['Mercury 0.2', 0.2, 64, 48],
  ];
  for (const [name, r, w, h] of spheres) {
    const g = new THREE.SphereGeometry(r, w, h);
    const lv = sphereLevels(g);
    const c0 = cost(g);
    lv.forEach((l, i) => {
      if (i === 0) return;
      const d = surfaceDistance(g, l.geometry, 15000);
      const c = cost(l.geometry);
      const p = (l.geometry as THREE.SphereGeometry).parameters;
      worstRatio = Math.max(worstRatio, d.hausdorff / l.error);
      rows.push({
        name: `sphere ${name} → ${p.widthSegments}×${p.heightSegments}`,
        level: i,
        tris: c.tris,
        verts: c.verts,
        origTris: c0.tris,
        origVerts: c0.verts,
        from: r4(l.from),
        bound: r4(l.error),
        hausdorff: r4(d.hausdorff),
        mean: r4(d.mean),
        hausdorffOfDiag: r4(d.hausdorff / (2 * r * Math.sqrt(3))),
        pxAtSwitch: r4(px(d.hausdorff, l.from)),
        pxAtSwitchWithHysteresis: r4(px(d.hausdorff, l.from * (1 - LOD_HYSTERESIS))),
        meanPxAtSwitch: r4(px(d.mean, l.from)),
      });
    });
  }

  // Belt rock: unit dodecahedron vs the icosahedron that replaces it (scale chosen to minimise Hausdorff).
  const dodeca = new THREE.DodecahedronGeometry(1, 0);
  const scan = [1.0, 1.04, 1.06, 1.08, 1.09, 1.1, 1.12, 1.15, 1.2].map((k) => ({ k, ...surfaceDistance(dodeca, new THREE.IcosahedronGeometry(k, 0), 8000) }));
  const best = scan.reduce((a, b) => (b.hausdorff < a.hausdorff ? b : a));
  const rock = beltRock();
  const dr = surfaceDistance(dodeca, rock, 15000);
  rows.push({
    name: `belt rock (×${ROCK_SCALE}; best scanned ×${best.k})`,
    level: 1,
    tris: cost(rock).tris,
    verts: cost(rock).verts,
    origTris: cost(dodeca).tris,
    origVerts: cost(dodeca).verts,
    hausdorffUnit: r4(dr.hausdorff),
    meanUnit: r4(dr.mean),
    note: 'rock sizes 0.018–0.088 units; px at 20 units for the largest: ' + r4(px(dr.hausdorff * 0.088, 20)) + ', median (0.022): ' + r4(px(dr.hausdorff * 0.022, 20)),
    scan: scan.map((s) => [s.k, r4(s.hausdorff)]),
  });

  mkdirSync('scripts/scrunch/results', { recursive: true });
  writeFileSync('scripts/scrunch/results/geometry.json', JSON.stringify(rows, null, 1));
  // A compact table on stdout.
  for (const r of rows) {
    const x = r as Record<string, number | string>;
    console.log(
      [x.name, `L${x.level}`, `tris ${x.origTris}→${x.tris}`, `verts ${x.origVerts}→${x.verts}`, x.from !== undefined ? `from ${x.from}` : '', x.bound !== undefined ? `bound ${x.bound}` : '', x.hausdorff !== undefined ? `H ${x.hausdorff}` : `H(unit) ${x.hausdorffUnit}`, x.mean !== undefined ? `mean ${x.mean}` : '', x.pxAtSwitch !== undefined ? `px ${x.pxAtSwitch} (hyst ${x.pxAtSwitchWithHysteresis})` : x.note ?? ''].join(' | '),
    );
  }
  console.log('worst measured/bound ratio', worstRatio.toFixed(3));
  // The analytic bounds that set the switch distances must hold (5% sampling slack).
  expect(worstRatio).toBeLessThan(1.05);
});
