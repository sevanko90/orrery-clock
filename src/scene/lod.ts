import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { switchDistance } from '../xr/scrunch';

/**
 * Distance LODs for procedural geometry (VR only; see xr/scrunch.ts).
 *
 * A builder is registered against a geometry when it is made, but nothing is
 * computed until a Batcher in scrunch mode asks for the chain, so the desktop
 * pays nothing. Level 0 is the original geometry, indexed (same triangles,
 * same attributes: an exact copy that shades the same but runs the vertex
 * shader a third as often).
 */
export interface LodLevel {
  geometry: THREE.BufferGeometry;
  /** Worst geometric error against the original (world units, before the mesh's scale). */
  error: number;
  /** Use this level from here (distance in the mesh's own units from the eye to the nearest point of its bounds). */
  from: number;
}

const builders = new WeakMap<THREE.BufferGeometry, () => Omit<LodLevel, 'from'>[]>();
const chains = new WeakMap<THREE.BufferGeometry, LodLevel[]>();

/** Say how to build cheaper versions of `geo` (levels past 0, coarsest last). */
export function registerLod(geo: THREE.BufferGeometry, build: () => Omit<LodLevel, 'from'>[]) {
  builders.set(geo, build);
}

/** The LOD chain for `geo` (level 0 first), or null if it has none. Built on first ask. */
export function lodChain(geo: THREE.BufferGeometry): LodLevel[] | null {
  const hit = chains.get(geo);
  if (hit) return hit;
  const build = builders.get(geo);
  if (!build) return null;
  const levels: LodLevel[] = [{ geometry: indexed(geo), error: 0, from: 0 }];
  for (const l of build()) {
    // Each level's switch distance is where its error falls to the pixel budget;
    // never nearer than the level before.
    levels.push({ ...l, from: Math.max(levels[levels.length - 1].from, switchDistance(l.error)) });
  }
  chains.set(geo, levels);
  return levels;
}

/** Indexed copy of a geometry (exact: welds only vertices whose every attribute matches). */
export function indexed(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geo.index) return geo;
  const g = mergeVertices(geo, 1e-6);
  g.computeBoundingSphere();
  return g;
}

/** Points on a circular arc (end points included), CCW from a0 to a1 unless `cw`. */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, n: number, cw = false): [number, number][] {
  let span = a1 - a0;
  if (!cw && span < 0) span += Math.PI * 2;
  if (cw && span > 0) span -= Math.PI * 2;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (span * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Segments an arc of radius r and angular span needs to keep its chord error under e. */
export function arcSegments(r: number, span: number, e: number, min = 3): number {
  if (r <= e) return min;
  const step = 2 * Math.acos(1 - e / r);
  return Math.max(min, Math.ceil(Math.abs(span) / step));
}

/** Chord error of an arc of radius r cut into n segments over `span`. */
export function arcError(r: number, span: number, n: number) {
  return r * (1 - Math.cos(Math.abs(span) / (2 * n)));
}

export function pathFrom(pts: [number, number][], into: THREE.Path = new THREE.Path()) {
  pts.forEach(([x, y], i) => (i === 0 ? into.moveTo(x, y) : into.lineTo(x, y)));
  into.closePath();
  return into;
}

/**
 * Extrude a polygon shape as a sharp-edged prism with the silhouette of a
 * bevelled extrusion: the walls sit where the bevelled version's walls are
 * (pushed out by bevelSize), the caps where its caps are (bevelThickness
 * beyond the depth). The bevel's chamfer is what's lost, at most
 * bt·bs / √(bt² + bs²) from the original surface. Returned indexed, in the
 * same orientation as gearGeometry (axis along +Y, centred).
 */
export function sharpPrism(shape: THREE.Shape, thickness: number, bevelThickness: number, bevelSize: number): THREE.BufferGeometry {
  const depth = thickness + 2 * bevelThickness;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    // Bevel on with no bevel layers: walls are pushed out by bevelSize, nothing else.
    bevelEnabled: bevelSize > 0,
    bevelSegments: 0,
    bevelThickness: 0,
    bevelSize,
    curveSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  const out = mergeVertices(geo, 1e-6);
  geo.dispose();
  out.computeBoundingSphere();
  return out;
}

/**
 * Worst distance from a sharp prism's edge to the bevelled original's
 * chamfer: bt·b / √(bt² + b²), with b the bevel's push-out. At a polygon
 * corner the push-out is mitred, up to √2 × bevelSize (three caps it there).
 */
export function chamferError(bevelThickness: number, bevelSize: number) {
  if (bevelThickness <= 0 || bevelSize <= 0) return 0;
  const b = bevelSize * Math.SQRT2;
  return (bevelThickness * b) / Math.hypot(bevelThickness, b);
}

/** Distance from point p to segment ab (2D). */
export function pointSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = THREE.MathUtils.clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
