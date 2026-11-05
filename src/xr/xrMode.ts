import * as THREE from 'three/webgpu';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XR, speedScale } from './config';
import { XrInput } from './input';
import { buildHangar } from './hangar';
import { Label, TextPlate } from './text';
import type { Body } from '../scene/bodies';
import { POINT_UNIFORMS } from '../scene/pointSize';
import { float, length, smoothstep, uniform, uv } from 'three/tsl';

/** What the pointer ray is on. */
export interface XrHit {
  point: THREE.Vector3;
  distance: number;
  label: string;
  note?: string;
  /** Set when the hit stands for a selectable body. */
  body?: Body;
}

/** What VR needs from the rest of the app. */
export interface XrHooks {
  pick(ray: THREE.Raycaster): XrHit | null;
  faster(): void;
  slower(): void;
  now(): void;
  /** Called each frame in VR with the head's world position (to skip drawing what it can't see); null on leaving VR. */
  view?(head: THREE.Vector3 | null): void;
  /** Lines for the wrist readout: the date shown and the speed. */
  status(): string[];
  /** Bloom on or off in VR (left stick click), for comparing look against frame rate. */
  toggleBloom(): boolean;
  /** Which GPU backend is drawing, for the readout. */
  backend(): string;
  /** Camera shake the scenes want (0..1); in VR it becomes controller rumble. */
  quake(): number;
}

export interface XrLayout {
  /** World box of the instrument (cabinet and arms). */
  orrery: THREE.Box3;
  tableRadius: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Immersive VR: the player stands in a hall with the orrery hovering at its
 * centre. The player's rig is scaled by 1 / metresPerUnit (see config.ts),
 * so the world itself is untouched.
 */
export class XrMode {
  readonly rig = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  private input: XrInput;
  private hangar: THREE.Group;
  private floorY: number;
  private half: number;
  private roofY: number;
  private start: THREE.Vector3;
  metresPerUnit: number = XR.metresPerUnit;
  /** Player velocity, m/s, world-aligned. */
  private velocity = new THREE.Vector3();
  private grounded = true;

  private raycaster = new THREE.Raycaster();
  private rayLine: THREE.Line;
  private rayDot: THREE.Sprite;
  private hoverLabel = new Label();
  private pinLabel = new Label();
  private halo: THREE.Sprite;
  private selected: Body | null = null;

  private vignette: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
  private vignetteStrength = uniform(0);
  private wrist: THREE.Mesh;
  private wristPlate = new TextPlate(512, 300);
  private wristShown = true;
  /** Seconds since the readout was last redrawn (starts due). */
  private wristAt = Infinity;
  /** Floats in front of the eyes while the world scale is being changed. */
  private scaleTag: THREE.Mesh;
  private scalePlate = new TextPlate(512, 160);
  private fps = 0;
  private frames = 0;
  private fpsAt = 0;
  private cpuMs = 0;
  private bloomOn = false;
  /** Desktop pixels per unit of tan(angle), which the particle sizes were tuned for. */
  private desktopPx = 1000;

  constructor(
    private renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    layout: XrLayout,
    private hooks: XrHooks,
  ) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');

    // The hall, sized from the instrument.
    this.floorY = layout.orrery.min.y - XR.hoverGap;
    this.half = layout.tableRadius + XR.hangarMargin;
    this.roofY = layout.orrery.max.y + XR.roofClearance;
    this.hangar = buildHangar({ floorY: this.floorY, half: this.half, roofY: this.roofY, tableRadius: layout.tableRadius });
    scene.add(this.hangar);
    // Start just beyond the table's edge, facing the instrument.
    this.start = new THREE.Vector3(0, this.floorY, layout.tableRadius + 4);

    this.rig.name = 'xr-rig';
    this.rig.add(this.camera);
    this.rig.visible = false;
    scene.add(this.rig);
    this.input = new XrInput(renderer, this.rig);

    const models = new XRControllerModelFactory();
    for (const s of this.input.all) s.grip.add(models.createControllerModel(s.grip));

