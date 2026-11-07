import * as THREE from 'three/webgpu';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XR, speedScale } from './config';
import { mark } from '../perfMarks';
import { SPRITE_SCALE } from '../scene/spriteScale';
import { XrInput } from './input';
import { buildHangar } from './hangar';
import { groundAt, spawnPoint, walkRadius, drumRadius, liftPoint, WALK_RADIUS, GROUND_Y, UNDERSIDE_Y, type Surface, type Viewpoint } from './vrScene';
import { CAPTURE_RADIUS, Lift } from './lift';
import { shellTopAt, type Lore } from '../scene/discworld';
import type { CardContent } from '../ui/infocard';
import { InfoPanel } from './infoPanel';
import { ControllerLabels } from './controllerLabels';
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
  /** Set when the hit is a Discworld figure with lore. */
  lore?: Lore;
}

/** What VR needs from the rest of the app. */
export interface XrHooks {
  pick(ray: THREE.Raycaster): XrHit | null;
  faster(): void;
  slower(): void;
  /** A screenshot of the view (dev builds: left stick click). */
  capture?(): void;
  now(): void;
  /** Called each frame in VR with the head's world position (to skip drawing what it can't see); null on leaving VR. */
  view?(head: THREE.Vector3 | null): void;
  /** Lines for the wrist readout: the date shown and the speed. */
  status(): string[];
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
  /** The panel's time controls (rows) and a press on one (`part`: which button or slider stop). */
  timeRows?(): PanelRow[];
  timePress?(index: number, part: number): void;
  /** The panel's scene controls, and a press on one. */
  panelRows?(): PanelRow[];
  panelPress?(index: number, part: number): void;
  /** The info card for a pointed-at object (its content, called again for live figures), or null if it has none. */
  card?(hit: XrHit): (() => CardContent) | null;
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
/** Display refresh rate asked for in VR (Hz). */
const TARGET_HZ = 72;

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
  /** When a panel popped up by A/B goes away again (performance.now() ms), or 0. */
  private popUntil = 0;
  private lastDt = 0;
  /** Which wrist panel is out: X toggles the time panel, Y the scene panel (one at a time). */
  private open: 'time' | 'scene' | null = null;
  /** The debug panel shown beside the scene panel (its Debug row toggles it). */
  private debugShown = false;
  /** The debug panel's readout lines. */
  private debugLines: string[] = ['DEBUG'];
  /** Floats in front of the eyes while the world scale is being changed. */
  private scaleTag: THREE.Mesh;
  private scalePlate = new TextPlate(512, 160);
  private fps = 0;
  private frames = 0;
  private fpsAt = 0;
  private cpuMs = 0;
  private marks = 0;
  private markShownUntil = 0;
  private sampleAt = 0;
  /** Desktop pixels per unit of tan(angle), which the particle sizes were tuned for. */
  private desktopPx = 1000;
  private wormhole = new Wormhole();
  /** The beam between A'Tuin's shell and the deck (Discworld on only). */
  private lift: Lift;
  private sky: THREE.Object3D[];
  private fader: THREE.Mesh;
  /** The time panel (X): the date, speed and time controls. */
  private timePanel: ControlPanel;
  /** The scene panel (Y): moons, the fiction catalogue, return, debug. */
  private scenePanel: ControlPanel;
  /** Frame rate, renderer and scale, beside the wrist panel. */
  private debugPanel: ControlPanel;
  /** Each controller's model (loaded from its input profile), for the labels. */
  private controllerModels: { slot: { grip: THREE.XRGripSpace; source: XRInputSource | null }; model: THREE.Object3D }[];
  /** Engraved control labels that show when a controller is raised to be read. */
  private controllerLabels = new ControllerLabels();
  /** The info card, opened with the trigger on a body or a Discworld figure. */
  readonly info = new InfoPanel();
  private panelAt = 0;
  /** A move in progress (swoop or fade), driven by update(). */
  private move: {
    kind: 'swoop' | 'fade' | 'lift';
    t: number;
    duration: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    yawFrom: number;
    yawTo: number | null;
    scaleTo: number;
    turned: boolean;
    done?: () => void;
    /** A lift ride's phases: centre in the beam, ride, then glide clear of it. Times in seconds. */
    lift?: { centre: THREE.Vector3; top: THREE.Vector3; exit: THREE.Vector3 | null; tc: number; tv: number };
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
    {
      const at = liftPoint();
      const shellY = shellTopAt(at.x, at.y) ?? GROUND_Y - 8;
      // The shell's normal there, from its slope.
      const e = 0.05;
      const dx = ((shellTopAt(at.x + e, at.y) ?? shellY) - (shellTopAt(at.x - e, at.y) ?? shellY)) / (2 * e);
      const dz = ((shellTopAt(at.x, at.y + e) ?? shellY) - (shellTopAt(at.x, at.y - e) ?? shellY)) / (2 * e);
      this.lift = new Lift(at, shellY, UNDERSIDE_Y, GROUND_Y, new THREE.Vector3(-dx, 1, -dz).normalize());
      scene.add(this.lift.group);
    }
    this.input = new XrInput(renderer, this.rig);

    const models = new XRControllerModelFactory();
    this.controllerModels = this.input.all.map((slot) => {
      const model = models.createControllerModel(slot.grip);
      slot.grip.add(model);
      return { slot, model };
    });

    // The pointer: a thin gold line and a bead where it lands, on whichever controller is the right hand.
    this.rayLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.7 }),
    );
    this.rayDot = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffe2a8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    scene.add(this.rayDot, this.hoverLabel.sprite);
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

    // The wrist panels, worn above the left wrist, one at a time.
    this.timePanel = new ControlPanel(
      () => this.hooks.timeRows?.() ?? [],
      (i, part) => this.hooks.timePress?.(i, part),
      () => {
        const [date = '', speed = ''] = this.hooks.status();
        return [date, speed, LEGACY_HALL ? `hall ${Math.round(this.half * 2 * this.metresPerUnit)} m` : this.scaleCompare()];
      },
    );
    this.scenePanel = new ControlPanel(
      () => [...(this.hooks.panelRows?.() ?? []), { label: 'Debug', on: this.debugShown }],
      (i, part) => {
        if (i < (this.hooks.panelRows?.().length ?? 0)) this.hooks.panelPress?.(i, part);
        else this.debugShown = !this.debugShown;
      },
      () => ['ORRERY'],
    );
    this.debugPanel = new ControlPanel(
      () => [],
      () => undefined,
      () => this.debugLines,
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
    const session = await xr.requestSession('immersive-vr', {
      // 'layers' lets the renderer draw both eyes in one pass (multiview).
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    await this.renderer.xr.setSession(session);
    // Quest runs at 90 Hz by default; 72 Hz gives each frame 13.9 ms instead
    // of 11.1 ms. Only rates the headset offers.
    const rates = session.supportedFrameRates;
    if (rates?.includes(TARGET_HZ) && session.updateTargetFrameRate) {
      await session.updateTargetFrameRate(TARGET_HZ).catch(() => undefined);
    }
  }

  private begin() {
    this.controllerLabels.showFor(30);
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
    this.info.hide();
    this.info.update(1); // (gone at once: no frames left to fade in)
    SPRITE_SCALE.value = 1;
    this.hooks.view?.(null);
    POINT_UNIFORMS.uPointView.value = 1;
    POINT_UNIFORMS.uPointMax.value = 4096;
    this.hangar.visible = this.rig.visible = false;
    this.lift.group.visible = false;
    for (const o of this.sky) {
      o.position.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrixWorld();
    }
    this.hooks.sessionEnd?.();
    this.move = null;
    this.fader.visible = false;
    this.rayDot.visible = false;
    this.hoverLabel.sprite.visible = false;
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
  private ground(x: number, z: number, feetY = this.rig.position.y): { y: number; on: Surface } | null {
    if (LEGACY_HALL) return { y: this.floorY, on: 'disc' };
    const g = groundAt(x, z, feetY, this.hooks.discOn?.() ?? false);
    // The lift's plinth stands on the shell: its top is a step up.
    if (g?.on === 'shell') {
      const pad = this.lift.padTop(x, z);
      if (pad !== null && pad > g.y) g.y = pad;
    }
    return g;
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

  /**
   * Ride the lift from `surface`: drawn to the beam's centre, carried
   * straight up to the deck or down to the shell at a steady pace, then
   * glided forward clear of the light.
   */
  private startLift(surface: Surface) {
    const from = this.head();
    const dy = this.lift.destination(surface) - this.rig.position.y;
    const metres = Math.abs(dy) * this.metresPerUnit;
    const centre = new THREE.Vector3(this.lift.at.x, from.y, this.lift.at.y);
    const top = centre.clone().setY(from.y + dy);
    const exit = this.clearOfLift(top, surface === 'shell' ? 'disc' : 'shell');
    const tc = 0.6,
      tv = THREE.MathUtils.clamp(metres / 3, 2.5, 6),
      tp = 0.8;
    this.move = {
      kind: 'lift',
      t: 0,
      duration: tc + tv + tp,
      lift: { centre, top, exit, tc, tv },
      from,
      to: exit ?? top,
      yawFrom: this.rig.rotation.y,
      yawTo: null,
      scaleTo: this.metresPerUnit,
      turned: true,
    };
    this.grounded = false;
    this.velocity.set(0, 0, 0);
  }

  /**
   * Where to set a player down clear of the beam at the end of a ride
   * (`top` is their head at the ride's end, standing on `onto`): forward,
   * the way they face, just past the beam's pull. If that isn't somewhere
   * to stand (inside the glass drum, past the rim, off the shell), they slide
   * sideways instead, else straight out from the hub, else back toward it.
   * The head keeps its height above the ground there.
   */
  private clearOfLift(top: THREE.Vector3, onto: Surface): THREE.Vector3 {
    const M = this.metresPerUnit;
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld).setY(0);
    const out = new THREE.Vector3(top.x, 0, top.z).normalize();
    if (fwd.lengthSq() < 1e-6) fwd.copy(out);
    fwd.normalize();
    const reach = CAPTURE_RADIUS + 0.4;
    const groundY = (x: number, z: number) => {
      if (onto === 'shell') return shellTopAt(x, z);
      const r = Math.hypot(x, z);
      const drum = drumRadius(M);
      return r <= walkRadius(M) && (drum === null || r >= drum + 0.3) ? GROUND_Y : null;
    };
    const side = fwd.clone().addScaledVector(out, -fwd.dot(out));
    const tries = [fwd, side.lengthSq() > 1e-4 ? side.normalize() : out, out, out.clone().negate()];
    const feetY = this.lift.destination(onto === 'disc' ? 'shell' : 'disc');
    for (const d of tries) {
      const p = top.clone().addScaledVector(d, reach);
      const g = groundY(p.x, p.z);
      if (g !== null) return p.setY(top.y + g - feetY);
    }
    return top.clone();
  }

  /** Desktop preview: show the lift with its hatches open by `open` (0..1). */
  previewLift(open: number | null) {
    this.lift.group.visible = open !== null;
    if (open !== null) this.lift.preview(open);
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
    if (m.kind === 'lift' && m.lift) {
      // Centre in the beam, ride (eased at both ends, steady between), glide clear.
      const L = m.lift;
      const T = m.t * m.duration;
      const ease = (x: number) => {
        const k = THREE.MathUtils.clamp(x, 0, 1);
        return k * k * (3 - 2 * k);
      };
      if (T < L.tc) this.setHead(this.tmpV.lerpVectors(m.from, L.centre, ease(T / L.tc)));
      else if (T < L.tc + L.tv || !L.exit) this.setHead(this.tmpV.lerpVectors(L.centre, L.top, ease((T - L.tc) / L.tv)));
      else this.setHead(this.tmpV.lerpVectors(L.top, L.exit, ease((T - L.tc - L.tv) / (m.duration - L.tc - L.tv))));
      vignette = 0.45;
    } else if (m.kind === 'swoop') {
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
      const feet = this.rig.position.y;
      const g = this.ground(m.to.x, m.to.z, feet)?.y ?? null;
      // Land on the Disc (or the shell) if the move ends standing on it.
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
    // Sprites don't feel the rig's scale by themselves: keep them in proportion (1 at the default scale).
    SPRITE_SCALE.value = this.metresPerUnit / XR.metresPerUnit;
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
    mark('xr.input');
    const a = this.input.actions;
    const M = this.metresPerUnit;
    const s = speedScale(M);

    if (a.timePanel) this.open = this.open === 'time' ? null : 'time';
    if (a.scenePanel) this.open = this.open === 'scene' ? null : 'scene';
    // A choice made with X or Y stands: no popped panel to take away.
    if (a.timePanel || a.scenePanel) this.popUntil = 0;
    // A / B step the clock, and pop the time panel up to show it (unless a panel is already out by choice).
    if (a.capture && this.hooks.capture) {
      this.hooks.capture();
      this.input.rumble(0.4, 60);
    }
    if (a.faster || a.slower) {
      if (a.faster) this.hooks.faster();
      else this.hooks.slower();
      if (this.open === null || this.popUntil) {
        this.open = 'time';
        this.popUntil = performance.now() + 2500;
        this.timePanel.refresh();
      }
    }
    this.lastDt = dt;
    if (a.mark) {
      this.marks++;
      this.hooks.report?.({ kind: 'mark', n: this.marks, ...this.snapshot() });
      this.input.rumble(0.6, 80);
      this.markShownUntil = performance.now() + 2500;
    }
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
      // Walk on the Disc's top (held back from the rim and the glass drum) or
      // on A'Tuin's shell; land on either from above. Off them, or with
      // Discworld off, float.
      const head = this.head();
      const ground = this.ground(head.x, head.z, this.grounded ? feetBefore : this.rig.position.y);
      const g = ground?.y ?? null;
      if (this.grounded) {
        if (ground === null) this.grounded = false;
        else if (ground.on === 'shell') this.rig.position.y = ground.y;
        else {
          this.rig.position.y = ground.y;
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

    mark('xr.move');
    // The lift: walk into its light (on the shell or the deck) to ride it.
    if (!LEGACY_HALL) {
      const discOn = this.hooks.discOn?.() ?? false;
      this.lift.group.visible = discOn;
      if (discOn) {
        const head = this.head();
        const sane = this.metresPerUnit >= 0.5 && this.metresPerUnit <= 4;
        const surface = this.grounded && !carried && sane ? (this.ground(head.x, head.z)?.on ?? null) : null;
        if (this.lift.update(dt, head, surface, this.move?.kind === 'lift') && surface) this.startLift(surface);
      }
    }

    // Comfort vignette (closed in while carried or arriving).
    const speed = v.length();
    const vig = Math.max(vigWanted, THREE.MathUtils.clamp((speed - XR.vignetteFrom) / (XR.vignetteFull - XR.vignetteFrom), 0, 1) * XR.vignetteMax);
    const u = this.vignetteStrength;
    u.value += (vig - u.value) * Math.min(1, dt * 6);
    this.vignette.visible = u.value > 0.01;

    mark('xr.lift');
    this.updatePointSizes();
    this.updateSky();
    mark('xr.sky');
    this.hooks.view?.(this.head());
    mark('xr.view');
    this.updatePointer(a.select);
    mark('xr.pointer');
    this.updateWrist(dt, cpuMs);
    this.controllerLabels.update(
      dt,
      this.controllerModels.map(({ slot, model }) => ({ grip: slot.grip, model, hand: (slot.source?.handedness as 'left' | 'right' | undefined) ?? null })),
      this.head(),
      this.metresPerUnit,
    );
    mark('xr.wrist');

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
    // The open wrist panel sits above the left wrist (rising from it); the debug panel beside the scene panel.
    // A/B popped the time panel to show the speed change: put it away again after a moment.
    if (this.popUntil && performance.now() > this.popUntil) {
      if (this.open === 'time') this.open = null;
      this.popUntil = 0;
    }
    const wrist = this.input.hand('left')?.grip ?? null;
    this.wear(this.timePanel, wrist, 0, this.open === 'time');
    this.wear(this.scenePanel, wrist, 0, this.open === 'scene');
    this.wear(this.debugPanel, wrist, this.scenePanel.width + 0.012, this.open === 'scene' && this.debugShown);
    for (const p of [this.timePanel, this.scenePanel, this.debugPanel]) p.step(this.lastDt);
    if (hand) {
      this.raycaster.setFromXRController(hand.ray);
      this.raycaster.camera = this.camera;
      const onPanel = this.timePanel.hit(this.raycaster) ?? this.scenePanel.hit(this.raycaster) ?? this.debugPanel.hit(this.raycaster);
      const onCard = onPanel ? null : this.info.hit(this.raycaster);
      if (onPanel) {
        // A press on the panel, not on the world.
        hit = { point: onPanel.point, distance: onPanel.distance, label: '' };
        if (select) for (const p of [this.timePanel, this.scenePanel, this.debugPanel]) p.press();
        select = false;
      } else if (onCard) {
        // On the info card: only its close mark does anything.
        hit = { point: onCard.hit.point, distance: onCard.hit.distance, label: '' };
        if (select && onCard.close) this.info.hide();
        select = false;
      } else hit = this.hooks.pick(this.raycaster);
    }
    if ((this.panelAt += 1) % 15 === 0) {
      if (this.open === 'time') this.timePanel.refresh();
      if (this.open === 'scene') this.scenePanel.refresh();
      if (this.open === 'scene' && this.debugShown) this.debugPanel.refresh();
    }
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

    if (select) {
      // The trigger on something with a card opens it; on nothing, closes it.
      const card = hit ? (this.hooks.card?.(hit) ?? null) : null;
      if (card) this.info.show(card, this.rig, this.camera);
      else if (!hit?.label) this.info.hide();
    }
    this.info.update(this.lastDt);

    const hoverShown = !!hit && !!hit.label;
    this.hoverLabel.sprite.visible = hoverShown;
    if (hit && hoverShown) {
      this.hoverLabel.plate.set(hit.label, hit.note ? [hit.note] : []);
      this.hoverLabel.place(hit.point, eye, XR.labelAngular);
    }
  }

  /** Frame rate (for the debug panel) and the telemetry sample each second. */
  private updateWrist(dt: number, cpuMs: number) {
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
    const marked = performance.now() < this.markShownUntil ? `Marked #${this.marks}` : '';
    this.debugLines = [
      'DEBUG',
      `${this.fps.toFixed(0)} fps · cpu ${this.cpuMs.toFixed(1)} ms`,
      this.backendText(),
      `${this.metresPerUnit.toFixed(2)} m per unit`,
      ...(marked ? [marked] : []),
    ];
    this.cpuMs = cpuMs;
  }

  /** Wear a panel on `wrist`, `x` metres to the side, fading in or out as `on` says. */
  private wear(panel: ControlPanel, wrist: THREE.Object3D | null, x: number, on: boolean) {
    panel.shown = on && !!wrist;
    const m = panel.mesh;
    m.position.set(x, 0.07, 0.03);
    m.rotation.set(-0.75, 0, 0);
    if (m.parent === wrist) return;
    m.removeFromParent();
    wrist?.add(m);
  }

  private backendText() {
    const multiview = (this.renderer.xr as unknown as { useMultiview(): boolean }).useMultiview();
    return `${this.hooks.backend()}${multiview ? ' multiview' : ''}`;
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
      hz: (this.renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null)?.frameRate ?? null,
      labels: this.controllerLabels.state,
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
      // At (or below) standing height over the Disc or the shell: stand on it.
      const g = this.ground(x, z, this.rig.position.y)?.y ?? null;
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

  /** Desktop preview: a wrist panel held in front of `camera` (null to put it away). */
  previewPanel(camera: THREE.Camera | null, which: 'time' | 'scene' = 'scene') {
    const holder = (this.previewHolder ??= new THREE.Group());
    holder.removeFromParent();
    holder.clear();
    if (!camera) return;
    const panel = which === 'time' ? this.timePanel : this.scenePanel;
    panel.mesh.removeFromParent();
    panel.mesh.position.set(0, 0, 0);
    panel.mesh.rotation.set(0, 0, 0);
    panel.refresh();
    holder.add(panel.mesh);
    // In world units: as big as it would look 35 cm away at the default scale (its pivot is its bottom edge).
    const k = 1 / XR.metresPerUnit;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    holder.position.copy(camera.position).addScaledVector(fwd, 0.35 * k);
    holder.quaternion.copy(camera.quaternion);
    holder.translateY(-0.12 * k);
    holder.scale.setScalar(k);
    camera.parent ? camera.parent.add(holder) : this.rig.parent?.add(holder);
  }
  private previewHolder: THREE.Group | null = null;

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
