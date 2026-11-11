import * as THREE from 'three/webgpu';

/**
 * Tabletop handling: the orrery as an object in the player's room, which they
 * pick up and move, never themselves.
 *
 * The scene stays in world units and the player's rig carries the room
 * (controllers and head are rig children, in metres). So "the orrery's place
 * in the room" is the rig's inverse: every grab and stick here edits that
 * room transform (world → room), then hands it back to the rig.
 *
 *  - One grip: hold the orrery and move / turn it with the hand (it stays upright).
 *  - Both grips: also scale it, by the hands' spread.
 *  - Floating ('air'): the sticks drive it like a remote control: left stick
 *    across the room (forward = away from the player), right stick up / down
 *    and turn.
 *  - On a table: only the turn (right stick across).
 */
export type Placement = 'air' | 'table';

/** Metres per world unit the hands may scale it to (~15 cm to ~3 m across). */
export const TABLETOP_SCALE = { min: 0.004, max: 0.08 };
const DRIVE = { speed: 0.5, rise: 0.35, turnDegPerS: 90 };

export interface TabletopInput {
  /** Left stick (x right, y forward), right stick (x right, y up); deadzoned. */
  left: THREE.Vector2;
  right: THREE.Vector2;
  gripLeft: boolean;
  gripRight: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);

export class TabletopHandling {
  placement: Placement = 'air';
  /** Hands held at the start of the grab, the hand frame then and the room transform then. */
  private grab: { key: string; h0inv: THREE.Matrix4; t0: THREE.Matrix4; m0: number; q0inv: THREE.Quaternion } | null = null;
  private m = new THREE.Matrix4();
  private h = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(
    private rig: THREE.Object3D,
    /** The orrery's centre (world units). */
    private centre: () => THREE.Vector3,
    /** Set the world scale (metres per unit): the rig's scale and everything sized from it. */
    private setScale: (metresPerUnit: number) => void,
  ) {}

  get grabbing() {
    return this.grab !== null;
  }

  /** Floating down onto a surface. */
  get landing() {
    return this.landingTo !== null;
  }

  /** The orrery's turn in the room (radians about the vertical). */
  get yaw() {
    this.e.setFromQuaternion(this.q.setFromRotationMatrix(this.m.extractRotation(this.room())), 'YXZ');
    return this.e.y;
  }

  /** Put it so world point `base` is at room point `at`, turned by `yaw`, at `metresPerUnit` (a restored spot). */
  placeAt(base: THREE.Vector3, at: THREE.Vector3, yaw: number, metresPerUnit: number) {
    this.landingTo = null;
    this.grab = null;
    const t = new THREE.Matrix4()
      .makeTranslation(at.x, at.y, at.z)
      .multiply(this.m.makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeScale(metresPerUnit, metresPerUnit, metresPerUnit))
      .multiply(new THREE.Matrix4().makeTranslation(-base.x, -base.y, -base.z));
    this.setRoom(t);
  }

  /**
   * Per frame. `hands` are the grip spaces (room metres) of the controllers
   * whose grip is held; `headQ` is the head's turn in the room. Returns 'grab' on the
   * frame a grab starts (for a buzz), 'drop' on the frame it's let go, true while it
   * moved the orrery, else false. Picked up, it floats until set down again (settle).
   */
  update(
    dt: number,
    input: TabletopInput,
    hands: { left: THREE.Object3D | null; right: THREE.Object3D | null },
    headQ: THREE.Quaternion,
  ): 'grab' | 'drop' | boolean {
    const held = [input.gripLeft ? hands.left : null, input.gripRight ? hands.right : null].filter((x): x is THREE.Object3D => !!x);
    const key = (input.gripLeft && hands.left ? 'L' : '') + (input.gripRight && hands.right ? 'R' : '');
    if (!key) {
      if (this.grab) {
        this.grab = null;
        return 'drop';
      }
      const landed = this.stepLanding(dt);
      return this.drive(dt, input, headQ) || landed;
    }
    // Taken hold of mid-landing: it's in the hand now.
    this.landingTo = null;
    const t = this.room();
    // A grab starts, or a hand joins or lets go: take hold afresh from where things are (no jump).
    if (!this.grab || this.grab.key !== key) {
      const started = !this.grab;
      this.placement = 'air';
      const q0inv = held[0].quaternion.clone().invert();
      this.grab = { key, h0inv: this.handFrame(held, q0inv).invert(), t0: t.clone(), m0: this.scale(t), q0inv };
      return started ? 'grab' : true;
    }
    const g = this.grab;
    const frame = this.handFrame(held, g.q0inv);
    // Two hands: hold the scale inside its limits (by clamping the spread's ratio).
    if (held.length === 2) {
      const ratio = this.s.setFromMatrixScale(frame).x * this.s.setFromMatrixScale(g.h0inv).x;
      const clamped = THREE.MathUtils.clamp(g.m0 * ratio, TABLETOP_SCALE.min, TABLETOP_SCALE.max) / g.m0;
      if (clamped !== ratio) frame.scale(this.s.setScalar(clamped / ratio));
    }
    this.setRoom(frame.multiply(g.h0inv).multiply(g.t0));
    return true;
  }

