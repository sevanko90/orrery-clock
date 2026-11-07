# VR polish list

Work queued for after perf (perf is done: see `docs/VR-PERFORMANCE.md`).
Not ordered unless noted.

## 1. Point and click for info cards (done)

Done 2026-11-07: trigger on a body or Discworld figure opens its card in
front of the player (`src/xr/infoPanel.ts`); another object switches it,
empty space or the close mark closes it.


Pointing at an object and pulling the trigger should open its info card,
as clicking does on desktop (planets, moons, fiction bodies, Discworld lore:
A'Tuin, the elephants' nameplates). The pointer already picks every frame
(`XrMode.updatePointer`, `xrPick` in `src/main.ts`, BVH-indexed for
Discworld) and selection already pins a label; this is about showing the
full card in VR.

## 2. Wrist panels (done)

Done 2026-11-07: X opens the time panel (date, speed slider, slower /
pause / faster / now, day / month / year steps), Y the scene panel (moons,
fiction, return, Debug); the debug panel opens beside the scene panel.
One at a time. (`src/xr/controlPanel.ts`.)


Today the clock panel shows debug readouts, and the fiction panel sits
above it. Combine the clock and the scene (fiction) controls into one
panel. Move the debug readouts (fps, CPU, backend) and in-VR toggles to a
separate debug panel, opened from a button.

## 3. Controller labels (done; bundling the model still open)

Done 2026-11-07 (`src/xr/controllerLabels.ts`): engraved brass plates,
one per control, spread round the controller (stick outside, buttons and
grip inside, upper button and trigger on top), facing the eyes, with leader
lines from each control's geometry (trigger and grip lines stop at the
mesh). They show for the first 30 s in VR, then when a controller is raised
in front of the face: within 50 cm, ~40° of the gaze, pointing up, top
toward the eyes; ~0.8 s fade. Wrist panels also face the eyes. Dev builds:
left stick click takes a VR screenshot to `.telemetry/captures/`.
Still to do: bundle the Quest 3 controller model (below).


An overlay on the controllers: arrows and short text for each control
(walk/fly, snap turn, rise/sink, jetpack, select, world scale, time
faster/slower, back to start, wrist panel, marker), ideally looking etched
into the controller's surface.

Feasible: the controller models are not supplied by the OS. three's
`XRControllerModelFactory` downloads them at runtime (glTF, from the WebXR
Input Profiles package on the jsDelivr CDN) and adds them to our scene, so we
can add to them or change them. Each model has named nodes per button and
stick, so labels can be attached to the right part and follow its motion.
"Etched" can be done as decals or an extra texture layer on the controller
mesh, or as small engraved-looking plates hovering just above the surface.

Related: that runtime CDN download should probably go. It fails offline (the
app is a PWA) and adds a third-party request. Bundle the Quest 3 controller
model (`meta-quest-touch-plus` profile) and point the factory at it with
`setPath`, keeping the CDN as a fallback for other headsets.

## 4. Dev telemetry: hardening (done: capture uploads capped at 16 MB)

Checked 2026-11-07. The release build is safe:
- The telemetry client is off in production (`enabled = import.meta.env.DEV`,
  a build-time constant): no requests, no command polling. The inert code is
  still in the bundle; it could be stripped with a dev-only dynamic import,
  for tidiness only.
- The server side is a Vite plugin with `apply: 'serve'`: it exists only in
  the dev server. GitHub Pages serves static files and has no such endpoint,
  so nobody can write to the release or steer a visitor's session.

The dev server is the only exposure, and only to the local network while
it runs (port 5173, bound to all interfaces so the Quest can reach it).
Anyone on that network can append lines to `.telemetry/log.jsonl` and write
PNGs to `.telemetry/captures/`. Filenames are sanitised, so there's no path
traversal. Commands can only come from files on the workstation, so nobody
can steer the headset. To do: cap the capture upload size (the log POST is
already capped at 1 MB) so it can't fill the disk.

## Also open

- World scale: the user likes the default (1.5 m per unit), maybe a touch
  bigger; they'll experiment (ignore the markers dropped on 2026-11-07).
  Sprites (glows, markers, labels) now keep their proportion at any scale
  (2d4fe76); before, the Sun's glow swamped the tabletop view.
- Scrunch round 2's rebuild hitch (~0.5 s when moons or fiction are first
  turned on mid-session).
