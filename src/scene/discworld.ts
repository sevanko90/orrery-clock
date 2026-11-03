import * as THREE from 'three';
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
const DISC_TOP = BOTTOM_PLATE - PLATE_T / 2;

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
const HEADING = THREE.MathUtils.degToRad(-30);

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
    ear: Object.assign(mats.brassDark.clone(), { side: THREE.DoubleSide }),
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

// ---- Elephant -----------------------------------------------------------------

interface ElephantRig {
  group: THREE.Group;
  legs: THREE.Group[];
  head: THREE.Group;
  ears: THREE.Object3D[];
  trunk: THREE.Group;
  phase: number;
}

/** Nameplate size and position on the flank, in elephant units. */
const PLAQUE = { cx: -0.5, w: 2.5, h: 0.8 };

const ELEPHANT_NAMES = ['Berilia', 'Tubul', "Great T'Phon", 'Jerakeen'];

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
 * (0, 5, 0) with half-axes 3.3, 2.3, 2.2). `side` is +1 or −1 for ±z; text
 * reads correctly from outside on both flanks.
 */
function flankPlaque(tex: THREE.Texture, side: number, rivetMat: THREE.Material) {
  const group = new THREE.Group();
  const cx = PLAQUE.cx,
    cy = 5.15,
    w = PLAQUE.w,
    h = PLAQUE.h;
  const onBody = (u: number, v: number, lift: number) => {
    const x = cx + side * u;
    const y = cy + v;
    const z = 2.2 * Math.sqrt(Math.max(0, 1 - (x / 3.3) ** 2 - ((y - 5) / 2.3) ** 2)) + lift;
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
  group.add(mesh(sphere, m.bronze, [0, 5.0, 0], [3.3, 2.3, 2.2]));
  const band = new THREE.TorusGeometry(1, 0.07, 8, 48);
  for (const x of [-1.85, 1.9]) {
    const k = Math.sqrt(1 - (x / 3.3) ** 2);
    const b = mesh(band, m.brass, [x, 5.0, 0], [2.2 * k + 0.03, 2.3 * k + 0.03, 1]);
    b.rotation.y = Math.PI / 2;
    group.add(b);
  }

  // Bearing pad on the back, which carries the Disc.
  group.add(mesh(new THREE.CylinderGeometry(2.5, 2.7, 0.25, 32), m.brassDark, [0, 7.22, 0]));
  group.add(mesh(new THREE.CylinderGeometry(1.0, 1.3, 0.5, 24), m.bronze, [0, 7.6, 0]));
  group.add(mesh(new THREE.CylinderGeometry(1.9, 1.6, 0.16, 32), m.brass, [0, 7.92, 0]));

  // Legs: hip pivots so they can lift; jointed with brass knees and hoof caps.
  const legs: THREE.Group[] = [];
  for (const [x, z] of [
    [2.0, 1.2],
    [2.0, -1.2],
    [-2.0, 1.2],
    [-2.0, -1.2],
  ]) {
    const hip = new THREE.Group();
    hip.position.set(x, 4.6, z);
    hip.add(mesh(new THREE.CylinderGeometry(0.85, 0.72, 2.4, 16), m.bronze, [0, -1.2, 0]));
    hip.add(mesh(sphere, m.brass, [0, -2.45, 0], [0.74, 0.74, 0.74]));
    hip.add(mesh(new THREE.CylinderGeometry(0.7, 0.82, 1.9, 16), m.bronze, [0, -3.4, 0]));
    hip.add(mesh(new THREE.CylinderGeometry(0.98, 0.98, 0.3, 20), m.brass, [0, -4.45, 0]));
    group.add(hip);
    legs.push(hip);
  }

  // Head, ears, tusks, eyes and an articulated trunk.
  const head = new THREE.Group();
  head.position.set(3.2, 5.8, 0);
  head.add(mesh(sphere, m.bronze, [0.6, 0.3, 0], [1.6, 1.75, 1.5]));
  head.add(mesh(sphere, m.bronze, [0.2, 1.3, 0], [1.2, 0.9, 1.2]));
  const ears: THREE.Object3D[] = [];
  const earGeo = new THREE.CircleGeometry(1, 28);
  for (const s of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(-0.1, 0.6, s * 1.25);
    const ear = mesh(earGeo, m.ear, [-0.9, -0.3, s * 0.4], [1.3, 1.7, 1]);
    ear.rotation.y = s * 0.45;
    const rim = mesh(new THREE.TorusGeometry(1, 0.06, 6, 40), m.brass, [-0.9, -0.3, s * 0.4], [1.3, 1.7, 1]);
    rim.rotation.y = s * 0.45;
    pivot.add(ear, rim);
    head.add(pivot);
    ears.push(pivot);

    const tusk = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(1.4, -0.7, s * 0.6),
        new THREE.Vector3(2.3, -1.4, s * 0.8),
        new THREE.Vector3(3.2, -1.1, s * 0.95),
        new THREE.Vector3(3.6, -0.4, s * 0.9),
      ]),
      16,
      0.16,
      8,
    );
    head.add(new THREE.Mesh(tusk, m.steel));
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
  group.add(flankPlaque(tex, 1, m.brassDark), flankPlaque(tex, -1, m.brassDark));

  // Tail.
  group.add(strut(new THREE.Vector3(-3.2, 5.4, 0), new THREE.Vector3(-3.7, 3.2, 0), 0.14, 0.08, m.bronze, 8));
  group.add(mesh(sphere, m.brass, [-3.72, 3.1, 0], [0.18, 0.3, 0.18]));

  return { group, legs, head, ears, trunk, phase: Math.random() * Math.PI * 2 };
}

