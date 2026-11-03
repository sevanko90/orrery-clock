import * as THREE from 'three';
import { ARMS, PLANE_Y, TABLE_RADIUS, TABLE_TOP, type ArmSpec } from './layout';
import { GLASS_Y, WINDOW_RADIUS, CENTRAL_HOLE, stage2Y, GEAR_T, BOTTOM_PLATE, PLATE_T } from '../mechanism/heights';

/** Walnut table surface: the movement's bottom plate rests on it. */
const TABLE_SURFACE = BOTTOM_PLATE - PLATE_T / 2;
import { buildMechanism, design, type Mechanism3D } from './mechanism3d';
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
  /** Rotates about the main axis: tube angle plus the arm's setting offset. */
  pivot: THREE.Group;
  /** Where the planet sits (child of pivot). */
  anchor: THREE.Object3D;
}

export interface Orrery {
  root: THREE.Group;
  arms: ArmRig[];
  mechanism: Mechanism3D;
  /** Set each arm's absolute angle (radians, plan convention). */
  setArmAngles(angles: Record<string, number>): void;
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

  // ---- Table and glass drum -------------------------------------------
  // A slim walnut table; the movement stands in a central glass drum (glass
  // sides between brass mullions, glass top) so it can be seen from any angle.
  const cabinet = new THREE.Group();
  const H = TABLE_TOP; // top of the drum, where the planet tubes emerge
  const S = TABLE_SURFACE;

