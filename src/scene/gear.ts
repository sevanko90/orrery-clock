import * as THREE from 'three/webgpu';
import { arcError, arcPoints, arcSegments, chamferError, pathFrom, pointSegment, registerLod, sharpPrism } from './lod';

export interface GearOptions {
  teeth: number;
  /** Gear module: pitch diameter = module × teeth. */
  module: number;
  thickness: number;
  boreRadius: number;
  /** Number of spoke windows (0 = solid web). */
  spokes?: number;
}

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * Extruded spur gear. Tooth 0 is centred on local +X; geometry lies in the
 * XZ plane (axis along Y), centred vertically.
 */
export function gearGeometry(opt: GearOptions): THREE.BufferGeometry {
  const key = JSON.stringify(opt);
  const hit = cache.get(key);
  if (hit) return hit;

  const { teeth, module: m, thickness, boreRadius } = opt;
  const pitchR = (m * teeth) / 2;
  const outerR = pitchR + m;
  const rootR = pitchR - 1.25 * m;
  const step = (Math.PI * 2) / teeth;

  // Trapezoidal tooth approximating an involute: wide at root, narrow at tip.
  const shape = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const c = i * step;
    const pts: [number, number][] = [
      [rootR, c - step * 0.5],
      [rootR, c - step * 0.3],
      [pitchR, c - step * 0.22],
      [outerR, c - step * 0.12],
      [outerR, c + step * 0.12],
      [pitchR, c + step * 0.22],
      [rootR, c + step * 0.3],
    ];
    pts.forEach(([r, a], j) => {
      const x = r * Math.cos(a),
        y = r * Math.sin(a);
      if (i === 0 && j === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();

  const bore = new THREE.Path();
  bore.absarc(0, 0, boreRadius, 0, Math.PI * 2, true);
  shape.holes.push(bore);

  const spokes = opt.spokes ?? 0;
  const rimInner = rootR - Math.max(0.12, m * 1.6);
  const hubOuter = boreRadius + Math.max(0.1, m * 1.2);
  if (spokes > 0 && rimInner - hubOuter > 0.25) {
    const spokeHalf = Math.min(0.5, (0.09 + m * 0.5) / ((rimInner + hubOuter) / 2));
    for (let s = 0; s < spokes; s++) {
      const a0 = (s / spokes) * Math.PI * 2 + spokeHalf;
      const a1 = ((s + 1) / spokes) * Math.PI * 2 - spokeHalf;
      const win = new THREE.Path();
      win.absarc(0, 0, rimInner, a0, a1, false);
      win.absarc(0, 0, hubOuter, a1, a0, true);
      win.closePath();
      shape.holes.push(win);
    }
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: Math.min(0.015, thickness * 0.15),
    bevelSize: Math.min(0.012, m * 0.15),
    bevelSegments: 1,
    curveSegments: 24,
  });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(-Math.PI / 2); // extrude axis → +Y; shape +Y → −Z (CCW from above preserved)
  geo.computeVertexNormals();
  cache.set(key, geo);
  registerLod(geo, () => gearLods(opt));
  return geo;
}

/** The bevel gearGeometry() puts on a gear. */
function gearBevel(opt: GearOptions) {
  return { bt: Math.min(0.015, opt.thickness * 0.15), bs: Math.min(0.012, opt.module * 0.15) };
}

/**
 * Cheaper builds of a gear for the headset (see lod.ts), coarsest last:
 *  1. Sharp-edged (no bevel faces, same silhouette), trapezoid teeth with
 *     4 points instead of 7, arcs only as fine as the error budget needs.
 *  2. As 1 with pointed teeth (3 points), for further away.
 * Each level's error bound is the lost chamfer plus the outline's worst
 * error (how far the dropped tooth points sit from the simplified outline,
 * or the arcs' chord error).
 */
export function gearLods(opt: GearOptions): { geometry: THREE.BufferGeometry; error: number }[] {
  const { teeth, module: m, thickness, boreRadius } = opt;
  const pitchR = (m * teeth) / 2;
  const outerR = pitchR + m;
  const rootR = pitchR - 1.25 * m;
  const step = (Math.PI * 2) / teeth;
  const { bt, bs } = gearBevel(opt);
  const P = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];

  // Tooth 0 (centred on +x), as gearGeometry draws it, and what each level keeps.
  const root0 = P(rootR, -step * 0.3),
    pitch0 = P(pitchR, -step * 0.22),
    tip0 = P(outerR, -step * 0.12),
    land = P(rootR, -step * 0.5),
    prevRoot = P(rootR, -step * 0.7);
  const apex = P(outerR, 0);
  // The flank's pitch point off the straight flank; the root land's middle point off its chord.
  const trapezoidError = Math.max(pointSegment(pitch0, root0, tip0), pointSegment(land, prevRoot, root0));
  // Pointed tooth: the tip land's corners and the pitch point off the new flank.
  const pointedError = Math.max(trapezoidError, pointSegment(tip0, root0, apex), pointSegment(pitch0, root0, apex));
  const chamfer = chamferError(bt, bs);

  const profiles: [number, number][][] = [
    [
      [rootR, -0.3],
      [outerR, -0.12],
      [outerR, 0.12],
      [rootR, 0.3],
    ],
    [
      [rootR, -0.3],
      [outerR, 0],
      [rootR, 0.3],
    ],
  ];
  return [trapezoidError, pointedError].map((toothError, level) => {
    // The outline's own error (teeth, arcs) and the lost chamfer can land on the
    // same edge, so the bound is their sum. Arcs are cut as finely as the teeth.
    const budget = Math.max(toothError, chamfer * 0.5);
    let outlineError = toothError;
    const outline: [number, number][] = [];
    for (let i = 0; i < teeth; i++) {
      for (const [r, f] of profiles[level]) outline.push(P(r, i * step + f * step));
    }
    const shape = pathFrom(outline, new THREE.Shape()) as THREE.Shape;
    const nb = arcSegments(boreRadius, Math.PI * 2, budget, 6);
    outlineError = Math.max(outlineError, arcError(boreRadius, Math.PI * 2, nb));
    shape.holes.push(pathFrom(arcPoints(0, 0, boreRadius, 0, -Math.PI * 2, nb, true).slice(0, -1)));

    const spokes = opt.spokes ?? 0;
    const rimInner = rootR - Math.max(0.12, m * 1.6);
    const hubOuter = boreRadius + Math.max(0.1, m * 1.2);
    if (spokes > 0 && rimInner - hubOuter > 0.25) {
      const spokeHalf = Math.min(0.5, (0.09 + m * 0.5) / ((rimInner + hubOuter) / 2));
      for (let s = 0; s < spokes; s++) {
        const a0 = (s / spokes) * Math.PI * 2 + spokeHalf;
        const a1 = ((s + 1) / spokes) * Math.PI * 2 - spokeHalf;
        const span = a1 - a0;
        const nr = arcSegments(rimInner, span, budget, 2);
        const nh = arcSegments(hubOuter, span, budget, 1);
        outlineError = Math.max(outlineError, arcError(rimInner, span, nr), arcError(hubOuter, span, nh));
        shape.holes.push(pathFrom([...arcPoints(0, 0, rimInner, a0, a1, nr), ...arcPoints(0, 0, hubOuter, a1, a0, nh, true)]));
      }
    }
    return { geometry: sharpPrism(shape, thickness, bt, bs), error: chamfer + outlineError };
  });
}

export function pitchRadius(module: number, teeth: number): number {
  return (module * teeth) / 2;
}

/**
 * Rotation for gear B meshing with gear A.
 * @param thetaA rotation of A (radians, about +Y)
 * @param phi direction from A's centre to B's centre (same angular convention)
 */
export function meshAngle(thetaA: number, teethA: number, teethB: number, phi: number): number {
  return phi + Math.PI - Math.PI / teethB + (teethA / teethB) * (phi - thetaA);
}
