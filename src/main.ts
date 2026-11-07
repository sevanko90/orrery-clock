// First: a seeded Math.random (?seed=N) must be in place before anything draws one.
import { reseed } from './xr/seed';
import { frameBegin, frameEnd, mark, probeRenderer, probes, startFrame, takeCpuParts, takeFrameStats } from './perfMarks';
import { VrGlass } from './xr/vrGlass';
import { captureEye } from './xr/vrCapture';
import './style.css';
import * as THREE from 'three/webgpu';
import { registerSW } from 'virtual:pwa-register';
import { Stage, detectQuality } from './scene/stage';
import { createMaterials } from './scene/materials';
import { buildOrrery } from './scene/orrery';
import { Bodies, type Body } from './scene/bodies';
import { FocusController } from './scene/focus';
import { Discworld, DISC_HOME_CAMERA, DISC_HOME_TARGET } from './scene/discworld';
import { HOME_CAMERA, HOME_TARGET } from './scene/stage';
import { SimClock, SPEED_STEPS } from './sim/clock';
import { Kinematics } from './mechanism/kinematics';
import { design } from './scene/mechanism3d';
import { meanLongitude, planetPosition, type PlanetId } from './astro/orbits';
import { ARMS, PLANE_Y } from './scene/layout';
import { Readout } from './ui/readout';
import { bindControls } from './ui/controls';
import { InfoCard, bodyCard, loreCard } from './ui/infocard';
import { detectGpu, warnIfNoGpu } from './ui/gpuCheck';
import { Fiction } from './scene/fiction';
import { FictionPanel } from './ui/fictionPanel';
import { nextOccurrence, type FictionEntry } from './fiction/catalog';
import { XrMode, type XrHit } from './xr/xrMode';
import { DetailCuller } from './xr/detailCull';
import { Batcher, raycastLayers } from './scene/batch';
import { Telemetry, type Command } from './xr/telemetry';
import { XR } from './xr/config';
import { TABLE_RADIUS } from './scene/layout';
import { LAYER_TEXEL_PX, QUEST_PX_PER_RAD, scrunchOn, VRVIEW_FLAG } from './xr/scrunch';
import { ScrunchDebug } from './xr/scrunchDebug';
import { MeshLods, beltRock } from './scene/meshLod';
import { SpriteBatch } from './scene/spriteBatch';
import { LineBatch } from './scene/lineBatch';
import { singlePass } from './scene/singlePass';
import { TextureLayers } from './scene/textureLayers';
import { discCapsOf, hiddenByDisc } from './scene/discOcclusion';
import { ownSunlitProgram } from './scene/sunlit';
import { viewpoints, yawFacing } from './xr/vrScene';
import { POINT_UNIFORMS } from './scene/pointSize';
import type { PanelRow } from './xr/controlPanel';
import { FICTION } from './fiction/catalog';

if (import.meta.env.PROD) {
  // Activate new builds immediately; reload once the new worker takes control.
  const updateSW = registerSW({ immediate: true, onNeedRefresh: () => updateSW(true) });
}

// Start-up progress to the dev server's telemetry log, so a page stuck on the
// veil (on a headset, with no console to hand) says how far it got.
const boot = new Telemetry(() => undefined);
boot.sendNow({ kind: 'boot', stage: 'start', url: location.href });

// Surface failures on the page rather than leaving a silent black canvas.
function showFatal(msg: string) {
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  el.textContent = `The orrery couldn't start: ${msg}`;
  document.getElementById('veil')?.classList.add('gone');
}
addEventListener('error', (e) => {
  showFatal(e.message || String(e.error));
  boot.sendNow({ kind: 'error', message: e.message, stack: String(e.error?.stack ?? '').slice(0, 2000) });
});
addEventListener('unhandledrejection', (e) => {
  showFatal(String(e.reason?.message ?? e.reason));
  boot.sendNow({ kind: 'error', message: String(e.reason?.message ?? e.reason), stack: String(e.reason?.stack ?? '').slice(0, 2000) });
});

const bootStall = setTimeout(() => {
  boot.sendNow({ kind: 'boot', stage: 'stalled' });
  showFatal('start-up stalled (the graphics device never came up). Try closing the tab and opening the page again.');
}, 20_000);

const container = document.getElementById('scene')!;
const gpu = detectGpu();
warnIfNoGpu(gpu);
const quality = detectQuality();
// Without a GPU, drop to the light settings so it at least stays usable.
if (gpu === 'software') Object.assign(quality, { low: true, pixelRatio: 1, shadows: false, bloom: false });
const stage = new Stage(container, quality);
/** The headset's cheaper scene (LODs, merged hall): see xr/scrunch.ts. */
const scrunch = scrunchOn(quality.headset);
// The GPU backend (WebGPU, or WebGL 2) comes up asynchronously.
boot.sendNow({ kind: 'boot', stage: 'renderer' });
await stage.init();
const multiDraw = (stage.renderer.backend as { extensions?: { has(name: string): boolean } }).extensions?.has('WEBGL_multi_draw') ?? null;
boot.sendNow({ kind: 'boot', stage: 'renderer ready', backend: stage.backend, multiDraw });
const mats = createMaterials(quality.low);
const orrery = buildOrrery(mats);
stage.scene.add(orrery.root);
// Scrunched (the headset): no glass in the drum, the mechanism open in its frame.
const vrGlass = new VrGlass(orrery.root);
if (scrunch) vrGlass.set(true);
// Draw the instrument's hundreds of parts as a few batches (one per material).
// (Scrunched: one batcher over the whole scene instead, built by rebatch() once the bodies exist.)
let orreryBatch = new Batcher(scrunch ? [] : orrery.root, stage.scene, { lod: scrunch });
// World matrices are brought up to date once a frame, just before the batches copy them.
stage.scene.matrixWorldAutoUpdate = false;
reseed('bodies');
const bodies = new Bodies(orrery.arms, { lowQuality: quality.low });
stage.scene.add(bodies.root);
/** Scrunched: spheres (planets, Sun, moons) step down in segments with distance. */
const meshLods = scrunch ? new MeshLods() : null;
if (scrunch) {
  // The belt's 1800 rocks: 20-face indexed rocks instead of 36-face unindexed ones.
  const belt = bodies.root.getObjectByName('belt') as THREE.InstancedMesh | undefined;
  if (belt) belt.geometry = beltRock();
}
/** Scrunched: the batches were rebuilt, so the detail culler must list its meshes afresh. */
let cullerStale = false;
/**
 * Scrunched: batch the whole scene (instrument, bodies, Discworld, fiction)
 * by shading model, rebuilt whenever a part is first built (see Batcher's
 * `uber` option). Cheap: the geometry and its LODs are shared, not copied.
 */
