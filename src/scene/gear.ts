import * as THREE from 'three';

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
  return geo;
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
