// One headset pass over many live experiments (no reloads, no leaving VR).
//
//   docker compose exec app node scripts/perf-pass.mjs
//
// Hold the view steady. It alternates baseline / experiment / baseline / ...
// and prices each experiment against the baselines either side of it (so a
// slow drift, e.g. the headset warming, doesn't fake a result). Each
// experiment is a set of telemetry commands to apply and the ones that undo
// them. Results: a table at the end, and .telemetry/perf-pass.jsonl.
import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const LOG = '.telemetry/log.jsonl';
const CMDS = '.telemetry/commands.jsonl';
const OUT = '.telemetry/perf-pass.jsonl';
const SETTLE = 2000,
  MEASURE = 5000;

const hide = (name) => ({ on: [{ type: 'hide', name, on: true }], off: [{ type: 'hide', name, on: false }] });
const mode = (m) => ({ on: [{ type: 'mode', mode: m, on: false }], off: [{ type: 'mode', mode: m, on: true }] });
const lod = (bias) => ({ on: [{ type: 'lod', bias }], off: [{ type: 'lod', bias: 1 }] });
const cull = (angle) => ({ on: [{ type: 'cull', angle }], off: [{ type: 'cull', angle: 0.0035 }] });
const both = (...xs) => ({ on: xs.flatMap((x) => x.on), off: xs.flatMap((x) => x.off) });

const EXPERIMENTS = [
  ['lod x2', lod(2)],
  ['lod x4', lod(4)],
  ['lod x16 (coarsest)', lod(16)],
  ['cull 0.01', cull(0.01)],
  ['cull 0.03', cull(0.03)],
  ['- stack', hide('stack')],
  ['- bodies', hide('bodies')],
  ['- moons (mode)', mode('moons')],
  ['- fiction (mode)', mode('fiction')],
  ['- star-dome', hide('star-dome')],
  ['- belt', hide('belt')],
  ['- cabinet', hide('cabinet')],
  ['- movement', hide('movement')],
  ['- rimfall', hide('rimfall')],
  ['lod x4 + no moons + no dome', both(lod(4), mode('moons'), hide('star-dome'))],
  ['- stack - bodies', both(hide('stack'), hide('bodies'))],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const size = () => (existsSync(LOG) ? statSync(LOG).size : 0);
const send = (cmds) => cmds.forEach((c) => appendFileSync(CMDS, JSON.stringify(c) + '\n'));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function measure() {
  await sleep(SETTLE);
  const from = size();
  await sleep(MEASURE);
  const s = readFileSync(LOG)
    .subarray(from)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.kind === 'sample');
  if (!s.length) return null;
  return {
    fps: median(s.map((r) => r.fps)),
    js: median(s.map((r) => r.cpuMs)),
    render: median(s.map((r) => r.cpuParts?.render)),
    outside: median(s.map((r) => r.frame?.outsideMs)),
    draws: median(s.map((r) => r.drawCalls)),
    tris: median(s.map((r) => r.triangles)),
  };
}

// --layers: the empty tabletop, then each group added back in turn (what each layer costs on its own floor).
if (process.argv.includes('--layers')) {
  const groups = ['star-dome', 'discworld', 'fiction', 'bodies', 'orrery'];
  const show = (m) => console.log(`${m.label.padEnd(24)} fps ${m.fps}  js ${m.js}  render ${m.render}  outside ${m.outside}  draws ${m.draws}  tris ${Math.round(m.tris / 1000)}k`);
  const all = await measure();
  if (all) show({ label: 'everything', ...all });
  send(groups.map((name) => ({ type: 'hide', name, on: true })));
  const none = await measure();
  if (none) show({ label: 'nothing', ...none });
  for (const name of [...groups].reverse()) {
    send([{ type: 'hide', name, on: false }]);
    const m = await measure();
    if (m) show({ label: `+ ${name}`, ...m });
  }
  console.log('');
}

const f = (v, w = 6, d = 1) => (v == null || Number.isNaN(v) ? '-' : (v > 0 ? '+' : '') + v.toFixed(d)).padStart(w);
const rows = [];
let base = await measure();
if (!base) {
  console.log('no samples: is the headset in a session?');
  process.exit(1);
}
console.log(`baseline: fps ${base.fps}  js ${base.js}  outside ${base.outside}  draws ${base.draws}  tris ${Math.round(base.tris / 1000)}k\n`);
for (const [label, x] of EXPERIMENTS) {
  send(x.on);
  const e = await measure();
  send(x.off);
  const next = await measure();
  if (!e || !next) {
    console.log(`${label}: no samples`);
    continue;
  }
  const mid = (k) => (base[k] + next[k]) / 2;
  const d = (k) => e[k] - mid(k);
  const row = { label, fps: e.fps, dFps: d('fps'), dJs: d('js'), dRender: d('render'), dOutside: d('outside'), dDraws: d('draws'), dTris: d('tris') / 1000, drift: Math.abs(base.draws - next.draws) > 6 };
  rows.push(row);
  appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  console.log(`${label.padEnd(30)} fps ${e.fps.toFixed(1).padStart(5)} (${f(row.dFps)})  js ${f(row.dJs)}  render ${f(row.dRender)}  outside ${f(row.dOutside)}  draws ${f(row.dDraws, 5, 0)}  tris ${f(row.dTris, 6, 0)}k${row.drift ? '  (view drifted)' : ''}`);
  base = next;
}
