import * as THREE from 'three/webgpu';
import { DISC_TOP, HEADING } from '../scene/discworld';
import { TABLE_RADIUS } from '../scene/layout';
import { WINDOW_RADIUS } from '../mechanism/heights';

/**
 * The VR scene's layout (no hall): the player arrives standing on the Disc
 * (the orrery's walnut table, Discworld on), at the rim, facing the way
 * A'Tuin swims, with its raised head just beyond the edge (Discworld's VR
 * pose). Walkable ground is the Disc's top; the rim and the glass drum at
 * the hub are soft walls. With Discworld off there is no ground: the player
 * floats and flies.
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
 * The arrival point: on the Disc a step in from the rim, a little round from
 * the heading (SPAWN_ANGLE), facing A'Tuin's raised head (Discworld's VR
 * pose puts it just beyond the rim, near the Disc's level, turned toward
 * this side). Straight over the head it would show only the back of the
 * skull; from here it's a three-quarter view, a few degrees below eye level.
 */
export const SPAWN_ANGLE = THREE.MathUtils.degToRad(22);
/** Roughly where the raised head sits (world units, from Discworld's VR pose). */
export function headPoint() {
  return onDisc(26, 0).setY(GROUND_Y - 1);
}
export function spawnPoint(): Viewpoint {
  const head = onDisc(WALK_RADIUS - 0.6, SPAWN_ANGLE);
  const to = headPoint().sub(head).setY(0);
  return { head, yawDeg: yawFacing(to), onGround: true, note: "spawn: A'Tuin's raised head beyond the rim, ahead" };
}

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

/** Ground height under (x, z), or null for none (off the Disc, or Discworld off). */
export function groundAt(x: number, z: number, discOn: boolean): number | null {
  if (!discOn) return null;
  return x * x + z * z <= TABLE_RADIUS * TABLE_RADIUS ? GROUND_Y : null;
}