let rebatchDue = scrunch;
function rebatch() {
  if (scrunch) rebatchDue = true;
}
function rebuildBatches() {
  rebatchDue = false;
  meshLods?.reset();
  orreryBatch.dispose();
  discBatch?.dispose();
  discBatch = null;
  const roots = [orrery.root, bodies.root, ...(discworld ? [discworld.root] : []), ...(fiction ? [fiction.root] : [])];
  // Each night fill its own shader program (see ownSunlitProgram).
  for (const root of roots) root.traverse((o) => { const m = (o as THREE.Mesh).material; if (m && !Array.isArray(m)) ownSunlitProgram(m as THREE.Material); });
  // The globes' surface maps go into layers of one array texture, so they batch together.
  globeLayers ??= new TextureLayers(512, 256, 32);
  bodies.root.traverse((o) => {
    const m = o as THREE.Mesh;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (m.isMesh && m.geometry.type === 'SphereGeometry' && (m.geometry as THREE.SphereGeometry).parameters.widthSegments > 16 && mat.isMeshStandardMaterial && mat.userData.sunlit && !mat.transparent) globeLayers!.track(mat);
  });
  globeLayers.update();
  // (Every batch is drawn on its first frames, shown or not, so its shader is built
  // then, not on first use. Warming them through compileAsync() instead leaves the
  // WebGL backend drawing black.)
  orreryBatch = new Batcher(roots, stage.scene, { lod: true, uber: true, noShadows: !quality.shadows, pxPerRad: QUEST_PX_PER_RAD / LAYER_TEXEL_PX });
  fictionSprites?.dispose();
  fictionSprites = new SpriteBatch([...roots, ...trueMarkers.values()], stage.scene);
  lineBatch?.dispose();
  lineBatch = new LineBatch(roots, stage.scene);
  singlePass(roots);
  cullerStale = true;
}
let globeLayers: TextureLayers | null = null;
/**
 * Scrunched: the walnut table at the Disc's core (a closed, opaque cylinder)
 * as two occluding caps: parts wholly behind it from the head aren't drawn
 * (the elephants and A'Tuin from the deck, the instrument from under the
 * Disc). Only while the table is on show.
 */
const discCaps = scrunch ? discCapsOf(orrery.root) : null;
function discHides(eye: THREE.Vector3, c: THREE.Vector3, r: number) {
  if (!discCaps) return false;
  for (let o: THREE.Object3D | null = discCaps.table; o; o = o.parent) if (!o.visible) return false;
  // (0.1 in from the rim: the cylinder's facets, and the eyes either side of the head.)
  return hiddenByDisc(discCaps.caps, eye, c, r, 0.1);
}

const clock = new SimClock();
const kinematics = new Kinematics(design);

// Each arm is clamped to its tube at a setting offset, like a real orrery
// that is set by hand. We set it whenever simulated time jumps.
const armOffsets: Record<string, number> = {};
let seenJumps = -1;
function setArms(simMs: number) {
  const date = new Date(simMs);
  for (const p of design.planets) {
    armOffsets[p.id] = meanLongitude(p.id as PlanetId, date) - kinematics.angle(p.tube);
  }
}

// Ring markers at each planet's true (Keplerian) position. The gears can only
// model average orbital speed, so the arms drift ahead of / behind these.
const trueMarkers = new Map<string, THREE.Sprite>();
const markerOwner = new Map<THREE.Object3D, string>();
{
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(160,220,255,1)');
  g.addColorStop(0.35, 'rgba(120,190,255,0.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  for (const a of ARMS) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    s.scale.setScalar(Math.max(0.35, a.size * 1.3));
    s.renderOrder = 3;
    stage.scene.add(s);
    trueMarkers.set(a.id, s);
    markerOwner.set(s, a.id);
  }
}
const markerButton = document.getElementById('c-true') as HTMLButtonElement;
let markersOn = true;
try {
  markersOn = localStorage.getItem('true-markers') !== '0';
} catch {
  /* ignore */
}
function setMarkers(on: boolean) {
  markersOn = on;
  trueMarkers.forEach((m) => (m.visible = on));
  markerButton.setAttribute('aria-pressed', String(on));
  markerButton.title = on ? 'Hide true positions (T)' : 'Show true positions (T)';
  try {
    localStorage.setItem('true-markers', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
setMarkers(markersOn);
markerButton.addEventListener('click', () => setMarkers(!markersOn));
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 't' || e.key === 'T') setMarkers(!markersOn);
});

/** Current arm longitude (radians) for a planet, for the info card. */
function armLongitude(id: string): number | null {
  const p = design.planets.find((x) => x.id === id);
  return p ? kinematics.angle(p.tube) + (armOffsets[p.id] ?? 0) : null;
}
const readout = new Readout(clock);
const focus = new FocusController(stage.camera, stage.controls);
const info = new InfoCard(() => unfocus(), armLongitude);

function select(body: Body) {
  focus.focus(body);
  info.show(body, clock.nowMs());
}
function unfocus() {
  if (!focus.focused) {
    info.hide(); // e.g. a Discworld lore card
    return;
  }
  focus.goHome();
  info.hide();
}
/** Fly back to the default camera position and zoom, whatever the state. */
function resetView() {
  info.hide();
  focus.goHome();
  lastInteraction = performance.now();
}
document.getElementById('c-home')!.addEventListener('click', resetView);
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'h' || e.key === 'H') resetView();
});

const { syncDate } = bindControls(clock, unfocus);

