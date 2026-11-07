# WebXR on Quest: lessons

Dos and don'ts for building VR in the browser for a Meta Quest, drawn from
taking this orrery into VR on a Quest 3 (Quest Browser, three.js
WebGPURenderer on its WebGL 2 backend, multiview). Most of it holds for any
WebXR app on Quest; the three.js section is library-specific. The detailed
measurements behind it are in `docs/VR-PERFORMANCE.md`.

## Measuring

- **Measure where the frame goes before optimising.** Time each part of the
  frame inside the loop, and log the gap between the end of one frame's work
  and the start of the next (time outside your code). Two rounds of work
  here were built on a wrong theory that a two-minute split would have
  disproved.
- **Price features by switching them off live**, from a workstation-side
  command, without leaving VR. Cost by elimination finds the expensive thing
  faster than reasoning about it.
- **A/B in the same session, back to back**, with a URL flag or a live
  toggle. Expect ±4 fps run-to-run noise, and the headset slows as it warms
  (render time crept 4.1 → 5.5 ms over an hour).
- **Keep a trivial raw-WebXR bench page.** It gives the device's real ceiling
  (here 120 / 90 / 72 Hz held easily), so you know whether the limit is the
  browser or your code.
- **Don't trust desktop numbers for Quest.** Everything was 4–5× slower, and
  not in the same proportions.
- **Build a remote loop early:** telemetry posted to the dev server, commands
  polled from it, and a way to grab a screenshot of the headset's view. It
  saves taking the headset on and off for every question.

## The frame budget

- **Budget far less JS than 1 / refresh rate.** At 72 Hz the frame is
  13.9 ms, but the browser, compositor and GPU waits took ~7 ms outside our
  code (~3 ms even for a trivial page). Plan on about half the frame for
  your JavaScript.
- **Ask for 72 Hz explicitly** (`session.updateTargetFrameRate(72)`); the
  Quest often defaults to 90.
- **Draw calls aren't automatically the cost.** Raw WebGL draws were nearly
  free (6000 a frame cost 1.15 ms); what a framework does per object costs
  more. Halving draw calls twice moved fps by 0–3.
- **Triangles and resolution weren't the limit** at our counts (up to
  ~500k triangles; eye-buffer scale 0.6–0.8 changed nothing and looked
  worse). **Big transparent surfaces were:** one double-sided glass cylinder
  close to the viewer cost ~9 fps in overdraw.
- **Lights barely mattered** in a scene of a handful of lights; don't strip
  look-defining lighting on a hunch.

## Per-frame work

- **Audit anything that runs every frame in VR but only on a click on the
  desktop.** Pointer raycasts against detailed meshes were the biggest
  single cost here (3 ms a frame). Index meshes (a BVH) or raycast simple
  stand-ins.
- **Guard against NaN state.** A missing timestamp on session start/end gave
  a NaN frame step that poisoned matrices: objects vanished, raycasts
  crawled (NaN defeats bounding-sphere rejects), fps fell to 10. When
  symptoms span unrelated systems, scan for non-finite matrices first.
- **Warm shaders before their first use**, or the first frame that shows a
  new effect stalls; in VR, compile for the two-eye (multiview) variants.

## Quest Browser quirks

- **`window.requestAnimationFrame` doesn't run during an immersive
  session** (only the session's own loop does). Anything polling with it
  never finishes: in three.js, GPU readback (`readRenderTargetPixelsAsync`)
  and async shader compiles (`compileAsync`). Stand a short timer in for it
  while such work is pending.
- **No GPU timer extension** (`EXT_disjoint_timer_query_webgl2`): infer GPU
  cost from the time outside your frame, or by turning things off.
- **No page screenshots from inside VR.** Render the left eye's view again
  into an offscreen target, read it back and upload it yourself; worth
  building on day one.
- **`WEBGL_multi_draw` is available**, so batched geometry really does draw
  as one call.

## three.js specifics

- **Read the XR camera's pose from its `matrixWorld`.** Its position and
  quaternion fields aren't kept in step, so `getWorldQuaternion()` rebuilds a
  wrong one.
- **The grip space's −Z runs along the handle**; the pointing direction is
  the target-ray space's −Z.
- **Sprites ignore a scaled rig.** three sizes a sprite from its own world
  scale after the view transform, so if world scale is done by scaling the
  player, sprites need a compensating factor.
- **`XRControllerModelFactory` loads models from a CDN at runtime.** Bundle
  the profiles you need (and point `setPath` at them) for offline use. The
  Quest 3 (meta-quest-touch-plus) model has no touch-point nodes: anchor UI to
  each control's root or moving-part mesh.
- **`NodeLibrary.addMaterial()` won't redefine a type**; to change how a
  classic material converts (e.g. every SpriteMaterial), replace the entry in
  `library.materialNodes`.

## UI in VR

- **Make help discoverable.** Labels that only appear on a gesture nobody
  knows about never appear: show them on arrival, then on a deliberate
  gesture (here, raising a controller in front of the face, pointed up,
  within 50 cm).
- **Make panels and labels face the eyes.** Anything lying on a controller's
  surface is edge-on when you look down at it.
- **Fade UI in and out (~400 ms)** rather than popping; long enough to see,
  short enough not to wait for.
- **Spread labels round a controller** by what reads as up and down when
  it's held up to read (the controller's forward axis, not its up), and end
  leader lines where they meet the controller rather than running through
  it.
- **Keep one panel out at a time** on the wrist, each on its own button, and
  let a quick action (here A/B for clock speed) briefly pop its panel so the
  effect is visible.
- **Things the player walks through anyway** (here, glass) can go in VR: an
  open frame reads fine and costs nothing.
