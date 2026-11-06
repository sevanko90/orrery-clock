import * as THREE from 'three/webgpu';
import type { Stage } from '../scene/stage';
import type { Batcher } from '../scene/batch';
import type { SimClock } from '../sim/clock';
import { SPEED_STEPS } from '../sim/clock';

/**
 * Measuring tools for the VR scrunch, driven from the desktop console or the
 * browser automation (window.orreryDebug.scrunch). Nothing here runs unless
 * called.
 *
 *   s = orreryDebug.scrunch
 *   await s.setup('marker1')        // fixed date, paused, frozen, camera at the marker with a Quest eye's view
 *   s.inventory()                   // triangles, vertices, draws in view, per subsystem
 *   await s.capture('m1-scrunch1')  // PNG to .telemetry/captures/ (dev server)
 */

/** VR viewpoints from headset telemetry (left-grip markers, 2026-11-05). */
export const POSES: Record<string, { head: [number, number, number]; look: [number, number, number] }> = {
  // Whole orrery in view, from beyond the table's edge.
  marker1: { head: [-0.739, 12.092, 19.396], look: [-0.186, -0.038, -0.982] },
  // Close in over the table, looking across the movement.
  marker2: { head: [-6.337, 9.976, -1.019], look: [0.908, 0.013, -0.419] },
  marker3: { head: [-6.333, 9.829, -2.809], look: [0.078, -0.128, -0.989] },
};

/** Quest 3, one eye: ~96° vertical field. */
export const QUEST_VFOV = 96;
/** The fixed date used for every measurement (all planets on show, no fiction event playing). */
export const MEASURE_DATE = '2027-08-20T12:00:00Z';

export interface DebugContext {
  stage: Stage;
  clock: SimClock;
  batches: () => Batcher[];
  roots: () => Record<string, THREE.Object3D | null | undefined>;
  setMode: (mode: 'fiction' | 'discworld' | 'moons' | 'markers' | 'hangar', on: boolean) => void;
  scrunch: boolean;
}

interface Row {
  draws: number;
  tris: number;
  /** Vertex shader runs (unique vertices for indexed geometry, three per triangle otherwise). */
  verts: number;
  objects: number;
  materials: Set<string>;
}

export class ScrunchDebug {
  frozen = false;
  /**
   * With ?seed=N the whole run is repeatable: every frame steps exactly 1/60 s
   * from the first, the clock is held at MEASURE_DATE, and setup() acts on fixed
   * frame numbers, so two loads (an A/B pair) reach the same frame.
   */
  readonly seeded = Number(new URLSearchParams(location.search).get('seed')) > 0;
  /** When set, every frame advances the scene by exactly this (s), so two page loads land on the same frame. */
  fixedDt: number | null = null;
  /** Desktop near plane override (world units), for previewing VR world scales. */
  near: number | null = null;
  /** Frames stepped (counted by the main loop). */
  ticks = 0;

  /** The frame step to use: 0 frozen, the fixed step, or the real one. */
  dt(real: number) {
    this.ticks++;
    return this.frozen ? 0 : (this.fixedDt ?? real);
  }
  constructor(private ctx: DebugContext) {
    if (this.seeded) {
      this.fixedDt = 1 / 60;
      this.ctx.clock.jumpTo(Date.parse(MEASURE_DATE));
      this.ctx.clock.setStep(SPEED_STEPS.findIndex((s) => s.speed === 0));
    }
  }

  get on() {
    return this.ctx.scrunch;
  }

  /** Stand the desktop camera at a VR viewpoint with a Quest eye's vertical field of view. */
  pose(name: string, vfov = QUEST_VFOV) {
    const p = POSES[name];
    if (!p) throw new Error(`no pose ${name}`);
    const { camera, controls } = this.ctx.stage;
    controls.autoRotate = false;
    controls.enableDamping = false;
    controls.enabled = false;
    controls.minDistance = 0;
    camera.position.set(...p.head);
    controls.target.set(...p.head).addScaledVector(new THREE.Vector3(...p.look).normalize(), 10);
    camera.fov = vfov;
    camera.updateProjectionMatrix();
    controls.update();
  }

