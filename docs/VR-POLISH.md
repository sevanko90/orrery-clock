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

## 3. Controller labels (done; Quest 3 model bundled)

Done 2026-11-07 (`src/xr/controllerLabels.ts`): engraved brass plates,
one per control, spread round the controller (stick outside, buttons and
grip inside, upper button and trigger on top), facing the eyes, with leader
lines from each control's geometry (trigger and grip lines stop at the
mesh). They show for the first 30 s in VR, then when a controller is raised
in front of the face: within 50 cm, ~40° of the gaze, pointing up, top
toward the eyes; ~0.8 s fade. Wrist panels also face the eyes. Dev builds:
left stick click takes a VR screenshot to `.telemetry/captures/`.
The Quest 3 controller model now ships in `public/controllers` (7be3103); other headsets still use the CDN.


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

## 5. Tabletop (passthrough) mode — proof works, UX to do

Proof 2026-11-07 (branch `tabletop`, 65567e6): a Tabletop button starts a
WebXR `immersive-ar` session; three's WebGPU renderer (WebGL 2, multiview)
clears to transparent and the room shows through. The instrument is placed
at ~60 cm across, base at 72 cm, 80 cm ahead. To work through:

- (Done 2026-11-08) Handling: the orrery is an object in the room, the
  player never moves. One grip holds it (moves and turns it, upright; the
  turn is the hand's twist about the vertical, so no flip overhead); both
  grips also scale it (~15 cm to ~3 m). No grip: the sticks drive it like a
  remote control while it floats (left stick across the room, right stick
  up / down and turn); on a table the stick only turns it.
- (Done 2026-11-08, headset-checked inside and outside the boundary, roomscale and stationary) Placing: let go with its base
  just over a real surface (WebXR plane detection: Space Setup's tables,
  desks, floor) and it settles onto it; a warm footprint ring shows there
  while it's held (a pulsing rim with ripples drawing in from past the
  disc), and it floats down onto the surface. Let go anywhere else and it floats. On entering it
  settles onto a table up to 50 cm under the default spot. No anchor yet
  (the room's reference space holds it; anchors would matter for keeping it
  between sessions).
- (Built 2026-11-08, headset check pending) The footprint rings show
  wherever the Discworld stack wouldn't fit below (any surface within ~19
  units x scale under the centre or the Disc's edge); let go then and it
  settles on that surface, the instrument alone. No rings: room for it, and
  letting go plays the Discworld entrance, clear of everything. (The rings
  may show quite high up: to be seen.) Re-checked whenever the floating
  orrery comes to rest.
- (Built 2026-11-08, headset check pending) Persistent anchor: where it was
  left (position, turn, scale, on a table or not) comes back next session.
- (Built 2026-11-08, headset check pending) Info cards open nearer and to
  the right in the tabletop, so they don't cover the orrery.
- (Built 2026-11-08, desktop-checked) Fiction on/off per element, in VR and the tabletop alike, like the
  desktop's fiction panel (fiction is forced on in both today; let the
  player show or hide the fictional elements).
- (Built 2026-11-08, headset check pending: loose ~3° pick, cards from the
  scene panel) Tabletop only: info cards without pointing. Choosing a fiction entry
  there also shows a holographic target reticle over it (four arrowheads
  at the compass points: blink, turn a quarter closing in, fade; ~7° across
  whatever the target's size), since at tabletop size a site like Utopia
  Planitia is a speck and leaning in breaks the model's illusion. At tabletop scale the models
  are too small to hit with the ray, so choosing an element (from the scene
  panel, or a bigger, more forgiving pick) pops its info card. (In VR the
  elements are big enough to point at: leave it as it is.)
- (Built 2026-11-08, desktop-checked) Stars: a faint dome of point stars
  over the orrery only (hemisphere, ~1.5x the Disc's reach, fading in), its
  own small sky in the room; the full sky sphere stays hidden.
- Lighting: the orrery's own warm light (no real-world light estimation on
  the web).
- Panels, labels and cards at tabletop distances; leaving and re-placing.
- (Done) Scenes don't move the player: the orrery turns the action round to
  the player's side; Return becomes "Place in front of me".
- (Done) The Demolition's hologram faces the real viewer in VR (it faced the
  desktop camera) and keeps a minimum apparent size (~4.5°).
- Discworld from mid-air: on a table it's the flat Disc; picked up or placed
  in the air, with room below for the whole stack clear of the floor and
  table, the Discworld entrance plays.

