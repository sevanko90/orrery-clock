import './style.css';
import * as THREE from 'three';
import { registerSW } from 'virtual:pwa-register';
import { Stage, detectQuality } from './scene/stage';
import { createMaterials } from './scene/materials';
import { buildOrrery } from './scene/orrery';
import { Bodies, type Body } from './scene/bodies';
import { FocusController } from './scene/focus';
import { SimClock } from './sim/clock';
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
const readout = new Readout(clock);
const focus = new FocusController(stage.camera, stage.controls);
const info = new InfoCard(() => unfocus());

function select(body: Body) {
  focus.focus(body);
  info.show(body, clock.nowMs());
}
function unfocus() {
  if (!focus.focused) return;
  focus.goHome();
  info.hide();
}

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

function pick(clientX: number, clientY: number): Body | null {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
  const hit = raycaster.intersectObjects(proxies, false)[0];
  return hit ? (bodies.bodies.find((b) => b.pickProxy === hit.object) ?? null) : null;
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
  const body = pick(e.clientX, e.clientY);
  canvas.style.cursor = body ? 'pointer' : '';
  hoverTag.hidden = !body;
  if (body) {
    hoverTag.textContent = body.name;
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
  orrery.setLongitudes(bodies.longitudes(new Date(simMs)));
  orrery.tick(Math.abs(clock.speed) <= 60 ? simMs / 1000 : elapsed * 4);
  orrery.root.updateMatrixWorld();
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
Object.assign(window, { orreryDebug: { stage, clock, bodies, orrery } });
