import * as THREE from 'three/webgpu';
import { abs, atan, clamp, dot, float, floor, fract, length, mix, mod, mx_noise_float, normalize, normalView, positionView, pow, smoothstep, step, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Surface } from './vrScene';

/**
 * The lift between A'Tuin's shell and the Disc's top (VR only): a column of
 * rising light standing on the shell, passing through the Disc by a brass
 * iris hatch in its underside and another in the deck. Walk into the light
 * and it carries you up (or, from the deck, down). The hatches open as you
 * come near; their open mouths are filled with the beam's light, so the
 * player rises through light rather than through the Disc's wood.
 *
 * Three draws: the column and the two irises (each iris is one procedural
 * disc: brass rim, eight blades and the light, all in its shader).
 */

/** Column radius (world units); walking within it starts a ride. */
export const LIFT_RADIUS = 1.0;
/** How near (world units, horizontally) a hatch starts opening for someone walking up to it. */
const OPEN_NEAR = 3.2;

const IRIS_RADIUS = LIFT_RADIUS * 1.25;
const GLOW = new THREE.Color(1.0, 0.86, 0.6);

export class Lift {
  readonly group = new THREE.Group();
  /** Where the column stands (world x, z). */
  readonly at: THREE.Vector2;
  private top: Iris;
  private bottom: Iris;
  private columnStrength = uniform(0.5);
  private time = uniform(0);
  /** After a ride, the player must step out of the light before it takes them again. */
  private armed = true;

  /**
   * @param at the column's position (world x, z)
   * @param shellY top of the shell under it, where the column starts
   * @param undersideY the Disc's underside, @param deckY its top
   */
  constructor(
    at: THREE.Vector2,
    readonly shellY: number,
    undersideY: number,
    readonly deckY: number,
  ) {
    this.at = at.clone();
    this.group.name = 'lift';
    this.group.position.set(at.x, 0, at.y);

    // The column: a soft open cylinder of light from the shell to a little above the deck.
    const height = deckY + 4 - shellY;
    const geo = new THREE.CylinderGeometry(LIFT_RADIUS, LIFT_RADIUS, height, 40, 1, true);
    const u = uv();
    const angle = u.x.mul(Math.PI * 2);
    const along = u.y.mul(height);
    // Rising motes and streaks.
    const rise = along.sub(this.time.mul(2.2));
    const streak = smoothstep(0.62, 0.95, mx_noise_float(vec3(angle.cos().mul(3), angle.sin().mul(3), rise.mul(0.35))).mul(0.5).add(0.5));
    // Brightest face-on, soft at the silhouette, so the cylinder reads as a volume of light.
    const facing = pow(abs(dot(normalize(normalView), normalize(positionView.negate()))), float(1.6));
    // Fade at the foot (into the shell) and out at the top.
    const ends = smoothstep(0, 0.6, along).mul(float(1).sub(smoothstep(height - 3.5, height, along)));
    const glow = vec3(GLOW.r, GLOW.g, GLOW.b);
    const colMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    colMat.colorNode = glow.mul(facing.mul(0.35).add(streak.mul(0.9))).mul(ends).mul(this.columnStrength);
    const column = new THREE.Mesh(geo, colMat);
    column.position.y = shellY + height / 2;
    column.name = 'lift-column';
    column.raycast = () => undefined;
    this.group.add(column);

    // The hatches: in the deck (facing up) and in the underside (facing down).
    this.top = new Iris();
    this.top.mesh.rotation.x = -Math.PI / 2;
    this.top.mesh.position.y = deckY;
    this.bottom = new Iris();
    this.bottom.mesh.rotation.x = Math.PI / 2;
    this.bottom.mesh.position.y = undersideY;
    this.group.add(this.top.mesh, this.bottom.mesh);
    this.group.visible = false;
  }

  /** Feet height a ride from `surface` ends at: the deck going up, the shell going down. */
  destination(surface: Surface) {
    return surface === 'shell' ? this.deckY : this.shellY;
  }

