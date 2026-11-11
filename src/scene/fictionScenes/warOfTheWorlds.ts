import * as THREE from 'three/webgpu';
import type { Materials } from '../materials';
import { GasConeMaterial } from '../fictionShaders';
import type { Bodies, Body } from '../bodies';
import { WAR_OF_THE_WORLDS, WOTW_FLIGHT_DAYS, WOTW_SHOTS, WOTW_SPAN_MS, wotwOccurrence } from '../../fiction/catalog';
import { CONE, DAY, DOWN, MARTIAN_GREEN, SUN, UP, fmtDate, glow, pickProxy } from './shared';

// ---- The War of the Worlds ---------------------------------------------------------

/** Fraction of the crossing each shot's gas trail spans behind it. */
const TRAIL_SPAN = 0.12;
/** Loose puffs of gas drifting off along each trail. */
const WAKE_PUFFS = 6;

interface Shot {
  head: THREE.Sprite;
  halo: THREE.Sprite;
  cone: THREE.Mesh<THREE.ConeGeometry, GasConeMaterial>;
  wake: THREE.Sprite[];
}

/**
 * Every 12 August at midnight Mars fires: a green flash and a jet of gas on
 * the side facing Earth, one a night for ten nights. Each shot (one of
 * the novel's cylinders) arcs to Earth, wide of the Sun, as a comet of green
 * gas rather than a solid shell, and lands with a puff.
 * Everything but the flash itself is a function of simulated time, so it
 * scrubs and runs backwards; the flash plays in real time when the clock
 * crosses a firing, so it is seen at any speed.
 */
export class WarOfTheWorlds {
  readonly group = new THREE.Group();
  readonly body: Body;
  private shots: Shot[] = [];
  private time = 0;
  private flash = glow(MARTIAN_GREEN);
  private plume: THREE.Sprite[] = [];
  private impact = glow(MARTIAN_GREEN);
  private lead = new THREE.Group();
  private flashAge = Infinity;
  private lastSim: number | null = null;
  /** Hidden while another entry's scene plays. */
  suppressed = false;
  private status = { start: 0, sinceStart: -1 };
  active = false;

  private mars = new THREE.Vector3();
  private earth = new THREE.Vector3();
  private ctrl = new THREE.Vector3();

  constructor(
    private bodies: Bodies,
    _mats: Materials,
  ) {
    this.group.name = 'wotw';
    for (let i = 0; i < WOTW_SHOTS; i++) {
      const head = glow(0xd8ffdc, 0.9);
      head.scale.setScalar(0.07);
      const halo = glow(MARTIAN_GREEN, 0.35);
      halo.scale.setScalar(0.2);
      const cone = new THREE.Mesh(CONE, new GasConeMaterial(MARTIAN_GREEN));
      cone.frustumCulled = false;
      const wake = Array.from({ length: WAKE_PUFFS }, () => glow(MARTIAN_GREEN, 0));
      this.shots.push({ head, halo, cone, wake });
      this.group.add(cone, ...wake, halo, head);
    }
    for (let i = 0; i < 9; i++) {
      const p = glow(MARTIAN_GREEN, 0);
      this.plume.push(p);
      this.group.add(p);
    }
    this.group.add(this.flash, this.impact, this.lead);

    const proxy = pickProxy(0.25);
    this.lead.add(proxy);
    this.body = {
      id: WAR_OF_THE_WORLDS.id,
      facts: null,
      name: WAR_OF_THE_WORLDS.title,
      kind: WAR_OF_THE_WORLDS.source,
      blurb: WAR_OF_THE_WORLDS.blurb,
      group: this.lead,
      pickProxy: proxy,
      radius: 0.3,
      upgrade: () => undefined,
      available: () => this.active && this.group.visible,
      rows: () => this.rows(),
    };
  }

  /** Point `s` (0 at Mars, 1 at Earth) along the cylinders' arc. */
  private along(s: number, out: THREE.Vector3) {
    const a = (1 - s) * (1 - s),
      b = 2 * (1 - s) * s,
      c = s * s;
    return out.copy(this.mars).multiplyScalar(a).addScaledVector(this.ctrl, b).addScaledVector(this.earth, c);
  }

