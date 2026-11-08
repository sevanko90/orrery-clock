import * as THREE from 'three/webgpu';
import { distance, dot, floor, fract, fwidth, length, max, mix, normalize, positionLocal, positionWorld, pow, sin, smoothstep, step, uniform, vec3 } from 'three/tsl';

/** Star cells across the dome's radius: the finer, the more (and smaller) the stars. */
const DENSITY = 260;

/**
 * Tabletop: a window of night behind the orrery, its own small sky in the
 * player's room (the full sky sphere would blot the room out). A smoked
 * half-dome over the orrery, shown only where it's farther from the eyes
 * than the orrery's centre (nothing lies between the player and the
 * instrument from any side or height), strongest as the player leans in
 * and fading as they step back.
 *
 * Its stars are drawn in the dome's own shader, not as points: each pixel
 * finds the one star in its cell of a fine grid over the dome and draws it
 * at the pixel's own size (so they stay pin-sharp and tiny at any
 * distance), most faint, a few bright, warm to blue-white. Point stars at
 * a usable size looked chunky beside the orrery's fine work.
 */
export class StarDome {
  /** The smoked half-dome, with its stars. */
  readonly backdrop: THREE.Mesh;
  /** 0..1, eased in when shown. */
  private fade = uniform(0);
  /** The eyes and the dome's centre (world), its radius (world units), and the eyes' distance from the centre. */
  private eye = uniform(new THREE.Vector3());
  private centre = uniform(new THREE.Vector3());
  private radius = uniform(1);
  private eyeToCentre = uniform(1);
  private wanted = 0;

  constructor() {
    // Shown only where farther from the eyes than the centre (fading in over a third of the radius).
    // And strongest close up: leaning in to the orrery, the night closes round it (full within ~1
    // radius, ~65 cm at the usual scale); stepping back it fades away (gone by ~2.2 radii, ~1.5 m),
    // so a half sky doesn't trail round the room after the instrument.
    const near = smoothstep(this.radius.mul(2.2), this.radius.mul(1), this.eyeToCentre);
    const far = smoothstep(this.eyeToCentre.add(this.radius.mul(0.05)), this.eyeToCentre.add(this.radius.mul(0.4)), distance(positionWorld, this.eye)).mul(near);

    // The star in this pixel's grid cell: where in the cell, whether there is one, how bright, what colour.
    const p = positionLocal.mul(DENSITY);
    const cell = floor(p);
    // (A sine hash: TSL's hash() takes its seed as an unsigned integer, so every cell with a
    // negative seed, half the dome, got the same answer.)
    const seed = dot(cell, vec3(127.1, 311.7, 74.7));
    const rnd = (k: number) => fract(sin(seed.add(k)).mul(43758.5453));
    const at = vec3(rnd(0), rnd(17.3), rnd(41.9));
    // About one cell in ten has a star; most faint, a very few bright.
    const there = step(0.9, rnd(73.1));
    const bright = pow(rnd(91.7), 9).mul(2.4).add(0.1);
    // A star a pixel or so across, whatever the distance (its falloff measured in this pixel's size).
    const pixel = max(length(fwidth(p)), 0.0001);
    // The star sits on the dome's surface (a random point in a 3D cell is mostly off it).
    const onDome = normalize(cell.add(at)).mul(DENSITY);
    const star = smoothstep(pixel.mul(1.1), pixel.mul(0.2), length(p.sub(onDome))).mul(there).mul(bright);
    const tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.72, 0.84, 1.0), rnd(29.3));

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide });
    const dark = vec3(0.01, 0.012, 0.03);
    const s = star.clamp(0, 1);
    mat.colorNode = mix(dark, tint, s);
    mat.opacityNode = max(far.mul(0.55), s.mul(far)).mul(this.fade);
    this.backdrop = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    this.backdrop.name = 'star-dome';
    // Before anything else see-through.
    this.backdrop.renderOrder = -1;
    this.backdrop.visible = false;
  }

  /** Show or hide (fading over ~1 s). */
  set shown(on: boolean) {
    this.wanted = on ? 1 : 0;
  }

  /** Per frame: over world point `centre`, `radius` world units across, seen from `eye`; easing the fade. */
  update(dt: number, centre: THREE.Vector3, radius: number, eye?: THREE.Vector3) {
    const f = this.fade.value + THREE.MathUtils.clamp(this.wanted - this.fade.value, -dt, dt);
    this.fade.value = f;
    this.backdrop.visible = f > 0.001;
    if (!this.backdrop.visible) return;
    if (eye) this.eye.value.copy(eye);
    this.centre.value.copy(centre);
    this.radius.value = radius;
    this.eyeToCentre.value = this.eye.value.distanceTo(centre);
    this.backdrop.position.copy(centre);
    this.backdrop.scale.setScalar(radius);
    this.backdrop.updateMatrixWorld();
  }
}
