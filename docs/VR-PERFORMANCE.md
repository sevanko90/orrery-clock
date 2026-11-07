# VR performance log (Quest 3)

What we tried to make the VR scene hold 72 fps on a Quest 3 (Quest Browser,
WebGL 2 backend of three's WebGPURenderer, multiview), why, and what each
step bought in which part of the frame budget. Numbers are headset
measurements unless marked "desktop". Keep this updated: it is the record
that stops us re-running the same experiments.

## Summary: what worked and what didn't

Where it ended (2026-11-07): roughly 60–69 fps at the heavy viewpoints,
72 at the lighter ones, judged smooth enough. Perf work stopped there in
favour of polish; the renderer stays WebGPURenderer.

**Worked (measured on the headset):**

| change | what it bought |
|---|---|
| Fixing the NaN frame step on leaving VR | 10 fps → normal after re-entering VR; picks 60–120 ms → under 3 ms |
| Asking for 72 Hz instead of the default 90 | a 13.9 ms frame instead of 11.1 ms; spawn locks 72 |
| BVH index for Discworld lore picking (three-mesh-bvh) | VR pointer 3 ms → 0.3 ms per frame (it brute-forced ~92k triangles every frame) |
| Dropping the glass drum in VR | hub 52 → ~61 fps (a cheaper unlit glass first gave +4); the glass was the costliest pixel work in the scene |
| Shader warm-up before the Demolition blast | desktop worst frame 83 → 34 ms (VR warm-up fixed later to finish in a session) |
| Disc occlusion and the movement-hide fix | fewer triangles drawn; no fps change on its own, but removed a visible pop |

**Didn't work (no measurable fps change, kept or dropped as noted):**

| change | result |
|---|---|
| Batching the orrery and Discworld (720 → 284 draws) | fps unchanged (~48 at the marker 1 view) |
| Scrunch round 1: distance LODs for gears, plates, spheres; triangles halved | fps unchanged |
| Scrunch round 2: one batch per shading model, merged lines and sprites, globe texture array (draws halved again, 150 → 65) | fps unchanged at the time. Re-tested after the glass and picking fixes (same session, two passes each): +3 fps at rim only (65 → 68; render 6.2 → 4.8 ms), nothing elsewhere. Taken out (8b79252, tag before-unscrunch has it): not worth ~1000 lines, ~22 MB GPU memory and a ~0.5 s rebuild hitch |
| Lower eye-buffer resolution (`xrscale` 0.6, 0.8) | no change, and it looked worse |
| MSAA off | no change; full MSAA kept |
| 90 vs 72 Hz at the heavy views | same fps either way |
| Fewer lights / no environment map at hub | lamp off +1 fps (noise level); env map ~+4 in one run; Sun, fill and Discworld lights nothing |

**What we learned, so we don't repeat it:**

- **Measure where the frame goes before optimising.** Two rounds of draw-call
  work were built on a "~45 µs per draw" model that was wrong; a one-session
  sweep (`scripts/headset-sweep.mjs`: per-part timings, hiding parts live)
  found the real costs in one go: the pointer's picking and the glass.
- **The frame is our JS plus ~7 ms outside it** (three's XR setup, the
  browser, GPU waits). Even a trivial page has ~3 ms outside; ours ~6.6–7.3.
  So our JS budget at 72 Hz is about 7 ms, not 11.
- **Raw WebGL draws are almost free** (6000 per frame cost 1.15 ms in the
  bench); three's draw loop costs ~80 µs per draw. Draws matter only once
  everything else is under budget, and only for CPU-bound views.
- **Triangles and pixels weren't the limit** on Quest 3 at these counts;
  overdraw from big transparent surfaces was (the glass).
- **Test a hypothesis with a same-build A/B (URL flag or live toggle)
  before building on it.** Across sessions, run noise is ±4 fps and the
  headset slows as it warms (render time crept 4.1 → 5.5 ms in an hour).
- **Quest Browser quirks:** `window.requestAnimationFrame` doesn't run
  during an XR session, so anything polling with it (three's GPU readback
  and async shader compile) never finishes unless a timer stands in. The
  Quest exposes no GPU timer extension.

## The budget

At 72 Hz a frame has 13.9 ms. The Quest Browser itself is not the limit:
the raw-WebXR bench (`bench.html`) holds 120, 90 and 72 Hz with a trivial
scene.

| part | budget | how we know |
|---|---|---|
| Our JavaScript per frame (everything inside the animation-loop callback) | **≈ 11 ms** | bench: synthetic 11 ms/frame holds 72.0 fps, 12 ms → 69.1, 13 ms → 64.9 |
| Raw WebGL draw calls | almost free | bench: 6000 `drawElements` per frame (3000 cubes × 2 eyes) cost 1.15 ms and held 72 |
| three.js per-object work (culling, sorting, state, uniforms) | the real cost behind "draw calls" | scene render 4–5.5 ms for ~60 draws but ~1035 visible objects walked |
| GPU | limits hub (glass drum + movement behind it) | Quest has no GPU timer; priced by hiding parts live (sweep S1) |

Note: the `spawn` viewpoint moved from the shell's crown to near its front edge (facing A'Tuin's head) after caf60f3; earlier spawn numbers are from the crown.

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

## One-session sweep (2026-11-07, `scripts/headset-sweep.mjs`, label S1)

Each line hides one part live (telemetry `hide`) and re-measures. The Quest
has no GPU timer extension, so GPU cost shows up as "outside" time: the
gap between the end of our frame's work and the start of the next.

| view | base fps | our JS ms | outside ms | three render (walk / draw loop) |
|---|---|---|---|---|
| spawn | 68.6 | 8.1 | 6.6 | 4.6 (0.4 / 4.2) |
| rim | 58.7 | 10.4 | 7.3 | 6.2 (0.4 / 5.5) |
| hub | 52.3 | 8.1 | **11.5** | 4.8 (0.4 / 4.4) |
| far | 63.6 | 9.2 | 7.2 | 5.6 (0.4 / 4.9) |

- **The frame is our JS + outside time.** Even at spawn the outside time is
  ~6.6 ms (three's XR setup, the browser's submit, GPU waits), against
  ~2.9 ms in the trivial bench. So our JS must stay near **7 ms**, not 11,
  while the GPU load stays as it is.
- **Hub is GPU-bound**: outside time 11.5 ms. Hiding the glass drum gives
  61 fps (outside 7.6), hiding the movement 65.5 (outside 6.6), the cabinet
  60.8. Looking through a double-sided transparent PBR cylinder at lit brass
  gears is the expensive pixel work.
- **Rim is CPU-bound** (JS 10.4 ms). What it gains when hidden: the
  Discworld stack +6 fps (−1.0 ms JS), planets and moons +4.7, fiction +4.5,
  the lift +4.2 (4 draws), orbit lines +2.6, cabinet/glass +2.
- **three's draw loop costs ~80 µs per draw** on Quest (rim: 5.5 ms for 78
  draws), while its scene walk is only 0.3–0.4 ms. So draws do cost CPU;
  halving them didn't raise fps at hub because hub is GPU-bound, and at rim
  the gain was lost in noise and other costs.
