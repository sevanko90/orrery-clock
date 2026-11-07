// One-session headset profile, through the dev-server telemetry.
//
//   docker compose exec app node scripts/headset-sweep.mjs [label]
//
// Enter VR (fiction, Discworld and moons on), then run this. It never needs
// you to leave VR: at each viewpoint it measures
//   base   probes off (the plain cost)
//   probe  probes on (GPU time, three's render split; and their own overhead)
// and at the heavy viewpoints it hides one part of the scene at a time
// (telemetry `hide`) to price each part in fps, JS and GPU time.
// Results: .telemetry/sweep.jsonl, and a table at the end.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const LOG = '.telemetry/log.jsonl';
const CMDS = '.telemetry/commands.jsonl';
const OUT = '.telemetry/sweep.jsonl';
const label = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== 'glass') ?? `sweep-${new Date().toISOString().slice(11, 16)}`;
const VIEWS = ['spawn', 'rim', 'hub', 'far'];
const HEAVY = new Set(['rim', 'hub']);
// Scene parts to price by hiding (names in the scene, or "type:X" for top-level objects of a type).
const PARTS = ['glass', 'cabinet', 'movement', 'bodies', 'stack', 'rimfall', 'fiction', 'stars', 'type:Sprite', 'sprite-batch', 'line-batch', 'lift'];
const SETTLE = 3, MEASURE = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const send = (cmd) => appendFileSync(CMDS, JSON.stringify(cmd) + '\n');
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function command(cmd) {
  const from = lines().length;
  send(cmd);
  for (let t = 0; t < 20; t++) {
    await sleep(500);
    const echoed = lines()
      .slice(from)
      .some((l) => {
        const r = JSON.parse(l);
        return r.kind === 'command' && r.type === cmd.type && (cmd.name === undefined || r.name === cmd.name);
      });
    if (echoed) return true;
  }
  console.error('no echo for', JSON.stringify(cmd), '(is the headset in VR?)');
  return false;
}

async function measure(view, step) {
  await sleep(SETTLE * 1000);
  const from = lines().length;
  await sleep(MEASURE * 1000);
  const s = lines()
    .slice(from)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'sample');
  const parts = {};
  for (const r of s) for (const [k, v] of Object.entries(r.cpuParts ?? {})) (parts[k] ??= []).push(v);
  const cpu = {};
  for (const [k, v] of Object.entries(parts)) cpu[k] = median(v);
  const js = Object.entries(cpu)
    .filter(([k]) => !k.includes('>'))
    .reduce((a, [, v]) => a + (v ?? 0), 0);
  const row = {
    label,
    view,
    step,
    n: s.length,
    fps: median(s.map((r) => r.fps)),
    jsMs: +js.toFixed(2),
    gpuMs: median(s.map((r) => r.gpuMs)),
    outsideMs: median(s.map((r) => r.frame?.outsideMs)),
    missed: median(s.map((r) => r.frame?.missed)),
    intervalP95: median(s.map((r) => r.frame?.intervalP95)),
    gcs: s.reduce((a, r) => a + (r.frame?.gcs ?? 0), 0),
    longFrames: s.reduce((a, r) => a + (r.frame?.longFrames ?? 0), 0),
    draws: median(s.map((r) => r.drawCalls)),
    objects: s.at(-1)?.objects ?? null,
    cpu,
  };
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  const f = (x, d = 1) => (x == null ? '  -  ' : x.toFixed(d).padStart(5));
  console.log(
    `${view.padEnd(6)} ${step.padEnd(18)} fps ${f(row.fps)}  js ${f(row.jsMs, 2)}  gpu ${f(row.gpuMs, 2)}  outside ${f(row.outsideMs, 2)}  ` +
      `render ${f(cpu.render, 2)} (walk ${f(cpu['render>project'], 2)} draw ${f(cpu['render>draw'], 2)})  missed/s ${f(row.missed, 0)}  gc ${row.gcs}  draws ${row.draws}`,
  );
  return row;
}

// `--toggle glass`: at rim and hub only, alternate the cheap VR glass and the desktop glass, twice each.
if (process.argv.includes('--toggle')) {
  for (const view of ['hub', 'rim']) {
    await command({ type: 'view', name: view });
    for (const cheap of [true, false, true, false]) {
      await command({ type: 'glass', cheap });
      await measure(view, cheap ? 'glass cheap' : 'glass full');
    }
  }
  await command({ type: 'glass', cheap: true });
  console.log(`done: ${OUT} (label ${label})`);
  process.exit(0);
}

await command({ type: 'list' });
await command({ type: 'date', iso: '2027-08-20T12:00:00Z' });
await command({ type: 'speed', step: 8 });
for (const view of VIEWS) {
  await command({ type: 'view', name: view });
  await command({ type: 'probe', on: false });
  await measure(view, 'base');
  await command({ type: 'probe', on: true });
  await measure(view, 'probe');
  if (HEAVY.has(view)) {
    for (const part of PARTS) {
      await command({ type: 'hide', name: part, on: true });
      await measure(view, `-${part}`);
      await command({ type: 'hide', name: part, on: false });
    }
  }
  await command({ type: 'probe', on: false });
}
console.log(`done: ${OUT} (label ${label})`);