// ---- Discworld mode ------------------------------------------------------------
// Built on first use so normal mode pays nothing for it.
let discworld: Discworld | null = null;
let discBatch: Batcher | null = null;
const discButton = document.getElementById('c-disc') as HTMLButtonElement;
const NORMAL_LIMITS = { maxPolar: stage.controls.maxPolarAngle, maxDistance: stage.controls.maxDistance };
function setDiscworld(on: boolean, persist = true) {
  if (on && !discworld) {
    reseed('discworld');
    discworld = new Discworld(mats, { lowQuality: quality.low || quality.headset, pixelRatio: quality.pixelRatio });
    // (Desktop: batch first, then add, as before, so the scene's order and its render stay the same.)
    if (scrunch) rebatch();
    else discBatch = new Batcher(discworld.root, stage.scene);
    stage.scene.add(discworld.root);
  }
  discworld?.setEnabled(on);
  discButton.setAttribute('aria-pressed', String(on));
  discButton.title = on ? 'Leave Discworld mode (D)' : 'Discworld mode (D)';
  if (on) {
    // Free the camera to swing under the Disc and far enough to frame A'Tuin.
    stage.controls.maxPolarAngle = Math.PI * 0.97;
    stage.controls.maxDistance = 170;
    focus.setHome(DISC_HOME_TARGET, DISC_HOME_CAMERA);
  } else {
    // Limits are restored once the camera is back above the table (see step()).
    focus.setHome(HOME_TARGET, HOME_CAMERA);
  }
  info.hide();
  focus.goHome(2.4);
  lastInteraction = performance.now();
  if (!persist) return;
  try {
    localStorage.setItem('discworld', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
discButton.addEventListener('click', () => setDiscworld(!discworld?.enabled));
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'd' || e.key === 'D') setDiscworld(!discworld?.enabled);
});

// ---- Moons ---------------------------------------------------------------------
const moonButton = document.getElementById('c-moons') as HTMLButtonElement;
function setMoons(on: boolean) {
  if (on && !bodies.moonsVisible) reseed('moons');
  const built = bodies.moonsBuilt;
  bodies.setMoonsVisible(on);
  if (!built && bodies.moonsBuilt) rebatch();
  moonButton.setAttribute('aria-pressed', String(on));
  moonButton.title = on ? 'Hide moons (M)' : 'Show moons (M)';
  // Don't leave the camera following a moon that has just vanished.
  if (!on && focus.focused?.moon) unfocus();
  try {
    localStorage.setItem('moons', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
{
  let saved = false;
  try {
    saved = localStorage.getItem('moons') === '1';
  } catch {
    /* ignore */
  }
  if (saved) setMoons(true);
}
moonButton.addEventListener('click', () => setMoons(!bodies.moonsVisible));
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'm' || e.key === 'M') setMoons(!bodies.moonsVisible);
});

// ---- Fiction mode --------------------------------------------------------------
// Built at startup even with the mode off: its dated events (the Vogons every
// Thursday, the Martians every August) play whenever the clock reaches them.
let fiction: Fiction | null = null;
/** Scrunched: fiction's ~130 additive glow sprites drawn as one. */
/** Scrunched: additive glow sprites and faint lines, drawn a few at a time (see rebuildBatches()). */
let fictionSprites: SpriteBatch | null = null;
let lineBatch: LineBatch | null = null;
/** Entry whose show was just started: frame it once the jump has landed. */
let pendingFrame: string | null = null;
/**
 * The scene played from the catalogue, until it ends (then the orrery goes
 * back to now, at real time) or the clock is taken elsewhere (then it's dropped).
 */
let playing: {
  id: string;
  end: number;
  jumps: number;
  followed: boolean;
  /** The speed step the scene last set; if the clock is on another, the user has taken over. */
  paced: number | null;
  /** The last camera beat flown to; null once the user takes the camera. */
  beat: string | null;
} | null = null;
/** Places switched off in the catalogue (remembered). */
const hiddenPlaces = new Set<string>();
try {
  for (const id of JSON.parse(localStorage.getItem('fiction-hidden') ?? '[]') as string[]) hiddenPlaces.add(id);
} catch {
  /* ignore */
}
const fictionButton = document.getElementById('c-fiction') as HTMLButtonElement;
const fictionPanel = new FictionPanel(playFiction, setPlaceShown, (id) => !hiddenPlaces.has(id));
const DAY_PER_SECOND = SPEED_STEPS.findIndex((s) => s.speed === 86_400);

/** Is the camera on, or a card open for, this fiction body? */
function fictionInView(id: string) {
  return focus.focused?.id === id || info.showingBody?.id === id;
}

function setPlaceShown(entry: FictionEntry, shown: boolean) {
  if (shown) hiddenPlaces.delete(entry.id);
  else hiddenPlaces.add(entry.id);
  fiction?.setPlaceShown(entry.id, shown);
  if (!shown && fictionInView(entry.id)) unfocus();
  try {
    localStorage.setItem('fiction-hidden', JSON.stringify([...hiddenPlaces]));
  } catch {
    /* ignore */
  }
}

/** Forget the playing scene (the user has moved on), leaving the clock alone. */
function dropScene() {
  playing = null;
  fiction?.setPlaying(null);
}

/** The scene has run its course: back to now, at real time, and the home view. */
function finishScene() {
  const id = playing!.id;
  dropScene();
  clock.resetToNow();
  if (fictionInView(id)) info.hide();
  focus.goHome();
  lastInteraction = performance.now();
  // In VR: swoop back to where the player was before choosing the scene.
  vrReturnHome();
}

// ---- VR: fiction from the control box ---------------------------------------------
/** Where the VR player was before a fiction scene carried them off (pose and scale). */
let vrReturn: import('./xr/xrMode').XrPose | null = null;
/** A fiction entry chosen in VR, waiting for the desktop focus logic to give its viewpoint. */
let vrFlyPending: string | null = null;
/** The entry the VR player was last carried to. */
let vrFictionAt: string | null = null;

/**
 * Chosen on the control box: play or show the entry exactly as the desktop
 * catalogue does, then carry the player to the viewpoint the desktop camera
 * flies to (approached from the player's own direction of view).
 */
function vrFiction(entry: FictionEntry) {
  if (!vrReturn) vrReturn = xr.pose();
  if (!fiction?.enabled) setFiction(true);
  const p = xr.pose();
  const fwd = new THREE.Vector3(-Math.sin(THREE.MathUtils.degToRad(p.yawDeg)), 0, -Math.cos(THREE.MathUtils.degToRad(p.yawDeg)));
  stage.camera.position.copy(p.head);
  stage.controls.target.copy(p.head).addScaledVector(fwd, 4);
  playFiction(entry);
  vrFlyPending = entry.id;
  vrFictionAt = entry.id;
}

