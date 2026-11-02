import { describe, expect, it } from 'vitest';
import designJson from './design.json';
import { checkDesign, meshAngle, meshAngleInverse, type MechanismDesign } from './design';
import { Kinematics } from './kinematics';

const design = designJson as MechanismDesign;
const TAU = Math.PI * 2;

describe('mechanism design', () => {
  it('has no collisions and every mesh is at the right centre distance', () => {
    expect(checkDesign(design)).toEqual([]);
  });

  it('reproduces sidereal period ratios to within 25 ppm', () => {
    for (const p of design.planets) {
      expect(Math.abs(p.ratio / p.target - 1)).toBeLessThan(25e-6);
    }
  });

  it('inverts meshes exactly', () => {
    const b = meshAngle(1.234, 17, 91, 0.7);
    expect(meshAngleInverse(b, 17, 91, 0.7)).toBeCloseTo(1.234, 12);
  });
});

describe('kinematics', () => {
  const DAY = 86_400_000;

  it('turns each planet tube at its true sidereal rate when cranked', () => {
    const k = new Kinematics(design);
    const t0 = Date.UTC(2026, 0, 1);
    k.update(t0, false, false, 0.016);
    const start = new Map(design.planets.map((p) => [p.id, k.angle(p.tube)]));
    const span = design.fPeriodDays * DAY; // one drive-arbor revolution
    k.update(t0 + span, false, false, 0.016);
    for (const p of design.planets) {
      const revs = (k.angle(p.tube) - start.get(p.id)!) / TAU;
      expect(revs).toBeCloseTo(p.ratio, 6);
      expect(revs).toBeGreaterThan(0); // all planets orbit counter-clockwise
    }
  });

  it('ticks the escape wheel one tooth-beat (6°) per second at real time', () => {
    const k = new Kinematics(design);
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0, 500);
    k.update(t0, true, false, 0.016);
    const e0 = k.angle('E');
    k.update(t0 + 1000, true, false, 0.016);
    expect(k.angle('E') - e0).toBeCloseTo(TAU / 60, 9);
  });

  it('keeps the drive train continuous when switching from escapement to crank', () => {
    const k = new Kinematics(design);
    const t0 = Date.UTC(2026, 0, 1, 12);
    k.update(t0, true, false, 0.016);
    k.update(t0 + 5000, true, false, 0.016);
    const f = k.angle('F');
    k.update(t0 + 5000, false, false, 0.016);
    expect(k.angle('F')).toBeCloseTo(f, 9);
  });
});
