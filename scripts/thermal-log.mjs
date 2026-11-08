// Thermal run: how the headset's frame time drifts as it warms.
//
//   docker compose exec app node scripts/thermal-log.mjs [minutes] [label]
//
// Start with a cold headset, enter the tabletop (or VR) and keep the view
// roughly steady. Every 30 s it prints the medians of the telemetry samples
// since the last line (fps, frame interval p95, JS cpu, render, outside time,
// missed frames, draws) and appends them to .telemetry/thermal.jsonl.
import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const LOG = '.telemetry/log.jsonl';
const OUT = '.telemetry/thermal.jsonl';
const minutes = Number(process.argv[2] ?? 20);
const label = process.argv[3] ?? `thermal-${new Date().toISOString().slice(0, 16)}`;
const STEP = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const size = () => (existsSync(LOG) ? statSync(LOG).size : 0);
const since = (offset) => {
  const buf = readFileSync(LOG);
  return buf
    .subarray(offset)
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
};

const start = Date.now();
let offset = size();
console.log(`${label}: ${minutes} min, a line every ${STEP / 1000} s`);
console.log('  min   fps  p95ms  cpuMs render outside missed draws  tris   mode');
while (Date.now() - start < minutes * 60_000) {
  await sleep(STEP);
  const s = since(offset);
  offset = size();
  if (!s.length) {
    console.log('  (no samples: is the headset in a session?)');
    continue;
  }
  const row = {
    label,
    at: new Date().toISOString(),
    min: +((Date.now() - start) / 60_000).toFixed(1),
    n: s.length,
    fps: median(s.map((r) => r.fps)),
    p95: median(s.map((r) => r.frame?.intervalP95)),
    cpuMs: median(s.map((r) => r.cpuMs)),
    render: median(s.map((r) => r.cpuParts?.render)),
    outside: median(s.map((r) => r.frame?.outsideMs)),
    missed: s.reduce((a, r) => a + (r.frame?.missed ?? 0), 0),
    draws: median(s.map((r) => r.drawCalls)),
    tris: median(s.map((r) => r.triangles)),
    mode: s.at(-1).session === 'ar' ? 'table' : (s.at(-1).session ?? '?'),
  };
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  const f = (v, w, d = 1) => (v == null ? '-' : v.toFixed(d)).padStart(w);
  console.log(
    `${f(row.min, 5)} ${f(row.fps, 5)} ${f(row.p95, 6)} ${f(row.cpuMs, 6)} ${f(row.render, 6)} ${f(row.outside, 7)} ${String(row.missed).padStart(6)} ${f(row.draws, 5, 0)} ${f(row.tris / 1000, 5, 0)}k  ${row.mode}`,
  );
}