/** Back to where the player was before the fiction scene (if they were carried off). */
function vrReturnHome() {
  vrFictionAt = null;
  if (!vrReturn || !xr.presenting) return;
  const r = vrReturn;
  vrReturn = null;
  xr.moveTo(r.head, r.yawDeg, r.metresPerUnit);
}

/** After the desktop logic has chosen its view: carry the VR player there. */
function vrFlyToFocus() {
  if (!vrFlyPending || pendingFrame) return;
  vrFlyPending = null;
  const d = focus.destination();
  if (!d || !xr.presenting) return;
  xr.moveTo(d.camera, yawFacing(d.target.clone().sub(d.camera).setY(0)));
}

/** The control box's rows. */
/** The VR panel's time controls: the desktop's speed slider, play/pause and now, and date steps standing in for its calendar. */
function timeRows(): PanelRow[] {
  const paused = clock.speed === 0;
  return [
    { label: 'Time', heading: true },
    { label: 'Speed', slider: { stops: SPEED_STEPS.length, at: clock.step, caption: SPEED_STEPS[clock.step].label } },
    { label: 'Play', buttons: [{ label: 'Slower' }, { label: paused ? 'Play' : 'Pause', active: paused }, { label: 'Faster' }, { label: 'Now', active: clock.isLive() }] },
    { label: 'Date', buttons: DATE_STEPS.map((d) => ({ label: d.label })) },
  ];
}
/** Date steps (calendar months and years, so the day of the month holds). */
const DATE_STEPS: { label: string; years?: number; months?: number; days?: number }[] = [
  { label: '−yr', years: -1 },
  { label: '−mo', months: -1 },
  { label: '−day', days: -1 },
  { label: '+day', days: 1 },
  { label: '+mo', months: 1 },
  { label: '+yr', years: 1 },
];
function timePress(i: number, part: number) {
  if (i === 1) return clock.setStep(part);
  if (i === 2) {
    if (part === 0) clock.setStep(clock.step - 1);
    else if (part === 1) clock.togglePause();
    else if (part === 2) clock.setStep(clock.step + 1);
    else clock.resetToNow();
    return;
  }
  const d = DATE_STEPS[part];
  if (i === 3 && d) {
    const t = new Date(clock.nowMs());
    if (d.years) t.setFullYear(t.getFullYear() + d.years);
    if (d.months) t.setMonth(t.getMonth() + d.months);
    if (d.days) t.setDate(t.getDate() + d.days);
    clock.jumpTo(t.getTime());
  }
}

function panelRows(): PanelRow[] {
  return [
    { label: 'Show', heading: true },
    { label: 'Moons', on: bodies.moonsVisible },
    { label: 'Fiction', heading: true },
    ...FICTION.map((e) => ({ label: e.title, active: vrFictionAt === e.id })),
    { label: vrReturn ? 'Return' : 'Return to the Disc' },
  ];
}
function panelPress(i: number) {
  if (i === 1) return setMoons(!bodies.moonsVisible);
  const entry = FICTION[i - 3];
  if (entry) return vrFiction(entry);
  if (i === FICTION.length + 3) {
    if (playing) dropScene();
    if (vrReturn) vrReturnHome();
    else xr.goTo(viewpoints().spawn);
  }
}

/** Discworld's state before VR turned it on, to put back after. */
let discBeforeVr = false;

function setFiction(on: boolean) {
  if (!fiction) {
    reseed('fiction');
    fiction = new Fiction(bodies, mats);
    hiddenPlaces.forEach((id) => fiction!.setPlaceShown(id, false));
    stage.scene.add(fiction.root);
    rebatch();
  }
  if (!on && playing) finishScene();
  fiction?.setEnabled(on);
  fictionPanel.setVisible(on);
  fictionButton.setAttribute('aria-pressed', String(on));
  fictionButton.title = on ? 'Leave fiction mode (F)' : 'Fiction mode (F)';
  // Don't leave the camera or a card on something that has just vanished (a place; events stay).
  const shown = [focus.focused, info.showingBody];
  if (!on && fiction && shown.some((b) => b && fiction!.bodies.includes(b) && b.available?.() === false)) unfocus();
  try {
    localStorage.setItem('fiction', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Dated events: jump to just before they start and run at a day a second. Places: fly to them. */
function playFiction(entry: FictionEntry) {
  const body = fiction?.bodies.find((b) => b.id === entry.id);
  if (!fiction || !body) return;
  const start = nextOccurrence(entry, clock.nowMs());
  if (start === null) {
    // A place: make sure it's on show (a playing scene hides it), then fly there.
    if (playing) dropScene();
    if (hiddenPlaces.has(entry.id)) {
      setPlaceShown(entry, true);
      fictionPanel.syncToggles();
    }
    return select(body);
  }
  clock.jumpTo(start - (entry.leadMs ?? 6 * 3_600_000));
  const step = SPEED_STEPS.findIndex((x) => x.speed === (entry.playSpeed ?? 86_400));
  clock.setStep(step >= 0 ? step : DAY_PER_SECOND);
  playing = { id: entry.id, end: start + (entry.durationMs ?? 0), jumps: clock.jumps, followed: false, paced: clock.step, beat: '' };
  fiction.setPlaying(entry.id);
  pendingFrame = entry.id;
  info.show(body, clock.nowMs());
  lastInteraction = performance.now();
}

{
  let saved = false;
  try {
    saved = localStorage.getItem('fiction') === '1';
  } catch {
    /* ignore */
  }
  setFiction(saved);
}
fictionButton.addEventListener('click', () => setFiction(!fiction?.enabled));
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'F') setFiction(!fiction?.enabled);
});

const credits = document.getElementById('credits') as HTMLDialogElement;
document.getElementById('credits-btn')!.addEventListener('click', () => credits.showModal());

// ---- Idle auto-rotation ----------------------------------------------------
let lastInteraction = -Infinity;
stage.controls.addEventListener('start', () => {
  lastInteraction = performance.now();
  // The viewer has taken the camera: a playing scene stops directing it.
  if (playing) playing.beat = null;
  stage.controls.autoRotate = false;
});
stage.controls.addEventListener('end', () => (lastInteraction = performance.now()));

