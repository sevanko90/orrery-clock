import * as THREE from 'three/webgpu';
import { abs, clamp, cos, float, fract, mix, mx_fractal_noise_float, pow, sin, smoothstep, uniform, uv, vec3 } from 'three/tsl';

/**
 * The VR arrival: about three seconds down a tunnel of brass and light,
 * opening out onto the scene.
 *
 * Real geometry, in metres around the player's head (it's parented to the
 * rig), so both eyes see true depth: a long tube with brass ribs every few
 * metres, two gold filaments spiralling along its walls and slow gas
 * between them. The pattern streams toward the player at a steady pace
 * (comfort: speed is eased in and out, never jerked, and the vignette is
 * on), the far end glows with the destination, and at the end the glow
 * floods the tube and fades, leaving the scene. Two draws.
 */

export const ARRIVAL_SECONDS = 3;

/** Tube radius and length (metres). */
const RADIUS = 2.2;
const LENGTH = 120;
/** How far behind the head the tube starts (metres). */
const BEHIND = 3;
/** Rib spacing (metres). */
const RIB = 3.5;
/** Cruising speed (metres a second). */
const CRUISE = 10;

export class Wormhole {
  /** The tunnel (tube and the glowing far end), placed at the head on start. */
  readonly mesh = new THREE.Group();
  private time = uniform(0);
  private travel = uniform(0);
  private fade = uniform(0);
  private flash = uniform(0);
  private t = -1;
  private travelled = 0;

  constructor() {
    const u = uv();
    // Distance ahead of the head along the tube (metres) and the pattern coordinate, streaming toward the player.
    const ahead = u.y.mul(LENGTH).sub(BEHIND);
    const s = ahead.add(this.travel);
    const around = u.x.mul(Math.PI * 2);

    // Brass ribs: thin bright bands, a softer shoulder either side.
    const ribPhase = abs(fract(s.div(RIB)).sub(0.5)).mul(2);
    const rib = pow(ribPhase, float(40)).add(pow(ribPhase, float(8)).mul(0.25));
    // Two gold filaments spiralling opposite ways.
    const line = (turns: number, pitch: number) => pow(float(1).sub(abs(fract(u.x.mul(turns).add(s.mul(pitch))).sub(0.5)).mul(2)), float(28));
    const filament = line(3, 0.045).add(line(-2, 0.03).mul(0.7));
    // Slow gas drifting along the walls.
    const gas = mx_fractal_noise_float(vec3(cos(around).mul(1.4), sin(around).mul(1.4), s.mul(0.12).sub(this.time.mul(0.25))), 3, 2, 0.5).mul(0.5).add(0.5);

    const bronze = vec3(0.14, 0.075, 0.03);
    const brass = vec3(0.95, 0.68, 0.3);
    const gold = vec3(1.0, 0.78, 0.38);
    const cream = vec3(1.0, 0.93, 0.78);
    let col = bronze.mul(gas.mul(0.9).add(0.2)).add(brass.mul(rib.mul(1.3))).add(gold.mul(filament.mul(1.1)));
    // The destination's glow fills the distance (and, at the end, the whole tube).
    const glowFrom = mix(float(30), float(-BEHIND), this.flash);
    const toward = smoothstep(glowFrom, float(LENGTH * 0.85), ahead);
    col = mix(col, cream.mul(1.1), clamp(toward.mul(0.85).add(this.flash.mul(0.6)), 0, 1));
    // Behind the head it dims away.
    col = col.mul(smoothstep(-BEHIND, 0.5, ahead).mul(0.8).add(0.2));

    const tubeMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide });
    tubeMat.colorNode = col;
    tubeMat.opacityNode = this.fade;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS, RADIUS, LENGTH, 64, 1, true), tubeMat);
    // Cylinder +y (uv.y = 1) points down −z, ahead of the player.
    tube.rotation.x = -Math.PI / 2;
    tube.position.z = -(LENGTH / 2 - BEHIND);
    tube.renderOrder = 29;

    // The far end: a disc of the destination's light.
    const endMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    endMat.colorNode = cream.mul(1.3);
    endMat.opacityNode = this.fade;
    const end = new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 48), endMat);
    end.position.z = -(LENGTH - BEHIND);
    end.renderOrder = 29;

    for (const m of [tube, end]) {
      m.frustumCulled = false;
      m.raycast = () => undefined;
      this.mesh.add(m);
    }
    this.mesh.name = 'arrival-tunnel';
    this.mesh.visible = false;
  }

  get active() {
    return this.t >= 0;
  }

  /** Start around `parent`-local point `at` (metres in the rig), the tunnel running along `yaw` (radians, about +Y). */
  start(parent: THREE.Object3D, at: THREE.Vector3, yaw: number) {
    parent.add(this.mesh);
    this.mesh.position.copy(at);
    this.mesh.rotation.set(0, yaw, 0);
    this.t = 0;
    this.travelled = 0;
    this.mesh.visible = true;
    this.apply();
  }

  /** Advance; returns the strength the comfort vignette should have (0 once done). */
  update(dt: number): number {
    if (this.t < 0) return 0;
    this.t += dt;
    if (this.t >= ARRIVAL_SECONDS) {
      this.stop();
      return 0;
    }
    this.apply(dt);
    // Vignette: on through the tunnel, easing off as it opens out.
    return 0.55 * (1 - smooth(2.2, ARRIVAL_SECONDS, this.t));
  }

  stop() {
    this.t = -1;
    this.mesh.visible = false;
    this.mesh.removeFromParent();
  }

  /** Show the tunnel frozen at time t (desktop preview). */
  preview(parent: THREE.Object3D, at: THREE.Vector3, yaw: number, t: number) {
    this.start(parent, at, yaw);
    this.t = t;
    this.travelled = t * CRUISE * 0.8;
    this.apply();
  }

  private apply(dt = 0) {
    const t = this.t;
    // Eases up to cruising pace, holds it, eases off as the tunnel opens onto the scene.
    const speed = CRUISE * (0.3 + 0.7 * smooth(0, 1.0, t)) * (1 - 0.7 * smooth(2.0, 2.8, t));
    this.travelled += speed * dt;
    this.travel.value = this.travelled;
    this.time.value = t;
    this.fade.value = smooth(0, 0.3, t) * (1 - smooth(2.5, ARRIVAL_SECONDS, t));
    this.flash.value = smooth(1.9, 2.5, t);
  }
}

function smooth(a: number, b: number, x: number) {
  const k = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
}