/** Height of the shell dome above its rim at (x, z) in the turtle's frame. */
function shellHeight(x: number, z: number) {
  return RY * Math.sqrt(Math.max(0, 1 - (x / RX) ** 2 - (z / RZ) ** 2));
}

/** Stretch each leg so its foot rests on the curved shell. */
function fitLegsToShell(rig: ElephantRig, a: number) {
  const S = ELEPHANT_SCALE;
  const g = rig.group.position;
  const hipY = g.y + 4.6 * S;
  for (const leg of rig.legs) {
    const lx = leg.position.x * S,
      lz = leg.position.z * S;
    const x = g.x + lx * Math.cos(a) + lz * Math.sin(a);
    const z = g.z - lx * Math.sin(a) + lz * Math.cos(a);
    const footY = SHELL_Y + shellHeight(x, z) - 0.12;
    leg.scale.y = (hipY - footY) / (4.6 * S);
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
  group.add(mesh(sphere, m.brass, [0, RY, 0], [2.2, 0.5, 2.0]));
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
  const geo = new THREE.BufferGeometry();
  // Positions are computed in the shader; this attribute only sets the count.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aRate', new THREE.BufferAttribute(rate, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), TABLE_RADIUS + 30);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uRadius: { value: TABLE_RADIUS + 0.05 },
      uTop: { value: DISC_TOP + 0.04 },
      uScale: { value: pixelScale },
    },
    vertexShader: /* glsl */ `
      attribute float aAngle;
      attribute float aSeed;
      attribute float aRate;
      uniform float uTime, uRadius, uTop, uScale;
      varying float vAlpha;
      void main() {
        float life = fract(uTime * aRate + aSeed);
        float t = life * 3.6;
        // Pour outward over the lip, then fall away and spread into spray.
        float jitter = fract(aSeed * 91.7) - 0.5;
        float r = uRadius + t * (0.55 + 0.25 * fract(aSeed * 13.1)) + t * t * 0.18;
        float a = aAngle + jitter * 0.01 * t;
        float y = uTop - 2.6 * t * t - 0.4 * t;
        vec4 mv = modelViewMatrix * vec4(cos(a) * r, y, sin(a) * r, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uScale * (0.1 + 0.16 * life) / -mv.z;
        vAlpha = smoothstep(0.0, 0.04, life) * pow(1.0 - life, 1.4);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vec3(0.62, 0.8, 1.0) * soft, soft * vAlpha * uOpacity * 0.55);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, mat };
}

/** Motes of space dust streaming past, so A'Tuin visibly swims. */
function buildDust(count: number, pixelScale: number) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 160;
    pos[i * 3 + 1] = -12 + (Math.random() - 0.5) * 70;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 160;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uOffset: { value: 0 }, uOpacity: { value: 0 }, uScale: { value: pixelScale } },
    vertexShader: /* glsl */ `
      uniform float uOffset, uScale;
      varying float vFade;
      void main() {
        vec3 p = position;
        p.x = mod(p.x - uOffset + 80.0, 160.0) - 80.0;
        vFade = 1.0 - smoothstep(55.0, 80.0, abs(p.x));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uScale * 0.12 / -mv.z + 1.0;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.1, d);
        gl_FragColor = vec4(vec3(1.0, 0.9, 0.75) * soft, soft * vFade * uOpacity * 0.5);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, mat };
}