  /** The sticks with no grip held. */
  private drive(dt: number, input: TabletopInput, headQ: THREE.Quaternion): boolean {
    const turn = input.right.x;
    const air = this.placement === 'air';
    const move = air ? input.left : null;
    const rise = air ? input.right.y : 0;
    if (!turn && !rise && !(move && move.lengthSq())) return false;
    const t = this.room();
    // Turn about the orrery's own upright axis (where it is in the room).
    if (turn) {
      const c = this.p.copy(this.centre()).applyMatrix4(t);
      const a = (-turn * DRIVE.turnDegPerS * Math.PI * dt) / 180;
      const r = this.h
        .makeTranslation(c.x, 0, c.z)
        .multiply(this.m.makeRotationY(a))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
      t.premultiply(r);
    }
    // Drive it across the room, relative to where the player faces; and up or down.
    if (move && move.lengthSq()) {
      const fwd = this.p.set(0, 0, -1).applyQuaternion(headQ).setY(0);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, UP);
      const d = fwd.multiplyScalar(move.y * DRIVE.speed * dt).addScaledVector(right, move.x * DRIVE.speed * dt);
      t.premultiply(this.m.makeTranslation(d.x, 0, d.z));
    }
    if (rise) t.premultiply(this.m.makeTranslation(0, rise * DRIVE.rise * dt, 0));
    this.setRoom(t);
    return true;
  }

  /** Where world point `p` is in the room (metres). */
  toRoom(p: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(p).applyMatrix4(this.room());
  }

  /**
   * Set it down on a surface: it floats down (or up) until world point `base`
   * is at room height `y`, easing in over about half a second; it's then on a table.
   */
  settle(base: THREE.Vector3, y: number) {
    this.landingTo = { base: base.clone(), y };
    this.placement = 'table';
  }
  private landingTo: { base: THREE.Vector3; y: number } | null = null;

  /** Per frame: ease a landing toward its surface. True while it moved. */
  private stepLanding(dt: number) {
    const l = this.landingTo;
    if (!l) return false;
    const t = this.room();
    const gap = l.y - this.p.copy(l.base).applyMatrix4(t).y;
    // Exponential ease (fast at first, settling softly), done within a millimetre.
    const step = Math.abs(gap) < 0.001 ? gap : gap * (1 - Math.exp(-dt * 7));
    if (step === gap) this.landingTo = null;
    this.setRoom(t.premultiply(this.m.makeTranslation(0, step, 0)));
    return true;
  }

  /**
   * The hands' frame in the room: where they hold, their (upright) turn, and for two hands their spread.
   * One hand's turn is how far it has twisted about the vertical since the grab (`q0inv`: its
   * rotation then, inverted). Not its yaw as an angle: that flips 180° as the hand passes
   * straight up, which swung the orrery over to the far side of a raised hand.
   */
  private handFrame(held: THREE.Object3D[], q0inv: THREE.Quaternion): THREE.Matrix4 {
    const out = new THREE.Matrix4();
    if (held.length === 1) {
      const g = held[0];
      // Twist about the vertical of the rotation since the grab (swing-twist split).
      const d = this.q.copy(g.quaternion).multiply(q0inv);
      const n = Math.hypot(d.y, d.w);
      if (n < 1e-6) d.identity();
      else d.set(0, d.y / n, 0, d.w / n);
      return out.compose(g.position, d, this.s.setScalar(1));
    }
    const [a, b] = held;
    const mid = this.p.copy(a.position).add(b.position).multiplyScalar(0.5);
    const yaw = Math.atan2(-(b.position.z - a.position.z), b.position.x - a.position.x);
    const spread = Math.max(0.02, a.position.distanceTo(b.position));
    return out.compose(mid, this.q.setFromAxisAngle(UP, yaw), this.s.setScalar(spread));
  }

  /** World → room (the rig's inverse). */
  private room(): THREE.Matrix4 {
    this.rig.updateMatrix();
    return this.rig.matrix.clone().invert();
  }

  /** Metres per unit of a room transform. */
  private scale(t: THREE.Matrix4) {
    return this.s.setFromMatrixScale(t).x;
  }

  /** Put the orrery where room transform `t` says: the rig becomes its inverse (upright, uniform scale). */
  private setRoom(t: THREE.Matrix4) {
    const r = this.m.copy(t).invert();
    r.decompose(this.rig.position, this.q, this.s);
    // Keep the rig upright (only its turn about the vertical), whatever rounding crept in.
    this.e.setFromQuaternion(this.q, 'YXZ');
    this.rig.rotation.set(0, this.e.y, 0);
    this.setScale(1 / this.s.x);
  }
}