// ---- Picking & hover ---------------------------------------------------------
// Also hits meshes drawn through batches (their originals sit on their own layer).
const raycaster = raycastLayers(new THREE.Raycaster());
const pointer = new THREE.Vector2();
/** Pick proxies of the bodies on show (hidden moons can't be picked). */
function allBodies(): Body[] {
  return fiction ? [...bodies.bodies, ...fiction.bodies] : bodies.bodies;
}
/** Is the object on show, all the way up its parents? (A hidden ship or globe can't be picked.) */
function shown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
function activeProxies() {
  return allBodies()
    .filter((b) => (!b.moon || bodies.moonsVisible) && (b.available?.() ?? true))
    .flatMap((b) => [b.pickProxy, ...(b.extraProxies ?? [])])
    .filter(shown);
}
/** The body a pick target stands for. */
function bodyOf(o: THREE.Object3D): Body | null {
  return allBodies().find((b) => b.pickProxy === o || b.extraProxies?.includes(o)) ?? null;
}
/**
 * Body under the pointer (call after setPointer). Moons sit inside their
 * planet's generous pick sphere, so a moon hit wins over its planet.
 */
function bodyUnderPointer(): Body | null {
  return bodyHit()?.body ?? null;
}
function bodyHit(): { body: Body; hit: THREE.Intersection } | null {
  const hits = raycaster.intersectObjects(activeProxies(), false);
  const hit = hits.find((h) => bodyOf(h.object)?.moon) ?? hits[0];
  const body = hit ? bodyOf(hit.object) : null;
  return body ? { body, hit } : null;
}
const hoverTag = document.getElementById('hover-tag')!;
const canvas = stage.renderer.domElement;

function setPointer(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
}

function pick(clientX: number, clientY: number): Body | null {
  setPointer(clientX, clientY);
  const body = bodyUnderPointer();
  if (body) return body;
  // Clicking a true-position ring selects its planet.
  const id = pickMarker();
  return id ? (bodies.bodies.find((b) => b.id === id) ?? null) : null;
}

/** Planet id whose true-position ring is under the pointer (call after setPointer). */
function pickMarker(): string | null {
  return markerHit()?.id ?? null;
}
function markerHit(): { id: string; hit: THREE.Intersection } | null {
  if (!markersOn) return null;
  const hit = raycaster.intersectObjects([...trueMarkers.values()], false)[0];
  const id = hit ? markerOwner.get(hit.object) : undefined;
  return hit && id ? { id, hit } : null;
}

/** VR pointer: what a controller's ray is on, with where it lands. */
function xrPick(ray: THREE.Raycaster): XrHit | null {
  raycaster.ray.copy(ray.ray);
  raycaster.camera = ray.camera;
  const b = bodyHit();
  if (b) return { point: b.hit.point, distance: b.hit.distance, label: b.body.hoverLabel ?? b.body.name, body: b.body };
  const m = markerHit();
  if (m) {
    const body = bodies.bodies.find((x) => x.id === m.id);
    return { point: m.hit.point, distance: m.hit.distance, label: `${body?.name ?? m.id}: true position`, body };
  }
  const lore = discworld?.pickLore(raycaster);
  if (lore) {
    // (Where pickLore's ray landed: a second pass over the whole root would also test the rimfall and dust points.)
    const hit = discworld!.loreHit;
    if (hit) return { point: hit.point, distance: hit.distance, label: lore.name, note: lore.kind, lore };
  }
  return null;
}

let downAt: { x: number; y: number; t: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY, t: performance.now() }));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const quick = performance.now() - downAt.t < 400;
  downAt = null;
  if (moved > 6 || !quick) return;
  const body = pick(e.clientX, e.clientY);
  if (body) return select(body);
  const lore = discworld?.pickLore(raycaster);
  if (lore) info.showLore(lore);
  else unfocus();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) {
    hoverTag.hidden = true;
    return;
  }
  setPointer(e.clientX, e.clientY);
  const body = bodyUnderPointer();
  const markerId = body ? null : pickMarker();
  const markerName = markerId ? bodies.bodies.find((b) => b.id === markerId)?.name : null;
  const lore = body || markerName ? null : (discworld?.pickLore(raycaster) ?? null);
  const label = body ? (body.hoverLabel ?? body.name) : markerName ? `${markerName}: true position` : (lore?.name ?? null);
  canvas.style.cursor = label ? 'pointer' : '';
  hoverTag.hidden = !label;
  if (label) {
    hoverTag.replaceChildren(label);
    if (markerName) {
      const note = document.createElement('small');
      note.textContent = `The gears turn ${markerName} at its average speed; this glow marks where it really is.`;
      hoverTag.append(note);
    } else if (lore) {
      const note = document.createElement('small');
      note.textContent = `${lore.kind}. Click for lore.`;
      hoverTag.append(note);
    }
    hoverTag.style.left = `${e.clientX}px`;
    hoverTag.style.top = `${e.clientY}px`;
  }
});
canvas.addEventListener('pointerleave', () => (hoverTag.hidden = true));

