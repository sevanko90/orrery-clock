// Kinematic simulation of the movement. Time drives either the escapement
// (real-time running) or the hand crank (any other speed); every other arbor's
// angle is propagated gear by gear through the meshes.

import { meshAngle, meshAngleInverse, type MechanismDesign, type MeshSpec } from './design';

const TAU = Math.PI * 2;

export type DriveMode = 'clock' | 'crank';

interface MeshCalc {
  driverArbor: string;
  drivenArbor: string;
  nA: number;
  nB: number;
  phi: number;
}

/** Dead-beat tick: a quick jump at each whole second, then rest. */
export function tickProgress(seconds: number): number {
  const whole = Math.floor(seconds);
  const f = Math.min(1, (seconds - whole) * 9);
  return whole + (1 - Math.pow(1 - f, 3));
}

export class Kinematics {
  readonly angles = new Map<string, number>();
  mode: DriveMode = 'crank';
  /** 0 = going train engaged with the drive arbor, 1 = fully lifted clear. */
  clutch = 1;
  balance = 0;
  anchorRock = 0;

  private going: MeshCalc[];
  private drive: MeshCalc[];
  private crank: MeshCalc;
  private yFromE: { c: number; k: number };
  private omegaY: number; // rad per simulated second (crank mode, exact)

  private anchorS = 0;
  private anchorY = 0;
  private anchorE = 0;
  private balanceAmp = 0;
  private initialised = false;

  constructor(readonly design: MechanismDesign) {
    const arb = new Map(design.arbors.map((a) => [a.id, a]));
    const gear = new Map(design.gears.map((g) => [g.id, g]));
    const calc = (m: MeshSpec): MeshCalc => {
      const a = gear.get(m.driver)!,
        b = gear.get(m.driven)!;
      const pa = arb.get(a.arbor)!,
        pb = arb.get(b.arbor)!;
      return { driverArbor: a.arbor, drivenArbor: b.arbor, nA: a.teeth, nB: b.teeth, phi: Math.atan2(pb.y - pa.y, pb.x - pa.x) };
    };
    this.going = design.going.map(calc);
    this.drive = design.drive.map(calc);
    this.crank = calc(design.crank);
    for (const a of design.arbors) this.angles.set(a.id, 0);

    // Y as an affine function of the escape arbor angle.
    const y0 = this.propagateGoing(0);
    const y1 = this.propagateGoing(1);
    this.yFromE = { c: y0, k: y1 - y0 };

    // Exact drive-arbor rate: F turns once per design period.
    const omegaF = TAU / (design.fPeriodDays * 86400);
    const yf = this.drive[0]; // Y.pinion → F.drive
    // dF/dY = −nA/nB for a single mesh.
    this.omegaY = omegaF / (-yf.nA / yf.nB);
  }

  /** Escape wheel speed in clock mode is 1 rev/min, 60 beats. */
  private propagateGoing(e: number): number {
    const tmp = new Map<string, number>([['E', e]]);
    for (const m of this.going) tmp.set(m.drivenArbor, meshAngle(tmp.get(m.driverArbor)!, m.nA, m.nB, m.phi));
    return tmp.get('Y')!;
  }

  private propagate(meshes: MeshCalc[]) {
    for (const m of meshes) {
      this.angles.set(m.drivenArbor, meshAngle(this.angles.get(m.driverArbor)!, m.nA, m.nB, m.phi));
    }
  }

  private reanchor(s: number) {
    this.anchorS = s;
    this.anchorY = this.angles.get('Y')!;
    if (this.mode === 'clock') {
      // Choose the escape angle that keeps Y exactly where it is.
      this.anchorE = (this.anchorY - this.yFromE.c) / this.yFromE.k;
    }
  }

  /**
   * Advance the mechanism to simulated time `simMs`.
   * @param realTime true when the clock runs at 1× (escapement drives)
   * @param jumped true when simulated time was set discontinuously
   */
  update(simMs: number, realTime: boolean, jumped: boolean, realDt: number) {
    const s = simMs / 1000;
    const want: DriveMode = realTime ? 'clock' : 'crank';
    if (!this.initialised) {
      this.mode = want;
      this.clutch = want === 'clock' ? 0 : 1;
      this.reanchor(s);
      this.initialised = true;
    } else if (want !== this.mode) {
      this.mode = want;
      this.reanchor(s);
    } else if (jumped) {
      this.reanchor(s);
    }

    if (this.mode === 'clock') {
      const beats = tickProgress(s) - tickProgress(this.anchorS);
      const e = this.anchorE + (TAU / 60) * beats;
      this.angles.set('E', e);
      this.propagate(this.going);
      // The crank stays meshed with Y and turns along.
      this.angles.set('crank', meshAngleInverse(this.angles.get('Y')!, this.crank.nA, this.crank.nB, this.crank.phi));
      // Balance swings through centre at each whole second.
      this.balanceAmp = Math.min(2.4, this.balanceAmp + realDt * 3);
    } else {
      const y = this.anchorY + this.omegaY * (s - this.anchorS);
      const c = meshAngleInverse(y, this.crank.nA, this.crank.nB, this.crank.phi);
      this.angles.set('crank', c);
      this.angles.set('Y', meshAngle(c, this.crank.nA, this.crank.nB, this.crank.phi));
      this.balanceAmp *= Math.exp(-realDt * 1.8);
    }
    this.propagate(this.drive);

    const phase = Math.sin(Math.PI * s);
    this.balance = this.balanceAmp * phase;
    this.anchorRock = this.balanceAmp > 0.05 ? 0.12 * Math.tanh(5 * phase) : this.anchorRock * 0.9;

    const target = this.mode === 'clock' ? 0 : 1;
    this.clutch += Math.sign(target - this.clutch) * Math.min(Math.abs(target - this.clutch), realDt * 3);
  }

  angle(arbor: string): number {
    return this.angles.get(arbor) ?? 0;
  }
}
