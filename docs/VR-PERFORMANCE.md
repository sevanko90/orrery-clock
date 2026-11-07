# VR performance log (Quest 3)

What we tried to make the VR scene hold 72 fps on a Quest 3 (Quest Browser,
WebGL 2 backend of three's WebGPURenderer, multiview), why, and what each
step bought in which part of the frame budget. Numbers are headset
measurements unless marked "desktop". Keep this updated: it is the record
that stops us re-running the same experiments.

## The budget

At 72 Hz a frame has 13.9 ms. The Quest Browser itself is not the limit:
the raw-WebXR bench (`bench.html`) holds 120, 90 and 72 Hz with a trivial
scene.

| part | budget | how we know |
|---|---|---|
| Our JavaScript per frame (everything inside the animation-loop callback) | **≈ 11 ms** | bench: synthetic 11 ms/frame holds 72.0 fps, 12 ms → 69.1, 13 ms → 64.9 |
| Raw WebGL draw calls | almost free | bench: 6000 `drawElements` per frame (3000 cubes × 2 eyes) cost 1.15 ms and held 72 |
| three.js per-object work (culling, sorting, state, uniforms) | the real cost behind "draw calls" | scene render 4–5.5 ms for ~60 draws but ~1035 visible objects walked |
| GPU | not yet isolated at hub | `gpuMs` telemetry added (5db1852); `?xrscale=` test pending |

Run-to-run noise is about ±4 fps. Over a long session the headset warms
up and slows down: the same render call crept from 4.1 to 5.5 ms over an
hour. Compare A/B runs back to back in the same session, using URL flags
on the same build, not across sessions.

## Current frame split (2026-11-07, after the lore-pick fix)

Median ms per frame from telemetry `cpuParts`, fiction, Discworld and moons on:

| part | spawn | rim | hub | far |
|---|---|---|---|---|
| three render call | 5.0 | 5.7 | 5.4 | 5.7 |
| batch / LOD / sprite / line sync | 0.8 | 1.0 | 1.0 | 1.0 |
| scene matrices | 0.6 | 0.7 | 0.7 | 0.6 |
| planet bodies | 0.4 | 0.4 | 0.4 | 0.4 |
| VR pointer (picking) | 0.3 | 0.4 | 0.3 | 0.3 |
| everything else | < 0.6 | < 0.6 | < 0.6 | < 0.6 |
| **total JS** | 8.2 | 9.3 | 8.9 | 9.1 |
| fps (that run) | 68 | 65 | 52 | 65 |

JS is now under the 11 ms budget at every viewpoint, yet hub runs at ~50.
So hub's remaining limit is outside our JavaScript: the GPU (looking
through the glass drum, layers of transparency) or heat. That is the next
thing to settle.

## Ledger: what we did, why, what it bought