  const tableGeo = new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS - 0.25, S - 0.12, 128);
  const uvT = tableGeo.attributes.uv as THREE.BufferAttribute;
  const posT = tableGeo.attributes.position as THREE.BufferAttribute;
  // Planar UVs on the cap so the grain runs straight across the table.
  for (let i = 0; i < uvT.count; i++) {
    if (Math.abs(posT.getY(i)) > (S - 0.12) / 2 - 1e-4) uvT.setXY(i, posT.getX(i) / (TABLE_RADIUS * 2) + 0.5, posT.getZ(i) / (TABLE_RADIUS * 2) + 0.5);
  }
  const table = new THREE.Mesh(tableGeo, [mats.woodEdge, mats.wood, mats.wood]);
  table.position.y = 0.12 + (S - 0.12) / 2;
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_RADIUS - 0.35, TABLE_RADIUS - 0.8, 0.12, 128), mats.woodEdge);
  plinth.position.y = 0.06;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(TABLE_RADIUS, 0.06, 12, 192), mats.brass);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = S - 0.02;

  // Drum frame: footing band, cornice ring and turned mullions.
  const drumR = WINDOW_RADIUS;
  const footing = new THREE.Mesh(new THREE.CylinderGeometry(drumR + 0.18, drumR + 0.28, 0.16, 128, 1, true), mats.brassDark);
  footing.position.y = S + 0.08;
  const cornice = new THREE.Mesh(new THREE.CylinderGeometry(drumR + 0.3, drumR + 0.18, 0.14, 128, 1, true), mats.brass);

  cornice.position.y = H - 0.05;
  const corniceCap = new THREE.Mesh(new THREE.RingGeometry(drumR - 0.02, drumR + 0.3, 128), mats.brass);
  corniceCap.rotation.x = -Math.PI / 2;
  corniceCap.position.y = H + 0.02;
  cabinet.add(corniceCap);
  const corniceLip = new THREE.Mesh(new THREE.TorusGeometry(drumR + 0.3, 0.05, 12, 160), mats.brass);
  corniceLip.rotation.x = Math.PI / 2;
  corniceLip.position.y = H + 0.02;
  const mullions = 10;
  const mullionH = H - 0.12 - (S + 0.16);
  for (let i = 0; i < mullions; i++) {
    const a = (i / mullions) * Math.PI * 2 + Math.PI / mullions;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, mullionH, 12), mats.brass);
    m.position.set(Math.cos(a) * (drumR + 0.04), S + 0.16 + mullionH / 2, -Math.sin(a) * (drumR + 0.04));
    cabinet.add(m);
    for (const y of [S + 0.2, H - 0.16]) {
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12), mats.brassDark);
      collar.position.set(m.position.x, y, m.position.z);
      cabinet.add(collar);
    }
  }

  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xdfe8ee,
    transparent: true,
    opacity: 0.05,
    roughness: 0.02,
    metalness: 0.0,
    envMapIntensity: 1.0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const sideGlass = new THREE.Mesh(new THREE.CylinderGeometry(drumR, drumR, H - S - 0.2, 128, 1, true), glassMat);
  sideGlass.position.y = S + 0.13 + (H - S - 0.2) / 2;
  sideGlass.renderOrder = 2;

  // Glass top, with a brass bush where the tubes rise and one for the crank.
  const glassShape = new THREE.Shape();
  glassShape.absarc(0, 0, drumR, 0, Math.PI * 2, false);
  const glassHole = new THREE.Path();
  glassHole.absarc(0, 0, CENTRAL_HOLE + 0.05, 0, Math.PI * 2, true);
  glassShape.holes.push(glassHole);
  const crank = design.arbors.find((a) => a.id === 'crank')!;
  const crankHole = new THREE.Path();
  crankHole.absarc(crank.x, crank.y, 0.12, 0, Math.PI * 2, true);
  glassShape.holes.push(crankHole);
  const glassGeo = new THREE.ShapeGeometry(glassShape, 96);
  glassGeo.rotateX(-Math.PI / 2);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.position.y = GLASS_Y;
  glass.renderOrder = 2;
  const bush = new THREE.Mesh(new THREE.TorusGeometry(CENTRAL_HOLE + 0.05, 0.05, 10, 48), mats.brass);
  bush.rotation.x = Math.PI / 2;
  bush.position.y = GLASS_Y;
  const crankBush = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 8, 24), mats.brass);
  crankBush.rotation.x = Math.PI / 2;
  crankBush.position.set(crank.x, GLASS_Y, -crank.y);

  cabinet.add(table, plinth, rim, footing, cornice, corniceLip, bush, crankBush);
  enableShadows(cabinet, true, true);
  table.castShadow = false;
  cabinet.add(glass, sideGlass);

  // Inlays sit a hair above the surface; a depth offset keeps them in front at
  // any viewing distance (otherwise they z-fight when zoomed out).
  const inlay = <T extends THREE.Material>(m: T) =>
    Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  // Orbit grooves: inlaid brass on the wood, fine silver lines on the glass.
  const grooveBrass = inlay(mats.brassDark.clone());
  for (const arm of ARMS) {
    const onGlass = arm.radius < WINDOW_RADIUS;
    const mat = onGlass
      ? inlay(new THREE.MeshBasicMaterial({ color: 0xd8c08a, transparent: true, opacity: 0.35, depthWrite: false }))
      : grooveBrass;
    const w = onGlass ? 0.012 : 0.025;
    const groove = new THREE.Mesh(new THREE.RingGeometry(arm.radius - w, arm.radius + w, 256), mat);
    groove.rotation.x = -Math.PI / 2;
    groove.position.y = (onGlass ? GLASS_Y : S) + 0.003;
    cabinet.add(groove);
  }

  // Zodiac band inlay (texture is generated once fonts are ready).
  const zInner = TABLE_RADIUS - 2.0,
    zOuter = TABLE_RADIUS - 0.35,
    extent = TABLE_RADIUS;
  const zodiacMat = inlay(mats.brass.clone());
  // Satin finish: a large flat ring of polished brass mirrors the Sun as a glare.
  zodiacMat.roughness = 0.55;
  zodiacMat.alphaTest = 0.5;
  zodiacMat.visible = false;
  const zodiac = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2, extent * 2), zodiacMat);
  zodiac.rotation.x = -Math.PI / 2;
  zodiac.position.y = S + 0.004;
  zodiac.receiveShadow = true;
  cabinet.add(zodiac);
  zodiacAlphaTexture(zInner, zOuter, extent).then((tex) => {
    zodiacMat.alphaMap = tex;
    zodiacMat.visible = true;
    zodiacMat.needsUpdate = true;
  });
  root.add(cabinet);

  // ---- The movement ----------------------------------------------------
  const mechanism = buildMechanism(mats);
  root.add(mechanism.root);

  // Warm work-lamp glow inside the cabinet so the gears read through the glass.
  const lamp = new THREE.PointLight(0xffc98a, 0.9, 10, 1.2);
  lamp.position.set(0, GLASS_Y - 0.05, 3.5);
  root.add(lamp);

  // ---- Planet arms -------------------------------------------------------
  const arms: ArmRig[] = [];
  ARMS.forEach((spec, k) => {
    const pivot = new THREE.Group();
    pivot.name = `arm-${spec.id}`;

    // Tube from its drive gear (inside the movement) up to the arm.
    const tubeBottom = stage2Y(k) - GEAR_T / 2;
    const tubeLen = spec.armY - tubeBottom;
    const tube = cylinder(spec.tubeRadius, tubeLen, mats.brass, 32);
    tube.position.y = tubeBottom + tubeLen / 2;
    pivot.add(tube);

    const collar = cylinder(spec.tubeRadius + 0.07, 0.16, mats.brassDark, 32);
    collar.position.y = spec.armY;
    pivot.add(collar);

    const armLen = spec.radius - spec.tubeRadius;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.06, 0.12), mats.brass);
    bar.position.set(spec.tubeRadius + armLen / 2, spec.armY, 0);
    pivot.add(bar);

    // Flat counterweight disc opposite (kept thin so it clears the crank).
    const stubLen = Math.min(1.2, 0.35 + spec.radius * 0.06);
    const stub = new THREE.Mesh(new THREE.BoxGeometry(stubLen, 0.05, 0.09), mats.brassDark);
    stub.position.set(-(spec.tubeRadius + stubLen / 2), spec.armY, 0);
    const weight = cylinder(0.13 + spec.radius * 0.007, 0.07, mats.brassDark, 24);
    weight.position.set(-(spec.tubeRadius + stubLen), spec.armY, 0);
    pivot.add(stub, weight);

    const rodTop = PLANE_Y - spec.size * 0.85;
    const rodLen = rodTop - spec.armY;
    const rod = cylinder(0.035, rodLen, mats.brass, 12);
    rod.position.set(spec.radius, spec.armY + rodLen / 2, 0);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), mats.brassDark);
    knuckle.position.set(spec.radius, spec.armY, 0);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(spec.size * 0.45, 0.04, spec.size * 0.35, 20, 1, true), mats.brass);
    cup.position.set(spec.radius, rodTop + spec.size * 0.05, 0);
    pivot.add(rod, knuckle, cup);

    const anchor = new THREE.Object3D();
    anchor.position.set(spec.radius, PLANE_Y, 0);
    pivot.add(anchor);

    enableShadows(pivot);
    root.add(pivot);
    arms.push({ spec, pivot, anchor });
  });

  return {
    root,
    arms,
    mechanism,
    setArmAngles(angles) {
      for (const rig of arms) {
        const a = angles[rig.spec.id];
        if (a !== undefined) rig.pivot.rotation.y = a;
      }
    },
  };
}