  /** Stand the desktop camera at a head position looking along `look`, with a Quest eye's field. */
  poseAt(head: THREE.Vector3, look: THREE.Vector3, vfov = QUEST_VFOV) {
    const { camera, controls } = this.ctx.stage;
    controls.autoRotate = false;
    controls.enableDamping = false;
    controls.enabled = false;
    controls.minDistance = 0;
    camera.position.copy(head);
    controls.target.copy(head).addScaledVector(look.clone().normalize(), 10);
    camera.fov = vfov;
    camera.updateProjectionMatrix();
    controls.update();
  }

  /** Hold every animation still (dt = 0) and the clock paused at a fixed date. */
  freeze(on = true, iso = MEASURE_DATE) {
    this.frozen = on;
    if (on) {
      this.ctx.clock.jumpTo(Date.parse(iso));
      this.ctx.clock.setStep(SPEED_STEPS.findIndex((s) => s.speed === 0));
    }
  }

  /** Wait for n frames. */
  async frames(n = 1) {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  }

  /**
   * The standard measurement state: modes as given (default: everything on,
   * as in the headset runs), fixed date, frozen, camera at the pose. Discworld
   * takes ~4 s to assemble, so it runs unfrozen until then.
   */
  async setup(pose = 'marker1', modes: Partial<Record<'fiction' | 'discworld' | 'moons' | 'markers' | 'hangar', boolean>> = {}) {
    const m = { fiction: true, discworld: true, moons: true, markers: true, hangar: true, ...modes };
    // Clock paused at the date; the scene steps 1/60 s a frame for 360 frames
    // (Discworld assembles in ~4 s), then holds still: the same frame on every load.
    // (Seeded runs act on fixed frame numbers: modes at frame 300, frozen at 660.)
    const start = this.seeded ? 300 : this.ticks;
    if (this.seeded && this.ticks > start) console.warn(`scrunch setup: called late (frame ${this.ticks}); frames may not match other loads`);
    while (this.ticks < start) await this.frames(1);
    this.freeze(true);
    this.frozen = false;
    this.fixedDt = 1 / 60;
    for (const [k, v] of Object.entries(m)) this.ctx.setMode(k as keyof typeof m, v);
    this.pose(pose);
    const until = start + 360;
    while (this.ticks < until) await this.frames(1);
    this.frozen = true;
    this.pose(pose);
    await this.frames(10);
  }

