import * as THREE from 'three/webgpu';
import { flipWinding, mergeStaticMeshes } from './merge';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { decimateTree } from './decimate';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  attribute,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  materialEmissive,
  texture,
  mod,
  modelViewMatrix,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { particleFloat, particleVec3, particles, pointSize } from './pointSize';
import type { Materials } from './materials';
import { TABLE_RADIUS } from './layout';
import { BOTTOM_PLATE, PLATE_T } from '../mechanism/heights';

/**
 * Discworld mode: the walnut table becomes the Disc, carried on the backs of
 * four bronze elephants who stand on the brass shell of Great A'Tuin, swimming
 * through the cosmos. Everything is built from primitives as a clockmaker's
 * automaton, with water pouring off the rim (the Rimfall).
 *
 * Scale is artistic: the turtle is only a little wider than the Disc so the
 * whole stack fits comfortably in frame.
 */

/** Disc underside is at y = 0; the table's top (where the rim sits) is here. */
export const DISC_TOP = BOTTOM_PLATE - PLATE_T / 2;

// Shell half-axes (turtle frame: +x forward, y up).
const RX = 18;
const RY = 6.5;
const RZ = 15;
/** Elephants stand this far from the shell's centre, on the diagonals. */
const ELEPHANT_R = 9;
/** Elephant model height (feet to top of the bearing pad), before scaling. */
const ELEPHANT_H = 8;
const ELEPHANT_SCALE = 1.15;
/** Height of the shell surface above its rim at the elephants' footprint. */
const FOOT_ON_SHELL = RY * Math.sqrt(1 - (ELEPHANT_R / Math.SQRT2 / RX) ** 2 - (ELEPHANT_R / Math.SQRT2 / RZ) ** 2);
/** Shell rim height so the elephants' pads just touch the Disc's underside. */
const SHELL_Y = -ELEPHANT_H * ELEPHANT_SCALE - FOOT_ON_SHELL + 0.25;
/** Overall heading of the stack, so A'Tuin swims across the default view. */
export const HEADING = THREE.MathUtils.degToRad(-30);
/** The brass boss on the shell's apex: half-axes (x, height, z) in the turtle's frame. */
const BOSS = { x: 2.2, h: 0.5, z: 2.0 };
/** Height of the top of the boss on the shell's crown (world units): where the VR player arrives. */
export const SHELL_CROWN_Y = SHELL_Y + RY + BOSS.h;

export const DISC_HOME_TARGET = new THREE.Vector3(0, -7, 0);
export const DISC_HOME_CAMERA = new THREE.Vector3(56, 6, 62);

const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

interface DiscMaterials {
  brass: THREE.Material;
  brassDark: THREE.Material;
  bronze: THREE.Material;
  shell: THREE.Material;
  steel: THREE.Material;
  ear: THREE.Material;
  earSheet: THREE.Material;
  eye: THREE.Material;
}

function makeMaterials(mats: Materials): DiscMaterials {
  const bronze = mats.brassDark.clone();
  bronze.color.set('#6a4526');
  bronze.roughness = 0.5;
  const shell = mats.brass.clone();
  shell.color.set('#b98b3f');
  shell.roughness = 0.5;
  return {
    brass: mats.brass,
    brassDark: mats.brassDark,
    bronze,
    shell,
    steel: mats.steel,
    ear: Object.assign(mats.brassDark.clone(), { side: THREE.DoubleSide, roughness: 0.62 }),
    // No brushed map: it pinches at the dish's pole.
    earSheet: Object.assign(bronze.clone(), { side: THREE.DoubleSide, roughnessMap: null }),
    eye: new THREE.MeshStandardMaterial({ color: '#ffb347', emissive: '#ff9a2a', emissiveIntensity: 2.2, roughness: 0.3 }),
  };
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, pos?: [number, number, number], scale?: [number, number, number]) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (scale) m.scale.set(...scale);
  return m;
}

/** A cylinder spanning two points. */
function strut(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, mat: THREE.Material, seg = 14) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, seg), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

function swimWord(rate: number) {
  if (rate === 0.1) return 'Drifting';
  if (rate < 0) return 'Backstroke';
  if (rate < 0.4) return 'Steady paddle';
  if (rate < 1.1) return 'Brisk';
  return 'Flat out';
}

// ---- Elephant -----------------------------------------------------------------

/**
 * One jointed leg: hip and knee hinge about axles across the body (z), and
 * the ankle keeps the hoof level.
 */
interface LegRig {
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
  shin: THREE.Mesh;
}

const THIGH = 2.25;
const SHIN = 2.05;
const HOOF = 0.3;
const HIP_Y = 4.6;

/** Lengthen or shorten the shin (and drop the hoof) by `delta`. */
function setShinExtension(leg: LegRig, delta: number) {
  const len = SHIN + delta;
  leg.shin.scale.y = len / SHIN;
  leg.shin.position.y = -len / 2;
  leg.ankle.position.y = -len;
}

/** Pose a leg (radians; positive hip swings the foot forward). */
function poseLeg(leg: LegRig, hipA: number, kneeA: number) {
  leg.hip.rotation.z = hipA;
  leg.knee.rotation.z = kneeA;
  leg.ankle.rotation.z = -(hipA + kneeA) * 0.85;
}

/** A joint: a bronze drum across the leg (z) with small brass caps. */
function joint(m: DiscMaterials, r: number, len: number) {
  const g = new THREE.Group();
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24), m.bronze);
  drum.rotation.x = Math.PI / 2;
  g.add(drum);
  for (const s of [1, -1]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.4, r * 0.5, 0.08, 16), m.brassDark);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = s * (len / 2 + 0.03);
    g.add(cap);
  }
  return g;
}

function buildLeg(m: DiscMaterials, x: number, z: number): LegRig {
  const hip = new THREE.Group();
  hip.position.set(x, HIP_Y, z);
  hip.add(joint(m, 0.52, 2.0));
  const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.78, THIGH - 0.2, 16), m.bronze);
  thigh.position.y = -THIGH / 2 - 0.05;
  hip.add(thigh);

  const knee = new THREE.Group();
  knee.position.y = -THIGH;
  knee.add(joint(m, 0.62, 1.75));
  const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.86, SHIN, 16), m.bronze);
  knee.add(shin);
  hip.add(knee);

  const ankle = new THREE.Group();
  const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 1.1, HOOF, 20), m.brassDark);
  hoof.position.y = -HOOF / 2;
  ankle.add(hoof);
  knee.add(ankle);

  const leg: LegRig = { hip, knee, ankle, shin };
  setShinExtension(leg, 0);
  return leg;
}

/**
 * Elephant body ellipsoid: long and fairly shallow, so the belly sits about
 * halfway up and the legs read long (after a side-on photo of a herd).
 */
const BODY = { cy: 5.3, rx: 3.4, ry: 1.95, rz: 2.1 };

/** Half-width (|z|) of an ellipsoid centred on the elephant's midline at (x, y), or 0 outside it. */
function halfWidth(x: number, y: number, cx: number, cy: number, rx: number, ry: number, rz: number) {
  const k = 1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2;
  return k > 0 ? rz * Math.sqrt(k) : 0;
}

