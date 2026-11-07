import * as THREE from 'three/webgpu';
import { XR } from './config';

/**
 * Controller input, read into a small set of actions. Everything else in VR
 * works from these, never from raw buttons, so hand tracking can later feed
 * the same actions (a pinch for select, a palm-down fist for thrust).
 *
 * Controller layout (xr-standard gamepad):
 *  Left stick    walk / fly           Right stick X  snap turn
 *  Left trigger  jetpack thrust,      Right stick Y  rise / sink
 *                along the left aim   Right trigger  select (pointer ray)
 *  Y             back to the start    Right grip + stick Y  world scale
 *                                     Left grip  telemetry marker
 *  X             wrist readout on/off A / B          faster / slower time
 *                                     Right stick click  back to now
 */
export interface Actions {
  /** Left stick, x right, y forward (deadzoned). */
  move: THREE.Vector2;
  /** Jetpack thrust 0..1 and its direction (world, from the left controller). */
  thrust: number;
  thrustDir: THREE.Vector3;
  /** Right stick y, up positive (0 while scaling). */
  lift: number;
  /** Snap turns this frame: -1 left, +1 right, 0 none. */
  snapTurn: number;
  /** Scale control: stick deflection while the right grip is held (0 otherwise). */
  scale: number;
  scaling: boolean;
  /** Edges (true for the one frame they're pressed). */
  select: boolean;
  reset: boolean;
  toggleHud: boolean;
  /** Left grip: drop a telemetry marker here. */
  mark: boolean;
  faster: boolean;
  slower: boolean;
  now: boolean;
}

type Hand = 'left' | 'right';

interface Slot {
  ray: THREE.XRTargetRaySpace;
  grip: THREE.XRGripSpace;
  source: XRInputSource | null;
  pressed: boolean[];
}

const dead = (v: number) => (Math.abs(v) < XR.stickDeadzone ? 0 : (v - Math.sign(v) * XR.stickDeadzone) / (1 - XR.stickDeadzone));

export class XrInput {
  readonly actions: Actions = {
    move: new THREE.Vector2(),
    thrust: 0,
    thrustDir: new THREE.Vector3(0, 1, 0),
    lift: 0,
    snapTurn: 0,
    scale: 0,
    scaling: false,
    select: false,
    reset: false,
    toggleHud: false,
    mark: false,
    faster: false,
    slower: false,
    now: false,
  };
  private slots: Slot[];
  private turnArmed = true;

  constructor(renderer: THREE.WebGPURenderer, parent: THREE.Object3D) {
    this.slots = [0, 1].map((i) => {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const slot: Slot = { ray, grip, source: null, pressed: [] };
      ray.addEventListener('connected', (e) => {
        slot.source = (e as unknown as { data: XRInputSource }).data;
        slot.pressed = [];
      });
      ray.addEventListener('disconnected', () => (slot.source = null));
      parent.add(ray, grip);
      return slot;
    });
  }

  /** The controller (pointer space and grip) held in this hand, if one is connected. */
  hand(hand: Hand): { ray: THREE.XRTargetRaySpace; grip: THREE.XRGripSpace } | null {
    const s = this.slots.find((x) => x.source?.handedness === hand && x.source.gamepad);
    return s ? { ray: s.ray, grip: s.grip } : null;
  }

  /** Every controller slot, connected or not (for attaching models). */
  get all() {
    return this.slots;
  }

  /** Buzz both controllers (strength 0..1). */
  rumble(strength: number, ms: number) {
    for (const s of this.slots) s.source?.gamepad?.hapticActuators?.[0]?.pulse(strength, ms).catch(() => undefined);
  }

  update() {
    const a = this.actions;
    a.move.set(0, 0);
    a.thrust = a.lift = a.snapTurn = a.scale = 0;
    a.scaling = a.select = a.reset = a.toggleHud = a.mark = a.faster = a.slower = a.now = false;

    for (const s of this.slots) {
      const pad = s.source?.gamepad;
      if (!pad) continue;
      const hand = s.source!.handedness;
      const down = (i: number) => pad.buttons[i]?.pressed ?? false;
      const edge = (i: number) => down(i) && !s.pressed[i];
      const sx = dead(pad.axes[2] ?? 0),
        sy = -dead(pad.axes[3] ?? 0);

      if (hand === 'left') {
        a.move.set(sx, sy);
        a.thrust = pad.buttons[0]?.value ?? 0;
        a.thrustDir.set(0, 0, -1).transformDirection(s.ray.matrixWorld);
        a.reset = edge(5);
        a.toggleHud = edge(4);
        a.mark = edge(1);
      } else if (hand === 'right') {
        a.scaling = down(1);
        if (a.scaling) a.scale = sy;
        else a.lift = sy;
        // Snap turn fires once per flick: the stick has to come back before the next.
        const x = pad.axes[2] ?? 0;
        if (this.turnArmed && Math.abs(x) > 0.6 && !a.scaling) {
          a.snapTurn = Math.sign(x);
          this.turnArmed = false;
        } else if (Math.abs(x) < 0.3) this.turnArmed = true;
        a.select = edge(0);
        a.faster = edge(4);
        a.slower = edge(5);
        a.now = edge(3);
      }
      pad.buttons.forEach((b, i) => (s.pressed[i] = b.pressed));
    }
  }
}