  /**
   * Per frame. `head` is the player's head (world), `surface` what they
   * stand on (null while flying or carried), `riding` whether a lift ride
   * is under way. Returns true when the player has just walked into the
   * light and a ride should start.
   */
  update(dt: number, head: THREE.Vector3, surface: Surface | null, riding: boolean): boolean {
    this.time.value += dt;
    const d = Math.hypot(head.x - this.at.x, head.z - this.at.y);
    const inside = d < LIFT_RADIUS * 0.9;
    // Hatches open for someone walking up to them, and for the whole ride.
    this.top.target = riding || (surface === 'disc' && d < OPEN_NEAR) ? 1 : 0;
    this.bottom.target = riding || (surface === 'shell' && d < OPEN_NEAR + 1) ? 1 : 0;
    this.top.step(dt);
    this.bottom.step(dt);
    this.columnStrength.value += ((riding ? 1.4 : inside ? 1 : 0.55) - this.columnStrength.value) * Math.min(1, dt * 3);
    if (!inside) this.armed = true;
    if (riding || !surface || !inside || !this.armed) return false;
    // From the deck, only once its hatch is (nearly) open.
    if (surface === 'disc' && this.top.open < 0.8) return false;
    this.armed = false;
    return true;
  }

  /** Desktop preview: both hatches held open by `open` (0..1). */
  preview(open: number) {
    for (const iris of [this.top, this.bottom]) {
      iris.open = iris.target = open;
      iris.step(0);
    }
  }
}

/** A brass iris on a disc: rim, eight curved blades, and the beam's light in the opening. */
class Iris {
  readonly mesh: THREE.Mesh;
  /** 0 shut, 1 open (animated toward `target`). */
  open = 0;
  target = 0;
  private openU = uniform(0);

  constructor() {
    const p = uv().sub(vec2(0.5)).mul(2);
    const r = length(p);
    const theta = atan(p.y, p.x).div(Math.PI * 2).add(0.5);
    const blades = 8;
    // Aperture radius (of the iris, 0..1) and the blade pattern: each blade's
    // edge sweeps out from the opening in a curve.
    const aperture = this.openU.mul(0.84);
    const sweep = theta.mul(blades).add(r.sub(aperture).mul(1.7));
    const edge = float(1).sub(smoothstep(0, 0.05, fract(sweep)));
    const blade = mod(floor(sweep), 2);
    const inRim = smoothstep(0.86, 0.875, r);
    const inHole = float(1).sub(step(aperture, r));
    const brass = vec3(0.8, 0.58, 0.27);
    const bladeCol = mix(vec3(0.52, 0.36, 0.15), vec3(0.62, 0.44, 0.19), blade).mul(float(1).sub(edge.mul(0.75)));
    // A thin dark seam where the blades meet the rim.
    const seam = smoothstep(0.84, 0.86, r).mul(float(1).sub(inRim));
    const metal = mix(bladeCol, brass, inRim).mul(float(1).sub(seam.mul(0.8)));
    const mat = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.colorNode = mix(metal, vec3(0), inHole);
    mat.metalnessNode = float(1).sub(inHole);
    mat.roughnessNode = mix(float(0.42), float(0.3), inRim);
    // The opening shows the beam: brightest at the centre.
    mat.emissiveNode = vec3(GLOW.r, GLOW.g, GLOW.b).mul(inHole.mul(clamp(float(1.6).sub(r.mul(0.8)), 0, 2)));
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(IRIS_RADIUS, 48), mat);
    this.mesh.name = 'lift-hatch';
    this.mesh.raycast = () => undefined;
  }

  step(dt: number) {
    const k = Math.min(1, dt * 1.6);
    this.open += THREE.MathUtils.clamp(this.target - this.open, -k, k);
    // Ease the blades: quick to start, settling at the ends.
    this.openU.value = this.open * this.open * (3 - 2 * this.open);
  }
}
