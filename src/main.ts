import './style.css';
import * as THREE from 'three';
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
import { InfoCard } from './ui/infocard';
import { detectGpu, warnIfNoGpu } from './ui/gpuCheck';
import { Fiction } from './scene/fiction';
import { FictionPanel } from './ui/fictionPanel';
import { nextOccurrence, type FictionEntry } from './fiction/catalog';
import { XrMode, type XrHit } from './xr/xrMode';
import { TABLE_RADIUS } from './scene/layout';

if (import.meta.env.PROD) {
  // Activate new builds immediately; reload once the new worker takes control.
  const updateSW = registerSW({ immediate: true, onNeedRefresh: () => updateSW(true) });
}

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
addEventListener('error', (e) => showFatal(e.message || String(e.error)));
addEventListener('unhandledrejection', (e) => showFatal(String(e.reason?.message ?? e.reason)));

const container = document.getElementById('scene')!;
const gpu = detectGpu();
warnIfNoGpu(gpu);
const quality = detectQuality();
// Without a GPU, drop to the light settings so it at least stays usable.
if (gpu === 'software') Object.assign(quality, { low: true, pixelRatio: 1, shadows: false, bloom: false });
const stage = new Stage(container, quality);
const mats = createMaterials(quality.low);
const orrery = buildOrrery(mats);
stage.scene.add(orrery.root);
const bodies = new Bodies(orrery.arms, { lowQuality: quality.low });
stage.scene.add(bodies.root);

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
const discButton = document.getElementById('c-disc') as HTMLButtonElement;
const NORMAL_LIMITS = { maxPolar: stage.controls.maxPolarAngle, maxDistance: stage.controls.maxDistance };
function setDiscworld(on: boolean) {
  if (on && !discworld) {
    discworld = new Discworld(mats, { lowQuality: quality.low || quality.headset, pixelRatio: quality.pixelRatio });
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
  bodies.setMoonsVisible(on);
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
}

function setFiction(on: boolean) {
  if (!fiction) {
    fiction = new Fiction(bodies, mats);
    hiddenPlaces.forEach((id) => fiction!.setPlaceShown(id, false));
    stage.scene.add(fiction.root);
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
const raycaster = new THREE.Raycaster();
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
    const hit = raycaster.intersectObject(discworld!.root, true)[0];
    if (hit) return { point: hit.point, distance: hit.distance, label: lore.name, note: lore.kind };
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
const xr = new XrMode(stage.renderer, stage.scene, { orrery: orreryBox, tableRadius: TABLE_RADIUS }, {
  pick: xrPick,
  // From under the cabinet its opaque base hides the whole movement (115 draw calls): skip it.
  view: (head) => (orrery.mechanism.root.visible = head.y > orreryBox.min.y),
  faster: () => clock.setStep(clock.step + 1),
  slower: () => clock.setStep(clock.step - 1),
  now: () => clock.resetToNow(),
  status: () => [new Date(clock.nowMs()).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), SPEED_STEPS[clock.step].label],
  quake: () => Math.max(discworld?.quake ?? 0, fiction?.quake ?? 0),
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

// ---- Main loop ---------------------------------------------------------------
const veil = document.getElementById('veil')!;
let prev = performance.now();
let elapsed = 0;
let frames = 0;

let frameFailed = false;
/** Simulation time of the last frame (ms), for the VR performance readout. */
let cpuMs = 0;
function frame(now: number) {
  const t0 = performance.now();
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
}

function step(now: number) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  elapsed += dt;

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

  const simDate = new Date(simMs);
  for (const a of ARMS) {
    const lon = planetPosition(a.id, simDate).lon;
    trueMarkers.get(a.id)!.position.set(Math.cos(lon) * a.radius, PLANE_Y, -Math.sin(lon) * a.radius);
  }
  bodies.update(simMs, dt, elapsed);
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
    fiction.update(simMs, dt, elapsed, jumped, stage.camera);
    if (pendingFrame) {
      const points = fiction.framePoints(pendingFrame);
      if (points.length) focus.frame(points, 2.4);
      pendingFrame = null;
    }
  }
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
  if (xr.presenting) xr.update(dt, cpuMs);
  stage.controls.update(dt);
  // Scale the near plane with zoom: depth precision falls off with distance,
  // so a fixed 0.1 makes thin inlays flicker when zoomed out.
  const near = THREE.MathUtils.clamp(stage.camera.position.distanceTo(stage.controls.target) * 0.006, 0.1, 0.5);
  if (Math.abs(near - stage.camera.near) > 0.01) {
    stage.camera.near = near;
    stage.camera.updateProjectionMatrix();
  }
  // An elephant shifting its feet shakes the whole Disc (and the camera).
  const quake = Math.max(discworld?.quake ?? 0, fiction?.quake ?? 0);
  const shake = quake > 0 && !xr.presenting ? new THREE.Vector3().randomDirection().multiplyScalar(quake * quake * 0.004 * stage.camera.position.distanceTo(stage.controls.target)) : null;
  if (shake) stage.camera.position.add(shake);
  stage.render(xr.camera);
  if (shake) stage.camera.position.sub(shake);

  readout.update();
  info.update(simMs);
  syncDate();

  if (++frames === 3) veil.classList.add('gone');
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
// The animation loop is the renderer's, so it carries on at the headset's own rate in VR.
stage.renderer.setAnimationLoop(frame);

// Expose for debugging in the console.
Object.assign(window, { orreryDebug: { stage, clock, bodies, orrery, kinematics, discworld: () => discworld, fiction: () => fiction, pick, xr } });
