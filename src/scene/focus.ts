import * as THREE from 'three/webgpu';
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
    /** Fixed look-at point (a framed view), instead of home or a body. */
    goal?: THREE.Vector3;
  } | null = null;
  private lastBodyPos = new THREE.Vector3();
  private homeTarget = HOME_TARGET.clone();
  private homeCamera = HOME_CAMERA.clone();

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

  /** Change the resting view that goHome() flies back to. */
  setHome(target: THREE.Vector3, camera: THREE.Vector3) {
    this.homeTarget.copy(target);
    this.homeCamera.copy(camera);
  }

  goHome(duration = 1.6) {
    const offset = this.homeCamera.clone().sub(this.homeTarget);
    if (innerWidth < innerHeight) offset.multiplyScalar(1.5);
    this.flight = {
      t: 0,
      duration,
      fromTarget: this.controls.target.clone(),
      fromCam: this.camera.position.clone(),
      offset,
      home: true,
    };
    this.focused = null;
  }

  /** Fly to a fixed view that fits all the given points, from roughly the current angle. */
  frame(points: THREE.Vector3[], duration = 2) {
    const center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
    const radius = Math.max(1, ...points.map((p) => p.distanceTo(center)));
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    dir.y = Math.max(dir.y, 0.7);
    dir.normalize();
    this.flight = {
      t: 0,
      duration,
      fromTarget: this.controls.target.clone(),
      fromCam: this.camera.position.clone(),
      offset: dir.multiplyScalar(dist),
      home: false,
      goal: center,
    };
    this.focused = null;
  }

  /** Where the current flight ends: camera position and look-at point (null if not flying). */
  destination(): { camera: THREE.Vector3; target: THREE.Vector3 } | null {
    const f = this.flight;
    if (!f) return null;
    const goal = (f.goal ?? (f.home ? this.homeTarget : this.focused?.group.getWorldPosition(new THREE.Vector3()))) ?? null;
    if (!goal) return null;
    return { camera: goal.clone().add(f.offset), target: goal.clone() };
  }

  update(dt: number) {
    const body = this.focused;
    const bodyPos = body ? body.group.getWorldPosition(new THREE.Vector3()) : null;

    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = ease(f.t);
      const goal = f.goal ?? (f.home ? this.homeTarget : bodyPos!);
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
