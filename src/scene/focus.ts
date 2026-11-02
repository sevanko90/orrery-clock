import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HOME_CAMERA, HOME_TARGET } from './stage';
import type { Body } from './bodies';

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Flies the camera to a body, then keeps it in frame as it moves. */
export class FocusController {
  focused: Body | null = null;
  private flight: {
    t: number;
    duration: number;
    fromTarget: THREE.Vector3;
    fromCam: THREE.Vector3;
    offset: THREE.Vector3;
    home: boolean;
  } | null = null;
  private lastBodyPos = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
  ) {}

  get flying() {
    return this.flight !== null;
  }

  focus(body: Body) {
    const pos = body.group.getWorldPosition(new THREE.Vector3());
    // Approach from the current viewing direction, slightly above the plane.
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    dir.y = Math.max(dir.y, 0.55);
    dir.normalize();
    const dist = Math.max(1.4, body.radius * 5.5 + 0.8);
    this.flight = {
      t: 0,
      duration: 1.6,
      fromTarget: this.controls.target.clone(),
      fromCam: this.camera.position.clone(),
      offset: dir.multiplyScalar(dist),
      home: false,
    };
    this.focused = body;
    this.lastBodyPos.copy(pos);
    body.upgrade();
  }

  goHome() {
    const offset = HOME_CAMERA.clone().sub(HOME_TARGET);
    if (innerWidth < innerHeight) offset.multiplyScalar(1.5);
    this.flight = {
      t: 0,
      duration: 1.6,
      fromTarget: this.controls.target.clone(),
      fromCam: this.camera.position.clone(),
      offset,
      home: true,
    };
    this.focused = null;
  }

  update(dt: number) {
    const body = this.focused;
    const bodyPos = body ? body.group.getWorldPosition(new THREE.Vector3()) : null;

    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = ease(f.t);
      const goal = f.home ? HOME_TARGET : bodyPos!;
      this.controls.target.lerpVectors(f.fromTarget, goal, k);
      const camGoal = goal.clone().add(f.offset);
      this.camera.position.lerpVectors(f.fromCam, camGoal, k);
      if (f.t >= 1) this.flight = null;
    } else if (body && bodyPos) {
      // Follow: translate camera and target with the body.
      const delta = bodyPos.clone().sub(this.lastBodyPos);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    if (bodyPos) this.lastBodyPos.copy(bodyPos);
  }
}
