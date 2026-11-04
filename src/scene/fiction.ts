import * as THREE from 'three';
import type { Bodies, Body } from './bodies';
import type { Materials } from './materials';
import { PLANE_Y } from './layout';
import {
  UTOPIA_LONGITUDE,
  UTOPIA_PLANITIA,
  WAR_OF_THE_WORLDS,
  WOTW_FLIGHT_DAYS,
  WOTW_SHOTS,
  WOTW_SPAN_MS,
  wotwOccurrence,
} from '../fiction/catalog';

const DAY = 86_400_000;
const SUN = new THREE.Vector3(0, PLANE_Y, 0);
const UP = new THREE.Vector3(0, 1, 0);
const MARTIAN_GREEN = new THREE.Color(0x7dff8a);

/** Soft white dot; sprites tint it with their material colour. */
let dotTexture: THREE.Texture | null = null;
function softDot() {
  if (dotTexture) return dotTexture;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  dotTexture = new THREE.CanvasTexture(c);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}

function glow(color: THREE.ColorRepresentation, opacity = 1) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softDot(),
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.renderOrder = 4;
  return s;
}

function pickProxy(radius: number) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// ---- The War of the Worlds ---------------------------------------------------------

/** Fraction of the crossing each shot's gas trail spans behind it. */
const TRAIL_SPAN = 0.12;
/** Loose puffs of gas drifting off along each trail. */
const WAKE_PUFFS = 6;

/**
 * A cone of glowing gas: brightest at the apex (the head of the shot),
 * fading toward the open tail and toward its silhouette edges, with a slow
 * shimmer running down it. Additive and double-sided, so it reads as a
 * volume of light rather than a solid.
 */
class GasConeMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: MARTIAN_GREEN.clone() },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uOpacity;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float along = vUv.y; // 1 at the head, 0 at the tail
          float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
          float shimmer = 0.7 + 0.3 * sin(along * 18.0 - uTime * 4.0 + vUv.x * 12.566);
          float a = pow(along, 1.6) * core * shimmer * uOpacity * 0.9;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });
  }
}

/** Apex at the origin, opening along −y to a rim of radius 1 at y = −1. */
const CONE = new THREE.ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

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
class WarOfTheWorlds {
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
      const cone = new THREE.Mesh(CONE, new GasConeMaterial());
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
    return out
      .copy(this.mars)
      .multiplyScalar(a)
      .addScaledVector(this.ctrl, b)
      .addScaledVector(this.earth, c);
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
    this.ctrl.copy(mid).addScaledVector(out, clear).addScaledVector(UP, 0.12 * len + 0.4);
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
      p.clone().sub(SUN).applyAxisAngle(UP, (span / periodDays) * Math.PI * 2).add(SUN);
    const mars = this.bodies.positionOf('mars');
    const earth = this.bodies.positionOf('earth');
    return [mars, earth, around(mars, 687), around(earth, 365.25)];
  }
}

// ---- Utopia Planitia -----------------------------------------------------------------

/**
 * A brass drydock: an open cage of rails and hoops with a hull inside,
 * welding sparks flickering over it, parked above Utopia Planitia so it
 * turns with Mars.
 */
class UtopiaPlanitia {
  readonly anchor = new THREE.Group();
  readonly body: Body;
  private sparks: THREE.Sprite[] = [];
  private beacons: THREE.Sprite[] = [];

