// Price scene parts live in the headset by hiding each for a few seconds.
//
//   docker compose exec app node scripts/hide-ab.mjs [name ...]
//
// Hold the view steady while it runs. For each name (an object's name in
// the scene, as the telemetry `hide` command takes it) it measures a
// baseline, then with that part hidden, and prints fps, JS (cpuMs), render,
// outside time (GPU waits land there), missed frames and draws.
import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const LOG = '.telemetry/log.jsonl';
const CMDS = '.telemetry/commands.jsonl';
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['star-dome', 'stack', 'rimfall', 'discworld'];
const SETTLE = 2000,
  MEASURE = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const size = () => (existsSync(LOG) ? statSync(LOG).size : 0);
const send = (cmd) => appendFileSync(CMDS, JSON.stringify(cmd) + '\n');
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const samplesSince = (offset) =>
  readFileSync(LOG)
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

async function measure(label) {
  await sleep(SETTLE);
  const from = size();
  await sleep(MEASURE);
  const s = samplesSince(from);
  if (!s.length) {
    console.log(`${label.padEnd(18)} no samples (is the headset in a session?)`);
    return null;
  }
  const f = (v, d = 1) => (v == null ? '   -' : v.toFixed(d).padStart(5));
  const m = { fps: median(s.map((r) => r.fps)), js: median(s.map((r) => r.cpuMs)), outside: median(s.map((r) => r.frame?.outsideMs)), draws: median(s.map((r) => r.drawCalls)) };
  console.log(
    `${label.padEnd(18)} fps ${f(median(s.map((r) => r.fps)))}  js ${f(median(s.map((r) => r.cpuMs)))}  render ${f(median(s.map((r) => r.cpuParts?.render)))}  outside ${f(median(s.map((r) => r.frame?.outsideMs)))}  missed ${String(s.reduce((a, r) => a + (r.frame?.missed ?? 0), 0)).padStart(3)}  draws ${f(median(s.map((r) => r.drawCalls)), 0)}`,
  );  return m;
}

// Each part measured on, hidden, on again, back to back: its cost is the hidden run against the
// mean of its two neighbours, so a view that drifts during the run can't fake a result.
for (const name of names) {
  const before = await measure(`  ${name} shown`);
  // ("a+b" hides several parts together.)
  for (const part of name.split('+')) send({ type: 'hide', name: part, on: true });
  const hidden = await measure(`- ${name}`);
  for (const part of name.split('+')) send({ type: 'hide', name: part, on: false });
  const after = await measure(`  ${name} shown`);
  if (before && hidden && after) {
    const d = (k) => (hidden[k] - (before[k] + after[k]) / 2).toFixed(1);
    const drift = Math.abs(before.draws - after.draws) > 6 ? '  (view drifted: retry)' : '';
    console.log(`= ${name.padEnd(16)} fps ${d('fps')}  js ${d('js')}  outside ${d('outside')}  draws ${d('draws')}${drift}\n`);
  }
}
