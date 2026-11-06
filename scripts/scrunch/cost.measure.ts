/**
 * Boot-time and memory cost of the scrunch LODs (node, no GPU):
 *   docker compose exec app npx vitest run -c scripts/scrunch/vitest.config.ts cost
 * Time to build every gear/plate chain and the planet sphere ladders, and the
 * bytes of the extra vertex/index buffers (what the GPU also holds).
 */
import { test } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildMechanism } from '../../src/scene/mechanism3d';
import { lodChain } from '../../src/scene/lod';
import { sphereLevels, beltRock } from '../../src/scene/meshLod';

const bytes = (g: THREE.BufferGeometry) =>
  Object.values(g.attributes).reduce((n, a) => n + (a as THREE.BufferAttribute).array.byteLength, 0) + (g.index?.array.byteLength ?? 0);

test('scrunch boot cost', () => {
  const m = () => new THREE.MeshStandardMaterial();
  const mats = { brass: m(), brassDark: m(), copper: m(), steel: m(), plate: m(), wood: m(), woodEdge: m(), felt: m() };
  const mech = buildMechanism(mats as never);
  const geos = new Set<THREE.BufferGeometry>();
  mech.root.traverse((o) => (o as THREE.Mesh).isMesh && geos.add((o as THREE.Mesh).geometry));
  let orig = 0;
  geos.forEach((g) => (orig += bytes(g)));
  const t0 = performance.now();
  let extra = 0, chains = 0;
  for (const g of geos) {
    const c = lodChain(g);
    if (!c) continue;
    chains++;
    c.forEach((l) => (extra += bytes(l.geometry)));
  }
  const t1 = performance.now();
  let sph = 0;
  for (const [r, w, h] of [[0.2, 64, 48], [0.32, 64, 48], [0.34, 64, 48], [0.26, 64, 48], [0.95, 64, 48], [0.8, 64, 48], [0.52, 64, 48], [0.5, 64, 48]] as const) {
    sphereLevels(new THREE.SphereGeometry(r, w, h)).slice(1).forEach((l) => (sph += bytes(l.geometry)));
  }
  const rock = bytes(beltRock());
  const t2 = performance.now();
  console.log(JSON.stringify({
    mechanismChains: chains,
    mechanismBuildMs: +(t1 - t0).toFixed(1),
    mechanismOriginalBytes: orig,
    mechanismLodBytes: extra,
    sphereLadderBytes: sph,
    beltRockBytes: rock,
    spheresAndRockMs: +(t2 - t1).toFixed(1),
  }));
});
