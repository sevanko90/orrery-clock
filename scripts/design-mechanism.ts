// Offline mechanism designer. Picks integer tooth counts that reproduce the
// planets' sidereal period ratios, then lays the arbors out with simulated
// annealing until no gear collides with any arbor or other gear.
//
// Run inside the container:
//   node --experimental-strip-types scripts/design-mechanism.ts
// Writes src/mechanism/design.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkDesign,
  type ArborSpec,
  type GearSpec,
  type MechanismDesign,
  type MeshSpec,
  type PlanetTrain,
} from '../src/mechanism/design.ts';
import {
  BOTTOM_PLATE,
  F_ARBOR_R,
  GEAR_T,
  L_DRIVE,
  MIDDLE_PLATE,
  SUN_POST_R,
  TABLE_TOP,
  TL1,
  TL2,
  TL3,
  TL4,
  TOP_ARBOR_TOP,
  TOP_GEAR_T,
  TOP_PLATE,
  stage1Y,
  stage2Y,
  tubeRadius,
} from '../src/mechanism/heights.ts';

const SID_YEAR = 365.256363;
const PERIODS: Record<string, number> = {
  mercury: 87.9691,
  venus: 224.70069,
  earth: 365.256363,
  mars: 686.97959,
  jupiter: 4332.589,
  saturn: 10759.22,
  uranus: 30685.4,
  neptune: 60189.0,
};
const ORDER = Object.keys(PERIODS);
/** The central drive arbor turns once every six sidereal years. */
const F_PERIOD = 6 * SID_YEAR;

// Deterministic PRNG so the design is reproducible.
let seed = Number(process.env.SEED ?? 12345);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

interface Cand {
  a: number;
  b: number;
  c: number;
  d: number;
  err: number;
}

function candidates(R: number): Cand[] {
  const out: Cand[] = [];
  for (let a = 10; a <= 140; a++)
    for (let b = 10; b <= 140; b++) {
      const s1 = a / b;
      if (s1 > 7 || s1 < 1 / 7) continue;
      const s2t = R / s1;
      if (s2t > 7 || s2t < 1 / 7) continue;
      for (let d = 10; d <= 140; d++) {
        const c = Math.round(s2t * d);
        if (c < 10 || c > 140) continue;
        // Tooth sums of ~70+ keep modules sensible at a 2.5–4.5 unit centre distance.
        if (a + b < 70 || c + d < 70) continue;
        const err = Math.abs((s1 * c) / d / R - 1);
        if (err < 3e-5) out.push({ a, b, c, d, err });
      }
    }
  out.sort((x, y) => x.err - y.err);
  return out.slice(0, 600);
}

const targets = ORDER.map((id) => F_PERIOD / PERIODS[id]);
const cands = targets.map(candidates);
cands.forEach((c, i) => console.log(`${ORDER[i]}: ratio ${targets[i].toFixed(6)}, ${c.length} candidates, best err ${c[0]?.err.toExponential(2)}`));

// ---------------------------------------------------------------------------
// Phase A: drive wheel, intermediate arbors, pillars.

interface StateA {
  planets: { ci: number; RX: number; alpha: number }[];
  yAlpha: number;
  yR: number;
  pillars: number[];
}

const DRIVE_WHEEL = 120;
const DRIVE_PINION = 10;
const TOP_MODULE = 0.026;

function arborAt(id: string, r: number, a: number, radius: number, bottom: number, top: number): ArborSpec {
  return { id, x: r * Math.cos(a), y: r * Math.sin(a), radius, bottom, top };
}