// ---- VR ------------------------------------------------------------------------
// The hall is sized from the instrument as built (cabinet and arms).
orrery.root.updateMatrixWorld(true);
const orreryBox = new THREE.Box3().setFromObject(orrery.root);
const culler = new DetailCuller();
let cullAngle: number = XR.detailCullAngle;
/** The VR player's head (world units), for culling small batched parts; null outside VR. */
let xrHead: THREE.Vector3 | null = null;
/** What VR skips drawing from where the head is (or, with ?vrview=1, the desktop camera). */
function viewFrom(head: THREE.Vector3 | null) {
  if (!head) {
    culler.restore();
    xrHead = null;
    orrery.mechanism.root.visible = true;
    return;
  }
  // From under the Disc its opaque underside hides the whole movement (115 draw calls): skip it.
  // (Only under it: out past the rim, below table height, the drum shows over the edge.)
  orrery.mechanism.root.visible = head.y > orreryBox.min.y || Math.hypot(head.x, head.z) > TABLE_RADIUS;
  if (cullerStale) {
    culler.reset();
    cullerStale = false;
  }
  culler.setRoots([orrery.root, bodies.root, ...(discworld ? [discworld.root] : []), ...(fiction ? [fiction.root] : [])]);
  culler.update(head, cullAngle);
  xrHead = head;
}
function countNonFinite() {
  let n = 0;
  stage.scene.traverse((o) => {
    if (!o.matrixWorld.elements.every(Number.isFinite)) n++;
  });
  return n;
}
function sceneCounts() {
  let all = 0,
    shown = 0;
  stage.scene.traverse(() => all++);
  stage.scene.traverseVisible(() => shown++);
  return [all, shown];
}
const xr = new XrMode(stage.renderer, stage.scene, { orrery: orreryBox, tableRadius: TABLE_RADIUS, sky: stage.sky }, {
  pick: xrPick,
  ...(import.meta.env.DEV ? { capture: () => (captureDue = `vr-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`) } : {}),
  faster: () => clock.setStep(clock.step + 1),
  slower: () => clock.setStep(clock.step - 1),
  card: (hit) => {
    const { body, lore } = hit;
    if (body) return () => bodyCard(body, clock.nowMs(), armLongitude);
    return lore ? () => loreCard(lore) : null;
  },
  view: viewFrom,
  now: () => clock.resetToNow(),
  status: () => [new Date(clock.nowMs()).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), SPEED_STEPS[clock.step].label],
  quake: () => Math.max(discworld?.quake ?? 0, fiction?.quake ?? 0),
  // Bloom can't run on a multiview frame; the toggle only works without it.
  report: (entry) => {
    telemetry.send({
      ...entry,
      ...lastRender,
      // Objects with a non-finite world matrix (NaN state hides them and makes picking crawl).
      nonFinite: countNonFinite(),
      cpuParts: takeCpuParts(),
      frame: takeFrameStats(1000 / ((stage.renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null)?.frameRate || 72)),
      hidden: [...forcedHidden.keys()],
      probes: probes.on,
      noGlass: vrGlass.on,
      // Scene graph size: every object, and those the renderer walks (visible chain).
      objects: sceneCounts(),
      scrunch,
      // Batches draw as one multi-draw call each; without the extension three falls back to a GL draw per part.
      multiDraw,
      lod: orreryBatch.lodCounts(),
      sphereLod: meshLods?.counts(),
      sim: new Date(clock.nowMs()).toISOString(),
      speed: SPEED_STEPS[clock.step].label,
      modes: { fiction: !!fiction?.enabled, discworld: !!discworld?.enabled, moons: bodies.moonsVisible, markers: markersOn },
      playing: playing?.id ?? null,
      carried: xr.moving,
    });
  },
  backend: () => stage.backend,
  discOn: () => !!discworld?.enabled,
  // The VR scene: Discworld on (assembled), without touching the saved setting.
  sessionStart: () => {
    discBeforeVr = !!discworld?.enabled;
    setDiscworld(true, false);
    discworld!.finish();
  },
  sessionEnd: () => {
    if (!discBeforeVr) setDiscworld(false, false);
    vrReturn = null;
    vrFlyPending = null;
  },
  timeRows,
  timePress,
  panelRows,
  panelPress,
});
{
  const vrButton = document.getElementById('c-vr') as HTMLButtonElement;
  navigator.xr
    ?.isSessionSupported('immersive-vr')
    .then((ok) => (vrButton.hidden = !ok))
    .catch(() => undefined);
  vrButton.addEventListener('click', () => {
    info.hide();
    xr.enter().catch((err) => console.error('Could not start VR', err));
  });
}