  /** Triangles, vertices and draws in the camera's view, per subsystem (and part type). */
  inventory(camera: THREE.Camera = this.ctx.stage.camera) {
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const rows = new Map<string, Row>();
    const row = (k: string) => {
      let r = rows.get(k);
      if (!r) rows.set(k, (r = { draws: 0, tris: 0, verts: 0, objects: 0, materials: new Set() }));
      return r;
    };
    const roots = Object.entries(this.ctx.roots()).filter(([, o]) => o) as [string, THREE.Object3D][];
    const groupOf = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) {
        const hit = roots.find(([, r]) => r === p);
        if (hit) return hit[0];
      }
      return 'other';
    };
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return true;
    };
    const sphere = new THREE.Sphere();
    const inView = (o: THREE.Object3D, g: THREE.BufferGeometry) => {
      if (!g.boundingSphere) g.computeBoundingSphere();
      sphere.copy(g.boundingSphere!).applyMatrix4(o.matrixWorld);
      return frustum.intersectsSphere(sphere);
    };
    const costOf = (g: THREE.BufferGeometry, count?: number) => {
      const n = count ?? (g.index ? g.index.count : g.attributes.position.count);
      return { tris: n / 3, verts: g.index ? Math.min(n, g.attributes.position.count) : n };
    };

    // Batched parts, counted per original (its subsystem), at the level drawn.
    const batchHit = new Set<THREE.BatchedMesh>();
    for (const b of this.ctx.batches()) {
      for (const e of b.instances()) {
        const batch = e.batch;
        if (!batch.visible || !shown(batch) || !batch.getVisibleAt(e.id)) continue;
        if (!inView(e.mesh, e.mesh.geometry)) continue;
        const range = batch.getGeometryRangeAt(batch.getGeometryIdAt(e.id));
        const tris = range.count / 3;
        const k = `${groupOf(e.mesh)}/${e.mesh.geometry.type}`;
        const r = row(k);
        r.tris += tris;
        // Unique vertices of the stored geometry (indexed) bound the shader runs.
        r.verts += Math.min(range.count, range.vertexCount);
        r.objects++;
        r.materials.add((batch.material as THREE.Material).uuid);
        if (!batchHit.has(batch)) {
          batchHit.add(batch);
          r.draws++;
        }
      }
    }
    this.ctx.stage.scene.traverseVisible((o) => {
      if (!o.layers.isEnabled(0)) return;
      const m = o as THREE.Mesh;
      if ((m as unknown as THREE.BatchedMesh).isBatchedMesh) return;
      const isDrawable = m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (o as THREE.Line).isLine;
      if (!isDrawable) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[];
      if (!mats.some((x) => x.visible)) return;
      const g = m.geometry;
      if (o.frustumCulled && g && !(o as THREE.Sprite).isSprite && !inView(o, g)) return;
      const k = `${groupOf(o)}/${(o as THREE.Sprite).isSprite ? 'Sprite' : (o as THREE.Points).isPoints ? 'Points' : (o as THREE.Line).isLine ? 'Line' : g.type}`;
      const r = row(k);
      const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      if (m.isMesh) {
        const c = costOf(g);
        r.tris += c.tris * inst;
        r.verts += c.verts * inst;
      }
      r.objects++;
      r.draws += Array.isArray(m.material) && g.groups.length ? g.groups.length : 1;
      mats.forEach((x) => r.materials.add(x.uuid));
    });
    const out: Record<string, { draws: number; tris: number; verts: number; objects: number; materials: number }> = {};
    const total = { draws: 0, tris: 0, verts: 0, objects: 0, materials: 0 };
    const allMats = new Set<string>();
    for (const [k, r] of [...rows].sort((a, b) => b[1].tris - a[1].tris)) {
      out[k] = { draws: r.draws, tris: Math.round(r.tris), verts: Math.round(r.verts), objects: r.objects, materials: r.materials.size };
      total.draws += r.draws;
      total.tris += r.tris;
      total.verts += r.verts;
      total.objects += r.objects;
      r.materials.forEach((x) => allMats.add(x));
    }
    total.tris = Math.round(total.tris);
    total.verts = Math.round(total.verts);
    total.materials = allMats.size;
    // Per subsystem.
    const bySystem: Record<string, { draws: number; tris: number; verts: number }> = {};
    for (const [k, r] of Object.entries(out)) {
      const s = (bySystem[k.split('/')[0]] ??= { draws: 0, tris: 0, verts: 0 });
      s.draws += r.draws;
      s.tris += r.tris;
      s.verts += r.verts;
    }
    const info = this.ctx.stage.renderer.info.render as unknown as { drawCalls: number; triangles: number };
    return {
      scrunch: this.ctx.scrunch,
      total,
      bySystem,
      rows: out,
      lod: this.ctx.batches().map((b) => b.lodCounts()),
      renderer: { drawCalls: info.drawCalls, triangles: Math.round(info.triangles) },
      /** Pixels per radian of this view (the Quest eye is ~720). */
      pxPerRad: Math.round(this.ctx.stage.renderer.domElement.height / 2 / Math.tan(THREE.MathUtils.degToRad((this.ctx.stage.camera as THREE.PerspectiveCamera).fov / 2))),
    };
  }

  /** Send the current frame as a PNG to the dev server (.telemetry/captures/<name>.png). */
  async capture(name: string) {
    const { stage } = this.ctx;
    // The frame the main loop drew (a render from here wouldn't reach the canvas until then).
    await this.frames(3);
    const url = stage.renderer.domElement.toDataURL('image/png');
    const res = await fetch(`/__telemetry/capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
    return { name, ok: res.ok, bytes: url.length, size: [stage.renderer.domElement.width, stage.renderer.domElement.height] };
  }

  /** Average frame time over n frames (ms), with the GPU drawing what's in view. */
  async frameTime(n = 120) {
    await this.frames(5);
    const t0 = performance.now();
    await this.frames(n);
    return (performance.now() - t0) / n;
  }
}