    // The pointer: a thin gold line and a bead where it lands, on whichever controller is the right hand.
    this.rayLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.7 }),
    );
    this.rayDot = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffe2a8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffc070, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.halo.visible = false;
    scene.add(this.rayDot, this.halo, this.hoverLabel.sprite, this.pinLabel.sprite);

    // Comfort vignette: a dark ring just in front of the eyes, closing in with speed.
    const vigMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const k = this.vignetteStrength;
    const r = length(uv().sub(0.5)).mul(2);
    vigMat.colorNode = float(0);
    vigMat.opacityNode = smoothstep(k.mul(-0.3).add(0.55), k.mul(-0.25).add(0.95), r).mul(k);
    this.vignette = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), vigMat);
    this.vignette.position.z = -0.25;
    this.vignette.renderOrder = 30;
    this.vignette.visible = false;
    this.camera.add(this.vignette);

    // Wrist readout, worn on the left controller.
    this.wrist = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.094),
      new THREE.MeshBasicMaterial({ map: this.wristPlate.texture, transparent: true, depthWrite: false }),
    );
    this.wrist.position.set(0, 0.07, 0.03);
    this.wrist.rotation.x = -Math.PI / 4;
    this.wrist.renderOrder = 25;

    this.scaleTag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.32, 0.1),
      new THREE.MeshBasicMaterial({ map: this.scalePlate.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.scaleTag.position.set(0, -0.12, -0.8);
    this.scaleTag.renderOrder = 31;
    this.scaleTag.visible = false;
    this.camera.add(this.scaleTag);

    renderer.xr.addEventListener('sessionstart', () => this.begin());
    renderer.xr.addEventListener('sessionend', () => this.end());
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  /** Ask for an immersive session (from a click). */
  async enter() {
    const xr = navigator.xr;
    if (!xr) return;
    this.renderer.xr.setFramebufferScaleFactor(this.resolutionScale);
    const session = await xr.requestSession('immersive-vr', {
      // 'layers' lets the renderer draw both eyes in one pass (multiview).
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    await this.renderer.xr.setSession(session);
  }

  /** Eye-buffer resolution relative to the headset's default (?xrscale=0.7 for a test); set before a session starts. */
  private readonly resolutionScale = (() => {
    const v = Number(new URLSearchParams(location.search).get('xrscale'));
    return v > 0.2 && v <= 1.5 ? v : 1;
  })();

  private begin() {
    // The desktop view the particle sizes were tuned against (40° field of view).
    this.desktopPx = this.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
    this.renderer.xr.setFoveation(1);
    this.hangar.visible = this.rig.visible = true;
    this.resetPosition();
  }

  private end() {
    this.hooks.view?.(null);
    POINT_UNIFORMS.uPointView.value = 1;
    POINT_UNIFORMS.uPointMax.value = 4096;
    this.hangar.visible = this.rig.visible = false;
    this.rayDot.visible = this.halo.visible = false;
    this.hoverLabel.sprite.visible = this.pinLabel.sprite.visible = false;
    this.selected = null;
  }

  private resetPosition() {
    this.rig.position.copy(this.start);
    this.rig.rotation.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.applyScale();
  }

  private applyScale() {
    this.rig.scale.setScalar(1 / this.metresPerUnit);
    // Far enough to reach the star sphere (900 units) whatever the scale.
    this.camera.far = 1200 * this.metresPerUnit;
    this.camera.updateProjectionMatrix();
  }

  /** The head's world position (from the last pose). */
  private head(out = new THREE.Vector3()) {
    this.rig.updateMatrixWorld();
    return this.rig.localToWorld(out.copy(this.camera.position));
  }

  /** Move the rig so the head's horizontal position is back at `was` (after turning or scaling). */
  private keepHead(was: THREE.Vector3, vertical = false) {
    const now = this.head();
    this.rig.position.x += was.x - now.x;
    this.rig.position.z += was.z - now.z;
    if (vertical) this.rig.position.y += was.y - now.y;
  }

  /** Per frame, before rendering, while presenting. `cpuMs` is the last frame's simulation time. */
  update(dt: number, cpuMs: number) {
    this.input.update();
    const a = this.input.actions;
    const M = this.metresPerUnit;
    const s = speedScale(M);

    if (a.reset) this.resetPosition();
    if (a.toggleHud) this.wristShown = !this.wristShown;
    if (a.toggleBloom) this.bloomOn = this.hooks.toggleBloom();
    if (a.faster) this.hooks.faster();
    if (a.slower) this.hooks.slower();
    if (a.now) this.hooks.now();

    // World scale, live: grows or shrinks everything around the player's head.
    if (a.scaling && a.scale !== 0) {
      const was = this.head();
      this.metresPerUnit = THREE.MathUtils.clamp(M * Math.exp(a.scale * dt * 1.2), XR.minMetresPerUnit, XR.maxMetresPerUnit);
      this.applyScale();
      this.keepHead(was, !this.grounded);
    }
    this.scaleTag.visible = a.scaling;
    if (a.scaling) this.scalePlate.set('World scale', [`${this.scaleText()} · stick up / down`]);

    if (a.snapTurn) {
      const was = this.head();
      this.rig.rotateY((-a.snapTurn * XR.snapTurnDeg * Math.PI) / 180);
      this.keepHead(was);
    }

    // Head-relative directions on the horizontal.
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP);
    const v = this.velocity;
    const wish = fwd.multiplyScalar(a.move.y).addScaledVector(right, a.move.x);

    if (this.grounded) {
      wish.multiplyScalar(XR.walkSpeed);
      v.set(wish.x, 0, wish.z);
    } else {
      wish.multiplyScalar(XR.flySpeed * s);
      const k = Math.min(1, dt * 3);
      v.x += (wish.x - v.x) * k;
      v.z += (wish.z - v.z) * k;
    }
    // Jetpack: thrust along wherever the left controller points.
    if (a.thrust > 0.05) v.addScaledVector(a.thrustDir, a.thrust * XR.thrust * s * dt);
    if (a.lift !== 0) v.y += (a.lift * XR.liftSpeed * s - v.y) * Math.min(1, dt * 4);
    if (!this.grounded) {
      // With nothing pressed it settles into a hover.
      const drag = Math.exp(-XR.drag * dt);
      if (a.lift === 0) v.y *= drag;
      if (a.move.lengthSq() === 0) {
        v.x *= drag;
        v.z *= drag;
      }
    }
    const cap = XR.flySpeed * s * 1.5;
    if (v.length() > cap) v.setLength(cap);
    if (v.y > 0.05) this.grounded = false;

    this.rig.position.addScaledVector(v, dt / M);

    // Floor, roof and walls.
    if (this.rig.position.y <= this.floorY) {
      this.rig.position.y = this.floorY;
      if (v.y <= 0) {
        v.y = 0;
        this.grounded = true;
      }
    }
    const head = this.head();
    const eyeRoom = 0.3 / M;
    if (head.y > this.roofY - eyeRoom) {
      this.rig.position.y -= head.y - (this.roofY - eyeRoom);
      v.y = Math.min(0, v.y);
    }
    const lim = this.half - 0.5 / M;
    if (Math.abs(head.x) > lim) this.rig.position.x -= head.x - Math.sign(head.x) * lim;
    if (Math.abs(head.z) > lim) this.rig.position.z -= head.z - Math.sign(head.z) * lim;

    // Comfort vignette.
    const speed = v.length();
    const vig = THREE.MathUtils.clamp((speed - XR.vignetteFrom) / (XR.vignetteFull - XR.vignetteFrom), 0, 1) * XR.vignetteMax;
    const u = this.vignetteStrength;
    u.value += (vig - u.value) * Math.min(1, dt * 6);
    this.vignette.visible = u.value > 0.01;

    this.updatePointSizes();
    this.hooks.view?.(this.head());
    this.updatePointer(a.select);
    this.updateWrist(dt, cpuMs);

    const quake = this.hooks.quake();
    if (quake > 0.05) this.input.rumble(Math.min(1, quake * quake), 60);
  }

  /**
   * Particles are sized as world size over view distance. In VR, view space
   * is in metres (the rig is scaled) and the eye buffers differ from the
   * desktop canvas, so rescale to match, and cap them so a cloud the player
   * stands inside can't swamp the GPU with screen-sized sprites.
   */
  private updatePointSizes() {
    const eye = this.renderer.xr.getCamera().cameras[0];
    const px = eye?.viewport ? (eye.viewport.w * eye.projectionMatrix.elements[5]) / 2 : 900;
    POINT_UNIFORMS.uPointView.value = (this.metresPerUnit * px) / this.desktopPx;
    POINT_UNIFORMS.uPointMax.value = XR.maxPointPx;
  }

  private updatePointer(select: boolean) {
    const hand = this.input.hand('right');
    if (this.rayLine.parent !== (hand?.ray ?? null)) {
      this.rayLine.removeFromParent();
      hand?.ray.add(this.rayLine);
    }
    const eye = this.head();
    let hit: XrHit | null = null;
    if (hand) {
      this.raycaster.setFromXRController(hand.ray);
      this.raycaster.camera = this.camera;
      hit = this.hooks.pick(this.raycaster);
    }
    // The ray lives in the controller's space, which is in metres.
    const len = hit ? hit.distance * this.metresPerUnit : XR.rayLength;
    this.rayLine.scale.set(1, 1, len);
    this.rayDot.visible = !!hit;
    if (hit) {
      this.rayDot.position.copy(hit.point);
      this.rayDot.scale.setScalar(hit.point.distanceTo(eye) * 0.012);
    }

    if (select) this.selected = hit?.body ?? null;

    // The selected body: a warm halo and its name pinned above it.
    const sel = this.selected;
    if (sel && !(sel.available?.() ?? true)) this.selected = null;
    this.halo.visible = this.pinLabel.sprite.visible = !!this.selected;
    if (this.selected) {
      const at = this.selected.group.getWorldPosition(new THREE.Vector3());
      this.halo.position.copy(at);
      this.halo.scale.setScalar(this.selected.radius * 3.2);
      this.pinLabel.plate.set(this.selected.name, this.selected.kind ? [this.selected.kind] : []);
      this.pinLabel.place(at.clone().addScaledVector(UP, this.selected.radius), eye, XR.labelAngular * 1.2, 0.9);
    }

    const hoverShown = !!hit && hit.body !== this.selected;
    this.hoverLabel.sprite.visible = hoverShown;
    if (hit && hoverShown) {
      this.hoverLabel.plate.set(hit.label, hit.note ? [hit.note] : []);
      this.hoverLabel.place(hit.point, eye, XR.labelAngular);
    }
  }

  private updateWrist(dt: number, cpuMs: number) {
    const left = this.input.hand('left');
    const parent = this.wristShown ? (left?.grip ?? null) : null;
    if (this.wrist.parent !== parent) {
      this.wrist.removeFromParent();
      parent?.add(this.wrist);
    }
    this.frames++;
    this.fpsAt += dt;
    this.cpuMs = Math.max(this.cpuMs * 0.95, cpuMs);
    if (this.fpsAt >= 1) {
      this.fps = this.frames / this.fpsAt;
      this.frames = 0;
      this.fpsAt = 0;
    }
    this.wristAt += dt;
    if (!parent || this.wristAt < 0.25) return;
    this.wristAt = 0;
    const M = this.metresPerUnit;
    const hall = Math.round(this.half * 2 * M);
    const [date = '', speed = ''] = this.hooks.status();
    this.wristPlate.set(date, [
      speed,
      `${this.fps.toFixed(0)} fps · cpu ${this.cpuMs.toFixed(1)} ms`,
      `${this.scaleText()} · hall ${hall} m`,
      `${this.backendText()}${this.resolutionScale !== 1 ? ` · res ×${this.resolutionScale}` : ''}`,
    ]);
    this.cpuMs = cpuMs;
  }

  private backendText() {
    const multiview = (this.renderer.xr as unknown as { useMultiview(): boolean }).useMultiview();
    return `${this.hooks.backend()}${multiview ? ' multiview · no bloom' : ` · bloom ${this.bloomOn ? 'on' : 'off'}`}`;
  }

  private scaleText() {
    const M = this.metresPerUnit;
    return `1 unit = ${M < 0.1 ? (M * 100).toFixed(1) + ' cm' : M.toFixed(2) + ' m'}`;
  }
}

let glow: THREE.Texture | null = null;
function glowTexture() {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glow = new THREE.CanvasTexture(c);
  return glow;
}