function buildLower(s: StateA) {
  const arbors: ArborSpec[] = [
    { id: 'F', x: 0, y: 0, radius: F_ARBOR_R, bottom: BOTTOM_PLATE, top: MIDDLE_PLATE },
    { id: 'sunpost', x: 0, y: 0, radius: SUN_POST_R, bottom: MIDDLE_PLATE, top: 30 },
    arborAt('Y', s.yR, s.yAlpha, 0.07, BOTTOM_PLATE, TL1 + 0.04),
  ];
  s.pillars.forEach((a, i) => arbors.push(arborAt(`pillar${i}`, 5.72, a, 0.17, BOTTOM_PLATE, TOP_PLATE)));

  const mD = (2 * s.yR) / (DRIVE_WHEEL + DRIVE_PINION);
  const gears: GearSpec[] = [
    { id: 'F.drive', arbor: 'F', kind: 'spur', teeth: DRIVE_WHEEL, module: mD, y: L_DRIVE, thickness: GEAR_T, bore: F_ARBOR_R, spokes: 6 },
    { id: 'Y.pinion', arbor: 'Y', kind: 'spur', teeth: DRIVE_PINION, module: mD, y: L_DRIVE, thickness: GEAR_T, bore: 0.07 },
  ];
  const drive: MeshSpec[] = [{ driver: 'Y.pinion', driven: 'F.drive' }];
  const planets: PlanetTrain[] = [];

  ORDER.forEach((id, k) => {
    const p = s.planets[k];
    const c = cands[k][p.ci];
    const tube = `tube.${id}`;
    const X = `X.${id}`;
    arbors.push({ id: tube, x: 0, y: 0, radius: tubeRadius(k), bottom: stage2Y(k) - GEAR_T / 2, top: 30 });
    arbors.push(arborAt(X, p.RX, p.alpha, 0.06, BOTTOM_PLATE, TOP_PLATE));
    const m1 = (2 * p.RX) / (c.a + c.b);
    const m2 = (2 * p.RX) / (c.c + c.d);
    const spokes = (n: number, m: number) => ((m * n) / 2 > 0.9 ? 5 : 0);
    gears.push(
      { id: `${id}.a`, arbor: 'F', kind: 'spur', teeth: c.a, module: m1, y: stage1Y(k), thickness: GEAR_T, bore: F_ARBOR_R, spokes: spokes(c.a, m1) },
      { id: `${id}.b`, arbor: X, kind: 'spur', teeth: c.b, module: m1, y: stage1Y(k), thickness: GEAR_T, bore: 0.06, spokes: spokes(c.b, m1) },
      { id: `${id}.c`, arbor: X, kind: 'spur', teeth: c.c, module: m2, y: stage2Y(k), thickness: GEAR_T, bore: 0.06, spokes: spokes(c.c, m2) },
      { id: `${id}.d`, arbor: tube, kind: 'spur', teeth: c.d, module: m2, y: stage2Y(k), thickness: GEAR_T, bore: tubeRadius(k), spokes: spokes(c.d, m2) },
    );
    drive.push({ driver: `${id}.a`, driven: `${id}.b` }, { driver: `${id}.c`, driven: `${id}.d` });
    planets.push({
      id,
      tube,
      stage1: [`${id}.a`, `${id}.b`],
      stage2: [`${id}.c`, `${id}.d`],
      ratio: ((c.a / c.b) * c.c) / c.d,
      target: targets[k],
    });
  });

  return { arbors, gears, drive, planets };
}

function penalty(viol: { deficit: number }[]) {
  // Squared term for big overlaps plus a fixed cost per violation, so the
  // compactness bonus can never pay for a sliver of overlap.
  return viol.reduce((s, v) => s + v.deficit * v.deficit + 0.05 * v.deficit + 0.002, 0);
}

function lowerDesign(s: StateA): MechanismDesign {
  const lo = buildLower(s);
  return {
    fPeriodDays: F_PERIOD,
    ...lo,
    going: [],
    crank: { driver: 'Y.pinion', driven: 'F.drive' },
  };
}

function scoreA(s: StateA) {
  const v = checkDesign(lowerDesign(s));
  const compact = s.planets.reduce((t, p) => t + p.RX, 0) * 0.0005;
  return { p: penalty(v) + compact, n: v.length };
}

function randomStateA(): StateA {
  return {
    planets: ORDER.map((_, k) => ({
      ci: Math.floor(rand() * Math.min(60, cands[k].length)),
      RX: 2.7 + rand() * 1.4,
      alpha: rand() * Math.PI * 2,
    })),
    yAlpha: rand() * Math.PI * 2,
    yR: 2.6 + rand() * 0.8,
    pillars: Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2 + rand() * 0.3),
  };
}