- No garbage-collection pauses. The probes' own cost is within noise.

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
| 12 | Cheap VR glass drum: unlit additive Fresnel sheen, one pass, instead of lit double-sided transparent PBR | sweep S1: hiding the glass took hub 52 → 61 fps (GPU) | GPU (outside time) | live A/B at hub, alternating twice: cheap 63.4 / 64.2 vs full 57.3 / 62.1 fps (outside 7.0 vs 7.2–9.2 ms); rim unchanged (~61). Then dropped the glass in VR altogether (the player walks through it anyway): the mechanism stands open in its brass frame | 3f009a1, 8ac1109, telemetry `glass` |
| 13 | Lights and environment map priced at hub (no glass), switching each off live | sweep S1 blamed the movement's shading at hub | GPU | none is a big lever: lamp off +1 fps (3 alternations: 62.5/63.8/64.0 vs 61.8/60.9/64.3), env map off ~+4 (single run), Sun/fill/Disc lights within noise. With the glass gone, hub's outside time is ~7.3 ms, about the floor seen at spawn: hub is no longer GPU-bound, the remaining gap is our JS (~8.5 ms) | 3a0eeb3, sweep L1/L2 |

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

(The A/B switches used along the way, `?sskip=`, `?xrhz=`, `?xrscale=`,
`?msaa=0`, `?sunlitkey=`, `?layerpx=`, the GPU timer and the old
`scripts/scrunch/` measuring scripts, were removed in the cleanup after the
renderer decision. Check out tag `vr-scene-good-2` to get them back.)

- **`bench.html`** (dev server, `/bench.html`): raw WebGL 2 + WebXR, no
  three.js. Enter VR and keep still ~2 min; it sweeps refresh rate,
  synthetic JS load per frame and raw draw count, logging each step to
  telemetry (`kind: "bench"`), plus a JS micro-benchmark at load (open it on
  desktop too to compare JS speed).
- **Telemetry samples** (`.telemetry/log.jsonl`, 1 per second, dev server
  only): `fps`, `cpuMs`, `cpuParts` (ms per frame by part: mechanism, bodies,
  fiction, discworld, xr.input/move/lift/sky/view/pointer/wrist, matrices,
  sync, render, uiTelemetry; with probes on also render>project and
  render>draw), `frame` (interval p50/p95/max, missed frames, outside time,
  long frames, GCs, heap), `objects` ([all, visible]), `drawCalls`,
  `triangles`, `multiDraw`, `nonFinite`, `hz`, modes.
- **Commands** (`.telemetry/commands.jsonl`): `view` (spawn, rim, hub,
  far), `hide` (a scene part by name, or `type:X`), `probe`, `list`,
  teleport, scale, mode, date, speed, cull, fiction, return.
- **`scripts/headset-sweep.mjs [label]`**: one VR session; base and probed
  runs at each viewpoint, then at rim and hub prices each scene part by
  hiding it. `--toggle-hide <name>` alternates one part at hub.
- **URL flags:** `?scrunch=0|1` (the headset's cheaper scene; on by default
  in VR), `?webgl=1`, `?headset=1&vrview=1` (desktop stands in for the
  headset), `?seed=1` (repeatable scene for image comparisons).
- **Scrunch agents** (`.claude/agents/`): scruncher optimises, scrunch-reviewer
  scores independently. Their budget assumed draws were the main lever; read
  this log before another round.

## Open

Decided 2026-11-07: perf is good enough (≈ 60–69 fps); stay on
WebGPURenderer; the work moves to polish. If perf work resumes:

1. Our JS needs to be near 7 ms (outside time ~6.6–7.3 ms at every view).
   Biggest JS cost: three's draw loop, ~80 µs per draw.
2. three's render call: ~1035 visible objects walked per frame (walk is only
   0.3–0.4 ms; the draw loop dominates).
3. Thermal drift over long sessions: test cool, keep runs short.
4. Scrunch round 2's rebuild hitch (~0.5 s when moons or fiction are first
   turned on mid-session): reuse the batch materials across rebuilds.
