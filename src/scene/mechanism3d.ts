import * as THREE from 'three/webgpu';
import designJson from '../mechanism/design.json';
import type { ArborSpec, GearSpec, MechanismDesign } from '../mechanism/design';
import type { Kinematics } from '../mechanism/kinematics';
import { BOTTOM_PLATE, CENTRAL_HOLE, MIDDLE_PLATE, PLATE_RADIUS, PLATE_T, TABLE_TOP, TL4, TOP_PLATE } from '../mechanism/heights';
import { gearGeometry } from './gear';
import { arcError, arcPoints, arcSegments, chamferError, pathFrom, registerLod, sharpPrism } from './lod';
import type { Materials } from './materials';

export const design = designJson as MechanismDesign;

/** Plan (x, y) → world (x, −z). */
const W = (a: { x: number; y: number }, y: number) => new THREE.Vector3(a.x, y, -a.y);

function escapeWheelGeometry(outer: number, teeth: number, thickness: number) {
  const shape = new THREE.Shape();
  const root = outer * 0.78;
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = ((i + 0.62) / teeth) * Math.PI * 2;
    const a2 = ((i + 0.72) / teeth) * Math.PI * 2;
    const p = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)] as const;
    // Ratchet teeth: long sloping back, short club-shaped face.
    const [x0, y0] = p(root, a0);
    if (i === 0) shape.moveTo(x0, y0);
    else shape.lineTo(x0, y0);
    shape.lineTo(...p(outer, a1));
    shape.lineTo(...p(outer * 0.97, a2));
    shape.lineTo(...p(root, a2 + 0.02));
  }
  shape.closePath();
  const hub = new THREE.Path();
  hub.absarc(0, 0, 0.03, 0, Math.PI * 2, true);
  shape.holes.push(hub);
  for (let s = 0; s < 4; s++) {
    const a0 = (s / 4) * Math.PI * 2 + 0.22;
    const a1 = ((s + 1) / 4) * Math.PI * 2 - 0.22;
    const win = new THREE.Path();
    win.absarc(0, 0, root - 0.06, a0, a1, false);
    win.absarc(0, 0, 0.09, a1, a0, true);
    win.closePath();
    shape.holes.push(win);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -thickness / 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Anchor (pallet fork) pointing along local +x toward the escape wheel. */
function anchorGroup(mats: Materials, distToEscape: number, thickness: number) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  const reach = distToEscape - 0.42;
  shape.moveTo(-0.06, -0.06);
  shape.lineTo(reach * 0.55, -0.3);
  shape.lineTo(reach * 0.55 + 0.12, -0.36);
  shape.lineTo(reach * 0.55 + 0.14, -0.28);
  shape.lineTo(0.08, 0);
  shape.lineTo(reach * 0.55 + 0.14, 0.28);
  shape.lineTo(reach * 0.55 + 0.12, 0.36);
  shape.lineTo(reach * 0.55, 0.3);
  shape.lineTo(-0.06, 0.06);
  // Lever tail.
  shape.lineTo(-0.34, 0.03);
  shape.lineTo(-0.38, 0);
  shape.lineTo(-0.34, -0.03);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(-Math.PI / 2);
  g.add(new THREE.Mesh(geo, mats.steel));
  // Ruby pallet stones.
  const ruby = new THREE.MeshStandardMaterial({ color: 0xb0102a, roughness: 0.15, metalness: 0.1, emissive: 0x2a0008 });
  for (const s of [-1, 1]) {
    const stone = new THREE.Mesh(new THREE.BoxGeometry(0.1, thickness * 1.2, 0.05), ruby);
    stone.position.set(reach * 0.55 + 0.16, 0, -s * 0.33);
    stone.rotation.y = s * 0.5;
    g.add(stone);
  }
  return g;
}