  constructor(frame: THREE.Object3D, mats: Materials) {
    this.anchor.name = 'utopia';
    // Sphere UVs put the map's longitude L at angle (L + 180)° from −x.
    const phi = ((UTOPIA_LONGITUDE + 180) / 360) * Math.PI * 2;
    const radial = new THREE.Vector3(-Math.cos(phi), 0, Math.sin(phi));
    this.anchor.position.copy(radial).multiplyScalar(0.62);
    // Lie along the orbit: the model's long (x) axis on the tangent.
    const tangent = new THREE.Vector3(-radial.z, 0, radial.x);
    this.anchor.rotation.y = Math.atan2(-tangent.z, tangent.x);
    frame.add(this.anchor);

    const dock = new THREE.Group();
    dock.scale.setScalar(1.15);
    this.anchor.add(dock);

    // Cage: four rails and five hoops.
    const rail = new THREE.CylinderGeometry(0.0035, 0.0035, 0.24, 6);
    rail.rotateZ(Math.PI / 2);
    for (const [y, z] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const m = new THREE.Mesh(rail, mats.brass);
      m.position.set(0, y * 0.04, z * 0.04);
      dock.add(m);
    }
    const hoop = new THREE.TorusGeometry(0.0566, 0.004, 6, 24);
    hoop.rotateY(Math.PI / 2);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(hoop, i % 2 ? mats.brassDark : mats.brass);
      m.position.x = -0.11 + i * 0.055;
      dock.add(m);
    }
    // Gantry arms reaching in to the hull.
    const arm = new THREE.CylinderGeometry(0.002, 0.002, 0.04, 5);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(arm, mats.brassDark);
      m.position.set(-0.06 + i * 0.04, i % 2 ? 0.03 : -0.03, 0);
      dock.add(m);
    }

    // The hull taking shape: a long body and two outboard pods on struts.
    const hull = new THREE.CapsuleGeometry(0.019, 0.1, 6, 14);
    hull.rotateZ(Math.PI / 2);
    dock.add(new THREE.Mesh(hull, mats.copper));
    const band = new THREE.TorusGeometry(0.0195, 0.003, 6, 20);
    band.rotateY(Math.PI / 2);
    for (const x of [-0.03, 0.02]) {
      const m = new THREE.Mesh(band, mats.brass);
      m.position.x = x;
      dock.add(m);
    }
    const pod = new THREE.CapsuleGeometry(0.007, 0.06, 4, 10);
    pod.rotateZ(Math.PI / 2);
    const strut = new THREE.CylinderGeometry(0.0025, 0.0025, 0.03, 5);
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(pod, mats.brassDark);
      m.position.set(-0.03, 0.022, side * 0.03);
      dock.add(m);
      const s = new THREE.Mesh(strut, mats.brass);
      s.position.set(-0.03, 0.012, side * 0.016);
      s.rotation.x = side * 0.9;
      dock.add(s);
    }

    // Welding sparks and red beacons at the cage's ends.
    for (let i = 0; i < 7; i++) {
      const s = glow(i % 2 ? 0xfff2c8 : 0x9fd8ff, 0);
      s.scale.setScalar(0.02);
      s.position.set(-0.07 + i * 0.023, Math.sin(i * 1.7) * 0.022, Math.cos(i * 2.3) * 0.022);
      this.sparks.push(s);
      dock.add(s);
    }
    for (const x of [-0.125, 0.125]) {
      const b = glow(0xff5040, 0);
      b.scale.setScalar(0.03);
      b.position.set(x, 0.04, 0.04);
      this.beacons.push(b);
      dock.add(b);
    }

    const proxy = pickProxy(0.16);
    this.anchor.add(proxy);
    this.body = {
      id: UTOPIA_PLANITIA.id,
      facts: null,
      name: UTOPIA_PLANITIA.title,
      kind: UTOPIA_PLANITIA.source,
      blurb: UTOPIA_PLANITIA.blurb,
      group: this.anchor,
      pickProxy: proxy,
      radius: 0.15,
      upgrade: () => undefined,
      available: () => this.anchor.visible,
      rows: () => [
        ['Orbits', 'Mars'],
        ['Station', `Above ${UTOPIA_LONGITUDE}° E`],
        ['Builds', 'Starships'],
      ],
    };
  }

  update(elapsed: number) {
    this.sparks.forEach((s, i) => {
      const flicker = Math.sin(elapsed * (9 + i * 1.3) + i * 4.1) * Math.sin(elapsed * 3.7 + i * 2.2);
      s.material.opacity = Math.max(0, flicker) ** 3 * 1.4;
    });
    const blink = (elapsed % 1.6) < 0.18 ? 1 : 0;
    this.beacons.forEach((b) => (b.material.opacity = blink * 0.9));
  }
}

// ---- Fiction mode -----------------------------------------------------------------------

export class Fiction {
  readonly root = new THREE.Group();
  readonly bodies: Body[];
  private wotw: WarOfTheWorlds;
  private utopia: UtopiaPlanitia;
  private on = false;
  /** Places switched off from the catalogue. */
  private hiddenPlaces = new Set<string>();
  /** Entry whose scene is playing: everything else steps aside. */
  private playing: string | null = null;

  constructor(bodies: Bodies, mats: Materials) {
    this.root.name = 'fiction';
    this.wotw = new WarOfTheWorlds(bodies, mats);
    this.root.add(this.wotw.group);
    this.utopia = new UtopiaPlanitia(bodies.surfaceFrame('mars')!, mats);
    this.bodies = [this.wotw.body, this.utopia.body];
    this.setEnabled(false);
  }

  get enabled() {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
    this.root.visible = on;
    this.refresh();
  }

  /** Show or hide one of the always-on places. */
  setPlaceShown(id: string, shown: boolean) {
    if (shown) this.hiddenPlaces.delete(id);
    else this.hiddenPlaces.add(id);
    this.refresh();
  }

  placeShown(id: string) {
    return !this.hiddenPlaces.has(id);
  }

  /** A scene is playing (or null when it ends): hide whatever isn't part of it. */
  setPlaying(id: string | null) {
    this.playing = id;
    this.refresh();
  }

  private refresh() {
    const inScene = (id: string) => this.playing === null || this.playing === id;
    this.utopia.anchor.visible = this.on && this.placeShown(UTOPIA_PLANITIA.id) && inScene(UTOPIA_PLANITIA.id);
    this.wotw.suppressed = !inScene(WAR_OF_THE_WORLDS.id);
  }

  update(simMs: number, dt: number, elapsed: number, jumped: boolean) {
    if (!this.on) return;
    this.wotw.update(simMs, dt, jumped);
    this.utopia.update(elapsed);
  }

  /** Points a camera should frame to watch an entry play out (empty: just focus its body). */
  framePoints(id: string): THREE.Vector3[] {
    return id === WAR_OF_THE_WORLDS.id ? this.wotw.framePoints() : [];
  }
}