/** Where an ear hinges: on the side of the head, at its root. */
const EAR_PIVOT = new THREE.Vector3(3.0, 5.7, 1.25);

/**
 * A cast ear: a big oval dish (a spherical cap) cupped outward, drawn into a
 * teardrop with the lobe toward the head and the top edge curling out, with
 * a rolled rim. It hangs over the front shoulder, standing just outside the
 * band the front leg swings in, and its root is set into the side of the
 * head. Built in the elephant's frame (+x forward) and returned as a group
 * pivoting at the root, so it can flare forward and out.
 */
function buildEar(m: DiscMaterials, side: number) {
  const capAngle = 1.0;
  const R = Math.sin(capAngle);
  const SX = 1.45,
    SY = 2.15;
  const shape = (geo: THREE.BufferGeometry) => {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const yn = pos.getY(i) / R;
      let x = pos.getX(i) * SX;
      if (yn < 0) x = x * (1 - 0.3 * yn * yn) + 0.45 * yn * yn; // narrow lobe, toward the head
      const y = pos.getY(i) * SY;
      const z = pos.getZ(i) * 0.7 + 0.18 * Math.max(0, yn) ** 2; // cupped; top edge curls out
      pos.setXYZ(i, x, y, z);
    }
    return geo;
  };

  const place = new THREE.Matrix4().compose(
    new THREE.Vector3(1.95, 5.6, side * 2.25),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * 0.12),
    new THREE.Vector3(1, 1, side),
  );
  const smoothMax = (a: number, b: number, k: number) => 0.5 * (a + b + Math.sqrt((a - b) ** 2 + k * k));
  const fit = (geo: THREE.BufferGeometry) => {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const front = Array.from({ length: pos.count }, (_, i) => THREE.MathUtils.smoothstep(pos.getX(i) / (R * SX), 0.45, 1));
    geo.applyMatrix4(place);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i),
        y = pos.getY(i);
      let z = Math.abs(pos.getZ(i));
      // Stand clear of the body, and outside the front leg's hip and swing.
      const legBand =
        2.42 *
        THREE.MathUtils.smoothstep(x, 0.9, 1.4) *
        (1 - THREE.MathUtils.smoothstep(x, 2.7, 3.3)) *
        (1 - THREE.MathUtils.smoothstep(y, 5.0, 5.6));
      z = smoothMax(z, Math.max(halfWidth(x, y, 0, BODY.cy, BODY.rx, BODY.ry, BODY.rz) + 0.14, legBand), 0.35);
      // Draw the root onto the side of the head.
      const head = Math.max(halfWidth(x, y, 3.8, 6.1, 1.6, 1.75, 1.5), halfWidth(x, y, 3.4, 7.1, 1.2, 0.9, 1.2));
      // Only where the head is broad; below it the lobe hangs free.
      const w = front[i] * THREE.MathUtils.smoothstep(head, 0.7, 1.05);
      if (w > 0) z = THREE.MathUtils.lerp(z, Math.min(z, head - 0.06), w);
      pos.setXYZ(i, x - EAR_PIVOT.x, y - EAR_PIVOT.y, side * z - side * EAR_PIVOT.z);
    }
    geo.computeVertexNormals();
    return geo;
  };

  const dish = new THREE.SphereGeometry(1, 48, 18, 0, Math.PI * 2, 0, capAngle);
  dish.rotateX(Math.PI / 2);
  dish.translate(0, 0, -Math.cos(capAngle));
  const rim = new THREE.TorusGeometry(R, 0.06, 8, 80);

  const ear = new THREE.Group();
  ear.position.set(EAR_PIVOT.x, EAR_PIVOT.y, side * EAR_PIVOT.z);
  ear.add(new THREE.Mesh(fit(shape(dish)), m.earSheet), new THREE.Mesh(fit(shape(rim)), m.ear));
  return ear;
}

interface ElephantRig {
  group: THREE.Group;
  legs: LegRig[];
  /** +z ear first, matching legs[0]. */
  ears: THREE.Group[];
  head: THREE.Group;
  trunk: THREE.Group;
  phase: number;
}

/** Nameplate size and position on the flank, in elephant units. */
const PLAQUE = { cx: -0.5, w: 2.5, h: 0.8 };

const ELEPHANT_NAMES = ['Berilia', 'Tubul', "Great T'Phon", 'Jerakeen'];

/** What the info card shows for a Discworld figure. */
export interface Lore {
  id: string;
  name: string;
  kind: string;
  blurb: string;
  /** Stat rows; may change while shown (e.g. A'Tuin's swimming pace). */
  rows: () => [string, string][];
}

const ELEPHANT_BLURBS: Record<string, string> = {
  Berilia:
    "The Disc's small sun circles the world, passing between the elephants, and each must lift a leg to let it by. The elephants on this orrery shift their feet now and then as well.",
  Tubul:
    "There were once five elephants. The fifth slid from the turtle's back, fell onto the Disc and was buried deep in Überwald, where its fat and bones are still mined.",
  "Great T'Phon":
    'Everything that flows to the edge of the Disc pours over in the Rimfall. Along part of the edge, the island of Krull strings the Circumfence to catch whatever is swept towards the drop.',
  Jerakeen:
    "The Disc turns slowly on the elephants' shoulders. 'Turnwise' is the direction it spins and 'widdershins' the other; the other two directions are 'hubward' and 'rimward'.",
};

function elephantLore(name: string): Lore {
  return {
    id: `elephant:${name}`,
    name,
    kind: 'World-elephant',
    blurb: ELEPHANT_BLURBS[name],
    rows: () => [
      ['Stands on', "Great A'Tuin"],
      ['Carries', 'The Disc'],
      ['Faces', 'Rimward'],
    ],
  };
}

