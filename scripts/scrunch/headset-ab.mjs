// Headset A/B for the VR scrunch, through the dev-server telemetry.
//
//   docker compose exec app node scripts/scrunch/headset-ab.mjs <label> [seconds=20] [speedStep=8]
//   (speedStep 8 = paused; a running clock, e.g. 12, also measures the per-frame
//   cost of moving batched parts, the moons' orbit lines among them)
//
// Run it once per build, each in a fresh VR session:
//   A: https://<dev-host>:5173/?scrunch=0   (original scene)
//   B: https://<dev-host>:5173/?scrunch=1   (scrunched; also the headset default)
// Enter VR with fiction, Discworld and moons already on (as in the earlier
// runs), say ready, then run this with label A or B. It never toggles modes
// (off→on toggles trip the open 10 fps bug); it only sets the date and moves
// the player between the VR viewpoints (spawn, rim, hub, far: viewpoints()
// in src/xr/vrScene.ts) with the telemetry `view` command. For each marker it waits for the
// command's echo in the log, lets the frame rate settle, then takes the
// median of the 1 s samples. Results are appended to
// .telemetry/scrunch-ab.jsonl so A and B can be compared side by side:
//   docker compose exec app node scripts/scrunch/headset-ab.mjs --compare
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const LOG = '.telemetry/log.jsonl';
const CMDS = '.telemetry/commands.jsonl';
const OUT = '.telemetry/scrunch-ab.jsonl';
const VIEWS = ['spawn', 'rim', 'hub', 'far'];
const DATE = '2027-08-20T12:00:00Z';

const [label, secondsArg, stepArg] = process.argv.slice(2);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

if (label === '--compare') {
  const rows = existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last = new Map();
  for (const r of rows) last.set(`${r.label}|${r.marker}`, r);
  console.log('label  view     scrunch  fps    cpuMs  drawCalls  triangles  n');
  for (const r of [...last.values()].sort((a, b) => a.marker.localeCompare(b.marker) || a.label.localeCompare(b.label))) {
    console.log(`${r.label.padEnd(6)} ${r.marker.padEnd(8)} ${String(r.scrunch).padEnd(8)} ${r.fps.toFixed(1).padEnd(6)} ${r.cpuMs.toFixed(1).padEnd(6)} ${String(r.drawCalls).padEnd(10)} ${String(r.triangles).padEnd(10)} ${r.n}`);
  }
  process.exit(0);
}
if (!label) {
  console.error('usage: headset-ab.mjs <label> [seconds]  |  headset-ab.mjs --compare');
  process.exit(1);
}
const seconds = Number(secondsArg ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const send = (cmd) => appendFileSync(CMDS, JSON.stringify(cmd) + '\n');

/** Send a command and wait until the page echoes it back (it polls every 2 s). */
async function command(cmd) {
  const from = lines().length;
  send(cmd);
  for (let t = 0; t < 30; t++) {
    await sleep(1000);
    const echo = lines()
      .slice(from)
      .map((l) => JSON.parse(l))
      .find((e) => e.kind === 'command' && e.type === cmd.type);
    if (echo) return;
  }
  throw new Error(`no echo for ${JSON.stringify(cmd)}: is the headset in VR on the dev server?`);
}

async function sampleAt(marker) {
  await command({ type: 'view', name: marker });
  await sleep(6000); // settle (LOD levels, frame pacing)
  const from = lines().length;
  await sleep(seconds * 1000);
  const samples = lines()
    .slice(from)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'sample');
  if (!samples.length) throw new Error('no samples: is the headset still in VR?');
  const row = {
    at: new Date().toISOString(),
    label,
    marker,
    scrunch: samples[0].scrunch,
    modes: samples[0].modes,
    n: samples.length,
    fps: median(samples.map((s) => s.fps)),
    cpuMs: median(samples.map((s) => s.cpuMs)),
    drawCalls: median(samples.map((s) => s.drawCalls)),
    triangles: median(samples.map((s) => s.triangles)),
    lod: samples[samples.length - 1].lod,
    sphereLod: samples[samples.length - 1].sphereLod,
  };
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
  const m = row.modes ?? {};
  if (!m.fiction || !m.discworld || !m.moons) console.warn('warning: not all of fiction/discworld/moons are on; runs are only comparable with the same modes');
}

await command({ type: 'note', text: `scrunch A/B ${label}` });
await command({ type: 'date', iso: DATE });
await command({ type: 'speed', step: Number(stepArg ?? 8) }); // 8: paused
for (const view of VIEWS) await sampleAt(view);
console.log('done. compare with: docker compose exec app node scripts/scrunch/headset-ab.mjs --compare');
