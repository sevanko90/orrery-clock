import * as THREE from 'three/webgpu';
import { DISC_TOP, HEADING, SHELL_CROWN_Y, shellTopAt } from '../scene/discworld';
import { TABLE_RADIUS } from '../scene/layout';
import { WINDOW_RADIUS } from '../mechanism/heights';

/**
 * The VR scene's layout (no hall): the player arrives on the crown of
 * A'Tuin's shell, under the Disc, between the four elephants, facing the
 * way the turtle swims (its head ahead, as on the desktop). Walkable ground
 * is the shell's gentler top and the Disc's top (the orrery's walnut
 * table); on the Disc the rim and the glass drum at the hub are soft walls.
 * With Discworld off there is no ground: the player floats and flies.
 */

/** Height of the Disc's top (world units): the ground. */
export const GROUND_Y = DISC_TOP;
/** How far from the centre the player can walk: a soft wall just short of the brass rim, ~30 cm (as the player sees it) in. */
export function walkRadius(metresPerUnit: number) {
  return TABLE_RADIUS - 0.06 - Math.min(0.3 / metresPerUnit, 1);
}
/** The glass drum at the hub: walk round it, not through it (null once the player is a giant, taller than it many times over). */
export function drumRadius(metresPerUnit: number): number | null {
  return metresPerUnit < 0.5 ? null : WINDOW_RADIUS + 0.3 + 0.3 / metresPerUnit;
}
/** At the default scale. */
export const WALK_RADIUS = walkRadius(1.5);
export const DRUM_RADIUS = drumRadius(1.5)!;

/** Unit vector (world, horizontal) of the way A'Tuin swims: the turtle's +x after the stack's heading. */
export function headingDir(out = new THREE.Vector3()) {
  return out.set(Math.cos(HEADING), 0, -Math.sin(HEADING));
}

/** Rig yaw (degrees) that faces the player along a horizontal direction. */
export function yawFacing(dir: THREE.Vector3) {
  return THREE.MathUtils.radToDeg(Math.atan2(-dir.x, -dir.z));
}

export interface Viewpoint {
  /** Head position (world units). With `onGround`, y is the ground and the head stands at its own height above it. */
  head: THREE.Vector3;
  yawDeg: number;
  onGround: boolean;
  /** What to do there, for the walkthrough. */
  note: string;
}

/** Point on the Disc at radius r along a world direction angle (radians, from the heading, CCW from above). */
function onDisc(r: number, fromHeading: number) {
  const a = HEADING + fromHeading; // world angle, as atan2(-z, x)
  return new THREE.Vector3(Math.cos(a) * r, GROUND_Y, -Math.sin(a) * r);
}

/**
 * The arrival point: standing on the brass boss on the crown of A'Tuin's shell, facing the way
 * it swims. The Disc is a ceiling ~10 m up, held by the elephants all round;
 * the head reaches out past the front of the shell.
 */
export function spawnPoint(): Viewpoint {
  return { head: new THREE.Vector3(0, SHELL_CROWN_Y, 0), yawDeg: yawFacing(headingDir()), onGround: true, note: "spawn: on A'Tuin's shell under the Disc, facing its head" };
}

/**
 * Where the lift stands (world x, z): on the heading line just outside the
 * glass drum, so the deck end is beside the movement and the shell end lies
 * between the crown (the arrival) and A'Tuin's head.
 */
export function liftPoint() {
  const p = onDisc(DRUM_RADIUS + 1.6, 0);
  return new THREE.Vector2(p.x, p.z);
}
/** The Disc's underside (world y): the bottom of its plinth. */
export const UNDERSIDE_Y = 0;

/** Walkthrough viewpoints (also usable as telemetry teleports). */
export function viewpoints(): Record<string, Viewpoint> {
  // Off the rim, just below the Disc's edge, looking in at the front elephant
  // (it stands at 45° from the heading, 9 units in: from on top the Disc hides it).
  const rimAt = onDisc(TABLE_RADIUS + 4, Math.PI / 4).setY(GROUND_Y - 3.5);
  const rimIn = rimAt.clone().setY(0).negate().normalize();
  const hub = onDisc(DRUM_RADIUS + 1.6, Math.PI / 2);
  const toHub = hub.clone().setY(0).negate().normalize();
  // Far off to the side, level with the Disc's edge, the whole stack in profile.
  const side = onDisc(55, -Math.PI / 2).setY(-6);
  const toCentre = side.clone().setY(0).negate().normalize();
  return {
    spawn: spawnPoint(),
    rim: { head: rimAt, yawDeg: yawFacing(rimIn), onGround: false, note: 'just off the rim, under its edge: the front elephant and the shell below' },
    hub: { head: hub, yawDeg: yawFacing(toHub), onGround: true, note: 'beside the glass drum: the movement and the Sun' },
    far: { head: side, yawDeg: yawFacing(toCentre), onGround: false, note: 'far off in space: Disc, elephants and A\'Tuin in profile' },
  };
}

/** What the player stands on: the Disc's top or A'Tuin's shell. */
export type Surface = 'disc' | 'shell';

/**
 * The ground under (x, z) for feet at height `feetY`: the highest walkable
 * surface at or a little below them (the Disc when above it, the shell when
 * under the Disc), or null for none (off both, or Discworld off).
 */
export function groundAt(x: number, z: number, feetY: number, discOn: boolean): { y: number; on: Surface } | null {
  if (!discOn) return null;
  const step = 0.5;
  if (feetY >= GROUND_Y - step && x * x + z * z <= TABLE_RADIUS * TABLE_RADIUS) return { y: GROUND_Y, on: 'disc' };
  const shell = shellTopAt(x, z);
  if (shell !== null && feetY >= shell - step) return { y: shell, on: 'shell' };
  return null;
}