function balanceGroup(mats: Materials, radius: number) {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.03, 0.03, 8, 48), mats.brass);
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(radius - 0.03, 0.025, 0.035), mats.brass);
    const a = (i / 3) * Math.PI * 2;
    spoke.position.set(Math.cos(a) * (radius / 2), 0, -Math.sin(a) * (radius / 2));
    spoke.rotation.y = a;
    g.add(spoke);
  }
  // Timing screws around the rim.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.06, 8), mats.steel);
    screw.rotation.z = Math.PI / 2;
    screw.rotation.y = a;
    screw.position.set(Math.cos(a) * (radius + 0.015), 0, -Math.sin(a) * (radius + 0.015));
    g.add(screw);
  }
  // Hairspring: an Archimedean spiral just below the wheel.
  const pts: THREE.Vector3[] = [];
  const turns = 9;
  for (let i = 0; i <= 600; i++) {
    const t = i / 600;
    const r = 0.05 + t * (radius * 0.55);
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, -0.05, -Math.sin(a) * r));
  }
  const spring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x3a5a9a }));
  spring.name = 'hairspring';
  g.add(spring);
  return g;
}

/** Annular plate with lightening holes that avoid every pivot passing through. */
function plateGeometry(avoid: { x: number; y: number; r: number }[], solid: boolean) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, PLATE_RADIUS, 0, Math.PI * 2, false);
  const centre = new THREE.Path();
  centre.absarc(0, 0, CENTRAL_HOLE, 0, Math.PI * 2, true);
  shape.holes.push(centre);
  const holes: { x: number; y: number; r: number }[] = [];
  if (!solid) {
    for (const r of [0.95, 0.75, 0.55, 0.4]) {
      for (let ring = CENTRAL_HOLE + r + 0.25; ring < PLATE_RADIUS - r - 0.3; ring += 0.35) {
        const n = Math.max(6, Math.floor((Math.PI * 2 * ring) / (r * 2.4)));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + ring;
          const h = { x: ring * Math.cos(a), y: ring * Math.sin(a), r };
          const clear =
            avoid.every((p) => Math.hypot(p.x - h.x, p.y - h.y) > h.r + p.r + 0.16) &&
            holes.every((o) => Math.hypot(o.x - h.x, o.y - h.y) > h.r + o.r + 0.14);
          if (clear) holes.push(h);
        }
      }
    }
    for (const h of holes) {
      const p = new THREE.Path();
      p.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true);
      shape.holes.push(p);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: PLATE_T,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 1,
    curveSegments: 48,
  });
  geo.translate(0, 0, -PLATE_T / 2);
  geo.rotateX(-Math.PI / 2);
  registerLod(geo, () => plateLods(holes));
  return geo;
}

/**
 * Headset builds of a plate (see lod.ts): sharp-edged, with every circle cut
 * only as finely as the level's error allows: chord error half the lost
 * chamfer at level 1, then the chamfer, then twice it.
 */
export function plateLods(holes: { x: number; y: number; r: number }[]) {
  const chamfer = chamferError(0.012, 0.012);
  return [0.5, 1, 2].map((k) => {
    const budget = chamfer * k;
    let outline = 0;
    const circle = (x: number, y: number, r: number, cw: boolean) => {
      const n = arcSegments(r, Math.PI * 2, budget, 8);
      outline = Math.max(outline, arcError(r, Math.PI * 2, n));
      return arcPoints(x, y, r, 0, cw ? -Math.PI * 2 : Math.PI * 2, n, cw).slice(0, -1);
    };
    const shape = pathFrom(circle(0, 0, PLATE_RADIUS, false), new THREE.Shape()) as THREE.Shape;
    shape.holes.push(pathFrom(circle(0, 0, CENTRAL_HOLE, true)));
    for (const h of holes) shape.holes.push(pathFrom(circle(h.x, h.y, h.r, true)));
    // Chord error and lost chamfer can meet on one edge: the bound is their sum.
    return { geometry: sharpPrism(shape, PLATE_T, 0.012, 0.012), error: chamfer + outline };
  });
}