// ---- Assembly -----------------------------------------------------------------

export class Discworld {
  readonly root = new THREE.Group();
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

  constructor(mats: Materials, opts: { lowQuality: boolean; pixelRatio: number }) {
    this.root.name = 'discworld';
    this.root.visible = false;
    const m = makeMaterials(mats);
    const sphere = new THREE.SphereGeometry(1, opts.lowQuality ? 20 : 32, opts.lowQuality ? 14 : 20);

    this.stack.rotation.y = HEADING;
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

    // World units to pixels at unit distance, for point sprites (40° fov).
    const pixelScale = (innerHeight * opts.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
    this.rimfall = buildRimfall(opts.lowQuality ? 3000 : 9000, pixelScale);
    this.dust = buildDust(opts.lowQuality ? 500 : 1400, pixelScale);
    this.root.add(this.rimfall.points);
    this.stack.add(this.dust.points);

    // The orrery's Sun only lights the Disc from above: add a cool light from
    // the depths and a warm key from the side so the stack reads underneath.
    const under = new THREE.DirectionalLight(0x9db4ff, 0);
    under.position.set(-30, -60, 25);
    const key = new THREE.DirectionalLight(0xffcf96, 0);
    key.position.set(60, -8, 45);
    this.lights.push({ light: under, base: 1.4 }, { light: key, base: 1.1 });
    this.root.add(under, key);
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

  get enabled() {
    return this.target === 1;
  }

  setEnabled(on: boolean) {
    this.target = on ? 1 : 0;
  }

  /** `simSpeed` is the clock's simulated seconds per real second. */
  update(dt: number, simSpeed: number, camera: THREE.Camera) {
    const step = dt / 3.2;
    this.progress = this.target > this.progress ? Math.min(1, this.progress + step) : Math.max(0, this.progress - step);
    const p = this.progress;
    this.root.visible = p > 0;
    this.quake = Math.max(0, this.quake - dt * 1.5);
    if (p === 0) return;
    this.time += dt;

    // Elephants rise into place first, then the turtle comes up beneath them.
    this.elephantGroup.position.y = -(1 - easeOut(smooth(0, 0.55, p))) * 45;
    this.turtle.group.position.y = SHELL_Y - (1 - easeOut(smooth(0.3, 1, p))) * 80;
    this.rimfall.mat.uniforms.uOpacity.value = smooth(0.15, 0.7, p);
    this.rimfall.mat.uniforms.uTime.value = this.time;
    this.dust.mat.uniforms.uOpacity.value = smooth(0.5, 1, p);
    for (const { light, base } of this.lights) light.intensity = base * p;

    // Swimming: faster time means harder paddling; reverse time, reverse strokes.
    const mag = Math.abs(simSpeed);
    const rate = simSpeed === 0 ? 0.1 : Math.sign(simSpeed) * (0.25 + 1.4 * THREE.MathUtils.clamp(Math.log10(mag) / 7.5, 0, 1));
    this.swimPhase += dt * rate * Math.PI * 2 * 0.35;
    this.swimDistance += dt * rate * 6;
    this.dust.mat.uniforms.uOffset.value = this.swimDistance;
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
      e.ears.forEach((ear, i) => (ear.rotation.y = (i === 0 ? 1 : -1) * (0.1 + Math.sin(w * 1.3) * 0.12)));
      e.trunk.rotation.z = Math.sin(w * 0.7) * 0.12;
      e.trunk.rotation.x = Math.sin(w * 0.45) * 0.1;
      e.head.rotation.y = Math.sin(w * 0.23) * 0.06;
      e.legs.forEach((leg) => (leg.rotation.z = 0));
    }

    // Now and then an elephant lifts a foot and the Disc shudders.
    if (p === 1 && !this.lift && this.time > this.nextQuake) {
      this.lift = this.liftFacing(camera.position);
      this.nextQuake = this.time + 25 + Math.random() * 30;
    }
    if (this.lift) {
      const L = this.lift;
      L.t += dt / 2.6;
      const k = Math.sin(Math.min(1, L.t) * Math.PI);
      L.rig.legs[L.leg].rotation.z = k * 0.7;
      if (L.t > 0.78 && L.t < 1) this.quake = Math.max(this.quake, 1);
      if (L.t >= 1) this.lift = null;
    }
  }
}
