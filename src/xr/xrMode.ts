import * as THREE from 'three/webgpu';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XR, speedScale } from './config';
import { XrInput } from './input';
import { buildHangar } from './hangar';
import { groundAt, spawnPoint, walkRadius, drumRadius, WALK_RADIUS, GROUND_Y, type Viewpoint } from './vrScene';
import { TABLE_RADIUS } from '../scene/layout';
import { Wormhole } from './wormhole';
import { ControlPanel, type PanelRow } from './controlPanel';
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
  /** Telemetry: a sample each second and markers on the left grip (with app state merged in). */
  report?(entry: Record<string, unknown>): void;
  /** Which GPU backend is drawing, for the readout. */
  backend(): string;
  /** Camera shake the scenes want (0..1); in VR it becomes controller rumble. */
  quake(): number;
  /** Is Discworld on (the Disc is then the ground)? */
  discOn?(): boolean;
  /** Session start / end (Discworld goes on for VR, and back after). */
  sessionStart?(): void;
  sessionEnd?(): void;
  /** The control box's rows, and a press on one. */
  panelRows?(): PanelRow[];
  panelPress?(index: number): void;
}

/** ?hangar=1: the old VR layout (the hall), for comparison. */
const LEGACY_HALL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('hangar') === '1';

/** A pose to come back to: head position (world units), facing, and world scale. */
export interface XrPose {
  head: THREE.Vector3;
  yawDeg: number;
  metresPerUnit: number;
}

export interface XrLayout {
  /** World box of the instrument (cabinet and arms). */
  orrery: THREE.Box3;
  tableRadius: number;
  /** The star sphere and stars, kept inside the far plane in VR. */
  sky?: THREE.Object3D[];
}