/** Engraved brass nameplate artwork; redrawn once the display font arrives. */
function plaqueTexture(name: string) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.round((1024 * PLAQUE.h) / PLAQUE.w);
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const draw = () => {
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, '#f0d58e');
    g.addColorStop(0.5, '#d2a752');
    g.addColorStop(1, '#a87d36');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    // Engraved double border.
    ctx.strokeStyle = '#4a3214';
    ctx.lineWidth = 6;
    ctx.strokeRect(18, 18, c.width - 36, c.height - 36);
    ctx.lineWidth = 2;
    ctx.strokeRect(32, 32, c.width - 64, c.height - 64);
    const text = name.toUpperCase();
    let size = 150;
    ctx.font = `600 ${size}px Cinzel, Georgia, serif`;
    while (ctx.measureText(text).width > c.width - 150 && size > 40) {
      size -= 4;
      ctx.font = `600 ${size}px Cinzel, Georgia, serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Cut letters: a bright lower lip under dark recessed strokes.
    ctx.fillStyle = 'rgba(255, 240, 200, 0.7)';
    ctx.fillText(text, c.width / 2, c.height / 2 + 5);
    ctx.fillStyle = '#3a240c';
    ctx.fillText(text, c.width / 2, c.height / 2 + 2);
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.load('600 64px Cinzel').then(draw, () => undefined);
  return tex;
}

/**
 * A nameplate conforming to the elephant's flank (body ellipsoid centred at
 * BODY). `side` is +1 or −1 for ±z; text
 * reads correctly from outside on both flanks.
 */
function flankPlaque(tex: THREE.Texture, side: number, rivetMat: THREE.Material) {
  const group = new THREE.Group();
  const cx = PLAQUE.cx,
    cy = BODY.cy + 0.1,
    w = PLAQUE.w,
    h = PLAQUE.h;
  const onBody = (u: number, v: number, lift: number) => {
    const x = cx + side * u;
    const y = cy + v;
    const z = halfWidth(x, y, 0, BODY.cy, BODY.rx, BODY.ry, BODY.rz) + lift;
    return new THREE.Vector3(x, y, side * z);
  };
  const geo = new THREE.PlaneGeometry(w, h, 24, 4);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const p = onBody(pos.getX(i), pos.getY(i), 0.035);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.85, roughness: 0.38 });
  group.add(new THREE.Mesh(geo, mat));
  const rivet = new THREE.SphereGeometry(0.06, 8, 6);
  for (const [u, v] of [
    [-w / 2 + 0.07, 0],
    [w / 2 - 0.07, 0],
  ]) {
    const r = new THREE.Mesh(rivet, rivetMat);
    r.position.copy(onBody(u, v, 0.05));
    group.add(r);
  }
  return group;
}

/** A bronze elephant, +x forward, feet at y = 0, bearing pad top at y = 8. */
function buildElephant(m: DiscMaterials, sphere: THREE.SphereGeometry, name: string): ElephantRig {
  const group = new THREE.Group();

  // Body with riveted brass girth bands.
  group.add(mesh(sphere, m.bronze, [0, BODY.cy, 0], [BODY.rx, BODY.ry, BODY.rz]));
  const band = new THREE.TorusGeometry(1, 0.07, 8, 48);
  for (const x of [-1.85, 1.9]) {
    const k = Math.sqrt(1 - (x / BODY.rx) ** 2);
    const b = mesh(band, m.brass, [x, BODY.cy, 0], [BODY.rz * k + 0.03, BODY.ry * k + 0.03, 1]);
    b.rotation.y = Math.PI / 2;
    group.add(b);
  }

  // Bearing pad on the back, which carries the Disc.
  group.add(mesh(new THREE.CylinderGeometry(2.5, 2.7, 0.25, 32), m.brassDark, [0, 7.22, 0]));
  group.add(mesh(new THREE.CylinderGeometry(1.0, 1.3, 0.5, 24), m.bronze, [0, 7.6, 0]));
  group.add(mesh(new THREE.CylinderGeometry(1.9, 1.6, 0.16, 32), m.brass, [0, 7.92, 0]));

  // Jointed legs.
  const legs: LegRig[] = [];
  for (const [x, z] of [
    [2.0, 1.2],
    [2.0, -1.2],
    [-2.0, 1.2],
    [-2.0, -1.2],
  ]) {
    const leg = buildLeg(m, x, z);
    group.add(leg.hip);
    legs.push(leg);
  }

  // Head, ears, tusks, eyes and an articulated trunk.
  const head = new THREE.Group();
  head.position.set(3.2, 5.8, 0);
  head.add(mesh(sphere, m.bronze, [0.6, 0.3, 0], [1.6, 1.75, 1.5]));
  head.add(mesh(sphere, m.bronze, [0.2, 1.3, 0], [1.2, 0.9, 1.2]));
  for (const s of [1, -1]) {
    const tuskCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.4, -0.7, s * 0.6),
      new THREE.Vector3(2.0, -1.3, s * 0.72),
      new THREE.Vector3(2.6, -1.55, s * 0.8),
      new THREE.Vector3(3.0, -1.4, s * 0.82),
    ]);
    head.add(new THREE.Mesh(tuskGeometry(tuskCurve, 0.16), m.steel));
    head.add(mesh(sphere, m.eye, [1.45, 0.8, s * 1.18], [0.17, 0.17, 0.17]));
    head.add(mesh(new THREE.TorusGeometry(0.22, 0.05, 6, 16), m.brass, [1.45, 0.8, s * 1.2]));
  }

  const trunk = new THREE.Group();
  trunk.position.set(1.9, 0.1, 0);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.8, -1.2, 0),
    new THREE.Vector3(0.9, -2.7, 0),
    new THREE.Vector3(0.6, -3.9, 0),
    new THREE.Vector3(1.2, -4.6, 0),
  ]);
  const N = 9;
  const ring = new THREE.TorusGeometry(1, 0.12, 6, 20);
  for (let i = 0; i < N; i++) {
    const a = curve.getPoint(i / N);
    const b = curve.getPoint((i + 1) / N);
    const r0 = THREE.MathUtils.lerp(0.62, 0.24, i / N);
    const r1 = THREE.MathUtils.lerp(0.62, 0.24, (i + 1) / N);
    trunk.add(strut(a, b, r0, r1, m.bronze, 12));
    if (i > 0) {
      const r = new THREE.Mesh(ring, m.brass);
      r.position.copy(a);
      r.scale.setScalar(r0 * 0.98);
      r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangent(i / N));
      trunk.add(r);
    }
  }
  head.add(trunk);
  group.add(head);

  // Riveted nameplates on both flanks.
  const tex = plaqueTexture(name);
  const plaques = [flankPlaque(tex, 1, m.brassDark), flankPlaque(tex, -1, m.brassDark)];
  for (const pl of plaques) pl.userData.lore = elephantLore(name);
  group.add(...plaques);

  // Tail.
  group.add(strut(new THREE.Vector3(-3.3, 5.7, 0), new THREE.Vector3(-3.75, 3.4, 0), 0.14, 0.08, m.bronze, 8));
  group.add(mesh(sphere, m.brass, [-3.77, 3.3, 0], [0.18, 0.3, 0.18]));

  const ears = [buildEar(m, 1), buildEar(m, -1)];
  group.add(...ears);

  return { group, legs, ears, head, trunk, phase: Math.random() * Math.PI * 2 };
}

/**
 * The walkable top of A'Tuin's shell under world point (x, z), or null off
 * it (the stack is centred on the origin, turned to HEADING), the brass
 * boss on its apex included. Only the
 * gentler part of the dome counts: past ~90% of the way out it is too steep
 * to stand on.
 */
export function shellTopAt(x: number, z: number): number | null {
  const c = Math.cos(HEADING),
    s = Math.sin(HEADING);
  const lx = x * c - z * s,
    lz = x * s + z * c;
  if ((lx / RX) ** 2 + (lz / RZ) ** 2 > 0.81) return null;
  // The brass boss on the apex stands up from the dome: stand on it too.
  const b = 1 - (lx / BOSS.x) ** 2 - (lz / BOSS.z) ** 2;
  const shell = SHELL_Y + shellHeight(lx, lz);
  return b > 0 ? Math.max(shell, SHELL_Y + RY + BOSS.h * Math.sqrt(b)) : shell;
}

/** Height of the shell dome above its rim at (x, z) in the turtle's frame. */
function shellHeight(x: number, z: number) {
  return RY * Math.sqrt(Math.max(0, 1 - (x / RX) ** 2 - (z / RZ) ** 2));
}

/** Stretch each leg so its foot rests on the curved shell. */
function fitLegsToShell(rig: ElephantRig, a: number) {
  const S = ELEPHANT_SCALE;
  const g = rig.group.position;
  const hipY = g.y + HIP_Y * S;
  for (const leg of rig.legs) {
    const lx = leg.hip.position.x * S,
      lz = leg.hip.position.z * S;
    const x = g.x + lx * Math.cos(a) + lz * Math.sin(a);
    const z = g.z - lx * Math.sin(a) + lz * Math.cos(a);
    const footY = SHELL_Y + shellHeight(x, z) - 0.12;
    setShinExtension(leg, (hipY - footY) / S - (THIGH + SHIN + HOOF));
  }
}

// ---- Turtle -------------------------------------------------------------------

interface TurtleRig {
  group: THREE.Group;
  head: THREE.Group;
  front: THREE.Group[];
  rear: THREE.Group[];
}

/** Point on the shell dome at polar angle θ (0 = apex) and azimuth φ. */
function shellPoint(theta: number, phi: number, lift = 1.004) {
  return new THREE.Vector3(
    RX * Math.sin(theta) * Math.cos(phi) * lift,
    RY * Math.cos(theta) * lift,
    RZ * Math.sin(theta) * Math.sin(phi) * lift,
  );
}

function buildFlipper(m: DiscMaterials, sphere: THREE.SphereGeometry, side: number, size: number) {
  const pivot = new THREE.Group();
  const paddle = new THREE.Group();
  paddle.rotation.y = -side * 0.55; // swept back
  paddle.scale.setScalar(size);
  paddle.add(mesh(sphere, m.bronze, [0, 0, side * 6.2], [2.8, 0.5, 6.4]));
  // Brass ribs running out along the paddle, like the stays of a fan.
  for (const x of [-1.2, 0, 1.2]) {
    paddle.add(strut(new THREE.Vector3(x * 0.6, 0.35, side * 0.6), new THREE.Vector3(x, 0.32, side * 10.5), 0.11, 0.07, m.brass, 6));
  }
  paddle.add(mesh(sphere, m.brass, [0, 0, side * 0.4], [1.5, 1.5, 1.5]));
  pivot.add(paddle);
  return pivot;
}

function buildTurtle(m: DiscMaterials, sphere: THREE.SphereGeometry, lowQuality: boolean): TurtleRig {
  const group = new THREE.Group();

  // Upper shell, plastron and the marginal rim band.
  const dome = new THREE.SphereGeometry(1, lowQuality ? 48 : 96, lowQuality ? 16 : 32, 0, Math.PI * 2, 0, Math.PI / 2);
  group.add(mesh(dome, m.shell, [0, 0, 0], [RX, RY, RZ]));
  const under = new THREE.SphereGeometry(1, 48, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  group.add(mesh(under, m.bronze, [0, 0, 0], [RX * 0.97, 2.8, RZ * 0.97]));
  const rimPts = Array.from({ length: 96 }, (_, i) => {
    const a = (i / 96) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * RX * 1.01, 0, Math.sin(a) * RZ * 1.01);
  });
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts, true), 192, 0.55, 10, true), m.brassDark));

  // Scute seams: meridian ribs and latitude bands, riveted where they meet.
  const ribs = 10;
  const lats = [0.42, 0.85, 1.25];
  const rivetSpots: THREE.Vector3[] = [];
  for (let i = 0; i < ribs; i++) {
    const phi = (i / ribs) * Math.PI * 2 + Math.PI / ribs;
    const pts = Array.from({ length: 16 }, (_, j) => shellPoint(lats[0] + (j / 15) * (Math.PI / 2 - lats[0]), phi));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.16, 6), m.brassDark));
    for (const t of lats) rivetSpots.push(shellPoint(t, phi, 1.012));
  }
  for (const t of lats) {
    const pts = Array.from({ length: 64 }, (_, j) => shellPoint(t, (j / 64) * Math.PI * 2));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 128, 0.16, 6, true), m.brassDark));
    for (let j = 0; j < 40; j++) rivetSpots.push(shellPoint(t, (j / 40) * Math.PI * 2, 1.012));
  }
  // Boss on the apex.
  group.add(mesh(sphere, m.brass, [0, RY, 0], [BOSS.x, BOSS.h, BOSS.z]));
  const rivets = new THREE.InstancedMesh(new THREE.SphereGeometry(0.24, 8, 6), m.brass, rivetSpots.length);
  const mtx = new THREE.Matrix4();
  rivetSpots.forEach((p, i) => rivets.setMatrixAt(i, mtx.makeTranslation(p.x, p.y, p.z)));
  group.add(rivets);

  // Neck (armoured segments) and head with glowing eyes.
  const head = new THREE.Group();
  head.position.set(RX - 1.5, -0.6, 0);
  for (let i = 0; i < 4; i++) {
    const r = 2.9 - i * 0.18;
    const seg = mesh(new THREE.CylinderGeometry(r, r + 0.2, 1.3, 28), i % 2 ? m.brassDark : m.bronze, [1 + i * 1.25, 0, 0]);
    seg.rotation.z = Math.PI / 2;
    head.add(seg);
  }
  const skull = new THREE.Group();
  skull.position.set(7.4, 0.4, 0);
  skull.add(mesh(sphere, m.bronze, [0, 0, 0], [4.2, 2.8, 3.1]));
  skull.add(mesh(sphere, m.brass, [-0.4, 1.7, 0], [3.0, 1.2, 2.2]));
  const beak = mesh(new THREE.ConeGeometry(1.5, 2.6, 20), m.brassDark, [4.4, -0.7, 0], [1, 1, 1.5]);
  beak.rotation.z = -Math.PI / 2 - 0.35;
  skull.add(beak);
  for (const s of [1, -1]) {
    skull.add(mesh(sphere, m.eye, [2.2, 0.9, s * 2.35], [0.62, 0.62, 0.62]));
    const bezel = mesh(new THREE.TorusGeometry(0.72, 0.14, 8, 24), m.brass, [2.2, 0.9, s * 2.42]);
    bezel.rotation.y = s * 0.5;
    skull.add(bezel);
  }
  head.add(skull);
  skull.userData.lore = 'atuin';
  group.add(head);

  // Flippers: big front pair, small rear pair.
  const front: THREE.Group[] = [];
  const rear: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const f = buildFlipper(m, sphere, s, 1.15);
    f.position.set(RX * 0.5, -1.2, s * RZ * 0.82);
    group.add(f);
    front.push(f);
    const r = buildFlipper(m, sphere, s, 0.6);
    r.position.set(-RX * 0.62, -1.2, s * RZ * 0.68);
    r.rotation.y = -s * 0.9;
    group.add(r);
    rear.push(r);
  }

  // Tail.
  const tail = mesh(new THREE.ConeGeometry(1.4, 5, 16), m.bronze, [-RX - 2, -0.8, 0]);
  tail.rotation.z = Math.PI / 2;
  group.add(tail);

  return { group, head, front, rear };
}

// ---- Rimfall and space dust ---------------------------------------------------

function buildRimfall(count: number, pixelScale: number) {
  const angle = new Float32Array(count);
  const seed = new Float32Array(count);
  const rate = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    angle[i] = Math.random() * Math.PI * 2;
    seed[i] = Math.random();
    rate[i] = 0.24 + Math.random() * 0.12;
  }
  const aAngle = particleFloat(angle).node;
  const aSeed = particleFloat(seed).node;
  const aRate = particleFloat(rate).node;
  const uniforms = { uTime: uniform(0), uOpacity: uniform(0) };
  const radius = TABLE_RADIUS + 0.05;
  const top = DISC_TOP + 0.04;
  const { sprite } = particles(count, (mat) => {
    const life = fract(uniforms.uTime.mul(aRate).add(aSeed));
    const t = life.mul(3.6);
    // Pour outward over the lip, then fall away and spread into spray.
    const jitter = fract(aSeed.mul(91.7)).sub(0.5);
    const r = t
      .mul(fract(aSeed.mul(13.1)).mul(0.25).add(0.55))
      .add(t.mul(t).mul(0.18))
      .add(radius);
    const a = aAngle.add(jitter.mul(0.01).mul(t));
    const y = float(top).sub(t.mul(t).mul(2.6)).sub(t.mul(0.4));
    const p = vec3(cos(a).mul(r), y, sin(a).mul(r));
    mat.positionNode = p;
    const depth = modelViewMatrix.mul(vec4(p, 1)).z.negate();
    mat.sizeNode = pointSize(float(pixelScale).mul(life.mul(0.16).add(0.1)).div(depth));
    const fade = smoothstep(0, 0.04, life).mul(life.oneMinus().pow(1.4));
    const soft = smoothstep(0, 0.5, uv().sub(0.5).length()).oneMinus();
    mat.colorNode = vec3(0.62, 0.8, 1.0).mul(soft);
    mat.opacityNode = soft.mul(fade).mul(uniforms.uOpacity).mul(0.55);
  });
  return { points: sprite, uniforms };
}

/** Motes of space dust streaming past, so A'Tuin visibly swims. */
function buildDust(count: number, pixelScale: number) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 160;
    pos[i * 3 + 1] = -12 + (Math.random() - 0.5) * 70;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 160;
  }
  const aPos = particleVec3(pos).node;
  const uniforms = { uOffset: uniform(0), uOpacity: uniform(0) };
  const { sprite } = particles(count, (mat) => {
    const x = mod(aPos.x.sub(uniforms.uOffset).add(80), 160).sub(80);
    const p = vec3(x, aPos.y, aPos.z);
    mat.positionNode = p;
    const fadeX = smoothstep(55, 80, x.abs()).oneMinus();
    const depth = modelViewMatrix.mul(vec4(p, 1)).z.negate();
    mat.sizeNode = pointSize(
      float(pixelScale * 0.12)
        .div(depth)
        .add(1),
    );
    const soft = smoothstep(0.1, 0.5, uv().sub(0.5).length()).oneMinus();
    mat.colorNode = vec3(1.0, 0.9, 0.75).mul(soft);
    mat.opacityNode = soft.mul(fadeX).mul(uniforms.uOpacity).mul(0.5);
  });
  return { points: sprite, uniforms };
}

// ---- Assembly -----------------------------------------------------------------

export class Discworld {
  readonly root = new THREE.Group();
  /**
   * The tabletop: once formed, the stack stands still (no swimming, ear
   * fans or stamps) and is baked into one mesh per material, in its pose
   * then: ~19 draws and their per-frame sync become ~4. Its materials are
   * the same, so it still dissolves away. The dust and Rimfall keep moving.
   */
  freeze = false;
  private baked: THREE.Group | null = null;
  /** Is the stack baked (its live parts hidden, nothing for their batches to sync)? */
  get isBaked() {
    return this.baked !== null;
  }
  /** Triangles before and after the headset's simplification (telemetry), or null. */
  trianglesSaved: { before: number; after: number } | null = null;
  /** 0 = hidden, 1 = fully assembled. */
  progress = 0;
  /** Earthquake strength (0–1), for a little camera shake. */
  quake = 0;
  private target = 0;
  private stack = new THREE.Group();
  private elephants: ElephantRig[] = [];
  private elephantGroup = new THREE.Group();
  private turtle: TurtleRig;
  private rimfall: ReturnType<typeof buildRimfall>;
  private dust: ReturnType<typeof buildDust>;
  private lights: { light: THREE.DirectionalLight; base: number }[] = [];
  private swimPhase = 0;
  private swimDistance = 0;
  private time = 0;
  private nextQuake = 18;
  private lift: { rig: ElephantRig; leg: number; t: number } | null = null;
  /** Current stroke rate (signed; negative swims backwards). */
  private rate = 0;
  private pickables: THREE.Object3D[] = [];
  /** Shapes still waiting for a ray index (BVH); a few are built per pick so none stalls a frame. */
  private bvhQueue: THREE.BufferGeometry[] = [];
  /** The hit behind the last pickLore() result (where the ray lands), or null. */
  loreHit: THREE.Intersection | null = null;
  private turtleLore: Lore = {
    id: 'atuin',
    name: "Great A'Tuin",
    kind: 'Star turtle',
    blurb:
      "The star turtle carries the four elephants, and they the Disc, through space. Nobody knows its sex or its destination. The 'Steady Gait' theory says it swims forever at the same pace; the 'Big Bang' theory says it is heading for a mating place. Astrozoologists from Krull once launched a voyage over the Rim to find out.",
    rows: () => [
      ['Species', 'Chelys galactica'],
      ['Sex', 'Unknown'],
      ['Shell', 'about 10,000 miles'],
      ['Swimming', swimWord(this.rate)],
    ],
  };

  constructor(mats: Materials, opts: { lowQuality: boolean; pixelRatio: number; decimate?: boolean }) {
    this.root.name = 'discworld';
    this.root.visible = false;
    const m = makeMaterials(mats);
    const sphere = new THREE.SphereGeometry(1, opts.lowQuality ? 20 : 32, opts.lowQuality ? 14 : 20);

    this.stack.rotation.y = HEADING;
    this.stack.name = 'stack';
    this.root.add(this.stack);

    this.turtle = buildTurtle(m, sphere, opts.lowQuality);
    this.turtle.group.position.y = SHELL_Y;
    this.stack.add(this.turtle.group, this.elephantGroup);

    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const rig = buildElephant(m, sphere, ELEPHANT_NAMES[i]);
      rig.group.scale.setScalar(ELEPHANT_SCALE);
      rig.group.position.set(Math.cos(a) * ELEPHANT_R, SHELL_Y + FOOT_ON_SHELL - 0.25, -Math.sin(a) * ELEPHANT_R);
      rig.group.rotation.y = a; // face outward
      fitLegsToShell(rig, a);
      this.elephantGroup.add(rig.group);
      this.elephants.push(rig);
    }

    // Let the Disc shade the stack from the orrery's Sun above it.
    this.stack.traverse((o) => (o.receiveShadow = true));
    // Hundreds of small parts: bake each rig's fixed parts together to cut draw calls
    // (the shins stretch as the legs step, so they stay separate).
    mergeStaticMeshes(this.stack, new Set(this.elephants.flatMap((e) => e.legs.map((l) => l.shin))));
    // Headset: a lighter stack (~137k triangles, none of it with LODs, ~5 fps of a warm Quest's
    // GPU at tabletop size): each mesh simplified to about a third, keeping its silhouette.
    if (opts.decimate) this.trianglesSaved = decimateTree(this.stack);

    // World units to pixels at unit distance, for point sprites (40° fov).
    const pixelScale = (innerHeight * opts.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
    this.rimfall = buildRimfall(opts.lowQuality ? 3000 : 9000, pixelScale);
    this.dust = buildDust(opts.lowQuality ? 500 : 1400, pixelScale);
    this.rimfall.points.name = 'rimfall';
    this.root.add(this.rimfall.points);
    this.stack.add(this.dust.points);

    // The orrery's Sun only lights the Disc from above: add a cool light from
    // the depths and a warm key from the side so the stack reads underneath.
    const under = new THREE.DirectionalLight(0x9db4ff, 0);
    under.position.set(-30, -60, 25);
    const key = new THREE.DirectionalLight(0xffcf96, 0);
    key.position.set(60, -8, 45);
    under.name = 'disc-under';
    key.name = 'disc-key';
    this.lights.push({ light: under, base: 1.4 }, { light: key, base: 1.1 });
    this.root.add(under, key);
    this.makeDissolvable();
  }

  /**
   * The tabletop leaves the Disc by dissolving it where it is (sinking, it
   * went through the room's floor). 0 = whole, past 1 = gone.
   */
  private dissolveU = uniform(0);
  /**
   * The tabletop: come and go by dissolving in place instead of rising from
   * below and sinking away (both went through the room's floor). Coming in,
   * it forms from the Disc down to A'Tuin; going, it's eaten from A'Tuin up.
   */
  dissolveOnExit = false;
  /** Seconds a dissolve takes, going and coming. */
  private static DISSOLVE_S = 0.9;
  private static FORM_S = 2;

  private dissolveMask!: THREE.Node<'bool'>;
  private dissolveGlow!: THREE.Node<'vec3'>;
  /** The baked stack's two shared materials (made on first bake). */
  private bakedMats: { metal: THREE.MeshStandardNodeMaterial; ears: THREE.MeshStandardNodeMaterial } | null = null;

  /**
   * Materials for the baked stack: colour, roughness and metalness per vertex,
   * so every metal part (and the name plaques, unreadable at tabletop size,
   * as plain brass) is one draw, and both ears another; with the dissolve.
   */
  private bakeMaterials(brushed: THREE.Texture | null) {
    if (this.bakedMats) return this.bakedMats;
    const make = (side: THREE.Side) => {
      const m = new THREE.MeshStandardNodeMaterial({ side });
      m.colorNode = attribute('color', 'vec3');
      const rough = attribute('rough', 'float');
      m.roughnessNode = brushed ? rough.mul(texture(brushed, uv()).g) : rough;
      m.metalnessNode = attribute('metal', 'float');
      m.maskNode = this.dissolveMask;
      m.emissiveNode = this.dissolveGlow;
      m.name = 'stack-baked';
      return m;
    };
    this.bakedMats = { metal: make(THREE.FrontSide), ears: make(THREE.DoubleSide) };
    return this.bakedMats;
  }

  /**
   * Give the stack its own copies of its lit materials (they're shared with
   * the orrery), each with a dissolve mask: eaten away from A'Tuin up to the
   * Disc through a ragged noise edge that glows brass as it goes. Built in
   * from the start, so a dissolve compiles nothing.
   */
  private makeDissolvable() {
    const u = this.dissolveU;
    // How soon a point goes: low first (A'Tuin's underside ~-19, the Disc ~0), ragged with noise.
    const height = clamp(positionWorld.y.add(19).div(19.5), 0, 1);
    // (Ragged with a single hash per small cell: 3D Perlin noise on every pixel of the stack,
    // even at rest, cost the headset ~3 ms of GPU a frame.)
    const cellNoise = fract(sin(dot(floor(positionWorld.mul(2.5)), vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    const key = height.mul(0.75).add(cellNoise.mul(0.25));
    const edge = smoothstep(u.add(0.07), u, key).mul(step(0.001, u));
    this.dissolveMask = key.greaterThan(u);
    this.dissolveGlow = vec3(1.0, 0.72, 0.32).mul(edge.mul(4));
    const copies = new Map<THREE.Material, THREE.Material>();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      const src = m.material as THREE.MeshStandardMaterial;
      if (!src.isMeshStandardMaterial || (src as unknown as { isNodeMaterial?: boolean }).isNodeMaterial) return;
      let copy = copies.get(src);
      if (!copy) {
        const n = new THREE.MeshStandardNodeMaterial();
        n.setValues({
          name: src.name,
          color: src.color,
          emissive: src.emissive,
          emissiveIntensity: src.emissiveIntensity,
          roughness: src.roughness,
          metalness: src.metalness,
          map: src.map,
          roughnessMap: src.roughnessMap,
          metalnessMap: src.metalnessMap,
          normalMap: src.normalMap,
          normalScale: src.normalScale,
          envMapIntensity: src.envMapIntensity,
          side: src.side,
          flatShading: src.flatShading,
        });
        n.maskNode = key.greaterThan(u);
        n.emissiveNode = materialEmissive.add(vec3(1.0, 0.72, 0.32).mul(edge.mul(4)));
        copy = n;
        copies.set(src, copy);
      }
      m.material = copy;
    });
  }

  /** Bake the turtle and elephants as they stand into one mesh per material (see `freeze`). */
  private bake() {
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    const groups = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
    // The brushed roughness map the metals share (each metal's roughness rides on it).
    let brushed: THREE.Texture | null = null;
    this.root.traverse((o) => {
      const mt = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!brushed && mt?.roughnessMap) brushed = mt.roughnessMap;
    });
    const shared = this.bakeMaterials(brushed);
    const plaques = this.plaqueAtlas();
    for (const part of [this.turtle.group, this.elephantGroup]) {
      part.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material) || Object.keys(m.geometry.morphAttributes).length) return;
        const material = m.material as THREE.Material;
        // (Pick proxies and anything hidden stay out.)
        if (!material.visible) return;
        for (let a: THREE.Object3D | null = m; a && a !== part.parent; a = a.parent) if (!a.visible) return;
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        if (!g.attributes.normal) g.computeVertexNormals();
        const toRoot = inv.clone().multiply(m.matrixWorld);
        g.applyMatrix4(toRoot);
        if (toRoot.determinant() < 0) flipWinding(g);
        // The emissive eye keeps its own material; the name plaques share one, their names
        // on one texture sheet; everything else goes to the shared two, its colour, roughness
        // and metalness written per vertex.
        const std = material as THREE.MeshStandardMaterial;
        const glowing = !!std.emissive && std.emissive.getHex() !== 0;
        let target: THREE.Material = material;
        const cell = std.map ? plaques?.cells.get(std.map) : undefined;
        if (cell && plaques) {
          const uvs = g.attributes.uv;
          for (let i = 0; i < uvs.count; i++) uvs.setXY(i, cell.u + uvs.getX(i) * cell.w, cell.v + uvs.getY(i) * cell.h);
          target = plaques.material;
        } else if (!glowing && std.isMeshStandardMaterial) {
          const n = g.attributes.position.count;
          const c = std.map ? new THREE.Color(0xc9a24e) : std.color;
          const colour = new Float32Array(n * 3),
            rough = new Float32Array(n),
            metal = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            colour.set([c.r, c.g, c.b], i * 3);
            rough[i] = std.roughness;
            metal[i] = std.metalness;
          }
          g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
          g.setAttribute('rough', new THREE.BufferAttribute(rough, 1));
          g.setAttribute('metal', new THREE.BufferAttribute(metal, 1));
          target = std.side === THREE.DoubleSide ? shared.ears : shared.metal;
        }
        const key = `${target.uuid}|${Object.keys(g.attributes).sort().join(',')}`;
        const entry = groups.get(key) ?? { material: target, geos: [] };
        entry.geos.push(g);
        groups.set(key, entry);
      });
    }
    const baked = new THREE.Group();
    baked.name = 'stack-baked';
    for (const { material, geos } of groups.values()) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (merged) baked.add(new THREE.Mesh(merged, material));
    }
    this.root.add(baked);
    this.baked = baked;
    this.turtle.group.visible = this.elephantGroup.visible = false;
  }

  private plaques: {
    material: THREE.MeshStandardNodeMaterial;
    cells: Map<THREE.Texture, { u: number; v: number; w: number; h: number }>;
  } | null = null;

  /**
   * The elephants' name plaques on one texture sheet, so baked they're one
   * draw with their names (each was a draw of its own), or null if their
   * textures aren't ready. Made once.
   */
  private plaqueAtlas() {
    if (this.plaques) return this.plaques;
    const maps: THREE.Texture[] = [];
    let template: THREE.MeshStandardMaterial | null = null;
    this.elephantGroup.traverse((o) => {
      const mt = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && mt?.map && !maps.includes(mt.map)) {
        maps.push(mt.map);
        template = template ?? mt;
      }
    });
    const first = maps[0]?.image as { width: number; height: number } | undefined;
    if (!maps.length || !first?.width || !template) return null;
    const cols = Math.min(4, maps.length),
      rows = Math.ceil(maps.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = first.width * cols;
    canvas.height = first.height * rows;
    const g = canvas.getContext('2d')!;
    const cells = new Map<THREE.Texture, { u: number; v: number; w: number; h: number }>();
    maps.forEach((map, i) => {
      const c = i % cols,
        r = Math.floor(i / cols);
      // (Canvas rows run down; texture v runs up, and these maps aren't flipped differently.)
      g.drawImage(map.image as CanvasImageSource, c * first.width, r * first.height, first.width, first.height);
      cells.set(map, { u: c / cols, v: map.flipY ? 1 - (r + 1) / rows : r / rows, w: 1 / cols, h: 1 / rows });
    });
    const atlas = new THREE.CanvasTexture(canvas);
    atlas.colorSpace = maps[0].colorSpace;
    atlas.flipY = maps[0].flipY;
    atlas.anisotropy = 4;
    const t = template as THREE.MeshStandardMaterial;
    const material = new THREE.MeshStandardNodeMaterial({ map: atlas, metalness: t.metalness, roughness: t.roughness });
    material.maskNode = this.dissolveMask;
    material.emissiveNode = this.dissolveGlow;
    material.name = 'stack-plaques';
    this.plaques = { material, cells };
    return this.plaques;
  }

  /** Back to the live stack. */
  private unbake() {
    if (!this.baked) return;
    this.baked.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.baked.removeFromParent();
    this.baked = null;
    this.turtle.group.visible = this.elephantGroup.visible = true;
  }

  /**
   * The elephant facing the camera most squarely, and its front leg on the
   * camera's side, so the cause of the shudder is always in view.
   */
  private liftFacing(cam: THREE.Vector3) {
    const pos = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const q = new THREE.Quaternion();
    let best = this.elephants[0];
    let bestScore = -Infinity;
    for (const e of this.elephants) {
      e.group.getWorldPosition(pos);
      fwd.set(1, 0, 0).applyQuaternion(e.group.getWorldQuaternion(q));
      const toCam = cam.clone().sub(pos).setY(0).normalize();
      const score = fwd.setY(0).normalize().dot(toCam);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    const local = best.group.worldToLocal(cam.clone());
    return { rig: best, leg: local.z >= 0 ? 0 : 1, t: 0 };
  }

  /**
   * The lore under a ray (the elephants' nameplates, A'Tuin's head), or null.
   * Only once the stack has fully assembled.
   */
  pickLore(raycaster: THREE.Raycaster): Lore | null {
    this.loreHit = null;
    if (this.progress < 1 || !this.enabled) return null;
    // Test every solid part, so a plaque behind the shell or another
    // elephant isn't picked through it.
    if (!this.pickables.length) {
      const shapes = new Set<THREE.BufferGeometry>();
      this.stack.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        this.pickables.push(mesh);
        shapes.add(mesh.geometry);
        mesh.raycast = pickRaycast;
      });
      this.bvhQueue = [...shapes];
    }
    // VR picks every frame, and a plain walk tests every triangle of every
    // part the ray passes near (~92k): milliseconds on a headset. A ray index
    // per shape makes it a handful of tests.
    const until = performance.now() + 1;
    while (this.bvhQueue.length && performance.now() < until) {
      const g = this.bvhQueue.pop()!;
      (g as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = new MeshBVH(g, { indirect: true }); // (indirect: leaves the shape's index, shared with drawing, untouched)
    }
    const hit = raycaster.intersectObjects(this.pickables, false)[0];
    this.loreHit = hit ?? null;
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      const lore = o.userData.lore as Lore | 'atuin' | undefined;
      if (lore) return lore === 'atuin' ? this.turtleLore : lore;
    }
    return null;
  }

  get enabled() {
    return this.target === 1;
  }

  /** Jump straight to the end of the entrance or exit (VR arrives with the stack already assembled). */
  finish() {
    this.progress = this.target;
  }

  setEnabled(on: boolean) {
    this.target = on ? 1 : 0;
  }

  /** `simSpeed` is the clock's simulated seconds per real second. */
  update(dt: number, simSpeed: number, camera: THREE.Camera) {
    // Entrance (~4 s) overlaps the camera's ~2.4 s flight so the arrival is
    // visible; the exit is quicker.
    // (Clamped step toward the target, so it rests exactly at 0 or 1.)
    if (this.dissolveOnExit && this.target === 0 && this.progress > 0) {
      // Dissolve where it stands (fully assembled), then gone.
      this.progress = 1;
      this.dissolveU.value += dt / Discworld.DISSOLVE_S;
      if (this.dissolveU.value >= 1.05) {
        this.progress = 0;
        this.dissolveU.value = 0;
      }
    } else if (this.dissolveOnExit && this.target === 1 && (this.progress < 1 || this.dissolveU.value > 0)) {
      // Form where it stands, from the Disc down (or turn back mid-dissolve).
      if (this.progress < 1) {
        this.progress = 1;
        this.dissolveU.value = 1.05;
      }
      this.dissolveU.value = Math.max(0, this.dissolveU.value - dt / Discworld.FORM_S);
    } else {
      this.dissolveU.value = 0;
      this.progress += THREE.MathUtils.clamp(this.target - this.progress, -dt / 3, dt / 4);
    }
    const p = this.progress;
    this.root.visible = p > 0;
    this.quake = Math.max(0, this.quake - dt * 1.5);
    if (p === 0 || (!this.freeze && this.baked)) this.unbake();
    if (p === 0) return;
    this.time += dt;

    // The Rimfall starts as the camera swings down; the elephants rise as it
    // arrives (~1.2–2.9 s) and the turtle surfaces alongside (~1.6–4 s).
    this.elephantGroup.position.y = -(1 - smooth(0.3, 0.72, p)) * 45;
    this.turtle.group.position.y = SHELL_Y - (1 - easeOut(smooth(0.4, 1, p))) * 80;
    const left = 1 - Math.min(1, this.dissolveU.value);
    this.rimfall.uniforms.uOpacity.value = smooth(0.08, 0.45, p) * left;
    this.rimfall.uniforms.uTime.value = this.time;
    this.dust.uniforms.uOpacity.value = smooth(0.5, 1, p) * left;
    for (const { light, base } of this.lights) light.intensity = base * p * left;

    // Swimming: faster time means harder paddling; reverse time, reverse strokes.
    const mag = Math.abs(simSpeed);
    const rate = simSpeed === 0 ? 0.1 : Math.sign(simSpeed) * (0.25 + 1.4 * THREE.MathUtils.clamp(Math.log10(mag) / 7.5, 0, 1));
    this.rate = rate;
    this.swimPhase += dt * rate * Math.PI * 2 * 0.35;
    this.swimDistance += dt * rate * 6;
    this.dust.uniforms.uOffset.value = this.swimDistance;
    if (this.freeze) {
      // Formed (whole, not mid-dissolve): bake once, and the limbs rest as they are.
      if (!this.baked && p === 1 && this.dissolveU.value === 0) this.bake();
      this.lift = null;
      return;
    }
    const ph = this.swimPhase;
    this.turtle.front.forEach((f, i) => {
      const s = i === 0 ? 1 : -1;
      f.rotation.x = s * Math.sin(ph) * 0.38;
      f.rotation.y = s * (Math.cos(ph) * 0.3 - 0.1);
    });
    this.turtle.rear.forEach((f, i) => {
      const s = i === 0 ? 1 : -1;
      f.rotation.x = s * Math.sin(ph + Math.PI) * 0.22;
    });
    const t = this.time;
    this.turtle.head.rotation.y = Math.sin(t * 0.13) * 0.18 + Math.sin(t * 0.31) * 0.05;
    this.turtle.head.rotation.z = Math.sin(t * 0.09) * 0.06 + 0.04;

    // Elephants: ears and trunks sway, and each shifts its weight a little.
    for (const e of this.elephants) {
      const w = t * 0.5 + e.phase;
      // A slow, slight fan of the ears (pivoting at the root, swinging out).
      const fan = 0.04 + 0.04 * Math.sin(w * 0.9);
      e.ears.forEach((ear, i) => (ear.rotation.y = (i === 0 ? 1 : -1) * fan));
      e.trunk.rotation.z = Math.sin(w * 0.7) * 0.12;
      e.trunk.rotation.x = Math.sin(w * 0.45) * 0.1;
      e.head.rotation.y = Math.sin(w * 0.23) * 0.06;
    }

    // Now and then an elephant lifts a foot and the Disc shudders.
    if (p === 1 && !this.lift && this.time > this.nextQuake) {
      this.lift = this.liftFacing(camera.position);
      this.nextQuake = this.time + 25 + Math.random() * 30;
    }
    if (this.lift) {
      const L = this.lift;
      L.t += dt / 2.6;
      // Hip swings forward, knee folds back, hoof stays level; then stamp.
      const k = Math.sin(Math.min(1, L.t) * Math.PI);
      poseLeg(L.rig.legs[L.leg], k * 0.6, -k * 1.3);
      // Ears flare forward and out (leading the leg) to show the stamp,
      // the near ear most.
      const t = Math.min(1, L.t);
      const flare = THREE.MathUtils.smoothstep(t, 0, 0.22) * (1 - THREE.MathUtils.smoothstep(t, 0.8, 1));
      L.rig.ears.forEach((ear, i) => (ear.rotation.y += (i === 0 ? 1 : -1) * flare * (i === L.leg ? 1.1 : 0.45)));
      if (L.t > 0.78 && L.t < 1) this.quake = Math.max(this.quake, 1);
      if (L.t >= 1) this.lift = null;
    }
  }
}

const pickSphere = new THREE.Sphere();
/**
 * A part's ray test for lore picking: the cheap bounding-sphere reject first
 * (the indexed test skips it), then the shape's ray index once built, a plain
 * triangle walk until then.
 */
function pickRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]) {
  const g = this.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  pickSphere.copy(g.boundingSphere!).applyMatrix4(this.matrixWorld);
  if (!raycaster.ray.intersectsSphere(pickSphere)) return;
  acceleratedRaycast.call(this, raycaster, hits);
}

/**
 * A tusk along `curve`: a tube of radius `r` for most of its length, then
 * tapering to a closed, blunt point (a plain tube would end in an open
 * ring). Seam vertices are welded so the shading runs smooth round it.
 */
function tuskGeometry(curve: THREE.Curve<THREE.Vector3>, r: number) {
  const segs = 24,
    radial = 10;
  const tube = new THREE.TubeGeometry(curve, segs, r, radial);
  const pos = tube.attributes.position;
  const centre = new THREE.Vector3(),
    v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Full width to 55% of the length, then easing to nothing at the tip.
    const k = t <= 0.55 ? 1 : Math.pow(Math.cos(((t - 0.55) / 0.45) * (Math.PI / 2)), 0.55);
    curve.getPointAt(t, centre);
    for (let j = 0; j <= radial; j++) {
      const n = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, n).sub(centre).multiplyScalar(k).add(centre);
      pos.setXYZ(n, v.x, v.y, v.z);
    }
  }
  tube.deleteAttribute('normal');
  tube.deleteAttribute('uv');
  const welded = mergeVertices(tube, 1e-5);
  welded.computeVertexNormals();
  // (Steel is untextured, but merged and batched neighbours carry uvs: keep the attribute set the same.)
  welded.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(welded.attributes.position.count * 2), 2));
  return welded;
}