function mutateA(s: StateA, T: number): StateA {
  const n: StateA = structuredClone(s);
  const r = rand();
  const k = Math.floor(rand() * ORDER.length);
  const step = 0.2 + T;
  if (r < 0.25) n.planets[k].ci = Math.max(0, Math.min(cands[k].length - 1, n.planets[k].ci + Math.round((rand() - 0.5) * 40)));
  else if (r < 0.5) n.planets[k].RX = Math.max(2.2, Math.min(4.6, n.planets[k].RX + (rand() - 0.5) * 0.6 * step));
  else if (r < 0.75) n.planets[k].alpha += (rand() - 0.5) * 1.2 * step;
  else if (r < 0.85) {
    n.yAlpha += (rand() - 0.5) * step;
    n.yR = Math.max(2.3, Math.min(4.0, n.yR + (rand() - 0.5) * 0.4 * step));
  } else {
    const i = Math.floor(rand() * 6);
    n.pillars[i] += (rand() - 0.5) * step;
  }
  return n;
}

function anneal<S>(init: S, score: (s: S) => { p: number; n: number }, mutate: (s: S, T: number) => S, steps: number) {
  let cur = init;
  let cs = score(cur);
  let best = cur,
    bs = cs;
  for (let i = 0; i < steps; i++) {
    const T = 1 - i / steps;
    const temp = 0.05 * T * T + 1e-6;
    const nxt = mutate(cur, T);
    const ns = score(nxt);
    if (ns.p < cs.p || rand() < Math.exp((cs.p - ns.p) / temp)) {
      cur = nxt;
      cs = ns;
      if (cs.p < bs.p) {
        best = cur;
        bs = cs;
      }
    }
  }
  return { best, score: bs };
}

/** Fine hill-climb on continuous variables to clear tiny residual overlaps. */
function refineA(s: StateA, steps: number) {
  let cur = s,
    cs = scoreA(cur);
  for (let i = 0; i < steps && cs.n > 0; i++) {
    const n: StateA = structuredClone(cur);
    const k = Math.floor(rand() * ORDER.length);
    const e = 0.03 * (1 - i / steps) + 0.002;
    const r = rand();
    if (r < 0.4) n.planets[k].RX = Math.max(2.2, Math.min(4.6, n.planets[k].RX + (rand() - 0.5) * e));
    else if (r < 0.8) n.planets[k].alpha += (rand() - 0.5) * e;
    else if (r < 0.9) n.yAlpha += (rand() - 0.5) * e;
    else n.pillars[Math.floor(rand() * 6)] += (rand() - 0.5) * e;
    const ns = scoreA(n);
    if (ns.p <= cs.p) {
      cur = n;
      cs = ns;
    }
  }
  return { best: cur, score: cs };
}

const CACHE_A = path.resolve(import.meta.dirname, '../.design-cache-phaseA.json');
let bestA: { best: StateA; score: { p: number; n: number } } | null = null;
if (process.env.REUSE_A && existsSync(CACHE_A)) {
  const best = JSON.parse(readFileSync(CACHE_A, 'utf8')) as StateA;
  bestA = { best, score: scoreA(best) };
  console.log('phase A: reused cached layout, violations', bestA.score.n);
}
for (let restart = 0; restart < 40 && !(bestA && bestA.score.n === 0); restart++) {
  let r = anneal(randomStateA(), scoreA, mutateA, 60000);
  if (r.score.n > 0 && r.score.n < 15) r = refineA(r.best, 20000);
  console.log(`phase A restart ${restart}: penalty ${r.score.p.toFixed(5)}, violations ${r.score.n}`);
  if (!bestA || r.score.p < bestA.score.p) bestA = r;
  if (r.score.n === 0) break;
}
if (!bestA || bestA.score.n > 0) {
  console.error('Phase A failed:', checkDesign(lowerDesign(bestA!.best)).slice(0, 10));
  process.exit(1);
}

