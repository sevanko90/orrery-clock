// Headset walkthrough of the new VR scene, through the dev-server telemetry.
//
//   docker compose exec app node scripts/scrunch/vr-walkthrough.mjs [hold-seconds=8]
//
// Open https://<dev-host>:5173/ on the Quest, enter VR (you arrive through the
// wormhole on the Disc's rim), and run this once you're standing there. It
// prints what to look at, moves you between the viewpoints, holds each and
// logs fps / cpu / draw calls / triangles (median of the 1 s samples).
// Results go to .telemetry/vr-walkthrough.jsonl.
//
// Steps:
//   1. spawn       arrival point on the rim, A'Tuin's raised head beyond it
//   2. rim         just off the rim, under its edge: the front elephant
//   3. hub         beside the glass drum: the movement, the Sun
//   4. far         far off in space: the whole stack in profile
//   5. scale sweep at the spawn: giant (0.02 m/unit), default (1.5), insect (80);
//                  then try the grip + stick scaling by hand, aiming the ray
//   6. fiction     plays "The War of the Worlds" from the control box's list,
//                  waits for it to end and checks you were swooped back
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const LOG = '.telemetry/log.jsonl';
const CMDS = '.telemetry/commands.jsonl';
const OUT = '.telemetry/vr-walkthrough.jsonl';
const hold = Number(process.argv[2] ?? 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const entries = (from) =>
  lines()
    .slice(from)
    .map((l) => JSON.parse(l));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function command(cmd) {
  const from = lines().length;
  appendFileSync(CMDS, JSON.stringify(cmd) + '\n');
  for (let t = 0; t < 30; t++) {
    await sleep(1000);
    if (entries(from).some((e) => e.kind === 'command' && e.type === cmd.type)) return;
  }
  throw new Error(`no echo for ${JSON.stringify(cmd)}: is the headset in VR on the dev server?`);
}

async function holdAndLog(step, say, seconds = hold) {
  console.log(`\n[${step}] ${say}`);
  await sleep(2500); // settle (moves take up to 2.5 s)
  const from = lines().length;
  await sleep(seconds * 1000);
  const s = entries(from).filter((e) => e.kind === 'sample');
  const row = {
    at: new Date().toISOString(),
    step,
    n: s.length,
    fps: median(s.map((x) => x.fps)),
    cpuMs: median(s.map((x) => x.cpuMs)),
    drawCalls: median(s.map((x) => x.drawCalls)),
    triangles: median(s.map((x) => x.triangles)),
    metresPerUnit: s.at(-1)?.metresPerUnit,
    head: s.at(-1)?.head,
    grounded: s.at(-1)?.grounded,
  };
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(`  fps ${row.fps} · cpu ${row.cpuMs} ms · ${row.drawCalls} draws · ${row.triangles} tris · scale ${row.metresPerUnit} m/unit · grounded ${row.grounded}`);
  return row;
}

await command({ type: 'note', text: 'vr walkthrough' });
await command({ type: 'view', name: 'spawn' });
await holdAndLog('spawn', "Arrival point. A'Tuin's head should be just beyond the rim, ahead and a little below eye level. Rimfall spray beside you: are the particles a sane size?");
await command({ type: 'view', name: 'rim' });
await holdAndLog('rim', 'Floating just off the rim, under its edge: the front elephant holding up the Disc, the shell below.');
await command({ type: 'view', name: 'hub' });
await holdAndLog('hub', 'Beside the glass drum: the movement turning, the Sun above.');
await command({ type: 'view', name: 'far' });
await holdAndLog('far', 'Far off in space: Disc, elephants and A\'Tuin in profile.');

// Scale sweep, at the spawn.
await command({ type: 'view', name: 'spawn' });
for (const [m, say] of [
  [0.02, 'Giant: the orrery a plate at your feet.'],
  [1.5, 'Default scale.'],
  [80, 'Insect: ~2 cm tall in orrery terms; the drum and gears tower like buildings.'],
  [1.5, 'Back to the default.'],
]) {
  await command({ type: 'scale', metresPerUnit: m });
  await holdAndLog(`scale ${m}`, say, Math.min(hold, 6));
}
console.log('\n[scale by hand] Hold the right grip and push the stick up/down for ~15 s, aiming the ray at the Disc or a planet: the world should grow or shrink about the gold bead.');
await holdAndLog('scale by hand', 'logging while you scale', 15);
await command({ type: 'view', name: 'spawn' });
await command({ type: 'scale', metresPerUnit: 1.5 });

// Fiction: play a dated event and wait for the swoop back.
const before = entries(0).filter((e) => e.kind === 'sample').at(-1)?.head;
await command({ type: 'fiction', id: 'wotw' });
await holdAndLog('fiction: wotw', 'Carried to The War of the Worlds viewpoint (glide if near, fade if far). It plays at a day a second.');
console.log('  waiting for the scene to end (about half a minute)...');
let from = lines().length;
for (let t = 0; t < 120; t++) {
  await sleep(1000);
  const s = entries(from).filter((e) => e.kind === 'sample');
  const last = s.at(-1);
  if (last && last.playing === null && !last.carried) break;
}
await sleep(4000);
const after = entries(0).filter((e) => e.kind === 'sample').at(-1)?.head;
const back = before && after ? Math.hypot(before[0] - after[0], before[1] - after[1], before[2] - after[2]) : null;
console.log(`  returned: head ${JSON.stringify(after)} vs before ${JSON.stringify(before)} (distance ${back?.toFixed(3)} units)`);
appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), step: 'fiction return', before, after, distance: back }) + '\n');
console.log('\nDone. Results: .telemetry/vr-walkthrough.jsonl');
