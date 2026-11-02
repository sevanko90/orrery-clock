import * as THREE from 'three';
import { ARMS, MOVEMENT, PLANE_Y, TABLE_RADIUS, TABLE_TOP, type ArmSpec } from './layout';
import { gearGeometry, meshAngle } from './gear';
import type { Materials } from './materials';

const ZODIAC = [
  'ARIES',
  'TAURUS',
  'GEMINI',
  'CANCER',
  'LEO',
  'VIRGO',
  'LIBRA',
  'SCORPIO',
  'SAGITTARIUS',
  'CAPRICORN',
  'AQUARIUS',
  'PISCES',
];

export interface ArmRig {
  spec: ArmSpec;
  /** Rotates about the main axis with the planet's ecliptic longitude. */
  pivot: THREE.Group;
  /** Where the planet sits (child of pivot). */
  anchor: THREE.Object3D;
  pinion: THREE.Mesh;
}

export interface Orrery {
  root: THREE.Group;
  arms: ArmRig[];
  /** Set each arm to an ecliptic longitude (radians). */
  setLongitudes(lon: Record<string, number>): void;
  /** Spin the decorative escapement by simulated seconds elapsed. */
  tick(simSeconds: number): void;
}

function enableShadows(obj: THREE.Object3D, cast = true, receive = true) {
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}

function cylinder(r: number, h: number, mat: THREE.Material, segments = 32) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), mat);
}