writeFileSync(CACHE_A, JSON.stringify(bestA.best));

// ---------------------------------------------------------------------------
// Phase B: going train, escapement and crank on the top plate.

const sA = bestA.best;
const Ypos = { x: sA.yR * Math.cos(sA.yAlpha), y: sA.yR * Math.sin(sA.yAlpha) };
const FRONT = (-60 * Math.PI) / 180; // where the default camera looks from

interface StateB {
  hops: number[]; // directions: Y→A4, A4→A3, A3→A2, A2→A1, A1→E, E→anchor, Y→crank
}

// Three planes, cycling so a wheel never shares a plane with the next pinion.
const GOING = [
  { id: 'A4', wheel: 98, pinion: 8, wheelY: TL2, pinionY: TL1, top: TL2 + 0.04 },
  { id: 'A3', wheel: 96, pinion: 8, wheelY: TL3, pinionY: TL2, top: TL3 + 0.04 },
  { id: 'A2', wheel: 96, pinion: 8, wheelY: TL1, pinionY: TL3, top: TL3 + 0.04 },
  { id: 'A1', wheel: 96, pinion: 8, wheelY: TL2, pinionY: TL1, top: TL2 + 0.04 },
];
const Y_WHEEL = 99;
const E_PINION = 8;
const CRANK_TEETH = 33;
const ESCAPE_OUTER = 0.5;
const ANCHOR_DIST = 0.62;

function buildFull(s: StateB): MechanismDesign {
  const lower = buildLower(sA);
  const arbors = [...lower.arbors];
  const gears = [...lower.gears];
  const going: MeshSpec[] = [];
  const top = (id: string, x: number, y: number, topY: number) =>
    arbors.push({ id, x, y, radius: 0.03, bottom: TOP_PLATE, top: topY });

  gears.push({ id: 'Y.wheel', arbor: 'Y', kind: 'spur', teeth: Y_WHEEL, module: TOP_MODULE, y: TL1, thickness: TOP_GEAR_T, bore: 0.07, spokes: 5 });
  void TL4;

  // Walk the chain outward from Y: each hop's length is the pitch-circle sum.
  let prev = { x: Ypos.x, y: Ypos.y, wheelTeeth: Y_WHEEL };
  let prevId = 'Y';
  let prevWheelId = 'Y.wheel';
  GOING.forEach((g, i) => {
    const dist = (TOP_MODULE * (prev.wheelTeeth + g.pinion)) / 2;
    const x = prev.x + dist * Math.cos(s.hops[i]);
    const y = prev.y + dist * Math.sin(s.hops[i]);
    top(g.id, x, y, g.top);
    gears.push(
      // Pinion leaves are cut into the arbor itself: no bore to speak of.
      { id: `${g.id}.pinion`, arbor: g.id, kind: 'spur', teeth: g.pinion, module: TOP_MODULE, y: g.pinionY, thickness: TOP_GEAR_T, bore: 0.02 },
      { id: `${g.id}.wheel`, arbor: g.id, kind: 'spur', teeth: g.wheel, module: TOP_MODULE, y: g.wheelY, thickness: TOP_GEAR_T, bore: 0.03, spokes: 5 },
    );
    // Kinematically the escape end drives: pinion of this arbor drives prev wheel.
    going.unshift({ driver: `${g.id}.pinion`, driven: prevWheelId });
    prev = { x, y, wheelTeeth: g.wheel };
    prevId = g.id;
    prevWheelId = `${g.id}.wheel`;
  });
  void prevId;

  // Escape wheel arbor: pinion meshes A1's wheel (layer TL1), escape wheel on TL2.
  const eDist = (TOP_MODULE * (prev.wheelTeeth + E_PINION)) / 2;
  const E = { x: prev.x + eDist * Math.cos(s.hops[4]), y: prev.y + eDist * Math.sin(s.hops[4]) };
  top('E', E.x, E.y, TL3 + 0.04);
  gears.push(
    { id: 'E.pinion', arbor: 'E', kind: 'spur', teeth: E_PINION, module: TOP_MODULE, y: TL2, thickness: TOP_GEAR_T, bore: 0.02 },
    { id: 'E.escape', arbor: 'E', kind: 'escape', teeth: 30, module: 0, y: TL3, thickness: TOP_GEAR_T, bore: 0.03, outer: ESCAPE_OUTER },
  );
  going.unshift({ driver: 'E.pinion', driven: prevWheelId });

  const An = { x: E.x + ANCHOR_DIST * Math.cos(s.hops[5]), y: E.y + ANCHOR_DIST * Math.sin(s.hops[5]) };
  top('anchor', An.x, An.y, TOP_ARBOR_TOP);
  gears.push(
    { id: 'anchor', arbor: 'anchor', kind: 'anchor', teeth: 0, module: 0, y: TL3, thickness: TOP_GEAR_T, bore: 0.03, outer: 0.42 },
    { id: 'balance', arbor: 'anchor', kind: 'balance', teeth: 0, module: 0, y: TL4, thickness: 0.05, bore: 0.03, outer: 0.58 },
  );

  const cDist = (TOP_MODULE * (Y_WHEEL + CRANK_TEETH)) / 2;
  const C = { x: Ypos.x + cDist * Math.cos(s.hops[6]), y: Ypos.y + cDist * Math.sin(s.hops[6]) };
  top('crank', C.x, C.y, TABLE_TOP + 0.3);
  gears.push({ id: 'crank.gear', arbor: 'crank', kind: 'spur', teeth: CRANK_TEETH, module: TOP_MODULE, y: TL1, thickness: TOP_GEAR_T, bore: 0.03 });

  return {
    fPeriodDays: F_PERIOD,
    arbors,
    gears,
    drive: lower.drive,
    going,
    crank: { driver: 'crank.gear', driven: 'Y.wheel' },
    planets: lower.planets,
  };
}