const UP = new THREE.Vector3(0, 1, 0);
/** Moves longer than this (metres, as the player sees it) fade instead of gliding. */
const SWOOP_MAX_M = 25;
/** Fallback pivot for scaling in the air: the orrery's centre, at the planets' height. */
const ORRERY_CENTRE = new THREE.Vector3(0, 4, 0);
/** The Disc's (the table's) top, as a plane. */
const DISC_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y);

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
  /** Where the pointer ray last landed (world), for the scale pivot; null if on nothing. */
  private rayHit: THREE.Vector3 | null = null;
  /** Far plane, in world units (see applyScale). */
  private farUnits = 1200;
  /** The scale pivot, fixed while the grip is held. */
  private scalePivot: THREE.Vector3 | null = null;
  private tmpPivot = new THREE.Vector3();
  private pivotDot = new THREE.Sprite(
    new THREE.SpriteMaterial({ color: 0xffd28a, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
  );

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
  private marks = 0;
  private markShownUntil = 0;
  private sampleAt = 0;
  /** Desktop pixels per unit of tan(angle), which the particle sizes were tuned for. */
  private desktopPx = 1000;
  private wormhole = new Wormhole();
  private sky: THREE.Object3D[];
  private fader: THREE.Mesh;
  readonly panel: ControlPanel;
  private panelAt = 0;
  /** A move in progress (swoop or fade), driven by update(). */
  private move: {
    kind: 'swoop' | 'fade';
    t: number;
    duration: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    yawFrom: number;
    yawTo: number | null;
    scaleTo: number;
    turned: boolean;
    done?: () => void;
  } | null = null;

  constructor(
    private renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    layout: XrLayout,
    private hooks: XrHooks,
  ) {
    this.sky = layout.sky ?? [];
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');

    // The hall, sized from the instrument (only with ?hangar=1: the VR scene now has no hall).
    this.floorY = layout.orrery.min.y - XR.hoverGap;
    this.half = layout.tableRadius + XR.hangarMargin;
    this.roofY = layout.orrery.max.y + XR.roofClearance;
    this.hangar = LEGACY_HALL ? buildHangar({ floorY: this.floorY, half: this.half, roofY: this.roofY, tableRadius: layout.tableRadius }) : new THREE.Group();
    this.hangar.visible = false;
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
    (this.pivotDot.material as THREE.SpriteMaterial).map = glowTexture();
    this.pivotDot.renderOrder = 24;
    this.pivotDot.visible = false;
    scene.add(this.pivotDot);

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
      // (No depth test, like the control box: it overlaps the controller model.)
      new THREE.MeshBasicMaterial({ map: this.wristPlate.texture, transparent: true, depthTest: false, depthWrite: false }),
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

    // Fade to black for long moves (a plane just in front of the eyes, over everything).
    const fadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.fader = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMat);
    this.fader.position.z = -0.2;
    this.fader.renderOrder = 32;
    this.fader.visible = false;
    this.camera.add(this.fader);

    // The control box, worn above the left wrist.
    this.panel = new ControlPanel(
      () => this.hooks.panelRows?.() ?? [],
      (i) => this.hooks.panelPress?.(i),
    );

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
    this.hangar.visible = LEGACY_HALL;
    this.rig.visible = true;
    this.hooks.sessionStart?.();
    this.resetPosition();
    // Arrive through the wormhole: standing still while it streams past, once per session.
    if (!LEGACY_HALL) {
      const at = this.camera.position.clone();
      at.y = Math.max(at.y, 1.2);
      this.wormhole.start(this.rig, at, 0);
    }
  }

  private end() {
    this.hooks.view?.(null);
    POINT_UNIFORMS.uPointView.value = 1;
    POINT_UNIFORMS.uPointMax.value = 4096;
    this.hangar.visible = this.rig.visible = false;
    for (const o of this.sky) {
      o.position.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrixWorld();
    }
    this.hooks.sessionEnd?.();
    this.move = null;
    this.fader.visible = false;
    this.rayDot.visible = this.halo.visible = false;
    this.hoverLabel.sprite.visible = this.pinLabel.sprite.visible = false;
    this.selected = null;
  }

  private resetPosition() {
    this.velocity.set(0, 0, 0);
    if (LEGACY_HALL) {
      this.rig.position.copy(this.start);
      this.rig.rotation.set(0, 0, 0);
      this.grounded = true;
      this.applyScale();
      return;
    }
    this.applyScale();
    this.goTo(spawnPoint());
  }

  /** Stand at a viewpoint (immediately). */
  goTo(v: Viewpoint) {
    this.rig.rotation.set(0, THREE.MathUtils.degToRad(v.yawDeg), 0);
    if (v.onGround) {
      this.rig.position.set(v.head.x, v.head.y, v.head.z);
      this.keepHead(v.head);
      this.rig.position.y = v.head.y;
      this.grounded = this.ground(v.head.x, v.head.z) !== null;
    } else {
      this.setHead(v.head);
      this.grounded = false;
    }
    this.velocity.set(0, 0, 0);
  }

  /** Put the head at p (world units) by moving the rig. */
  private setHead(p: THREE.Vector3) {
    const now = this.head();
    this.rig.position.add(this.tmpV.copy(p).sub(now));
  }
  private tmpV = new THREE.Vector3();

  /** Ground height under (x, z), or null (no ground: float). */
  private ground(x: number, z: number): number | null {
    if (LEGACY_HALL) return this.floorY;
    return groundAt(x, z, this.hooks.discOn?.() ?? false);
  }

  /** Where the player is now, to come back to. */
  pose(): XrPose {
    return { head: this.head(), yawDeg: THREE.MathUtils.radToDeg(this.rig.rotation.y), metresPerUnit: this.metresPerUnit };
  }

  /** Is the player being moved (arrival or a swoop / fade)? */
  get moving() {
    return this.move !== null || this.wormhole.active;
  }

  /**
   * Carry the player to a head position (world units), facing `yawDeg` (or
   * keeping their facing), at a world scale. Comfort: up to SWOOP_MAX_M metres
   * it is a smooth eased glide of 1.5–2.5 s with the vignette closed in and
   * any turn done as one snap at mid-glide; further than that it fades to
   * black, moves, and fades back. No roll or pitch ever.
   */
  moveTo(head: THREE.Vector3, yawDeg: number | null, metresPerUnit = this.metresPerUnit, done?: () => void) {
    const from = this.head();
    const metres = from.distanceTo(head) * Math.max(this.metresPerUnit, metresPerUnit);
    const swoop = metres <= SWOOP_MAX_M && Math.abs(Math.log(metresPerUnit / this.metresPerUnit)) < 0.05;
    this.move = {
      kind: swoop ? 'swoop' : 'fade',
      t: 0,
      duration: swoop ? THREE.MathUtils.clamp(1.5 + metres / SWOOP_MAX_M, 1.5, 2.5) : 0.9,
      from,
      to: head.clone(),
      yawFrom: this.rig.rotation.y,
      yawTo: yawDeg === null ? null : THREE.MathUtils.degToRad(yawDeg),
      scaleTo: metresPerUnit,
      turned: false,
      done,
    };
    this.grounded = false;
    this.velocity.set(0, 0, 0);
  }

  /** Advance a move; returns the vignette strength it wants. */
  private stepMove(dt: number): number {
    const m = this.move!;
    m.t = Math.min(1, m.t + dt / m.duration);
    const turn = () => {
      if (m.turned || m.yawTo === null) return;
      const was = this.head();
      this.rig.rotation.set(0, m.yawTo, 0);
      this.keepHead(was, true);
      m.turned = true;
    };
    let vignette = 0;
    if (m.kind === 'swoop') {
      const k = m.t < 0.5 ? 4 * m.t ** 3 : 1 - (-2 * m.t + 2) ** 3 / 2;
      this.setHead(this.tmpV.lerpVectors(m.from, m.to, k));
      if (m.t >= 0.5) turn();
      vignette = 0.75 * Math.sin(Math.PI * Math.min(1, m.t * 1.15));
    } else {
      // Fade out (first third), move in the dark, fade in (last third).
      const op = m.t < 1 / 3 ? m.t * 3 : m.t > 2 / 3 ? (1 - m.t) * 3 : 1;
      if (m.t >= 1 / 3 && !m.turned) {
        this.metresPerUnit = m.scaleTo;
        this.applyScale();
        turn();
        m.turned = true;
        this.setHead(m.to);
      }
      (this.fader.material as THREE.MeshBasicMaterial).opacity = op;
      this.fader.visible = op > 0;
    }
    if (m.t >= 1) {
      this.setHead(m.to);
      turn();
      this.fader.visible = false;
      const g = this.ground(m.to.x, m.to.z);
      const feet = this.rig.position.y;
      // Land on the Disc if the move ends standing on it.
      this.grounded = g !== null && Math.abs(feet - g) < 0.6 / this.metresPerUnit;
      if (this.grounded) this.rig.position.y = g!;
      const done = m.done;
      this.move = null;
      done?.();
    }
    return vignette;
  }

  private applyScale() {
    this.rig.scale.setScalar(1 / this.metresPerUnit);
    // Far enough to reach the star sphere (900 units) whatever the scale.
    // The far plane (metres) must hold the whole scene (~160 units across) but
    // no more than it needs, for depth precision: 1200 units up to the default
    // scale, down to 160 units at the insect end. The sky is drawn inside it
    // (see updateSky).
    this.farUnits = THREE.MathUtils.clamp(9000 / this.metresPerUnit, 160, 1200);
    this.camera.far = this.farUnits * this.metresPerUnit;
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
    if (a.mark) {
      this.marks++;
      this.hooks.report?.({ kind: 'mark', n: this.marks, ...this.snapshot() });
      this.input.rumble(0.6, 80);
      this.markShownUntil = performance.now() + 2500;
      this.wristAt = Infinity;
    }
    if (a.faster) this.hooks.faster();
    if (a.slower) this.hooks.slower();
    if (a.now) this.hooks.now();

    // Arriving through the wormhole, or being carried somewhere: no locomotion.
    let vigWanted = 0;
    let carried = false;
    if (this.wormhole.active) {
      vigWanted = this.wormhole.update(dt);
      carried = true;
    } else if (this.move) {
      vigWanted = this.stepMove(dt);
      carried = true;
    }

    // World scale, live, pivoting at what the ray points at (else the
    // orrery's centre), so the world visibly grows or shrinks about that
    // point. Standing on the Disc, the pivot is dropped onto the Disc's top:
    // the surface stays put and the feet stay on it, sliding toward or away
    // from the pivot. (The old hall pivoted at the head.)
    if (a.scaling && !this.scalePivot) this.scalePivot = (this.rayHit ?? ORRERY_CENTRE).clone();
    if (!a.scaling) this.scalePivot = null;
    if (!carried && a.scaling && a.scale !== 0) {
      const next = THREE.MathUtils.clamp(M * Math.exp(a.scale * dt * XR.scaleRate), XR.minMetresPerUnit, XR.maxMetresPerUnit);
      if (LEGACY_HALL) {
        const was = this.head();
        this.metresPerUnit = next;
        this.applyScale();
        this.keepHead(was, !this.grounded);
      } else {
        const pivot = this.tmpPivot.copy(this.scalePivot!);
        if (this.grounded) pivot.y = this.rig.position.y;
        // The player shrinks (or grows) by M / next about the pivot.
        this.rig.position.sub(pivot).multiplyScalar(M / next).add(pivot);
        this.metresPerUnit = next;
        this.applyScale();
      }
    }
    // A bead marks the pivot while scaling.
    this.pivotDot.visible = !!this.scalePivot && !LEGACY_HALL;
    if (this.scalePivot) {
      this.pivotDot.position.copy(this.scalePivot);
      this.pivotDot.scale.setScalar(this.scalePivot.distanceTo(this.head()) * 0.03);
    }
    this.scaleTag.visible = a.scaling;
    if (a.scaling) this.scalePlate.set(this.scaleCompare(), [`${this.scaleText()} · stick up / down`]);

    if (!carried && a.snapTurn) {
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
    if (carried) {
      wish.set(0, 0, 0);
      v.set(0, 0, 0);
    }

    if (this.grounded) {
      wish.multiplyScalar(XR.walkSpeed);
      v.set(wish.x, 0, wish.z);
    } else if (!carried) {
      wish.multiplyScalar(XR.flySpeed * s);
      const k = Math.min(1, dt * 3);
      v.x += (wish.x - v.x) * k;
      v.z += (wish.z - v.z) * k;
    }
    if (!carried) {
      // Jetpack: thrust along wherever the left controller points.
      if (a.thrust > 0.05) v.addScaledVector(a.thrustDir, a.thrust * XR.thrust * s * dt);
      if (a.lift !== 0) v.y += (a.lift * XR.liftSpeed * s - v.y) * Math.min(1, dt * 4);
    }
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

    const feetBefore = this.rig.position.y;
    this.rig.position.addScaledVector(v, dt / M);

    if (LEGACY_HALL) {
      // Floor, roof and walls of the hall.
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
    } else if (!carried) {
      // The Disc: walk on its top, held back from the rim and the glass drum;
      // land on it from above. Off it, or with Discworld off, float.
      const head = this.head();
      const g = this.ground(head.x, head.z);
      if (this.grounded) {
        if (g === null) this.grounded = false;
        else {
          this.rig.position.y = g;
          const r = Math.hypot(head.x, head.z);
          const outer = walkRadius(M),
            inner = drumRadius(M);
          const limit = r > outer ? outer : inner !== null && r < inner && r > 1e-6 ? inner : r;
          if (limit !== r) {
            this.rig.position.x += (head.x / r) * (limit - r);
            this.rig.position.z += (head.z / r) * (limit - r);
          }
        }
      } else if (g !== null && v.y <= 0 && feetBefore >= g - 1e-4 && this.rig.position.y <= g) {
        this.rig.position.y = g;
        v.y = 0;
        this.grounded = true;
      }
    }

    // Comfort vignette (closed in while carried or arriving).
    const speed = v.length();
    const vig = Math.max(vigWanted, THREE.MathUtils.clamp((speed - XR.vignetteFrom) / (XR.vignetteFull - XR.vignetteFrom), 0, 1) * XR.vignetteMax);
    const u = this.vignetteStrength;
    u.value += (vig - u.value) * Math.min(1, dt * 6);
    this.vignette.visible = u.value > 0.01;

    this.updatePointSizes();
    this.updateSky();
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
  /**
   * The star sphere (900 units) and the sparkling stars (600–800) sit beyond
   * a near-insect player's far plane: centre them on the head and shrink them
   * inside it. They're at infinity either way, so nothing visible changes.
   */
  private updateSky() {
    const k = Math.min(1, (0.9 * this.farUnits) / 900);
    const head = this.head();
    for (const o of this.sky) {
      o.position.copy(head);
      o.scale.setScalar(k);
      o.updateMatrixWorld();
    }
  }

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
    // The control box sits above the left wrist.
    const left = this.input.hand('left');
    const panelParent = this.hooks.panelRows ? (left?.grip ?? null) : null;
    if (this.panel.mesh.parent !== panelParent) {
      const m = this.panel.mesh;
      m.removeFromParent();
      m.position.set(0, 0.2, 0.02);
      m.rotation.set(-0.75, 0, 0);
      m.scale.setScalar(1);
      panelParent?.add(m);
    }
    if (hand) {
      this.raycaster.setFromXRController(hand.ray);
      this.raycaster.camera = this.camera;
      const onPanel = this.panel.hit(this.raycaster);
      if (onPanel) {
        // A press on the panel, not on the world.
        hit = { point: onPanel.point, distance: onPanel.distance, label: '' };
        if (select) this.panel.press();
        select = false;
      } else hit = this.hooks.pick(this.raycaster);
    }
    if ((this.panelAt += 1) % 30 === 0) this.panel.refresh();
    this.rayHit = hit && hit.label ? hit.point.clone() : null;
    // Otherwise the point aimed at on the Disc's top (the orrery's table), for the scale pivot.
    if (!this.rayHit && hand && !LEGACY_HALL) {
      const p = this.raycaster.ray.intersectPlane(DISC_PLANE, new THREE.Vector3());
      if (p && Math.hypot(p.x, p.z) <= TABLE_RADIUS) this.rayHit = p;
    }
    // The ray lives in the controller's space, which is in metres.
    // (Unbroken it reaches 40 m, or 25 units when the world is huge around an insect-sized player.)
    const len = hit ? hit.distance * this.metresPerUnit : Math.max(XR.rayLength, 25 * this.metresPerUnit);
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

    const hoverShown = !!hit && !!hit.label && hit.body !== this.selected;
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
    this.sampleAt += dt;
    if (this.sampleAt >= 1) {
      this.sampleAt = 0;
      this.hooks.report?.({ kind: 'sample', ...this.snapshot() });
    }
    this.wristAt += dt;
    if (!parent || this.wristAt < 0.25) return;
    this.wristAt = 0;
    const M = this.metresPerUnit;
    const hall = LEGACY_HALL ? `hall ${Math.round(this.half * 2 * M)} m` : this.scaleCompare();
    const [date = '', speed = ''] = this.hooks.status();
    const marked = performance.now() < this.markShownUntil ? `Marked #${this.marks}` : '';
    this.wristPlate.set(marked || date, [
      speed,
      `${this.fps.toFixed(0)} fps · cpu ${this.cpuMs.toFixed(1)} ms`,
      `${hall}`,
      `${this.backendText()}${this.resolutionScale !== 1 ? ` · res ×${this.resolutionScale}` : ''}`,
    ]);
    this.cpuMs = cpuMs;
  }

  private backendText() {
    const multiview = (this.renderer.xr as unknown as { useMultiview(): boolean }).useMultiview();
    return `${this.hooks.backend()}${multiview ? ' multiview · no bloom' : ` · bloom ${this.bloomOn ? 'on' : 'off'}`}`;
  }

  /** Where the player is and how it's running, for telemetry. */
  private snapshot() {
    const head = this.head();
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld);
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      fps: Math.round(this.fps * 10) / 10,
      cpuMs: r(this.cpuMs),
      head: [r(head.x), r(head.y), r(head.z)],
      look: [r(fwd.x), r(fwd.y), r(fwd.z)],
      yawDeg: Math.round(THREE.MathUtils.radToDeg(this.rig.rotation.y)),
      metresPerUnit: r(this.metresPerUnit),
      grounded: this.grounded,
      resolutionScale: this.resolutionScale,
      renderer: this.backendText(),
    };
  }

  /** Put the player's head at (x, y, z) world units, facing `yawDeg` (from a telemetry command). */
  teleport(x: number, y: number, z: number, yawDeg = 0) {
    this.rig.rotation.set(0, THREE.MathUtils.degToRad(yawDeg), 0);
    this.rig.position.set(x, y, z);
    const head = this.head();
    this.rig.position.x += x - head.x;
    this.rig.position.z += z - head.z;
    this.rig.position.y += y - head.y;
    if (LEGACY_HALL) {
      this.rig.position.y = Math.max(this.floorY, this.rig.position.y);
      this.grounded = this.rig.position.y <= this.floorY + 1e-6;
    } else {
      // At (or below) standing height over the Disc: stand on it.
      const g = this.ground(x, z);
      this.grounded = g !== null && this.rig.position.y <= g + 0.5 / this.metresPerUnit;
      if (this.grounded) this.rig.position.y = g!;
    }
    this.velocity.set(0, 0, 0);
  }

  /** Set the world scale (from a telemetry command). */
  setScale(metresPerUnit: number) {
    const was = this.head();
    this.metresPerUnit = THREE.MathUtils.clamp(metresPerUnit, XR.minMetresPerUnit, XR.maxMetresPerUnit);
    this.applyScale();
    this.keepHead(was, !this.grounded);
  }

  /** Show or hide the hall (from a telemetry command). `preview` shows it outside VR too (?vrview=1). */
  setHangar(on: boolean, preview = false) {
    this.hangar.visible = on && (this.presenting || preview);
  }

  /** Desktop preview: the arrival tunnel around `at`, frozen at time t. */
  previewArrival(parent: THREE.Object3D, at: THREE.Vector3, yaw: number, t: number) {
    if (t < 0) this.wormhole.stop();
    else this.wormhole.preview(parent, at, yaw, t);
  }

  /** Desktop preview: the control box held in front of `camera` (null to put it away). */
  previewPanel(camera: THREE.Camera | null, _rows: number) {
    const m = this.panel.mesh;
    m.removeFromParent();
    if (!camera) return;
    this.panel.refresh();
    // In world units: as big as it would look 35 cm away at the default scale.
    const k = 1 / XR.metresPerUnit;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    m.position.copy(camera.position).addScaledVector(fwd, 0.26 * k);
    m.quaternion.copy(camera.quaternion);
    m.scale.setScalar(k);
    camera.parent ? camera.parent.add(m) : this.rig.parent?.add(m);
  }

  /** The hall, for measuring. */
  get hall() {
    return this.hangar;
  }

  /** The world scale as a human comparison. */
  private scaleCompare() {
    const M = this.metresPerUnit;
    const disc = 2 * WALK_RADIUS * M;
    const m = (x: number) => (x >= 10 ? `${Math.round(x)} m` : x >= 1 ? `${x.toFixed(1)} m` : `${Math.round(x * 100)} cm`);
    return `Disc ${m(disc)} across`;
  }

  private scaleText() {
    const M = this.metresPerUnit;
    // You, 1.7 m tall, against the orrery's Sun (3.1 units across).
    const sun = 3.1 * M;
    return `Sun ${sun >= 1 ? sun.toFixed(1) + ' m' : Math.round(sun * 100) + ' cm'} wide · you 1.7 m`;
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