/** Spoked flat plate (a ring joined to a hub by spokes). */
function plateGeometry(outer: number, rimWidth: number, hubOuter: number, bore: number, spokes: number, depth: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const boreP = new THREE.Path();
  boreP.absarc(0, 0, bore, 0, Math.PI * 2, true);
  shape.holes.push(boreP);
  const rimInner = outer - rimWidth;
  const half = 0.1;
  for (let s = 0; s < spokes; s++) {
    const a0 = (s / spokes) * Math.PI * 2 + half;
    const a1 = ((s + 1) / spokes) * Math.PI * 2 - half;
    const win = new THREE.Path();
    win.absarc(0, 0, rimInner, a0, a1, false);
    win.absarc(0, 0, hubOuter, a1 - 0.08, a0 + 0.08, true);
    win.closePath();
    shape.holes.push(win);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.015,
    bevelSegments: 2,
    curveSegments: 64,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Turned pillar profile, like a clock movement's column. */
function pillarGeometry(height: number) {
  const pts: THREE.Vector2[] = [];
  const prof: [number, number][] = [
    [0.0, 0],
    [0.17, 0],
    [0.17, 0.06],
    [0.12, 0.1],
    [0.09, 0.2],
    [0.08, 0.5],
    [0.11, 0.55],
    [0.08, 0.6],
    [0.08, 0.9],
    [0.12, 0.94],
    [0.17, 0.97],
    [0.17, 1],
    [0, 1],
  ];
  for (const [r, t] of prof) pts.push(new THREE.Vector2(r, t * height));
  return new THREE.LatheGeometry(pts, 24);
}

async function zodiacAlphaTexture(rInner: number, rOuter: number, extent: number): Promise<THREE.Texture> {
  try {
    await document.fonts.load('600 48px Cinzel');
  } catch {
    /* fall back to serif */
  }
  const size = 4096;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const px = size / (2 * extent);
  const c = size / 2;
  const R0 = rInner * px,
    R1 = rOuter * px;

  // Solid band (white = brass), then cut engravings in black.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(c, c, R1, 0, Math.PI * 2);
  ctx.arc(c, c, R0, 0, Math.PI * 2, true);
  ctx.fill();

  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  const band = R1 - R0;
  const Rtick = R0 + band * 0.22;
  const lineW = Math.max(2, px * 0.03);

  for (const r of [R0 + band * 0.07, Rtick, R1 - band * 0.07]) {
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Degree ticks between the inner rings. Canvas y is down, so a world
  // longitude θ is drawn at angle −θ.
  for (let d = 0; d < 360; d++) {
    const a = (-d * Math.PI) / 180;
    const len = d % 30 === 0 ? band * 0.15 : d % 10 === 0 ? band * 0.1 : d % 5 === 0 ? band * 0.07 : band * 0.04;
    ctx.lineWidth = d % 10 === 0 ? lineW * 1.2 : lineW * 0.7;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * (R0 + band * 0.07), c + Math.sin(a) * (R0 + band * 0.07));
    ctx.lineTo(c + Math.cos(a) * (R0 + band * 0.07 + len), c + Math.sin(a) * (R0 + band * 0.07 + len));
    ctx.stroke();
  }

  // Sign boundaries and names.
  const textR = (Rtick + R1 - band * 0.07) / 2;
  ctx.font = `600 ${Math.round(band * 0.34)}px Cinzel, "Times New Roman", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let s = 0; s < 12; s++) {
    const a0 = (-s * 30 * Math.PI) / 180;
    ctx.lineWidth = lineW * 1.3;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a0) * Rtick, c + Math.sin(a0) * Rtick);
    ctx.lineTo(c + Math.cos(a0) * (R1 - band * 0.07), c + Math.sin(a0) * (R1 - band * 0.07));
    ctx.stroke();

    // Letters run along the arc, centred on the sign's middle.
    const mid = -((s * 30 + 15) * Math.PI) / 180;
    const word = ZODIAC[s].split('').join(' ');
    const spacing = band * 0.27;
    const chars = [...word];
    const totalAngle = (chars.length * spacing * 0.62) / textR;
    chars.forEach((ch, k) => {
      const a = mid + totalAngle / 2 - (k + 0.5) * (totalAngle / chars.length);
      ctx.save();
      ctx.translate(c + Math.cos(a) * textR, c + Math.sin(a) * textR);
      ctx.rotate(a - Math.PI / 2);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  return tex;
}

export function buildOrrery(mats: Materials): Orrery {
  const root = new THREE.Group();
  root.name = 'orrery';

  // ---- Table -------------------------------------------------------------
  const table = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS, 0.3, 128), [
    mats.woodEdge,
    mats.wood,
    mats.wood,
  ]);
  top.position.y = TABLE_TOP - 0.15;
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(TABLE_RADIUS - 0.25, TABLE_RADIUS - 0.6, 0.3, 128),
    mats.woodEdge,
  );
  skirt.position.y = TABLE_TOP - 0.45;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(TABLE_RADIUS, 0.06, 12, 192), mats.brass);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = TABLE_TOP - 0.02;
  table.add(top, skirt, rim);

  // Inlaid brass orbit grooves.
  for (const arm of ARMS) {
    const groove = new THREE.Mesh(new THREE.RingGeometry(arm.radius - 0.025, arm.radius + 0.025, 256), mats.brassDark);
    groove.rotation.x = -Math.PI / 2;
    groove.position.y = TABLE_TOP + 0.002;
    table.add(groove);
  }

  // Zodiac band inlay (texture is generated once fonts are ready).
  const zInner = TABLE_RADIUS - 2.0,
    zOuter = TABLE_RADIUS - 0.35,
    extent = TABLE_RADIUS;
  const zodiacMat = mats.brass.clone();
  zodiacMat.transparent = false;
  zodiacMat.alphaTest = 0.5;
  zodiacMat.visible = false;
  const zodiac = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2, extent * 2), zodiacMat);
  zodiac.rotation.x = -Math.PI / 2;
  zodiac.position.y = TABLE_TOP + 0.004;
  table.add(zodiac);
  zodiacAlphaTexture(zInner, zOuter, extent).then((tex) => {
    zodiacMat.alphaMap = tex;
    zodiacMat.visible = true;
    zodiacMat.needsUpdate = true;
  });

  root.add(table);

  // ---- Movement (gear train between two plates) --------------------------
  const movement = new THREE.Group();
  const plateR = 6.0;
  const bottomPlate = new THREE.Mesh(plateGeometry(plateR, plateR, 0.5, 0.15, 0, 0.1), mats.brassDark);
  bottomPlate.position.y = MOVEMENT.bottom;
  const topPlate = new THREE.Mesh(plateGeometry(plateR, 0.45, 1.15, 0.85, 6, 0.1), mats.brass);
  topPlate.position.y = MOVEMENT.top;
  movement.add(bottomPlate, topPlate);

  // Feet between table and bottom plate.
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const foot = cylinder(0.22, MOVEMENT.bottom - TABLE_TOP, mats.brassDark, 20);
    foot.position.set(Math.cos(a) * (plateR - 0.6), (TABLE_TOP + MOVEMENT.bottom) / 2, -Math.sin(a) * (plateR - 0.6));
    movement.add(foot);
  }

  // Pillars, kept clear of the layshaft's pinions.
  const pillarH = MOVEMENT.top - MOVEMENT.bottom;
  const pillarGeo = pillarGeometry(pillarH);
  for (let k = 0; k < 6; k++) {
    const a = MOVEMENT.layshaftAngle + Math.PI / 6 + (k * Math.PI) / 3;
    const p = new THREE.Mesh(pillarGeo, mats.brass);
    const r = plateR - 0.3;
    p.position.set(Math.cos(a) * r, MOVEMENT.bottom, -Math.sin(a) * r);
    movement.add(p);
  }

  // Layshaft.
  const lsA = MOVEMENT.layshaftAngle;
  const lsX = Math.cos(lsA) * MOVEMENT.layshaftDistance;
  const lsZ = -Math.sin(lsA) * MOVEMENT.layshaftDistance;
  const layshaft = cylinder(0.08, pillarH + 0.3, mats.steel, 16);
  layshaft.position.set(lsX, (MOVEMENT.bottom + MOVEMENT.top) / 2, lsZ);
  movement.add(layshaft);
  for (const y of [MOVEMENT.bottom + 0.08, MOVEMENT.top + 0.08]) {
    const jewel = cylinder(0.16, 0.06, mats.copper, 20);
    jewel.position.set(lsX, y, lsZ);
    movement.add(jewel);
  }

  // Central fixed post carrying the Sun.
  const post = cylinder(0.12, PLANE_Y - MOVEMENT.bottom, mats.steel, 20);
  post.position.y = (PLANE_Y + MOVEMENT.bottom) / 2;
  movement.add(post);

  root.add(movement);

  // ---- Planet arms -------------------------------------------------------
  const arms: ArmRig[] = [];
  const gearThickness = 0.12;

  for (const spec of ARMS) {
    const pivot = new THREE.Group();
    pivot.name = `arm-${spec.id}`;

    const tubeLen = spec.armY - spec.gearY;
    const tube = cylinder(spec.tubeRadius, tubeLen, mats.brass, 32);
    tube.position.y = spec.gearY + tubeLen / 2;
    pivot.add(tube);

    const collar = cylinder(spec.tubeRadius + 0.07, 0.16, mats.brassDark, 32);
    collar.position.y = spec.armY;
    pivot.add(collar);

    // Radial arm: a flat bar from the collar to the planet's radius.
    const armLen = spec.radius - spec.tubeRadius;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.06, 0.12), mats.brass);
    bar.position.set(spec.tubeRadius + armLen / 2, spec.armY, 0);
    pivot.add(bar);

    // Counterweight stub opposite.
    const stubLen = Math.min(1.2, 0.35 + spec.radius * 0.06);
    const stub = new THREE.Mesh(new THREE.BoxGeometry(stubLen, 0.05, 0.09), mats.brassDark);
    stub.position.set(-(spec.tubeRadius + stubLen / 2), spec.armY, 0);
    const weight = new THREE.Mesh(new THREE.SphereGeometry(0.11 + spec.radius * 0.006, 16, 12), mats.brassDark);
    weight.position.set(-(spec.tubeRadius + stubLen), spec.armY, 0);
    pivot.add(stub, weight);

    // Vertical rod up to the planet plane, with a little cradle.
    const rodTop = PLANE_Y - spec.size * 0.85;
    const rodLen = rodTop - spec.armY;
    const rod = cylinder(0.035, rodLen, mats.brass, 12);
    rod.position.set(spec.radius, spec.armY + rodLen / 2, 0);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), mats.brassDark);
    knuckle.position.set(spec.radius, spec.armY, 0);
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.size * 0.45, 0.04, spec.size * 0.35, 20, 1, true),
      mats.brass,
    );
    cup.material = mats.brass;
    cup.position.set(spec.radius, rodTop + spec.size * 0.05, 0);
    pivot.add(rod, knuckle, cup);

    const anchor = new THREE.Object3D();
    anchor.position.set(spec.radius, PLANE_Y, 0);
    pivot.add(anchor);

    // Drive gear on the tube inside the movement.
    const [nd, np] = spec.teeth;
    const drivenR = (MOVEMENT.module * nd) / 2;
    const driven = new THREE.Mesh(
      gearGeometry({
        teeth: nd,
        module: MOVEMENT.module,
        thickness: gearThickness,
        boreRadius: spec.tubeRadius * 0.98,
        spokes: drivenR > 1.1 ? 5 : 0,
      }),
      spec.id === 'earth' ? mats.copper : mats.brass,
    );
    driven.position.y = spec.gearY;
    pivot.add(driven);

    const pinionR = (MOVEMENT.module * np) / 2;
    const pinion = new THREE.Mesh(
      gearGeometry({
        teeth: np,
        module: MOVEMENT.module,
        thickness: gearThickness,
        boreRadius: 0.09,
        spokes: pinionR > 1.1 ? 5 : 0,
      }),
      mats.brassDark,
    );
    pinion.position.set(lsX, spec.gearY, lsZ);
    root.add(pinion);

    root.add(pivot);
    arms.push({ spec, pivot, anchor, pinion });
  }

  // ---- Escapement: a small ticking wheel on the top plate ---------------
  const escape = new THREE.Group();
  const escA = MOVEMENT.layshaftAngle + Math.PI;
  escape.position.set(Math.cos(escA) * 4.6, MOVEMENT.top + 0.12, -Math.sin(escA) * 4.6);
  const escWheel = new THREE.Mesh(
    gearGeometry({ teeth: 30, module: 0.045, thickness: 0.05, boreRadius: 0.05, spokes: 4 }),
    mats.copper,
  );
  const escArbor = cylinder(0.05, 0.25, mats.steel, 12);
  escape.add(escWheel, escArbor);
  root.add(escape);

  enableShadows(root);
  table.traverse((o) => (o.castShadow = false));

  const thetas = new Map<string, number>();

  return {
    root,
    arms,
    setLongitudes(lon) {
      for (const rig of arms) {
        const theta = lon[rig.spec.id];
        if (theta === undefined) continue;
        if (thetas.get(rig.spec.id) === theta) continue;
        thetas.set(rig.spec.id, theta);
        rig.pivot.rotation.y = theta;
        const [nd, np] = rig.spec.teeth;
        rig.pinion.rotation.y = meshAngle(theta, nd, np, MOVEMENT.layshaftAngle);
      }
    },
    tick(simSeconds) {
      // Dead-beat style: jump one tooth per (simulated) second.
      const whole = Math.floor(simSeconds);
      const frac = simSeconds - whole;
      const snap = Math.min(1, frac * 8);
      const ease = 1 - Math.pow(1 - snap, 3);
      escWheel.rotation.y = -((whole % 30) + ease) * ((Math.PI * 2) / 30);
    },
  };
}