function scoreB(s: StateB) {
  const d = buildFull(s);
  const v = checkDesign(d);
  const e = d.arbors.find((a) => a.id === 'E')!;
  const ang = Math.atan2(e.y, e.x);
  const front = 1 - Math.cos(ang - FRONT); // 0 when the escapement faces the viewer
  return { p: penalty(v) + front * 0.002, n: v.length };
}

function mutateB(s: StateB, T: number): StateB {
  const n = structuredClone(s);
  const i = Math.floor(rand() * n.hops.length);
  n.hops[i] += (rand() - 0.5) * (0.4 + 2 * T);
  return n;
}

let bestB: { best: StateB; score: { p: number; n: number } } | null = null;
for (let restart = 0; restart < 60; restart++) {
  const start: StateB = { hops: Array.from({ length: 7 }, () => rand() * Math.PI * 2) };
  const r = anneal(start, scoreB, mutateB, 40000);
  if (!bestB || r.score.p < bestB.score.p) bestB = r;
  console.log(`phase B restart ${restart}: penalty ${r.score.p.toFixed(5)}, violations ${r.score.n}`);
  if (r.score.n === 0 && r.score.p < 0.0015) break;
}
const final = buildFull(bestB!.best);
const remaining = checkDesign(final);
if (remaining.length) {
  console.error('Phase B failed:', remaining.slice(0, 10));
  process.exit(1);
}

const out = path.resolve(import.meta.dirname, '../src/mechanism/design.json');
writeFileSync(out, JSON.stringify(final, null, 1) + '\n');
console.log('wrote', path.relative(process.cwd(), out));
for (const p of final.planets) {
  const g = (id: string) => final.gears.find((x) => x.id === id)!;
  console.log(
    `${p.id.padEnd(8)} ${g(p.stage1[0]).teeth}:${g(p.stage1[1]).teeth} × ${g(p.stage2[0]).teeth}:${g(p.stage2[1]).teeth}  ratio ${p.ratio.toFixed(6)} (target ${p.target.toFixed(6)}, err ${(Math.abs(p.ratio / p.target - 1) * 1e6).toFixed(2)} ppm)`,
  );
}