| # | change | why | part of budget | measured result | where |
|---|---|---|---|---|---|
| 1 | WebGPURenderer (TSL shaders) with multiview in VR; bloom off in VR | one submission for both eyes; bloom can't run multiview | render CPU | made VR viable; no isolated fps figure | `webgpu` branch |
| 2 | BatchedMesh batching of orrery and Discworld | draw calls looked like the cost | render CPU | draws 720 → 284; fps barely moved (~48 → ~48 at marker 1, cpu ~12 ms) | b205396 |
| 3 | Mode step-down test | find what costs most | — | Discworld −0, moons −0.4, fiction −8 fps, hangar −8 fps (72.9 with all off) | measurement only |
| 4 | NaN frame-step fix on VR exit | re-entry ran at 10 fps, objects vanished | everything | 10 fps → normal; picks 60–120 ms → ≤ 2.9 ms (NaN matrices defeated the raycaster's bounding-sphere reject) | e7938ac |
| 5 | Request 72 Hz at session start (`?xrhz=`) | Quest default can be 90 | frame budget 11.1 → 13.9 ms | spawn locks 72; heavy views 61–68 at both 72 and 90 | scrunch/vr-scene |
| 6 | `?xrscale=0.8`, `?msaa=0` tests | rule out GPU fill | GPU | no change (±4 fps), at the time: GPU was not the limit then; full res + MSAA kept | measurement only |
| 7 | Scrunch round 1: gear/plate/sphere distance LODs, fiction sprite batch | triangles (~1.1M) and fiction draws | render CPU, GPU | rim 283 → 150 draws, 623k → 319k tris (desktop count); headset 117–131 draws, 61–68 fps | fc3eae6..39fcbb8, `?scrunch=0/1` |
| 8 | Scrunch round 2: one batch per shading model, merged orbit lines, glow sprites, globe texture array, Disc occlusion | draws still believed the lever (~45 µs/draw model) | render CPU | draws halved again (rim 156 → 65, hub 126 → 58, far 145 → 65) but **fps unchanged** (same-build A/B, `?sskip=all` vs default). Costs: ~0.5 s rebuild hitch when moons/fiction first enabled mid-session, ~22 MB GPU memory. Kept on branch, not merged | 6bd761f..5502193, `?sskip=` |
| 9 | Demolition-of-Earth shader warm-up (`compileAsync` when the fleet arrives) | visible hitch at the blast | one-off stall | desktop worst frame 83 → ≤ 34 ms | 3484a4a |
| 10 | Movement hidden only while under the Disc (not "below table height") | gears popped in past the rim | correctness | pop gone; small extra draw cost outside the rim | 3484a4a |
| 11 | BVH (three-mesh-bvh) for Discworld lore picking | VR picks every frame; the plain test walked ~92k triangles of 199 parts | our JS | VR pointer 3.0 ms → 0.33 ms per frame (headset); desktop pick 1.77 → 0.09 ms, identical hits | bbe9eb5 |

## Models that turned out wrong

- **"Resolution/triangles are the cost."** Disproved early (#6, #7): fps
  didn't track triangles or pixels.
- **"CPU-bound on draw submission, ~45 µs per draw."** Fitted to a few
  points and drove scrunch round 2. Disproved by #8 (draws halved, fps flat)
  and by the bench (raw draws ~0.2 µs). What costs is three.js's per-object
  work and our own per-frame JS, not the GL calls.
- **Lesson:** measure where the frame goes (`cpuParts`, `gpuMs`) before
  optimising, and test a hypothesis with a same-build A/B before building a
  round of work on it.

## Tools

- **`bench.html`** (dev server, `/bench.html`): raw WebGL 2 + WebXR, no
  three.js. Enter VR and keep still ~2 min; it sweeps refresh rate,
  synthetic JS load per frame and raw draw count, logging each step to
  telemetry (`kind: "bench"`), plus a JS micro-benchmark at load (open it on
  desktop too to compare JS speed).
- **Telemetry samples** (`.telemetry/log.jsonl`, 1 per second): `fps`,
  `cpuMs`, `cpuParts` (ms per frame by part: mechanism, bodies, fiction,
  discworld, xr.input/move/lift/sky/view/pointer/wrist, matrices, sync,
  render, uiTelemetry), `gpuMs`, `objects` ([all, visible]), `drawCalls`,
  `triangles`, `multiDraw`, `nonFinite`, `hz`, modes.
- **Commands** (`.telemetry/commands.jsonl`): `{"type":"view","name":"spawn|rim|hub|far"}`,
  teleport, mode, date, speed, cull, etc.
- **`scripts/scrunch/headset-ab.mjs <label> [secs] [speedStep]`**: steps
  through the four viewpoints and records medians; `--compare` prints
  the table.
- **URL flags:** `?scrunch=0|1`, `?sskip=all` (or a list: uber, layers,
  lines, sprites, single, occlude), `?xrhz=`, `?xrscale=`, `?msaa=0`,
  `?webgl=1`, `?headset=1&vrview=1` (desktop stands in for the headset).
- **Scrunch agents** (`.claude/agents/`): scruncher optimises, scrunch-reviewer
  scores independently. They assume draws are the lever; revisit their
  budget section before another round.

## Open

1. Hub at ~50 fps with JS under budget: check `gpuMs` and `?xrscale=0.7` at
   hub; if GPU-bound, look at the glass drum and stacked transparent layers.
2. three's render call (4–5.5 ms): ~1035 visible objects walked per frame
   for ~60 draws. Hide the originals of batched parts from the graph walk
   (not just by layer), drop empty batches (6–11 per view).
3. Thermal drift over long sessions: test cool, keep runs short.
4. Scrunch round 2: neutral for fps; decide whether to keep once the real
   limit is fixed (it may then pay off). Rebuild hitch fix if kept.
5. Native port question (Unity etc.) parked until the above numbers are in.