// Dev-server telemetry: headset samples and markers out, workstation commands in.
const telemetry = new Telemetry((c: Command) => {
  telemetry.send({ kind: 'command', ...c });
  switch (c.type) {
    case 'teleport':
      return xr.teleport(c.x, c.y, c.z, c.yawDeg);
    case 'scale':
      return xr.setScale(c.metresPerUnit);
    case 'mode':
      if (c.mode === 'fiction') setFiction(c.on);
      else if (c.mode === 'discworld') setDiscworld(c.on);
      else if (c.mode === 'moons') setMoons(c.on);
      else if (c.mode === 'markers') setMarkers(c.on);
      else if (c.mode === 'hangar') xr.setHangar(c.on, VRVIEW_FLAG);
      return;
    case 'date':
      return clock.jumpTo(Date.parse(c.iso));
    case 'speed':
      return clock.setStep(c.step);
    case 'cull':
      cullAngle = c.angle;
      return;
    case 'view': {
      const v = viewpoints()[c.name];
      if (v) xr.goTo(v);
      return;
    }
    case 'fiction': {
      const e = FICTION.find((f) => f.id === c.id);
      if (e) vrFiction(e);
      return;
    }
    case 'return':
      if (playing) dropScene();
      return vrReturnHome();
    case 'hide': {
      if (!c.on) {
        for (const o of forcedHidden.get(c.name) ?? []) {
          o.visible = hiddenWas.get(o) ?? true;
          hiddenWas.delete(o);
        }
        forcedHidden.delete(c.name);
        return;
      }
      const found = findHideable(c.name);
      if (!found.length) telemetry.send({ kind: 'hide-missing', name: c.name });
      else if (!forcedHidden.has(c.name)) {
        for (const o of found) if (!hiddenWas.has(o)) hiddenWas.set(o, o.visible);
        forcedHidden.set(c.name, found);
      }
      return;
    }
    case 'probe':
      probes.on = c.on;
      return;
    case 'capture':
      captureDue = c.name ?? `vr-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
      return;
    case 'list': {
      const groups: Record<string, string[]> = {};
      for (const o of stage.scene.children) groups[o.name || o.type] = o.children.filter((k) => k.name).map((k) => k.name);
      telemetry.send({ kind: 'scene-list', groups });
      return;
    }
  }
});

// ---- Scrunch measuring tools (console / automation only) ------------------------
const debug = new ScrunchDebug({
  stage,
  clock,
  scrunch,
  batches: () => [orreryBatch, ...(discBatch ? [discBatch] : [])],
  roots: () => ({ movement: orrery.mechanism.root, orrery: orrery.root, bodies: bodies.root, discworld: discworld?.root, fiction: fiction?.root, hangar: xr.hall }),
  setMode: (mode, on) => {
    if (mode === 'fiction') setFiction(on);
    else if (mode === 'discworld') setDiscworld(on);
    else if (mode === 'moons') setMoons(on);
    else if (mode === 'markers') setMarkers(on);
    else xr.setHangar(on, VRVIEW_FLAG);
  },
});
if (VRVIEW_FLAG) xr.setHangar(true, true);

// ---- Main loop ---------------------------------------------------------------
const veil = document.getElementById('veil')!;
let prev = performance.now();
let elapsed = 0;
let frames = 0;

let frameFailed = false;
/** Simulation time of the last frame (ms), for the VR performance readout. */
let cpuMs = 0;
/** What the last frame drew (read straight after it, for telemetry). */
const lastRender = { drawCalls: 0, triangles: 0 };
if (telemetry.enabled) probeRenderer(stage.renderer);
/** Objects the workstation has forced hidden (telemetry `hide`), re-applied every frame before drawing. */
/** A VR screenshot asked for by telemetry (its name), taken after the next frame's render. */
let captureDue: string | null = null;
const forcedHidden = new Map<string, THREE.Object3D[]>();
const hiddenWas = new Map<THREE.Object3D, boolean>();
/** Objects for a `hide` name: every object with that name, or every top-level object of that type ("type:Sprite"). */
function findHideable(name: string): THREE.Object3D[] {
  if (name.startsWith('type:')) return stage.scene.children.filter((o) => o.type === name.slice(5));
  const found: THREE.Object3D[] = [];
  stage.scene.traverse((o) => {
    if (o.name === name) found.push(o);
  });
  return found;
}
function frame(now: number) {
  const t0 = performance.now();
  startFrame(t0);
  frameBegin(now, t0);
  try {
    step(now);
  } catch (err) {
    if (!frameFailed) {
      frameFailed = true;
      console.error(err);
      showFatal(err instanceof Error ? err.message : String(err));
    }
    stage.renderer.setAnimationLoop(null);
    return;
  }
  cpuMs = performance.now() - t0;
  telemetry.tick(t0);
  mark('uiTelemetry');
  frameEnd(t0);
}

/**
 * Compile the shaders of everything under `root` in the background, hidden
 * parts included, so their first appearance doesn't stall a frame. (The
 * renderer only compiles what is visible and in view, so those flags are
 * lifted for the call and put back straight after; nothing is drawn.)
 */
function warmShaders(root: THREE.Object3D) {
  const restore: [THREE.Object3D, boolean, boolean][] = [];
  root.traverse((o) => {
    restore.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  let p: Promise<unknown> | undefined;
  try {
    // In VR, against the headset's camera, so the two-eye shader variants are the ones built.
    const camera = xr.presenting ? stage.renderer.xr.getCamera() : stage.camera;
    p = stage.renderer.compileAsync(root, camera, stage.scene);
  } finally {
    for (const [o, visible, culled] of restore) {
      o.visible = visible;
      o.frustumCulled = culled;
    }
  }
  p?.catch(() => undefined);
}

function step(now: number) {
  // (Frozen by the scrunch debug tools: every animation holds still for frame diffs.)
  // three's animation loop calls once with no timestamp when it (re)starts,
  // e.g. on leaving VR. A NaN step would poison every animated transform (the
  // camera, the Discworld) for good, so fall back to the clock; and the XR and
  // page clocks can differ, so never step backwards either.
  if (!Number.isFinite(now)) now = performance.now();
  const dt = debug.dt(THREE.MathUtils.clamp((now - prev) / 1000, 0, 0.1));
  prev = now;
  elapsed += dt;

  if (rebatchDue) rebuildBatches();
  const simMs = clock.nowMs();
  const jumped = clock.jumps !== seenJumps;
  kinematics.update(simMs, clock.speed === 1, jumped, dt);
  if (jumped) {
    seenJumps = clock.jumps;
    setArms(simMs);
  }
  orrery.mechanism.update(kinematics);
  const armAngles: Record<string, number> = {};
  for (const p of design.planets) armAngles[p.id] = kinematics.angle(p.tube) + armOffsets[p.id];
  orrery.setArmAngles(armAngles);
  orrery.root.updateMatrixWorld();
  mark('mechanism');

  const simDate = new Date(simMs);
  for (const a of ARMS) {
    const lon = planetPosition(a.id, simDate).lon;
    trueMarkers.get(a.id)!.position.set(Math.cos(lon) * a.radius, PLANE_Y, -Math.sin(lon) * a.radius);
  }
  bodies.update(simMs, dt, elapsed);
  mark('bodies');
  if (playing) {
    if (clock.jumps !== playing.jumps) dropScene();
    else if (simMs >= playing.end) finishScene();
    else if (fiction && playing.paced !== null) {
      // Some scenes vary their replay speed (slowing for the big moment),
      // until the user changes the speed themselves.
      if (clock.step !== playing.paced) playing.paced = null;
      else {
        const pace = fiction.scenePace(playing.id, simMs);
        const step = pace === null ? -1 : SPEED_STEPS.findIndex((x) => x.speed === pace);
        if (step >= 0 && step !== clock.step) {
          clock.setStep(step);
          playing.paced = step;
        }
      }
    }
    if (playing && playing.beat !== null && fiction) {
      // Camera beats: the scene reframes itself at its big moments.
      const beat = fiction.sceneBeat(playing.id, simMs);
      if (beat && beat.key !== playing.beat) {
        playing.beat = beat.key;
        focus.frame(beat.points, beat.duration);
        lastInteraction = now; // hold off idle auto-rotation while the scene directs
      }
    }
    if (playing && !playing.followed && fiction) {
      // Some scenes hand over from a framed view to riding along with their body.
      const from = fiction.followFrom(playing.id);
      const body = fiction.bodies.find((b) => b.id === playing!.id);
      if (from !== null && simMs >= from && body) {
        playing.followed = true;
        focus.focus(body);
      }
    }
  }
  if (fiction) {
    fiction.update(simMs, dt, elapsed, jumped, stage.camera, clock.speed);
    const warm = fiction.takeWarmup();
    if (warm) warmShaders(warm);
    if (pendingFrame) {
      const points = fiction.framePoints(pendingFrame);
      if (points.length) focus.frame(points, 2.4);
      pendingFrame = null;
    }
  }
  mark('fiction');
  vrFlyToFocus();
  fictionPanel.update(simMs);
  focus.update(dt);
  if (discworld) {
    discworld.update(dt, clock.speed, stage.camera);
    if (!discworld.enabled && !focus.flying && stage.controls.maxPolarAngle !== NORMAL_LIMITS.maxPolar) {
      stage.controls.maxPolarAngle = NORMAL_LIMITS.maxPolar;
      stage.controls.maxDistance = NORMAL_LIMITS.maxDistance;
    }
  }

  if (!stage.controls.autoRotate && !focus.flying && now - lastInteraction > 20_000) {
    stage.controls.autoRotate = true;
  }
  mark('discworld');
  if (xr.presenting) xr.update(dt, cpuMs);
  mark('xr');
  stage.controls.update(dt);
  // Scale the near plane with zoom: depth precision falls off with distance,
  // so a fixed 0.1 makes thin inlays flicker when zoomed out.
  const near = debug.near ?? THREE.MathUtils.clamp(stage.camera.position.distanceTo(stage.controls.target) * 0.006, 0.1, 0.5);
  if (Math.abs(near - stage.camera.near) > 0.01) {
    stage.camera.near = near;
    stage.camera.updateProjectionMatrix();
  }
  // An elephant shifting its feet shakes the whole Disc (and the camera).
  const quake = Math.max(discworld?.quake ?? 0, fiction?.quake ?? 0);
  const shake = quake > 0 && !xr.presenting ? new THREE.Vector3().randomDirection().multiplyScalar(quake * quake * 0.004 * stage.camera.position.distanceTo(stage.controls.target)) : null;
  if (shake) stage.camera.position.add(shake);
  // ?vrview=1: the desktop camera stands in for the head (hall shown, VR culling run).
  if (VRVIEW_FLAG && !xr.presenting) {
    viewFrom(stage.camera.position);
    // The headset's particle cap, in this canvas's pixels (it's 64 px on a ~720 px/rad Quest eye).
    const f = stage.renderer.domElement.height / 2 / Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2));
    POINT_UNIFORMS.uPointMax.value = (XR.maxPointPx * f) / 720;
  }
  mark('misc');
  stage.scene.updateMatrixWorld();
  mark('matrices');
  const eye = xr.presenting || VRVIEW_FLAG ? (xrHead ?? undefined) : undefined;
  // Scrunched: pick LOD levels by distance from the head (or the desktop camera).
  const lodEye = scrunch ? (xr.presenting ? (xrHead ?? undefined) : stage.camera.position) : undefined;
  // (Before the batches sync, so batched parts follow their hidden originals.)
  for (const list of forcedHidden.values()) for (const o of list) o.visible = false;
  fictionSprites?.sync();
  lineBatch?.sync();
  globeLayers?.update();
  if (meshLods && lodEye) meshLods.update(lodEye, [bodies.root, ...(fiction ? [fiction.root] : [])]);
  orreryBatch.sync(eye, cullAngle, lodEye, scrunch && eye ? (c, r) => discHides(eye, c, r) : undefined);
  discBatch?.sync(eye, cullAngle);
  mark('sync');
  stage.render(xr.camera);
  mark('render');
  if (captureDue && xr.presenting) {
    const name = captureDue;
    captureDue = null;
    captureEye(stage.renderer, stage.scene, name, (stage) => telemetry.sendNow({ kind: 'capture-stage', name, stage })).then(
      () => telemetry.send({ kind: 'captured', name }),
      (e) => telemetry.send({ kind: 'capture-failed', name, error: String(e) }),
    );
  }
  {
    const r = stage.renderer.info.render as unknown as { drawCalls: number; triangles: number };
    lastRender.drawCalls = r.drawCalls;
    lastRender.triangles = r.triangles;
  }
  if (shake) stage.camera.position.sub(shake);

  readout.update();
  info.update(simMs);
  syncDate();

  if (++frames === 3) {
    veil.classList.add('gone');
    clearTimeout(bootStall);
    boot.sendNow({ kind: 'boot', stage: 'running' });
  }
}
// Restore Discworld mode last: it touches state declared throughout this file.
{
  const param = new URLSearchParams(location.search).get('disc');
  let saved = false;
  try {
    saved = localStorage.getItem('discworld') === '1';
  } catch {
    /* ignore */
  }
  if (param === '1' || (param !== '0' && saved)) setDiscworld(true);
}
/**
 * Desktop preview of the VR scene (?headset=1&vrview=1): stand the camera at a
 * VR viewpoint at the default world scale (eye 1.6 m over the Disc), and show
 * the arrival tunnel and the control box in front of it.
 */
const vrPreview = {
  /** `metresPerUnit` previews another world scale (eye height and near plane as VR would have them). */
  view(name: string, pitchDeg = -8, metresPerUnit: number = XR.metresPerUnit) {
    const v = viewpoints()[name];
    if (!v) throw new Error(`no viewpoint ${name}`);
    const head = v.head.clone();
    if (v.onGround) head.y += 1.6 / metresPerUnit;
    debug.near = 0.1 / metresPerUnit;
    const yaw = THREE.MathUtils.degToRad(v.yawDeg),
      pitch = THREE.MathUtils.degToRad(pitchDeg);
    const look = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    debug.poseAt(head, look);
    return { head: head.toArray(), yawDeg: v.yawDeg, note: v.note };
  },
  arrival(t = 1.2) {
    const cam = stage.camera;
    xr.previewArrival(stage.scene, cam.position, cam.rotation.y, t);
  },
  panel(on = true, which: 'time' | 'scene' = 'scene') {
    xr.previewPanel(on ? stage.camera : null, which);
  },
  /** The lift, hatches open by `open` (0..1), or hidden with null. */
  lift(open: number | null = 1) {
    xr.previewLift(open);
  },
};

// The animation loop is the renderer's, so it carries on at the headset's own rate in VR.
stage.renderer.setAnimationLoop(frame);

// Expose for debugging in the console.
Object.assign(window, { orreryDebug: { stage, clock, bodies, orrery, kinematics, discworld: () => discworld, fiction: () => fiction, pick, xr, scrunch: debug, scrunchParts: { meshLods, culler, fictionSprites: () => fictionSprites, lineBatch: () => lineBatch, batch: () => orreryBatch, globeLayers: () => globeLayers, rebuild: () => { const t0 = performance.now(); rebuildBatches(); return performance.now() - t0; } }, vr: vrPreview } });