  /** Bend the arc up off the table and, when the Sun is in the way, wide round it. */
  private shapeArc() {
    const mid = this.mars.clone().add(this.earth).multiplyScalar(0.5);
    const out = new THREE.Vector3(mid.x - SUN.x, 0, mid.z - SUN.z);
    const reach = out.length();
    if (reach > 0.01) out.divideScalar(reach);
    else out.set(-(this.earth.z - this.mars.z), 0, this.earth.x - this.mars.x).normalize();
    // A quadratic arc passes half way to its control point.
    const clear = Math.max(0, 4.5 - reach) * 2;
    const len = this.mars.distanceTo(this.earth);
    this.ctrl
      .copy(mid)
      .addScaledVector(out, clear)
      .addScaledVector(UP, 0.12 * len + 0.4);
  }

  update(simMs: number, dt: number, jumped: boolean) {
    const start = wotwOccurrence(simMs);
    const since = (simMs - start) / DAY;
    this.status = { start, sinceStart: since };
    this.active = since >= 0 && simMs <= start + WOTW_SPAN_MS;

    // A firing crossed this frame (not by a jump): play the flash.
    const prev = this.lastSim;
    this.lastSim = simMs;
    if (prev !== null && !jumped && Math.abs(simMs - prev) < 2 * DAY) {
      const lo = Math.min(prev, simMs),
        hi = Math.max(prev, simMs);
      for (const s of [start, wotwOccurrence(lo)]) {
        for (let n = 0; n < WOTW_SHOTS; n++) {
          const t = s + n * DAY;
          if (t > lo && t <= hi) this.flashAge = 0;
        }
      }
    }
    this.flashAge += dt;

    this.group.visible = !this.suppressed && (this.active || this.flashAge < 3);
    if (!this.group.visible) return;

    this.bodies.positionOf('mars', this.mars);
    this.bodies.positionOf('earth', this.earth);
    this.shapeArc();
    const toEarth = this.earth.clone().sub(this.mars).normalize();
    const marsR = 0.27;

    // Flash on Mars's Earth-facing side.
    const f = Math.exp(-this.flashAge * 1.6);
    this.flash.visible = f > 0.01;
    this.flash.position.copy(this.mars).addScaledVector(toEarth, marsR);
    this.flash.scale.setScalar(0.3 + 1.4 * Math.exp(-this.flashAge * 3));
    this.flash.material.opacity = f;

    // The gas jet from the latest firing lingers about a day.
    const jetAge = since - Math.floor(since);
    const lastShot = Math.floor(since);
    const jetting = this.active && lastShot >= 0 && lastShot < WOTW_SHOTS;
    const grow = Math.min(1, jetAge / 0.12);
    this.plume.forEach((p, i) => {
      const k = i / this.plume.length;
      p.visible = jetting;
      if (!jetting) return;
      p.position
        .copy(this.mars)
        .addScaledVector(toEarth, marsR + k * 0.55 * grow)
        .addScaledVector(UP, Math.sin(i * 2.1) * 0.03 * k);
      p.scale.setScalar(0.06 + k * 0.16 * grow);
      p.material.opacity = (1 - jetAge) ** 2 * (1 - k * 0.8) * 0.8;
    });

    // Shots in flight: a bright head and a cone of gas streaming behind.
    const tmp = new THREE.Vector3();
    const tail = new THREE.Vector3();
    const side = new THREE.Vector3();
    let leadS = -1;
    let latestLanding = -Infinity;
    this.time += dt;
    this.shots.forEach((c, n) => {
      const age = since - n;
      const flying = this.active && age >= 0 && age <= WOTW_FLIGHT_DAYS;
      c.head.visible = c.halo.visible = c.cone.visible = flying;
      c.wake.forEach((d) => (d.visible = flying));
      if (age > WOTW_FLIGHT_DAYS) latestLanding = Math.max(latestLanding, age - WOTW_FLIGHT_DAYS);
      if (!flying) return;
      const s = age / WOTW_FLIGHT_DAYS;
      // Swell out of Mars and thin away into Earth.
      const fade = Math.min(1, age / 0.6, (WOTW_FLIGHT_DAYS - age) / 0.8);
      this.along(s, c.head.position);
      c.halo.position.copy(c.head.position);
      c.head.material.opacity = 0.9 * fade;
      c.halo.material.opacity = 0.35 * fade;

      // The gas cone, from the head back to where the trail began.
      this.along(Math.max(0, s - TRAIL_SPAN), tail);
      const back = tail.clone().sub(c.head.position);
      const len = back.length();
      c.cone.visible = len > 0.01;
      if (c.cone.visible) {
        c.cone.position.copy(c.head.position);
        c.cone.quaternion.setFromUnitVectors(DOWN, back.divideScalar(len));
        const width = Math.min(0.13, len * 0.25);
        c.cone.scale.set(width, len, width);
        c.cone.material.uniforms.uTime.value = this.time + n * 1.7;
        c.cone.material.uniforms.uOpacity.value = fade;
      }

      // Puffs drifting loose behind it, spreading as they fall back.
      side.copy(back).cross(UP).normalize();
      c.wake.forEach((d, k) => {
        const b = (k + 1) / WAKE_PUFFS;
        this.along(Math.max(0, s - TRAIL_SPAN * b * 1.3), d.position);
        const drift = Math.sin(n * 3.1 + k * 1.9 + this.time * 0.6) * b * 0.05;
        d.position.addScaledVector(side, drift).addScaledVector(UP, Math.cos(k * 2.3 + n) * b * 0.03);
        d.scale.setScalar(0.05 + b * 0.13);
        d.material.opacity = (1 - b) * 0.3 * fade;
      });
      if (s > leadS) {
        leadS = s;
        this.lead.position.copy(c.head.position);
      }
    });
    if (leadS < 0) this.lead.position.copy(this.active && since >= WOTW_SHOTS ? this.earth : this.mars);

    // A puff of green dust where the latest cylinder came down.
    const dust = this.active && latestLanding >= 0 && latestLanding < 1.5 ? 1 - latestLanding / 1.5 : 0;
    this.impact.visible = dust > 0;
    if (dust > 0) {
      this.along(0.97, tmp);
      const dir = tmp.sub(this.earth).normalize();
      this.impact.position.copy(this.earth).addScaledVector(dir, 0.36);
      this.impact.scale.setScalar(0.15 + (1 - dust) * 0.35);
      this.impact.material.opacity = dust * 0.9;
    }
  }

