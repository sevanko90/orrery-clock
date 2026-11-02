import './style.css';
import * as THREE from 'three';
import { registerSW } from 'virtual:pwa-register';
import { Stage, detectQuality } from './scene/stage';
import { createMaterials } from './scene/materials';
import { buildOrrery } from './scene/orrery';
import { Bodies, type Body } from './scene/bodies';
import { FocusController } from './scene/focus';
import { SimClock } from './sim/clock';
import { Kinematics } from './mechanism/kinematics';
import { design } from './scene/mechanism3d';
import { meanLongitude, planetPosition, type PlanetId } from './astro/orbits';
import { ARMS, PLANE_Y } from './scene/layout';
import { Readout } from './ui/readout';
import { bindControls } from './ui/controls';
import { InfoCard } from './ui/infocard';

if (import.meta.env.PROD) registerSW({ immediate: true });

const container = document.getElementById('scene')!;
const quality = detectQuality();
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
  if (!focus.focused) return;
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

const credits = document.getElementById('credits') as HTMLDialogElement;
document.getElementById('credits-btn')!.addEventListener('click', () => credits.showModal());

// ---- Idle auto-rotation ----------------------------------------------------
let lastInteraction = -Infinity;
stage.controls.addEventListener('start', () => {
  lastInteraction = performance.now();
  stage.controls.autoRotate = false;
});
stage.controls.addEventListener('end', () => (lastInteraction = performance.now()));

// ---- Picking & hover ---------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const proxies = bodies.bodies.map((b) => b.pickProxy);
const hoverTag = document.getElementById('hover-tag')!;
const canvas = stage.renderer.domElement;

function setPointer(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
}

function pick(clientX: number, clientY: number): Body | null {
  setPointer(clientX, clientY);
  const hit = raycaster.intersectObjects(proxies, false)[0];
  if (hit) return bodies.bodies.find((b) => b.pickProxy === hit.object) ?? null;
  // Clicking a true-position ring selects its planet.
  const id = pickMarker();
  return id ? (bodies.bodies.find((b) => b.id === id) ?? null) : null;
}

/** Planet id whose true-position ring is under the pointer (call after setPointer). */
function pickMarker(): string | null {
  if (!markersOn) return null;
  const hit = raycaster.intersectObjects([...trueMarkers.values()], false)[0];
  return hit ? (markerOwner.get(hit.object) ?? null) : null;
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
  if (body) select(body);
  else unfocus();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) {
    hoverTag.hidden = true;
    return;
  }
  setPointer(e.clientX, e.clientY);
  const hit = raycaster.intersectObjects(proxies, false)[0];
  const body = hit ? (bodies.bodies.find((b) => b.pickProxy === hit.object) ?? null) : null;
  const markerId = body ? null : pickMarker();
  const markerName = markerId ? bodies.bodies.find((b) => b.id === markerId)?.name : null;
  const label = body ? body.name : markerName ? `${markerName}: true position` : null;
  canvas.style.cursor = label ? 'pointer' : '';
  hoverTag.hidden = !label;
  if (label) {
    hoverTag.replaceChildren(label);
    if (markerName) {
      const note = document.createElement('small');
      note.textContent = `The gears turn ${markerName} at its average speed; this glow marks where it really is.`;
      hoverTag.append(note);
    }
    hoverTag.style.left = `${e.clientX}px`;
    hoverTag.style.top = `${e.clientY}px`;
  }
});
canvas.addEventListener('pointerleave', () => (hoverTag.hidden = true));

// ---- Main loop ---------------------------------------------------------------
const veil = document.getElementById('veil')!;
let prev = performance.now();
let elapsed = 0;
let frames = 0;

function frame(now: number) {
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
  focus.update(dt);

  if (!stage.controls.autoRotate && !focus.flying && now - lastInteraction > 20_000) {
    stage.controls.autoRotate = true;
  }
  stage.controls.update(dt);
  stage.render();

  readout.update();
  info.update(simMs);
  syncDate();

  if (++frames === 3) veil.classList.add('gone');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for debugging in the console.
Object.assign(window, { orreryDebug: { stage, clock, bodies, orrery, kinematics } });
