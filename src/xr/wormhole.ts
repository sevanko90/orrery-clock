import * as THREE from 'three/webgpu';
import { atan, clamp, cos, float, max, mix, mx_fractal_noise_float, mx_noise_float, normalize, positionLocal, pow, sin, smoothstep, uniform, vec3 } from 'three/tsl';

/**
 * The VR arrival: about three seconds inside a streaming tunnel of brass and
 * gold light and slow gas, opening out onto the scene.
 *
 * It's an inside-out sphere around the player's head, fixed in the world (so
 * looking around is free and nothing is locked to the head), drawn over the
 * scene. Its shader treats every view direction as a ray down an endless
 * cylinder along the arrival heading: depth along the tunnel is cot θ from
 * the axis, so streaks of light and wisps of gas, moving along that depth,
 * stream past on all sides while the player stands still. Far ahead a warm
 * glow gathers; at the end the tunnel brightens into it and fades away,
 * leaving the scene.
 */
export const ARRIVAL_SECONDS = 3;

export class Wormhole {
  readonly mesh: THREE.Mesh;
  private time = uniform(0);
  private travel = uniform(0);
  private fade = uniform(0);
  private flash = uniform(0);
  private t = -1;
  private travelled = 0;

  constructor() {
    const dir = normalize(positionLocal);
    // Tunnel axis: local −z (the way the player faces on arrival).
    const along = dir.z.negate();
    const across = max(float(1).sub(along.mul(along)).sqrt(), 0.04);
    const depth = along.div(across); // cot θ: distance down a unit cylinder
    const phi = atan(dir.y, dir.x);
    const ring = vec3(cos(phi), sin(phi), 0);
    const z = depth.add(this.travel);

    // Long streaks of light: thin in angle, stretched along the tunnel.
    const streak = mx_noise_float(vec3(ring.x.mul(9), ring.y.mul(9), z.mul(0.12))).mul(0.5).add(0.5);
    const streaks = pow(smoothstep(0.55, 0.95, streak), float(3));
    // Slow gas: soft billows drifting with the flow.
    const gas = mx_fractal_noise_float(vec3(ring.x.mul(2.2), ring.y.mul(2.2), z.mul(0.35).sub(this.time.mul(0.2))), 3, 2, 0.5).mul(0.5).add(0.5);
    // The destination: a glow gathering dead ahead.
    const core = pow(clamp(along, 0, 1), float(10));
    // Behind the player the tunnel dims away.
    const behind = smoothstep(-0.9, 0.2, along);

    const bronze = vec3(0.3, 0.16, 0.05);
    const gold = vec3(1.0, 0.72, 0.32);
    const cream = vec3(1.0, 0.93, 0.78);
    // (Fading the pattern into the glow where the tunnel's depth runs to infinity.)
    const glow = gas.mul(0.55).add(streaks.mul(1.6)).mul(behind.mul(0.7).add(0.3)).mul(float(1).sub(core));
    let col = mix(bronze, gold, clamp(glow, 0, 1));
    col = mix(col, cream, clamp(streaks.mul(0.8).add(core), 0, 1));
    col = col.mul(glow.add(0.25)).add(cream.mul(core.mul(1.5)));
    col = mix(col, cream.mul(1.4), this.flash);

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide });
    mat.colorNode = col;
    mat.opacityNode = this.fade;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(2.5, 48, 32), mat);
    this.mesh.renderOrder = 29;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.raycast = () => undefined;
  }

  get active() {
    return this.t >= 0;
  }

  /** Start around `parent`-local point `at`, the tunnel running along `yaw` (radians, about +Y). */
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
      this.t = -1;
      this.mesh.visible = false;
      this.mesh.removeFromParent();
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
    this.travelled = t * 6;
    this.apply();
  }

  private apply(dt = 0) {
    const t = this.t;
    // Speed builds, then eases off as the tunnel opens onto the scene.
    const speed = 4 + 10 * smooth(0, 1.6, t) - 8 * smooth(2.0, 2.8, t);
    this.travelled += speed * dt;
    this.travel.value = this.travelled;
    this.time.value = t;
    this.fade.value = smooth(0, 0.35, t) * (1 - smooth(2.45, ARRIVAL_SECONDS, t));
    this.flash.value = smooth(2.0, 2.5, t) * (1 - smooth(2.5, ARRIVAL_SECONDS, t)) * 0.85;
  }
}

function smooth(a: number, b: number, x: number) {
  const k = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
}