  private rows(): [string, string][] {
    const { start, sinceStart } = this.status;
    const fired = THREE.MathUtils.clamp(Math.floor(sinceStart) + 1, 0, WOTW_SHOTS);
    const landed = THREE.MathUtils.clamp(Math.floor(sinceStart - WOTW_FLIGHT_DAYS) + 1, 0, WOTW_SHOTS);
    const rows: [string, string][] = [];
    if (!this.active) {
      rows.push(['First flash', fmtDate(start)]);
      return rows;
    }
    rows.push(['Fired', `${fired} of ${WOTW_SHOTS}`]);
    rows.push(['In flight', String(fired - landed)]);
    rows.push(['Landed', String(landed)]);
    if (landed < WOTW_SHOTS) rows.push(['Next landing', fmtDate(start + (landed + WOTW_FLIGHT_DAYS) * DAY)]);
    return rows;
  }

  /** Points to keep in view for the whole show: Earth and Mars now and as they move on. */
  framePoints(): THREE.Vector3[] {
    const span = WOTW_SPAN_MS / DAY;
    const around = (p: THREE.Vector3, periodDays: number) =>
      p
        .clone()
        .sub(SUN)
        .applyAxisAngle(UP, (span / periodDays) * Math.PI * 2)
        .add(SUN);
    const mars = this.bodies.positionOf('mars');
    const earth = this.bodies.positionOf('earth');
    return [mars, earth, around(mars, 687), around(earth, 365.25)];
  }
}