function pillarGeometry(height: number) {
  const prof: [number, number][] = [
    [0.0, 0],
    [0.17, 0],
    [0.17, 0.04],
    [0.12, 0.08],
    [0.09, 0.18],
    [0.08, 0.5],
    [0.11, 0.54],
    [0.08, 0.58],
    [0.08, 0.86],
    [0.12, 0.93],
    [0.17, 0.96],
    [0.17, 1],
    [0, 1],
  ];
  return new THREE.LatheGeometry(
    prof.map(([r, t]) => new THREE.Vector2(r, t * height)),
    20,
  );
}

export interface Mechanism3D {
  root: THREE.Group;
  update(k: Kinematics): void;
}

export function buildMechanism(mats: Materials): Mechanism3D {
  const root = new THREE.Group();
  root.name = 'movement';
  const arbors = new Map(design.arbors.map((a) => [a.id, a]));
  const ruby = new THREE.MeshStandardMaterial({ color: 0xc0142e, roughness: 0.12, metalness: 0.2, emissive: 0x300008 });

  // ---- Plates & pillars ----
  const throughMiddle = design.arbors.filter((a) => a.bottom < MIDDLE_PLATE && a.top > MIDDLE_PLATE && Math.hypot(a.x, a.y) > 1e-6);
  const throughTop = design.arbors.filter((a) => a.bottom <= TOP_PLATE + 1e-6 && a.top >= TOP_PLATE - 1e-6 && Math.hypot(a.x, a.y) > 1e-6);
  const pad = (list: ArborSpec[], extra = 0.12) => list.map((a) => ({ x: a.x, y: a.y, r: a.radius + extra }));
  const bottomPlate = new THREE.Mesh(plateGeometry([], true), mats.plate);
  bottomPlate.position.y = BOTTOM_PLATE;
  const middlePlate = new THREE.Mesh(plateGeometry(pad(throughMiddle), false), mats.plate);
  middlePlate.position.y = MIDDLE_PLATE;
  // Keep a solid table under the going train's pivots and the drive arbor.
  const topAvoid = pad(throughTop, 0.2);
  for (const g of design.gears) {
    const a = arbors.get(g.arbor)!;
    if (a.bottom >= TOP_PLATE - 1e-6) topAvoid.push({ x: a.x, y: a.y, r: 0.25 });
  }
  const topPlate = new THREE.Mesh(plateGeometry(topAvoid, false), mats.plate);
  topPlate.position.y = TOP_PLATE;
  root.add(bottomPlate, middlePlate, topPlate);

  const pillarGeo = pillarGeometry(TOP_PLATE - BOTTOM_PLATE);
  for (const a of design.arbors.filter((x) => x.id.startsWith('pillar'))) {
    const p = new THREE.Mesh(pillarGeo, mats.brass);
    p.position.copy(W(a, BOTTOM_PLATE));
    root.add(p);
  }

  // ---- Arbors (static steel rods; they look the same rotating) ----
  for (const a of design.arbors) {
    if (a.id.startsWith('pillar') || a.id.startsWith('tube.') || a.id === 'sunpost') continue;
    const top = a.id === 'crank' ? TABLE_TOP + 0.12 : a.top;
    const h = top - a.bottom;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(a.radius * 0.8, a.radius * 0.8, h, 12), mats.steel);
    rod.position.copy(W(a, a.bottom + h / 2));
    root.add(rod);
    // Jewelled pivots where arbors pass through the top and middle plates.
    for (const y of [TOP_PLATE, MIDDLE_PLATE]) {
      if (a.bottom < y - 0.01 && a.top > y - 0.01 && Math.hypot(a.x, a.y) > 1e-6) {
        const jewel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, PLATE_T + 0.02, 16), ruby);
        jewel.position.copy(W(a, y));
        root.add(jewel);
      }
    }
  }
  const sunpostRod = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, TABLE_TOP + 0.4 - MIDDLE_PLATE, 16), mats.steel);
  sunpostRod.position.y = (TABLE_TOP + 0.4 + MIDDLE_PLATE) / 2;
  root.add(sunpostRod);

  // ---- Gears ----
  const byArbor = new Map<string, THREE.Object3D[]>();
  const add = (arbor: string, o: THREE.Object3D) => {
    if (!byArbor.has(arbor)) byArbor.set(arbor, []);
    byArbor.get(arbor)!.push(o);
    root.add(o);
  };
  let clutchPinion: THREE.Object3D | null = null;
  let balance: THREE.Object3D | null = null;
  let anchor: THREE.Object3D | null = null;
  let anchorBase = 0;

  for (const g of design.gears) {
    const a = arbors.get(g.arbor)!;
    let obj: THREE.Object3D;
    if (g.kind === 'spur') {
      const pinion = g.teeth <= 12;
      const mat = pinion
        ? mats.steel
        : g.id === 'F.drive' || g.id.endsWith('.d')
          ? mats.copper
          : g.id.endsWith('.b') || g.id.endsWith('.c')
            ? mats.brassDark
            : mats.brass;
      obj = new THREE.Mesh(
        gearGeometry({ teeth: g.teeth, module: g.module, thickness: g.thickness, boreRadius: g.bore, spokes: g.spokes ?? 0 }),
        mat,
      );
    } else if (g.kind === 'escape') {
      obj = new THREE.Mesh(escapeWheelGeometry(g.outer!, g.teeth, g.thickness), mats.steel);
    } else if (g.kind === 'anchor') {
      const e = arbors.get('E')!;
      obj = anchorGroup(mats, Math.hypot(e.x - a.x, e.y - a.y), g.thickness);
      anchorBase = Math.atan2(e.y - a.y, e.x - a.x);
      anchor = obj;
    } else {
      obj = balanceGroup(mats, g.outer! - 0.04);
      balance = obj;
    }
    obj.position.copy(W(a, g.y));
    obj.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    if (g.id === 'A4.pinion') clutchPinion = obj;
    if (g.kind === 'spur' || g.kind === 'escape') add(g.arbor, obj);
    else root.add(obj);
  }

  // Balance cock: a small bridge over the balance.
  const anchorArbor = arbors.get('anchor')!;
  const cock = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.16), mats.brass);
  cock.position.copy(W(anchorArbor, TL4 + 0.06));
  cock.position.x += 0.3;
  root.add(cock);

  // Crank handle above the table, on the crank arbor.
  const crankArbor = arbors.get('crank')!;
  const crank = new THREE.Group();
  crank.position.copy(W(crankArbor, TABLE_TOP + 0.12));
  const crankArm = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 0.1), mats.brass);
  crankArm.position.x = 0.25;
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.18, 16), mats.woodEdge);
  knob.position.set(0.5, 0.1, 0);
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.06, 16), mats.brassDark);
  crank.add(crankArm, knob, boss);
  crank.traverse((o) => (o.castShadow = true));
  root.add(crank);

  // Hub collars on the planet tubes are part of the arms; gears on tubes rotate here.
  const clutchBaseY = clutchPinion ? (clutchPinion as THREE.Object3D).position.y : 0;

  return {
    root,
    update(k) {
      for (const [arbor, objs] of byArbor) {
        const theta = k.angle(arbor);
        for (const o of objs) o.rotation.y = theta;
      }
      crank.rotation.y = k.angle('crank');
      if (clutchPinion) (clutchPinion as THREE.Object3D).position.y = clutchBaseY + k.clutch * 0.055;
      if (balance) (balance as THREE.Object3D).rotation.y = k.balance;
      if (anchor) (anchor as THREE.Object3D).rotation.y = anchorBase + k.anchorRock;
    },
  };
}

export function gearOf(id: string): GearSpec {
  return design.gears.find((g) => g.id === id)!;
}
