// Mechanism description and geometric validation. Pure TypeScript (no three.js)
// so the offline solver and the unit tests share exactly the same rules.

/** Plan coordinates: x = world x, y = −world z. Angles CCW seen from above. */
export interface ArborSpec {
  id: string;
  x: number;
  y: number;
  radius: number;
  bottom: number;
  top: number;
}

export type GearKind = 'spur' | 'escape' | 'anchor' | 'balance';

export interface GearSpec {
  id: string;
  arbor: string;
  kind: GearKind;
  teeth: number;
  module: number;
  /** Layer centre height. */
  y: number;
  thickness: number;
  bore: number;
  /** For non-spur parts: swept outer radius. */
  outer?: number;
  spokes?: number;
}

export interface MeshSpec {
  driver: string;
  driven: string;
}

export interface PlanetTrain {
  id: string;
  tube: string;
  stage1: [string, string];
  stage2: [string, string];
  /** Achieved tube revolutions per drive-arbor (F) revolution. */
  ratio: number;
  /** Ideal ratio from sidereal periods. */
  target: number;
}

export interface MechanismDesign {
  /** Seconds per revolution of the central drive arbor F. */
  fPeriodDays: number;
  arbors: ArborSpec[];
  gears: GearSpec[];
  /** Meshes downstream of the drive arbor Y (Y → F → planets). */
  drive: MeshSpec[];
  /** Going train from the escape wheel arbor to Y. */
  going: MeshSpec[];
  /** Crank pinion → Y wheel. */
  crank: MeshSpec;
  planets: PlanetTrain[];
}

export const pitchR = (g: GearSpec) => (g.module * g.teeth) / 2;
export const outerR = (g: GearSpec) => g.outer ?? g.module * (g.teeth / 2 + 1);
export const rootR = (g: GearSpec) => g.module * (g.teeth / 2 - 1.25);

export interface Violation {
  msg: string;
  deficit: number;
}

const MARGIN = 0.04;

export function checkDesign(d: MechanismDesign, maxExtent = 5.9): Violation[] {
  const out: Violation[] = [];
  const arb = new Map(d.arbors.map((a) => [a.id, a]));
  const gear = new Map(d.gears.map((g) => [g.id, g]));
  const meshPairs = new Set<string>();
  for (const m of [...d.drive, ...d.going, d.crank]) {
    meshPairs.add(`${m.driver}|${m.driven}`);
    meshPairs.add(`${m.driven}|${m.driver}`);
  }

  // A gear's meshing partner's arbor sits inside the partner's root circle,
  // so it is allowed within this gear's addendum.
  const partnerArbors = new Map<string, Set<string>>();
  for (const m of [...d.drive, ...d.going, d.crank]) {
    const a = gear.get(m.driver)!,
      b = gear.get(m.driven)!;
    if (!partnerArbors.has(a.id)) partnerArbors.set(a.id, new Set());
    if (!partnerArbors.has(b.id)) partnerArbors.set(b.id, new Set());
    partnerArbors.get(a.id)!.add(b.arbor);
    partnerArbors.get(b.id)!.add(a.arbor);
  }

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const overlapsY = (g: GearSpec, lo: number, hi: number) => g.y + g.thickness / 2 > lo && g.y - g.thickness / 2 < hi;

  // Meshes must sit at the right centre distance, on the same layer.
  for (const m of [...d.drive, ...d.going, d.crank]) {
    const a = gear.get(m.driver)!,
      b = gear.get(m.driven)!;
    const ca = arb.get(a.arbor)!,
      cb = arb.get(b.arbor)!;
    const want = pitchR(a) + pitchR(b);
    const err = Math.abs(dist(ca, cb) - want);
    if (err > 1e-6) out.push({ msg: `mesh ${a.id}-${b.id} centre distance off by ${err.toFixed(4)}`, deficit: err * 10 });
    if (Math.abs(a.y - b.y) > 1e-6) out.push({ msg: `mesh ${a.id}-${b.id} not on one layer`, deficit: 1 });
    if (Math.abs(a.module - b.module) > 1e-9 && a.kind === 'spur' && b.kind === 'spur')
      out.push({ msg: `mesh ${a.id}-${b.id} module mismatch`, deficit: 1 });
  }

  for (const g of d.gears) {
    const c = arb.get(g.arbor)!;
    const o = outerR(g);

    // Bore must clear the arbor/tube with material left at the tooth root.
    if (g.kind === 'spur') {
      const room = rootR(g) - (g.bore + 0.04);
      if (room < 0) out.push({ msg: `${g.id} root inside bore`, deficit: -room });
      const lo = 0.022 - g.module,
        hi = g.module - 0.09;
      if (lo > 0 || hi > 0) out.push({ msg: `${g.id} module ${g.module.toFixed(3)} out of range`, deficit: 5 * Math.max(lo, hi) + 0.01 });
    }

    // Stay inside the cabinet window.
    const ext = Math.hypot(c.x, c.y) + o - maxExtent;
    if (ext > 0) out.push({ msg: `${g.id} extends beyond plates`, deficit: ext });

    // Gear vs every arbor it shares height with.
    for (const q of d.arbors) {
      if (q.id === g.arbor) continue;
      if (partnerArbors.get(g.id)?.has(q.id)) continue;
      if (!overlapsY(g, q.bottom, q.top)) continue;
      const dd = dist(c, q);
      if (dd < 1e-6) {
        // Coaxial: the other member must pass through this gear's bore.
        if (q.radius > g.bore - 0.005) out.push({ msg: `${g.id} bore blocks coaxial ${q.id}`, deficit: q.radius - g.bore + 0.005 });
        continue;
      }
      const need = o + q.radius + MARGIN;
      if (dd < need) out.push({ msg: `${g.id} hits arbor ${q.id}`, deficit: need - dd });
    }

    // Gear vs gear on overlapping layers (other than meshing partners / same arbor).
    for (const h of d.gears) {
      if (h.id <= g.id) continue;
      if (h.arbor === g.arbor) continue;
      if (!overlapsY(g, h.y - h.thickness / 2, h.y + h.thickness / 2)) continue;
      if (meshPairs.has(`${g.id}|${h.id}`)) continue;
      // The anchor's pallets deliberately reach into the escape wheel.
      if ((g.kind === 'anchor' && h.kind === 'escape') || (g.kind === 'escape' && h.kind === 'anchor')) continue;
      const ch = arb.get(h.arbor)!;
      const dd = dist(c, ch);
      if (dd < 1e-6) continue; // coaxial gears on different tubes, separated by layer rules
      const need = o + outerR(h) + MARGIN;
      if (dd < need) out.push({ msg: `${g.id} hits gear ${h.id}`, deficit: need - dd });
    }
  }
  return out;
}

/**
 * Rotation of gear B meshing with gear A, so their teeth interleave.
 * Tooth 0 of every gear points along its local +x at angle 0.
 * @param phi direction (plan angle) from A's centre to B's centre
 */
export function meshAngle(thetaA: number, teethA: number, teethB: number, phi: number): number {
  return phi + Math.PI - Math.PI / teethB + (teethA / teethB) * (phi - thetaA);
}

/** Inverse of meshAngle: the driver angle that produces driven angle thetaB. */
export function meshAngleInverse(thetaB: number, teethA: number, teethB: number, phi: number): number {
  return phi - (teethB / teethA) * (thetaB - phi - Math.PI + Math.PI / teethB);
}
