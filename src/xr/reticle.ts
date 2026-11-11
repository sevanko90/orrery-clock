import * as THREE from 'three/webgpu';
import { fract, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';

/** Seconds: blinking, then turning in, then fading. */
const BLINK = 1.2,
  TURN = 0.8,
  FADE = 0.6;
/** Half the reticle's size as seen (radians): ~7° across, readable however tiny the target. */
const ANGLE = THREE.MathUtils.degToRad(3.5);

/**
 * Tabletop: a holographic target reticle over something chosen (at tabletop
 * size a fiction site like Utopia Planitia is a speck, and leaning in close
 * would break the model's illusion). Four arrowheads at the compass points,
 * pointing in: they blink, then turn a quarter while closing in, then fade.
 * A fixed size as seen, facing the eyes, drawn over everything, following
 * the target as it moves.
 */
export class Reticle {
  readonly group = new THREE.Group();
  private ring = new THREE.Group();
  private opacity = uniform(0);
  private t = -1;
  private target: (() => THREE.Vector3 | null) | null = null;

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    // Hologram blue, with faint scanlines.
    const scan = smoothstep(0.2, 0.5, fract(positionLocal.y.mul(18)))
      .mul(0.35)
      .add(0.65);
    mat.colorNode = vec3(0.5, 0.92, 1.0).mul(scan);
    mat.opacityNode = this.opacity;
    // An arrowhead: a chevron pointing toward the centre (−y), its tip at the origin.
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0.32, 0.38);
    s.lineTo(0.16, 0.38);
    s.lineTo(0, 0.2);
    s.lineTo(-0.16, 0.38);
    s.lineTo(-0.32, 0.38);
    s.closePath();
    const geo = new THREE.ShapeGeometry(s);
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Group();
      arm.rotation.z = (i * Math.PI) / 2;
      const head = new THREE.Mesh(geo, mat);
      head.position.y = 0.55;
      head.renderOrder = 28;
      arm.add(head);
      this.ring.add(arm);
    }
    this.group.add(this.ring);
    this.group.visible = false;
    this.group.name = 'reticle';
  }

  /** Mark whatever `target` gives the world position of (null when it's gone). */
  show(target: () => THREE.Vector3 | null) {
    this.target = target;
    this.t = 0;
  }

  hide() {
    this.t = -1;
    this.group.visible = false;
  }

  /** Per frame: follow the target, face the eyes at `eye` (world), and play. */
  update(dt: number, eye: THREE.Vector3, eyeQ: THREE.Quaternion) {
    if (this.t < 0) return;
    const at = this.target?.();
    this.t += dt;
    const t = this.t;
    if (!at || t > BLINK + TURN + FADE) return this.hide();
    this.group.visible = true;
    this.group.position.copy(at);
    this.group.quaternion.copy(eyeQ);
    let r = 1,
      o = 1;
    if (t < BLINK) {
      // Three blinks a second.
      o = Math.sin(t * Math.PI * 6) > -0.2 ? 1 : 0.15;
      this.ring.rotation.z = 0;
    } else {
      const k = Math.min(1, (t - BLINK) / TURN);
      const e = k * k * (3 - 2 * k);
      this.ring.rotation.z = (e * Math.PI) / 2;
      r = 1 - 0.3 * e;
      if (t > BLINK + TURN) o = 1 - (t - BLINK - TURN) / FADE;
    }
    this.opacity.value = 0.9 * o;
    this.group.scale.setScalar(at.distanceTo(eye) * Math.tan(ANGLE) * r);
  }
}
