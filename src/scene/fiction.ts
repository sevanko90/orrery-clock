import * as THREE from 'three';
import { MOON_SYSTEMS, moonSize, sunlit, type Bodies, type Body } from './bodies';
import type { Materials } from './materials';
import { ARMS, PLANE_Y, SUN_RADIUS, TABLE_RADIUS, toWorld } from './layout';
import { cometPosition, sampleOrbit, type CometElements } from '../astro/orbits';
import { J2000, julianDate } from '../astro/time';
import { ProgressiveTexture } from './textures';
import { moonLongitude } from '../astro/sky';
import {
  BREAKAWAY,
  BREAKAWAY_DAYS,
  CERES_ORBIT,
  CERES_STATION,
  EROS,
  EROS_ORBIT,
  PETROVA_LINE,
  RING_GATE,
  RING_GATE_AT,
  TYCHO_ORBIT,
  TYCHO_STATION,
  type FictionEntry,
  VOGON,
  VOGON_DEMOLITION,
  vogonOccurrence,
  SPACE_1999,
  WORMHOLE,
  UTOPIA_LONGITUDE,
  UTOPIA_PLANITIA,
  WAR_OF_THE_WORLDS,
  WOTW_FLIGHT_DAYS,
  WOTW_SHOTS,
  WOTW_SPAN_MS,
  wotwOccurrence,
} from '../fiction/catalog';

const DAY = 86_400_000;
const DEG = Math.PI / 180;
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
  constructor(color: THREE.ColorRepresentation = MARTIAN_GREEN) {
    super({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
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

// ---- Space: 1999 ----------------------------------------------------------------------

const BLAST_BLUE = new THREE.Color(0xcfe4ff);
const DEBRIS = 28;

/**
 * Breakaway: the Moon's waste dumps explode, a white-blue flash and a shell of
 * debris, and the Moon tumbles out of orbit, climbing out of the planets'
 * plane on a plume of blue-white gas until it is lost among the stars. A
 * stand-in Moon plays the part (so it appears even with moons switched off)
 * while the real one is hidden.
 */
class Breakaway {
  readonly group = new THREE.Group();
  readonly body: Body;
  suppressed = false;
  active = false;
  /** Carries the stand-in Moon along its path (camera target). */
  private holder = new THREE.Group();
  private moon: THREE.Mesh;
  private flash = glow(BLAST_BLUE);
  private debris: { sprite: THREE.Sprite; dir: THREE.Vector3 }[] = [];
  private cone = new THREE.Mesh(CONE, new GasConeMaterial(BLAST_BLUE));
  private flashAge = Infinity;
  private lastSim: number | null = null;
  private since = -1;
  private time = 0;
  private readonly orbit: number;
  private earth = new THREE.Vector3();
  private blastAt = new THREE.Vector3();

  constructor(private bodies: Bodies) {
    this.group.name = 'space1999';
    this.orbit = ARMS.find((a) => a.id === 'earth')!.size * MOON_SYSTEMS.earth![0];
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0 });
    new ProgressiveTexture(
      'moon',
      (t) => {
        mat.map = t;
        mat.needsUpdate = true;
      },
      THREE.SRGBColorSpace,
      false,
    ).start('1k');
    sunlit(mat);
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(moonSize(1737.4), 32, 24), mat);
    this.cone.frustumCulled = false;
    this.holder.add(this.moon);
    this.group.add(this.holder, this.cone, this.flash);
    for (let i = 0; i < DEBRIS; i++) {
      const sprite = glow(i % 3 ? BLAST_BLUE : 0xffffff, 0);
      this.debris.push({ sprite, dir: new THREE.Vector3().randomDirection() });
      this.group.add(sprite);
    }
    const proxy = pickProxy(0.2);
    this.holder.add(proxy);
    this.body = {
      id: SPACE_1999.id,
      facts: null,
      name: SPACE_1999.title,
      kind: SPACE_1999.source,
      blurb: SPACE_1999.blurb,
      group: this.holder,
      pickProxy: proxy,
      radius: 0.15,
      upgrade: () => undefined,
      available: () => this.group.visible,
      rows: () => [
        ['Blast', fmtDate(BREAKAWAY)],
        ['Aboard', 'Moonbase Alpha, 311'],
        ['Moon', this.since < 0 ? 'In Earth orbit' : this.since < BREAKAWAY_DAYS * 0.9 ? 'Leaving Earth' : 'Lost to deep space'],
      ],
    };
  }

  /** Where the runaway Moon is, `days` after the blast (Earth-relative). */
  private flight(days: number, out: THREE.Vector3) {
    const lon = moonLongitude(new Date(BREAKAWAY)) * DEG;
    if (days <= 0) {
      const l = moonLongitude(new Date(BREAKAWAY + days * DAY)) * DEG;
      return out.set(Math.cos(l) * this.orbit, 0, -Math.sin(l) * this.orbit).add(this.earth);
    }
    // Flung out from where it was, swinging round to head away from the Sun
    // (out toward the dark and the stars), and climbing out of the plane.
    const start = new THREE.Vector3(Math.cos(lon), 0, -Math.sin(lon));
    const away = new THREE.Vector3(this.earth.x - SUN.x, 0, this.earth.z - SUN.z).normalize();
    const heading = start.lerp(away, THREE.MathUtils.smoothstep(days, 0, 0.35));
    if (heading.lengthSq() < 1e-4) heading.copy(away); // started dead sunward
    heading.normalize();
    // Steady at first so the departure can be watched, then away for good.
    const dist = this.orbit + 3 * days + 20 * days ** 3;
    return out
      .copy(heading)
      .multiplyScalar(dist)
      .add(this.earth)
      .addScaledVector(UP, 0.8 * (dist - this.orbit));
  }

  /** Stop standing in for the Moon. */
  release() {
    this.bodies.setMoonHidden('moon', false);
  }

  update(simMs: number, dt: number, jumped: boolean) {
    const since = (simMs - BREAKAWAY) / DAY;
    this.since = since;
    this.active = since >= -0.5 && since <= BREAKAWAY_DAYS;
    const prev = this.lastSim;
    this.lastSim = simMs;
    if (prev !== null && !jumped && Math.abs(simMs - prev) < 2 * DAY) {
      if (BREAKAWAY > Math.min(prev, simMs) && BREAKAWAY <= Math.max(prev, simMs)) this.flashAge = 0;
    }
    this.flashAge += dt;
    this.time += dt;

    const show = !this.suppressed && this.active;
    this.group.visible = show || (!this.suppressed && this.flashAge < 3);
    this.bodies.setMoonHidden('moon', show);
    if (!this.group.visible) return;

    this.bodies.positionOf('earth', this.earth);
    this.flight(0, this.blastAt);
    this.flight(since, this.holder.position);
    const lon = moonLongitude(new Date(simMs)) * DEG;
    // Tidally locked until the blast; then it tumbles.
    if (since <= 0) this.moon.rotation.set(0, lon, 0);
    else this.moon.rotation.set(since * 5, lon, since * 2.2);
    this.holder.visible = since < BREAKAWAY_DAYS * 0.95;

    // The blast: a flash that plays in real time, and a shell of debris in sim time.
    const f = Math.exp(-this.flashAge * 1.2);
    this.flash.visible = f > 0.01;
    this.flash.position.copy(this.blastAt);
    this.flash.scale.setScalar(0.45 + 2.4 * Math.exp(-this.flashAge * 2.5));
    this.flash.material.opacity = f;
    const burst = since >= 0 && since < 0.6 ? since / 0.6 : -1;
    for (const d of this.debris) {
      d.sprite.visible = burst >= 0;
      if (burst < 0) continue;
      d.sprite.position.copy(this.blastAt).addScaledVector(d.dir, 0.08 + 1.6 * burst);
      d.sprite.scale.setScalar(0.03 + 0.09 * burst);
      d.sprite.material.opacity = (1 - burst) ** 2 * 0.7;
    }

    // The plume streaming behind the runaway Moon.
    const tail = new THREE.Vector3();
    this.flight(Math.max(0, since - 0.12), tail);
    const back = tail.sub(this.holder.position);
    const len = back.length();
    this.cone.visible = since > 0 && this.holder.visible && len > 0.01;
    if (this.cone.visible) {
      this.cone.position.copy(this.holder.position);
      this.cone.quaternion.setFromUnitVectors(DOWN, back.divideScalar(len));
      const width = Math.min(0.2, len * 0.25);
      this.cone.scale.set(width, len, width);
      this.cone.material.uniforms.uTime.value = this.time;
      this.cone.material.uniforms.uOpacity.value = 1.8 * Math.min(1, since / 0.05) * (1 - since / BREAKAWAY_DAYS);
    }
  }

  /** Earth, and the Moon's path as it leaves. */
  framePoints(): THREE.Vector3[] {
    this.bodies.positionOf('earth', this.earth);
    return [this.earth.clone(), this.flight(0, new THREE.Vector3()), this.flight(0.55, new THREE.Vector3())];
  }
}

// ---- Interstellar -----------------------------------------------------------------------

/**
 * The wormhole as the film shows it: a sphere. Looking into it you see
 * another galaxy, bent and flipped as through a glass ball; round its edge our
 * own sky is wrapped into a thin, bright lensing ring. Both depend on the
 * viewing direction, so the view shifts as the camera moves round it. Faint
 * wisps of light drift over the surface.
 */
class WormholeMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vN;
        varying vec3 vObj;
        void main() {
          vObj = position;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vN;
        varying vec3 vObj;

        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        // Point stars on the sky in direction d.
        vec3 stars(vec3 d, float scale, float density) {
          vec3 g = d * scale;
          vec3 c = floor(g);
          vec3 f = fract(g) - 0.5;
          float h = hash(c);
          float s = step(1.0 - density, h) * smoothstep(0.22, 0.0, length(f));
          vec3 tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash(c + 7.0));
          return tint * s * (0.5 + 0.5 * hash(c + 3.0));
        }
        // The other galaxy: a warm, mottled band with a bright core.
        vec3 galaxy(vec3 d) {
          vec3 axis = normalize(vec3(0.3, 1.0, 0.2));
          float lat = dot(d, axis);
          float band = exp(-lat * lat * 40.0);
          // Fine mottling, and a dark dust lane down the middle of the band.
          float mottle = 0.72 + 0.28 * sin(d.x * 31.0 + d.z * 17.0) * sin(d.y * 29.0 - d.x * 13.0);
          float lane = 1.0 - 0.7 * exp(-lat * lat * 900.0);
          float toCore = max(dot(d, normalize(vec3(0.8, 0.1, -0.5))), 0.0);
          float core = pow(toCore, 400.0);
          float bulge = pow(toCore, 30.0);
          return vec3(0.95, 0.72, 0.48) * band * (0.3 + 0.5 * bulge) * mottle * lane + vec3(1.0, 0.9, 0.75) * core * 1.4;
        }

        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vWorld);
          float mu = clamp(dot(N, V), 0.0, 1.0);

          // Through the throat, a fish-eye view of the far side: the whole
          // sky beyond is squeezed into the ball, and turns as you move round it.
          vec3 through = normalize(-N - V * 0.35);
          vec3 col = galaxy(through) + stars(through, 160.0, 0.05) * 1.4 + vec3(0.01, 0.01, 0.025);

          // Round the edge, our own sky wrapped into a thin bright ring.
          vec3 around = reflect(-V, N);
          float rim = pow(1.0 - mu, 6.0);
          col = mix(col, stars(around, 90.0, 0.08) * 1.6 + vec3(0.45, 0.55, 1.0) * 0.18, rim);
          col += vec3(0.9, 0.95, 1.0) * exp(-pow((mu - 0.06) / 0.04, 2.0)) * 1.1;

          // Thin streaks of light swirling slowly over the surface.
          vec3 p = normalize(vObj);
          float a = atan(p.z, p.x);
          float swirl = sin(a * 2.0 + p.y * 7.0 - uTime * 0.3);
          float streak = pow(max(swirl, 0.0), 24.0) * (0.5 + 0.5 * sin(a * 5.0 - p.y * 3.0 + uTime * 0.2));
          col += vec3(0.6, 0.72, 1.0) * streak * 0.35 * (0.25 + 0.75 * (1.0 - mu));

          gl_FragColor = vec4(col, smoothstep(0.0, 0.1, mu));
        }
      `,
    });
  }
}

class Wormhole {
  readonly anchor = new THREE.Group();
  readonly body: Body;
  private sphere = new THREE.Mesh(new THREE.SphereGeometry(0.55, 64, 48), new WormholeMaterial());
  private halo = glow(0x8fa8ff, 0.3);
  private saturn = new THREE.Vector3();

  constructor(private bodies: Bodies) {
    this.anchor.name = 'wormhole';
    this.halo.scale.setScalar(1.9);
    this.anchor.add(this.halo, this.sphere);
    const proxy = pickProxy(0.6);
    this.anchor.add(proxy);
    this.body = {
      id: WORMHOLE.id,
      facts: null,
      name: WORMHOLE.title,
      kind: WORMHOLE.source,
      blurb: WORMHOLE.blurb,
      group: this.anchor,
      pickProxy: proxy,
      radius: 0.6,
      upgrade: () => undefined,
      available: () => this.anchor.visible,
      rows: () => [
        ['Near', 'Saturn'],
        ['Leads to', 'Another galaxy'],
      ],
    };
  }

  update(elapsed: number) {
    // Keeps pace with Saturn, a little ahead of it and above the plane.
    this.bodies.positionOf('saturn', this.saturn);
    this.anchor.position.copy(this.saturn).sub(SUN).applyAxisAngle(UP, 0.24).add(SUN);
    this.anchor.position.y += 0.9;
    this.sphere.rotation.y = elapsed * 0.04;
    this.sphere.material.uniforms.uTime.value = elapsed;
    this.halo.material.opacity = 0.26 + 0.05 * Math.sin(elapsed * 0.7);
  }
}

// ---- The Hitchhiker's Guide: the demolition of Earth -----------------------------------

const HOUR = 3_600_000;
const SHIPS = 7;
const CHUNKS = 64;
const VOGON_YELLOW = new THREE.Color(0xffe27a);

/** Smooth 0→1 as `x` runs from `a` to `b`. */
const ramp = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(x, a, b);

/** A blocky Vogon constructor ship: yellow enamel slabs with a brass band, engines glowing astern. */
function vogonShip(mats: Materials, enamel: THREE.Material) {
  const ship = new THREE.Group();
  const block = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = enamel) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    ship.add(m);
  };
  block(0.22, 0.05, 0.09, 0, 0, 0);
  block(0.225, 0.008, 0.095, 0, 0.026, 0, mats.brassDark);
  block(0.14, 0.035, 0.07, -0.02, 0.046, 0);
  block(0.05, 0.03, 0.05, -0.05, 0.078, 0);
  block(0.03, 0.04, 0.012, 0.04, -0.04, 0.03);
  block(0.03, 0.04, 0.012, 0.04, -0.04, -0.03);
  for (const z of [0.022, -0.022]) {
    const engine = glow(0xfff0b0, 0.8);
    engine.scale.setScalar(0.06);
    engine.position.set(-0.115, 0, z);
    ship.add(engine);
  }
  return ship;
}

/**
 * The hyperspace bypass: a glowing lane that fades out with distance from the
 * orrery's centre, so it runs right across the table and dies away at the rim.
 */
class LaneMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0x9fd8ff) },
        uOpacity: { value: 0 },
        uRadius: { value: TABLE_RADIUS },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uRadius;
        varying vec3 vWorld;
        void main() {
          float fade = 1.0 - smoothstep(uRadius * 0.5, uRadius, length(vWorld.xz));
          float a = uOpacity * fade;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });
  }
}

/** Fades the bypass traffic the same way as the lane. */
const laneFade = (p: THREE.Vector3) => 1 - THREE.MathUtils.smoothstep(Math.hypot(p.x, p.z), TABLE_RADIUS * 0.5, TABLE_RADIUS);

/** GLSL value noise (2D and 3D) and fBm, for the explosion's shaders. */
const NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y),
      u.z);
  }
`;

const PLANE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The shockwave: a turbulent ring racing outward on a 2×2 plane. White-hot at
 * the front, cooling through orange to blue as it spreads and fades, with a
 * ragged, wobbling edge and haze trailing behind it.
 */
class ShockwaveMaterial extends THREE.ShaderMaterial {
  constructor(seed: number) {
    super({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uAge: { value: 0 }, uFront: { value: 0 }, uSeed: { value: seed } },
      vertexShader: PLANE_VERT,
      fragmentShader: /* glsl */ `
        uniform float uAge;
        uniform float uFront;
        uniform float uSeed;
        varying vec2 vUv;
        ${NOISE_GLSL}
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          vec2 dir = p / max(r, 1e-4);
          float wobble = (fbm(dir * 3.0 + uSeed) - 0.5) * 0.18 * uFront;
          float d = r - (uFront + wobble);
          float width = 0.02 + 0.1 * uAge;
          float ring = exp(-d * d / (width * width));
          float haze = d < 0.0 ? exp(d / (0.3 * uFront + 0.01)) : 0.0;
          float tex = 0.35 + fbm(p * 7.0 + vec2(uAge * 2.0, uSeed)) * 1.1;
          float heat = 1.0 - uAge;
          vec3 cool = vec3(0.35, 0.55, 1.0);
          vec3 warm = vec3(1.0, 0.5, 0.15);
          vec3 hot = vec3(1.0, 0.95, 0.8);
          vec3 col = mix(mix(cool, warm, smoothstep(0.0, 0.6, heat)), hot, smoothstep(0.65, 1.0, heat));
          float a = (ring * 1.7 + haze * 0.3) * tex * pow(1.0 - uAge, 1.3);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

/** The fireball: an expanding shell, brightest round its rim. */
class FireballMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uFade: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFade;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float mu = abs(dot(normalize(vN), normalize(vV)));
          float a = (0.25 + 0.75 * pow(1.0 - mu, 2.0)) * uFade;
          vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.75), uFade);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

/** Glowing cracks spreading over the planet in its last seconds. */
class CracksMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uIntensity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vObj;
        void main() {
          vObj = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uIntensity;
        uniform float uTime;
        varying vec3 vObj;
        ${NOISE_GLSL}
        void main() {
          vec3 p = normalize(vObj);
          float n = vnoise3(p * 5.0) * 0.6 + vnoise3(p * 11.0 + 3.1) * 0.4;
          float w = 0.012 + 0.06 * uIntensity;
          float crack = 1.0 - smoothstep(0.0, w, abs(n - 0.5));
          float flicker = 0.85 + 0.15 * sin(uTime * 23.0 + n * 40.0);
          float a = (crack * 1.6 + 0.12) * uIntensity * flicker;
          vec3 col = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.4), crack * uIntensity);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

/**
 * A demolition beam: a hot core with pulses of energy racing down toward
 * Earth, flickering, growing heavier as the moment comes. The cylinder runs
 * from the ship (v = 0) to Earth (v = 1).
 */
class BeamMaterial extends THREE.ShaderMaterial {
  constructor(seed: number, edge = new THREE.Color(1.0, 0.8, 0.35), core = new THREE.Color(1.0, 1.0, 0.92)) {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPower: { value: 0 }, uTime: { value: 0 }, uSeed: { value: seed }, uEdge: { value: edge }, uCore: { value: core } },
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
        uniform float uPower;
        uniform float uTime;
        uniform float uSeed;
        uniform vec3 uEdge;
        uniform vec3 uCore;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float core = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
          float pulses = pow(0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 14.0 + uSeed), 8.0);
          float flick = 0.8 + 0.2 * sin(uTime * 37.0 + uSeed * 3.0);
          float a = uPower * (0.3 + 0.7 * core) * (0.55 + 1.3 * pulses) * flick;
          vec3 col = mix(uEdge, uCore, core);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

const HOLO_CYAN = 'vec3(0.45, 0.9, 1.0)';

/**
 * Hologram of the planet that was: a cyan lat-long wireframe with a glowing
 * rim, drawn in from the bottom by a bright scan line, flickering.
 */
class HoloGlobeMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uReveal: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 } },
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
        uniform float uReveal;
        uniform float uOpacity;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        float gridLine(float x, float n) {
          float d = 0.5 - abs(fract(x * n) - 0.5);
          return 1.0 - smoothstep(0.0, 0.05, d);
        }
        void main() {
          if (vUv.y > uReveal) discard;
          float grid = max(gridLine(vUv.y, 12.0), gridLine(vUv.x, 24.0));
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
          float edge = exp(-pow((uReveal - vUv.y) / 0.02, 2.0)) * step(uReveal, 0.999);
          float scan = 0.85 + 0.15 * sin(vUv.y * 200.0 - uTime * 6.0);
          float flicker = 0.9 + 0.1 * sin(uTime * 41.0);
          float a = (grid * 0.8 + rim * 0.35 + edge * 1.5) * scan * flicker * uOpacity;
          vec3 col = mix(${HOLO_CYAN}, vec3(1.0), edge);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

/**
 * The survey line: a dashed holographic line marching along the route the
 * bypass will take, spreading out from Earth's position to the table's rim.
 */
class SurveyLineMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uReveal: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 }, uRadius: { value: TABLE_RADIUS } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uReveal;
        uniform float uOpacity;
        uniform float uTime;
        uniform float uRadius;
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          if (abs(vUv.y - 0.5) * 2.0 > uReveal) discard;
          float dash = step(0.45, fract(vUv.y * 160.0 - uTime * 1.5));
          float fade = 1.0 - smoothstep(uRadius * 0.5, uRadius, length(vWorld.xz));
          float a = dash * fade * uOpacity * 0.9;
          vec3 col = mix(vec3(1.0, 0.85, 0.25), ${HOLO_CYAN}, 0.35);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

/**
 * The construction sign, as a hologram: hazard stripes and lettering drawn
 * once to a canvas, shown with scanlines, flicker, an occasional glitch, and
 * wiped in from the left.
 */
class HoloSignMaterial extends THREE.ShaderMaterial {
  constructor(map: THREE.Texture) {
    super({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uMap: { value: map }, uReveal: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: PLANE_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uReveal;
        uniform float uOpacity;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          if (vUv.x > uReveal) discard;
          vec2 uv = vUv;
          // Now and then a band of the sign slips sideways.
          float glitch = step(0.93, fract(sin(floor(uTime * 7.0)) * 43758.5453));
          uv.x += glitch * 0.012 * sin(uv.y * 70.0 + uTime * 30.0);
          vec4 tex = texture2D(uMap, uv);
          float scan = 0.7 + 0.3 * sin(vUv.y * 140.0 - uTime * 5.0);
          float flicker = 0.88 + 0.12 * sin(uTime * 37.0) * sin(uTime * 13.0);
          float edge = exp(-pow((uReveal - vUv.x) / 0.015, 2.0)) * step(uReveal, 0.999);
          float a = (tex.a * scan * flicker + edge * 0.8) * uOpacity;
          vec3 col = tex.rgb + vec3(edge);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
  }
}

/** Draw the construction sign: hazard-striped frame, lettering, on a clear ground. */
function constructionSignTexture() {
  const w = 1024,
    h = 340;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // Hazard-striped frame.
  const band = 34;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.rect(band, band, w - band * 2, h - band * 2);
  ctx.clip('evenodd');
  ctx.fillStyle = '#ffcf3a';
  for (let x = -h; x < w + h; x += 56) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 28, 0);
    ctx.lineTo(x + 28 - h, h);
    ctx.lineTo(x - h, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Lettering.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#c8f6ff';
  ctx.font = '800 76px "Helvetica Neue", Arial, sans-serif';
  ctx.fillText('HYPERSPACE BYPASS', w / 2, 128);
  ctx.fillStyle = '#ffd95a';
  ctx.font = '800 56px "Helvetica Neue", Arial, sans-serif';
  ctx.fillText('UNDER CONSTRUCTION', w / 2, 214);
  ctx.fillStyle = '#8fdcff';
  ctx.font = '600 26px "Helvetica Neue", Arial, sans-serif';
  ctx.fillText('VOGON CONSTRUCTOR FLEET', w / 2, 272);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * The hitchhikers' teleport, in sim seconds from the blast: the white beam
 * comes on, two figures rise up it, arrive aboard with a flash, beam fades.
 */
const TELEPORT = { on: -21, rise: -19.5, arrive: -14, off: -12, ship: 0 };

/**
 * The departure, in minutes after VOGON.depart: the ships leave one after
 * another, the bypass fades in, and the construction hologram stutters and
 * dies, all as one moment.
 */
const LEAVING = { shipStagger: 0.4, shipTakes: 3.5, bypassFrom: 1, bypassTo: 6, siteFadeFrom: 2, siteGone: 7, paceUntil: 8 };

/** How long (real seconds) the explosion's parts play out. */
const BLAST = { shock: 3.5, echo: 2.6, fireball: 1.3, embers: 4.5 };
const EMBERS = 60;

interface Chunk {
  mesh: THREE.Mesh;
  size: number;
  /** Stretch, so pieces are shards and slabs rather than balls. */
  shape: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  spin: THREE.Vector3;
}

/**
 * THE DEMOLITION OF EARTH: design brief
 * ======================================
 * (The Hitchhiker's Guide to the Galaxy.) This is the intent, written so the
 * scene can be rebuilt from it with a better engine or more time; the code
 * below is one way of meeting it, not the definition of it.
 *
 * Aim: cinematic, not physical. On a Thursday morning you should see the
 * planet explode. The orrery's look applies: effects are light, gas and fire
 * rather than solid objects; craft are yellow-enamel-and-brass automata.
 *
 * When: every Thursday, local time, whenever fiction mode is on, including
 * when the clock is simply running in real time. Times are from VOGON in the
 * catalogue (hours after the fleet's 08:00 arrival).
 *
 *   08:00–09:30  The Vogon fleet (seven blocky yellow ships) drops out of
 *                hyperspace on golden streaks and takes up a ring formation
 *                over Earth. Arrival is staggered ship by ship.
 *   09:30–09:45  The announcement: the lead ship broadcasts to Earth (pulsing
 *                ripples toward the planet). The fleet never just sits there:
 *                the formation slowly circles Earth and closes in, lower and
 *                tighter, like a noose.
 *   09:45        Demolition beams lock on from every ship. They should feel
 *                like demolition beams: a hot core, pulses of energy racing
 *                down them toward Earth, flicker, and flares where they strike
 *                the surface.
 *   ~20 s before The hitchhikers: a bright white teleport beam shoots from
 *                Earth's surface up to one of the ships, thin, at an angle from
 *                elsewhere on the planet into the ship's underside (never along
 *                its demolition beam); two figures (Arthur
 *                and Ford) rise up it and arrive aboard with a flash; the
 *                beam fades. Just before the end, as in the book.
 *   last ~10 s   Crescendo. The beams grow heavier and pulse faster; glowing
 *                cracks spread across the planet's surface.
 *   10:00        Earth explodes:
 *                  - a big flash, and the camera shakes;
 *                  - the fleet rocks in the blast;
 *                  - a fireball shell expands for about a second;
 *                  - shockwaves race outward FAST (seconds, never minutes),
 *                    textured and turbulent rather than a plain polygon ring:
 *                    white-hot at the front, cooling through orange to blue,
 *                    ragged-edged, with haze behind; tilted off the plane for
 *                    depth;
 *                  - Earth flies apart: chunks carrying its real surface, plus
 *                    molten glowing pieces from inside, and a spray of embers.
 *                    The pieces burst out quickly, then drift and fade.
 *                The globe is hidden from 10:00; its arm and rod stay, empty.
 *                The Moon stays where it is.
 *   10:01–10:15  The construction site, while the fleet waits: a holographic
 *                cyan wireframe of the planet that was, drawn in by a scan
 *                line; a holographic HYPERSPACE BYPASS / UNDER CONSTRUCTION
 *                sign (hazard-striped, scanlines, flicker, the odd glitch)
 *                above it; a dashed survey line marching out along the future
 *                route to the rim; each ship visibly at work from the start,
 *                with a pulsing projector under its hull playing a defined
 *                beam (core and running pulses) over the hologram. The sign
 *                stays up, steady, until the fleet starts to leave.
 *   10:15        One beat: the fleet leaves the way it came, ship by ship over
 *                a few minutes (not drifting off for half an hour); the
 *                construction hologram stutters, glitches and fades out; and
 *                the hyperspace bypass fades in: a glowing lane straight through where Earth was, along its
 *                old orbit, running rim to rim across the whole orrery and
 *                fading out toward the table's edge, with traffic already on it.
 *                It has its own hover tooltip and card.
 *   12:00        Scene over: Earth is quietly back on its arm, ready for next
 *                week.
 *
 * The ships are hoverable ("Vogon Constructor Fleet") and clickable (this
 * scene's card) while they are there, real time or replay.
 *
 * Time: the explosion itself (flash, fireball, shockwaves, the pieces'
 * initial burst, embers, shake) plays in REAL seconds, triggered when the
 * clock runs forward through 10:00, so it looks the same at any speed and
 * never sits frozen on screen at real time. Everything else follows sim time,
 * so it scrubs and runs backwards. Arriving after 10:00 by a jump shows the
 * aftermath (scattered pieces, no shockwave); running backwards through 10:00
 * brings Earth back without an explosion.
 *
 * Replay (from the catalogue): jump to just before the fleet arrives, then
 * pace it like a film: brisk (10 min/s) for the arrival, easing down (1 min/s)
 * to REAL TIME for the teleport, the crescendo and the explosion, a minute a
 * second while the construction site goes up, then brisk again (10 min/s) for
 * the departure and the bypass. The camera frames Earth and the
 * fleet; after the blast it eases back to take in the shockwave spreading and
 * fading, and once the bypass opens it pulls right back to show the lane
 * crossing the whole disc. If the viewer changes the speed, or takes the
 * camera, stop steering that. When the scene ends, return to now at real time
 * and fly the camera home.
 */
class Demolition {
  readonly group = new THREE.Group();
  readonly body: Body;
  /** The bypass has its own card. */
  readonly bypassBody: Body;
  private bypassFocus = new THREE.Group();
  private bypassOpened = 0;
  suppressed = false;
  active = false;
  /** Camera shake, 0..1, decaying after the blast. */
  quake = 0;
  private ships: {
    ship: THREE.Group;
    streak: THREE.Mesh<THREE.ConeGeometry, GasConeMaterial>;
    beam: THREE.Mesh<THREE.CylinderGeometry, BeamMaterial>;
    impact: THREE.Sprite;
    /** Construction: a pulsing projector under the hull and the ray it plays on the hologram. */
    emitter: THREE.Sprite;
    ray: THREE.Mesh<THREE.CylinderGeometry, BeamMaterial>;
  }[] = [];
  /** The ships themselves can be hovered ("Vogon Constructor Fleet") and clicked for the scene's card. */
  readonly fleetBody: Body;
  private chunks: Chunk[] = [];
  private embers: { sprite: THREE.Sprite; dir: THREE.Vector3; speed: number }[] = [];
  private flash = glow(0xfff3d0);
  private shock = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new ShockwaveMaterial(1.7));
  private echo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new ShockwaveMaterial(5.3));
  private fireball = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new FireballMaterial());
  private cracks = new THREE.Mesh(new THREE.SphereGeometry(0.346, 64, 48), new CracksMaterial());
  /** The announcement: ripples broadcast from the lead ship toward Earth. */
  private ripples: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  /** The teleport: a white beam (core and glow), two hitchhikers rising up it, an arrival flash. */
  private teleCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 1, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  private teleGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 1, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xdfeaff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  private hitchhikers = [glow(0xffffff, 0), glow(0xcfe6ff, 0)];
  private arrival = glow(0xffffff, 0);
  /** The construction site: Earth's ghost, the sign, the survey line, and the ships' projector rays. */
  private ghost = new THREE.Mesh(new THREE.SphereGeometry(0.34, 48, 32), new HoloGlobeMaterial());
  private sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.43), new HoloSignMaterial(constructionSignTexture()));
  private survey = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6, 1, true), new SurveyLineMaterial());

  private lane: THREE.Mesh<THREE.CylinderGeometry, LaneMaterial>;
  private traffic: THREE.Sprite[] = [];
  private focus = new THREE.Group();
  /** Real seconds since the blast; Infinity when it wasn't seen (arrived after it, or not yet). */
  private blastAge = Infinity;
  private lastSim: number | null = null;
  private hours = -1;
  private start = 0;
  private time = 0;
  private beamClock = 0;
  private earth = new THREE.Vector3();

  constructor(
    private bodies: Bodies,
    mats: Materials,
  ) {
    this.group.name = 'vogons';
    const enamel = new THREE.MeshStandardMaterial({ color: 0xd9b43a, metalness: 0.5, roughness: 0.45 });
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    for (let i = 0; i < SHIPS; i++) {
      const ship = vogonShip(mats, enamel);
      const streak = new THREE.Mesh(CONE, new GasConeMaterial(VOGON_YELLOW));
      streak.frustumCulled = false;
      const beam = new THREE.Mesh(beamGeo, new BeamMaterial(i * 1.9));
      beam.frustumCulled = false;
      const impact = glow(0xfff0c0, 0);
      const emitter = glow(0x8fefff, 0);
      emitter.position.set(0, -0.045, 0);
      ship.add(emitter);
      const ray = new THREE.Mesh(beamGeo, new BeamMaterial(i * 2.7, new THREE.Color(0.3, 0.75, 1.0), new THREE.Color(0.85, 1.0, 1.0)));
      ray.frustumCulled = false;
      ship.add(pickProxy(0.17));
      this.ships.push({ ship, streak, beam, impact, emitter, ray });
      this.group.add(ship, streak, beam, impact, ray);
    }

    // The pieces: Earth's own surface, and molten rock from inside.
    const surface = new THREE.MeshStandardMaterial({ roughness: 1, envMapIntensity: 0, flatShading: true });
    new ProgressiveTexture('earth', (t) => ((surface.map = t), (surface.needsUpdate = true))).start('2k');
    sunlit(surface);
    const molten = new THREE.MeshStandardMaterial({ color: 0x5a1e0a, emissive: 0xff5a14, emissiveIntensity: 0.8, roughness: 1, flatShading: true });
    const chunkGeo = new THREE.IcosahedronGeometry(1, 0);
    for (let i = 0; i < CHUNKS; i++) {
      const hot = i % 5 === 0;
      const mesh = new THREE.Mesh(chunkGeo, hot ? molten : surface);
      mesh.visible = false;
      const r = () => 0.45 + Math.random() * 0.9;
      this.chunks.push({
        mesh,
        size: (hot ? 0.015 : 0.02) + Math.random() * 0.04,
        shape: new THREE.Vector3(r(), r() * 0.6, r()),
        dir: new THREE.Vector3().randomDirection(),
        speed: 0.5 + Math.random() * 0.9,
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4),
      });
      this.group.add(mesh);
    }
    for (let i = 0; i < EMBERS; i++) {
      const sprite = glow(i % 3 ? 0xff8a30 : 0xffe0a0, 0);
      this.embers.push({ sprite, dir: new THREE.Vector3().randomDirection(), speed: 1 + Math.random() * 2 });
      this.group.add(sprite);
    }

    // Shockwaves lie a little off the plane, at different tilts, for depth.
    this.shock.rotation.set(-Math.PI / 2 + 0.28, 0, 0.2);
    this.echo.rotation.set(-Math.PI / 2 - 0.35, 0.3, 0);
    this.shock.frustumCulled = this.echo.frustumCulled = false;
    this.cracks.renderOrder = 2;

    // The hyperspace bypass, with traffic already using it.
    this.lane = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 1, 10, 1, true), new LaneMaterial());
    this.lane.frustumCulled = false;
    for (let i = 0; i < 14; i++) {
      const car = glow(0xd8f0ff, 0);
      car.scale.setScalar(0.07);
      this.traffic.push(car);
      this.group.add(car);
    }
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 48),
        new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.ripples.push(ring);
      this.group.add(ring);
    }
    this.teleCore.frustumCulled = this.teleGlow.frustumCulled = false;
    this.group.add(this.teleGlow, this.teleCore, ...this.hitchhikers, this.arrival);
    for (const m of [this.ghost, this.sign, this.survey]) m.frustumCulled = false;
    this.group.add(this.ghost, this.survey, this.sign);
    this.group.add(this.flash, this.shock, this.echo, this.fireball, this.cracks, this.lane, this.focus, this.bypassFocus);

    // A generous invisible sleeve along the lane, so it can be hovered and clicked anywhere.
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1, 8, 1, true), new THREE.MeshBasicMaterial({ visible: false }));
    this.lane.add(sleeve);
    this.bypassBody = {
      id: 'bypass',
      facts: null,
      name: 'Hyperspace Express Route',
      kind: VOGON_DEMOLITION.source,
      blurb:
        'The reason Earth had to go: a hyperspace express route, built straight through where the planet used to be. ' +
        'On this orrery it runs from rim to rim across the table, and the traffic is already using it.',
      group: this.bypassFocus,
      pickProxy: sleeve,
      radius: 2,
      upgrade: () => undefined,
      available: () => this.group.visible && this.lane.visible,
      rows: () => [
        ['Built by', 'Vogon Constructor Fleet'],
        ['Opened', new Date(this.bypassOpened).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })],
        ['Through', 'Where Earth was'],
        ['Traffic', 'Already heavy'],
      ],
    };

    const proxy = pickProxy(0.5);
    this.focus.add(proxy);
    this.body = {
      id: VOGON_DEMOLITION.id,
      facts: null,
      name: VOGON_DEMOLITION.title,
      kind: VOGON_DEMOLITION.source,
      blurb: VOGON_DEMOLITION.blurb,
      group: this.focus,
      pickProxy: proxy,
      radius: 0.8,
      upgrade: () => undefined,
      available: () => this.group.visible,
      rows: () => this.rows(),
    };
    const shipProxies = this.ships.map(({ ship }) => ship.children[ship.children.length - 1] as THREE.Mesh);
    this.fleetBody = {
      ...this.body,
      id: 'vogon-fleet',
      hoverLabel: 'Vogon Constructor Fleet',
      pickProxy: shipProxies[0],
      extraProxies: shipProxies.slice(1),
    };
  }

  /**
   * Where ship `i` sits in the formation over Earth at `h` hours into the
   * scene. Once in place the formation slowly circles the planet, and through
   * the announcement it closes in, lower and tighter, until the beams lock on.
   */
  private station(i: number, out: THREE.Vector3, h = 0) {
    const circling = Math.max(0, h - VOGON.inPlace) * 0.9;
    const close = ramp(h, VOGON.inPlace, VOGON.beams);
    const a = (i / SHIPS) * Math.PI * 2 + 0.3 + circling;
    const radius = 1.05 - 0.15 * close;
    const height = 0.55 - 0.15 * close + 0.12 * Math.sin(i * 2.1);
    return out.set(Math.cos(a) * radius, height, Math.sin(a) * radius).add(this.earth);
  }

  /** Give the real Earth back. */
  release() {
    this.bodies.setPlanetHidden('earth', false);
  }

  /**
   * Replay speed (sim seconds per second) for the scene at `simMs`: brisk for
   * the fleet's arrival, easing to real time for the explosion, then brisk
   * again for the departure and the bypass.
   */
  pace(simMs: number): number {
    const t = (simMs - (vogonOccurrence(simMs) + VOGON.demolish * HOUR)) / 1000;
    if (t < -150) return 600;
    if (t < -22) return 60;
    if (t < 8) return 1;
    // A minute a second while the construction site goes up and the fleet leaves.
    if (t < (VOGON.depart - VOGON.demolish) * 3600 + LEAVING.paceUntil * 60) return 60;
    return 600;
  }

  update(simMs: number, dt: number, jumped: boolean, camera: THREE.Camera) {
    const start = vogonOccurrence(simMs);
    const h = (simMs - start) / HOUR;
    const blast = start + VOGON.demolish * HOUR;
    /** Sim seconds from the blast (negative before). */
    const toBlast = (simMs - blast) / 1000;
    this.start = start;
    this.hours = h;
    this.active = h >= 0 && h <= VOGON.end;
    this.time += dt;

    // Going forward through ten o'clock (not by a jump) sets it off.
    const prev = this.lastSim;
    this.lastSim = simMs;
    if (prev !== null && !jumped && simMs > prev && simMs - prev < 2 * DAY && blast > prev && blast <= simMs) {
      this.blastAge = 0;
      this.quake = 1;
    } else if (toBlast < 0) {
      this.blastAge = Infinity;
    }
    this.blastAge += dt;
    this.quake = Math.max(0, this.quake - dt * 0.7);
    const age = this.blastAge;
    const seen = Number.isFinite(age);

    const show = !this.suppressed && this.active;
    this.group.visible = show || (!this.suppressed && seen && age < BLAST.embers);
    this.bodies.setPlanetHidden('earth', show && toBlast >= 0);
    if (!this.group.visible) {
      this.quake = 0;
      return;
    }

    this.bodies.positionOf('earth', this.earth);
    this.focus.position.copy(this.earth);
    const spot = new THREE.Vector3();
    const dir = new THREE.Vector3();

    // Beams: lock on at 09:45, build to a crescendo in the last seconds, cut at the blast.
    const crescendo = ramp(toBlast, -10, 0);
    const power = toBlast < 0 ? ramp(h, VOGON.beams, VOGON.demolish - 0.05) * (0.7 + 0.6 * crescendo) : 0;
    this.beamClock += dt * (1 + 2.5 * crescendo);

    // The fleet: down out of hyperspace, hold station, beams, and away again.
    this.ships.forEach(({ ship, streak, beam, impact }, i) => {
      const lag = i * 0.08;
      const arrive = ramp(h, lag, VOGON.inPlace - 0.4 + lag);
      const goes = VOGON.depart + (i * LEAVING.shipStagger) / 60;
      const leave = ramp(h, goes, goes + LEAVING.shipTakes / 60);
      ship.visible = this.active && arrive > 0 && leave < 1;
      streak.visible = beam.visible = impact.visible = false;
      if (!ship.visible) return;
      this.station(i, spot, h);
      const rise = 8 * ((1 - arrive) ** 2 + leave ** 2);
      // The blast rocks the fleet.
      const rock = seen ? Math.exp(-age * 1.5) * 0.06 * Math.sin(age * 18 + i) : 0;
      ship.position.copy(spot).addScaledVector(UP, rise + 0.015 * Math.sin(this.time * 0.8 + i) + rock);
      ship.lookAt(this.earth.x, ship.position.y, this.earth.z);
      ship.rotateY(-Math.PI / 2);

      // Hyperspace streak while moving fast.
      const moving = Math.max(1 - arrive, leave);
      if (moving > 0.02) {
        streak.visible = true;
        streak.position.copy(ship.position);
        streak.quaternion.setFromUnitVectors(DOWN, UP);
        const len = 0.3 + 2.5 * moving;
        streak.scale.set(0.06, len, 0.06);
        streak.material.uniforms.uOpacity.value = 1.6 * moving;
        streak.material.uniforms.uTime.value = this.time;
      }

      if (power > 0.01) {
        beam.visible = impact.visible = true;
        dir.copy(this.earth).sub(ship.position);
        const len = dir.length();
        dir.divideScalar(len);
        beam.position.copy(ship.position).addScaledVector(dir, len / 2);
        beam.quaternion.setFromUnitVectors(UP, dir);
        const w = 0.008 + 0.02 * power;
        beam.scale.set(w, len, w);
        beam.material.uniforms.uPower.value = power;
        beam.material.uniforms.uTime.value = this.beamClock;
        // A flare where the beam strikes the surface.
        impact.position.copy(this.earth).addScaledVector(dir, -0.35);
        const flare = 0.7 + 0.3 * Math.sin(this.time * 31 + i * 2.3);
        impact.scale.setScalar((0.08 + 0.14 * power) * flare);
        impact.material.opacity = Math.min(1, power) * flare;
      }
    });

    // Cracks glowing across the planet in its last seconds.
    this.cracks.visible = toBlast < 0 && crescendo > 0;
    if (this.cracks.visible) {
      this.cracks.position.copy(this.earth);
      this.cracks.material.uniforms.uIntensity.value = crescendo;
      this.cracks.material.uniforms.uTime.value = this.time;
    }

    // The announcement: the lead ship broadcasts to Earth, ripples pulsing
    // out toward the planet (in real time, so they pulse at any speed).
    const lead = this.ships[0].ship;
    const announcing = this.active && lead.visible && h >= VOGON.inPlace && h < VOGON.beams;
    this.ripples.forEach((ring, k) => {
      ring.visible = announcing;
      if (!announcing) return;
      const u = (this.time * 0.6 + k / this.ripples.length) % 1;
      ring.position.lerpVectors(lead.position, this.earth, u * 0.7);
      ring.lookAt(this.earth);
      ring.scale.setScalar(0.06 + 0.3 * u);
      ring.material.opacity = Math.sin(Math.PI * u) * 0.7;
    });

    // The hitchhikers: just before the end, a white teleport beam lifts two
    // figures from Earth to one of the ships.
    const tp = this.ships[TELEPORT.ship].ship;
    const beamOn = toBlast < 0 && tp.visible ? ramp(toBlast, TELEPORT.on, TELEPORT.on + 1) * (1 - ramp(toBlast, TELEPORT.arrive, TELEPORT.off)) : 0;
    this.teleCore.visible = this.teleGlow.visible = beamOn > 0.01;
    if (this.teleCore.visible) {
      // Up at an angle from elsewhere on Earth (well clear of this ship's
      // demolition beam) into the underside of the ship.
      // Of the two sides of the ship, use the one facing the camera, so it's seen.
      const toShip = tp.position.clone().sub(this.earth).normalize();
      const toCamera = camera.position.clone().sub(this.earth).normalize();
      const sides = [1.0, -1.0].map((turn) => toShip.clone().applyAxisAngle(UP, turn).addScaledVector(UP, -0.25).normalize());
      const footDir = sides[0].dot(toCamera) >= sides[1].dot(toCamera) ? sides[0] : sides[1];
      const foot = this.earth.clone().addScaledVector(footDir, 0.34);
      const hatch = tp.position.clone().addScaledVector(UP, -0.03);
      dir.copy(hatch).sub(foot);
      const len = dir.length();
      dir.divideScalar(len);
      for (const m of [this.teleCore, this.teleGlow]) {
        m.position.lerpVectors(foot, hatch, 0.5);
        m.quaternion.setFromUnitVectors(UP, dir);
        m.scale.set(1, len, 1);
      }
      const shimmer = 0.85 + 0.15 * Math.sin(this.time * 25);
      this.teleCore.material.opacity = beamOn * shimmer;
      this.teleGlow.material.opacity = beamOn * 0.35 * shimmer;
      this.hitchhikers.forEach((s, k) => {
        const u = THREE.MathUtils.clamp((toBlast - TELEPORT.rise - k * 0.6) / (TELEPORT.arrive - TELEPORT.rise - 0.6), 0, 1);
        s.visible = u > 0 && u < 1;
        if (!s.visible) return;
        s.position.lerpVectors(foot, hatch, u * u * (3 - 2 * u));
        s.position.addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x).normalize(), (k ? 1 : -1) * 0.008);
        s.scale.setScalar(0.05 * (0.8 + 0.2 * Math.sin(this.time * 30 + k * 2)));
        s.material.opacity = 1;
      });
    } else {
      this.hitchhikers.forEach((s) => (s.visible = false));
    }
    const sinceArrive = toBlast - TELEPORT.arrive;
    this.arrival.visible = toBlast < 0 && tp.visible && sinceArrive >= 0 && sinceArrive < 3;
    if (this.arrival.visible) {
      this.arrival.position.copy(tp.position).addScaledVector(UP, -0.03);
      this.arrival.scale.setScalar(0.15 + 0.35 * Math.exp(-sinceArrive * 2));
      this.arrival.material.opacity = Math.exp(-sinceArrive * 1.5);
    }

    // The explosion, in real time: flash, fireball, two shockwaves, embers.
    const f = seen ? Math.exp(-age * 1.4) : 0;
    this.flash.visible = f > 0.01;
    this.flash.position.copy(this.earth);
    this.flash.scale.setScalar(1 + 4.5 * Math.exp(-age * 2.2));
    this.flash.material.opacity = f;

    const fb = age / BLAST.fireball;
    this.fireball.visible = fb < 1;
    if (this.fireball.visible) {
      this.fireball.position.copy(this.earth);
      this.fireball.scale.setScalar(0.36 + 1.1 * (1 - (1 - fb) ** 3));
      this.fireball.material.uniforms.uFade.value = (1 - fb) ** 2;
    }
    for (const [mesh, life, reach, delay] of [
      [this.shock, BLAST.shock, 3.4, 0],
      [this.echo, BLAST.echo, 2.3, 0.25],
    ] as const) {
      const u = (age - delay) / life;
      mesh.visible = u >= 0 && u < 1;
      if (!mesh.visible) continue;
      mesh.position.copy(this.earth);
      mesh.scale.setScalar(reach);
      mesh.material.uniforms.uAge.value = u;
      mesh.material.uniforms.uFront.value = 1 - (1 - u) ** 3;
    }
    const e = age / BLAST.embers;
    for (const em of this.embers) {
      em.sprite.visible = e < 1;
      if (e >= 1) continue;
      em.sprite.position.copy(this.earth).addScaledVector(em.dir, 0.3 + em.speed * (1 - Math.exp(-age * 1.3)) * 1.1);
      em.sprite.scale.setScalar(0.05 * (1 - e) + 0.01);
      em.sprite.material.opacity = (1 - e) ** 1.5;
    }

    // The pieces: a fast burst (real time, if it was seen), then a slow drift and fade (sim time).
    const hoursSince = h - VOGON.demolish;
    const scatter = toBlast >= 0 && this.active;
    const burst = 1 - Math.exp(-(seen ? age : 99) * 0.9);
    const fade = 1 - ramp(hoursSince, 1.2, VOGON.end - VOGON.demolish);
    for (const c of this.chunks) {
      c.mesh.visible = scatter && fade > 0.02;
      if (!c.mesh.visible) continue;
      const out = 0.22 + c.speed * (1.1 * burst + 0.12 * hoursSince);
      c.mesh.position.copy(this.earth).addScaledVector(c.dir, out);
      const turn = Math.min(seen ? age : 30, 30) * 0.4 + hoursSince * 3;
      c.mesh.rotation.set(c.spin.x * turn, c.spin.y * turn, c.spin.z * turn);
      c.mesh.scale.copy(c.shape).multiplyScalar(c.size * fade);
    }

    // The construction site, while the fleet waits: Earth's ghost drawn in,
    // the sign wiped in above it, the survey line spreading along the route,
    // all fading as the real bypass opens.
    const min = 1 / 60;
    const d0 = VOGON.demolish;
    // Steady until the fleet starts to go; then it stutters, dropping out more
    // and more, and fades as the ships leave and the bypass comes in.
    const dying = ramp(h, VOGON.depart, VOGON.depart + LEAVING.siteGone * min);
    const fadeOut = 1 - ramp(h, VOGON.depart + LEAVING.siteFadeFrom * min, VOGON.depart + LEAVING.siteGone * min);
    const stutter = dying > 0 && Math.sin(this.time * 53) * Math.sin(this.time * 17.3) > 0.7 - 1.2 * dying ? 0.12 : 1;
    const site = this.active ? fadeOut * stutter : 0;
    const globe = ramp(h, d0 + 1 * min, d0 + 5 * min);
    const signIn = ramp(h, d0 + 3 * min, d0 + 6 * min);
    const surveyIn = ramp(h, d0 + 5 * min, d0 + 11 * min);
    this.ghost.visible = site > 0 && globe > 0;
    this.sign.visible = site > 0 && signIn > 0;
    this.survey.visible = site > 0 && surveyIn > 0;
    // Projectors come on a little before the hologram starts to appear, so
    // the ships are visibly at work from the first moment.
    const projecting = this.active && h >= d0 + 0.5 * min && h < VOGON.depart ? site * ramp(h, d0 + 0.5 * min, d0 + 1.5 * min) : 0;
    if (this.ghost.visible) {
      this.ghost.position.copy(this.earth);
      this.ghost.rotation.y = this.time * 0.15;
      this.ghost.material.uniforms.uReveal.value = globe;
      this.ghost.material.uniforms.uOpacity.value = site;
      this.ghost.material.uniforms.uTime.value = this.time;
    }
    if (this.sign.visible) {
      this.sign.position.copy(this.earth).addScaledVector(UP, 0.72);
      this.sign.quaternion.copy(camera.quaternion);
      this.sign.material.uniforms.uReveal.value = signIn;
      this.sign.material.uniforms.uOpacity.value = site;
      this.sign.material.uniforms.uTime.value = this.time;
    }
    if (this.survey.visible) {
      const tangent = new THREE.Vector3(-(this.earth.z - SUN.z), 0, this.earth.x - SUN.x).normalize();
      const fromCentre = Math.hypot(this.earth.x - SUN.x, this.earth.z - SUN.z);
      const length = 2 * Math.sqrt(Math.max(1, TABLE_RADIUS ** 2 - fromCentre ** 2));
      this.survey.position.copy(this.earth);
      this.survey.quaternion.setFromUnitVectors(UP, tangent);
      this.survey.scale.set(1, length, 1);
      this.survey.material.uniforms.uReveal.value = surveyIn;
      this.survey.material.uniforms.uOpacity.value = site;
      this.survey.material.uniforms.uTime.value = this.time;
    }
    // Each ship's projector pulses under its hull and plays a ray over the
    // hologram, sweeping across it.
    const side = new THREE.Vector3();
    const target = new THREE.Vector3();
    this.ships.forEach(({ ship, emitter, ray }, i) => {
      const on = ship.visible && projecting > 0.01;
      emitter.visible = ray.visible = on;
      if (!on) return;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 6 + i * 1.3);
      emitter.scale.setScalar(0.07 + 0.06 * pulse);
      emitter.material.opacity = projecting * (0.55 + 0.45 * pulse);
      dir.copy(ship.position).sub(this.earth).normalize();
      side.set(-dir.z, 0, dir.x).normalize();
      target
        .copy(dir)
        .addScaledVector(side, 0.5 * Math.sin(this.time * 1.3 + i * 1.7))
        .addScaledVector(UP, 0.4 * Math.cos(this.time * 0.9 + i))
        .normalize()
        .multiplyScalar(0.34)
        .add(this.earth);
      const from = emitter.getWorldPosition(spot);
      const along = target.sub(from);
      const len = along.length();
      along.divideScalar(len);
      ray.position.copy(from).addScaledVector(along, len / 2);
      ray.quaternion.setFromUnitVectors(UP, along);
      ray.scale.set(0.006, len, 0.006);
      ray.material.uniforms.uPower.value = projecting * 0.9;
      ray.material.uniforms.uTime.value = this.time;
    });

    // The bypass: a straight lane through where Earth was, along its old
    // orbit, right across the orrery; traffic already on it.
    const open = this.active ? ramp(h, VOGON.depart + LEAVING.bypassFrom / 60, VOGON.depart + LEAVING.bypassTo / 60) : 0;
    this.lane.visible = open > 0;
    this.traffic.forEach((t) => (t.visible = open > 0));
    if (open > 0) {
      const tangent = new THREE.Vector3(-(this.earth.z - SUN.z), 0, this.earth.x - SUN.x).normalize();
      // Earth is the lane's nearest point to the centre, so it sits midway.
      const fromCentre = Math.hypot(this.earth.x - SUN.x, this.earth.z - SUN.z);
      const length = 2 * Math.sqrt(Math.max(1, TABLE_RADIUS ** 2 - fromCentre ** 2));
      this.lane.position.copy(this.earth);
      this.bypassFocus.position.copy(this.earth);
      this.bypassOpened = this.start + VOGON.depart * HOUR;
      this.lane.quaternion.setFromUnitVectors(UP, tangent);
      this.lane.scale.set(1, length, 1);
      this.lane.material.uniforms.uOpacity.value = open * (0.6 + 0.1 * Math.sin(this.time * 2));
      this.traffic.forEach((t, i) => {
        const u = ((this.time * 0.05 + i / this.traffic.length) % 1) - 0.5;
        t.position.copy(this.earth).addScaledVector(tangent, u * length);
        t.material.opacity = open * 0.9 * laneFade(t.position);
      });
    }
  }

  private rows(): [string, string][] {
    const h = this.hours;
    const when = (hours: number) =>
      new Date(this.start + hours * HOUR).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (!this.active) return [['Next demolition', when(VOGON.demolish)]];
    const toBlast = (h - VOGON.demolish) * 3600;
    const status =
      h < VOGON.inPlace
        ? 'Fleet arriving'
        : h < VOGON.beams
          ? 'Announcing'
          : toBlast < TELEPORT.arrive
            ? 'Beams locked on'
            : h < VOGON.demolish
              ? 'Two hitchhikers aboard'
              : h < VOGON.demolish + 1 / 60
                ? 'Demolished'
                : h < VOGON.depart
                  ? 'Bypass under construction'
                  : 'Bypass open';
    return [
      ['Demolition', when(VOGON.demolish)],
      ['Status', status],
      ['Earth back', when(VOGON.end)],
    ];
  }

  /**
   * Camera beats for the replay: after the blast, ease out to take in the
   * shockwave spreading and fading; once the bypass opens, pull right back to
   * show it crossing the whole orrery. Null while the opening framing holds.
   */
  beat(simMs: number): { key: string; points: THREE.Vector3[]; duration: number } | null {
    const start = vogonOccurrence(simMs);
    const h = (simMs - start) / HOUR;
    this.bodies.positionOf('earth', this.earth);
    if (h >= VOGON.depart + LEAVING.bypassFrom / 60) {
      const tangent = new THREE.Vector3(-(this.earth.z - SUN.z), 0, this.earth.x - SUN.x).normalize();
      const fromCentre = Math.hypot(this.earth.x - SUN.x, this.earth.z - SUN.z);
      const half = Math.sqrt(Math.max(1, TABLE_RADIUS ** 2 - fromCentre ** 2)) * 0.8;
      return {
        key: 'bypass',
        points: [this.earth.clone().addScaledVector(tangent, half), this.earth.clone().addScaledVector(tangent, -half), this.earth.clone()],
        duration: 3,
      };
    }
    if (simMs >= start + VOGON.demolish * HOUR && this.blastAge > 0.5) {
      const r = 3.4;
      return {
        key: 'shock',
        points: [
          this.earth.clone().add(new THREE.Vector3(r, 0, 0)),
          this.earth.clone().add(new THREE.Vector3(-r, 0, 0)),
          this.earth.clone().add(new THREE.Vector3(0, 0, r)),
          this.earth.clone().add(new THREE.Vector3(0, 0, -r)),
        ],
        duration: 2.5,
      };
    }
    return null;
  }

  /** Earth and the fleet's formation round it. */
  framePoints(): THREE.Vector3[] {
    this.bodies.positionOf('earth', this.earth);
    const pts = [this.earth.clone(), this.earth.clone().addScaledVector(UP, 1.2)];
    for (let i = 0; i < SHIPS; i++) pts.push(this.station(i, new THREE.Vector3()));
    return pts;
  }
}

// ---- Project Hail Mary: the Petrova line --------------------------------------------------

const ASTROPHAGE = 600;

/**
 * Astrophage in transit: points flowing between two ends, half outbound and
 * half returning, fanning out toward Venus. Positions are worked out in the
 * shader from the two ends, so the stream follows Venus round its orbit.
 */
class AstrophageMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uFrom: { value: new THREE.Vector3() },
        uTo: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uScale: { value: 110 },
        uColor: { value: new THREE.Color(0xff3b2e) },
      },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute float aDir;
        attribute vec3 aSeed;
        uniform vec3 uFrom;
        uniform vec3 uTo;
        uniform float uTime;
        uniform float uScale;
        varying float vA;
        void main() {
          float t = fract(aT + uTime * 0.035 * aDir);
          vec3 p = uFrom + (uTo - uFrom) * t + aSeed * (0.03 + 0.22 * t * t);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * (0.6 + 0.4 * fract(aT * 7.31)) / -mv.z;
          vA = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.9, t);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = pow(smoothstep(0.5, 0.0, d), 1.5) * vA * 0.6;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });
  }
}

class PetrovaLine {
  readonly object = new THREE.Group();
  readonly body: Body;
  private mat = new AstrophageMaterial();
  private haze = glow(0xff4a35, 0.2);
  private sleeve: THREE.Mesh;
  /** A faint continuous glow along the line, under the particles. */
  private core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 1, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff3b2e, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  private mid = new THREE.Group();
  private venus = new THREE.Vector3();
  private from = new THREE.Vector3();

  constructor(private bodies: Bodies) {
    this.object.name = PETROVA_LINE.id;
    const geo = new THREE.BufferGeometry();
    const t = new Float32Array(ASTROPHAGE);
    const dir = new Float32Array(ASTROPHAGE);
    const seed = new Float32Array(ASTROPHAGE * 3);
    for (let i = 0; i < ASTROPHAGE; i++) {
      t[i] = Math.random();
      dir[i] = i % 2 ? 1 : -1;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(Math.random());
      // The two flows keep slightly apart, so the line has a little body.
      v.y += dir[i] * 0.15;
      seed.set([v.x, v.y, v.z], i * 3);
    }
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ASTROPHAGE * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const points = new THREE.Points(geo, this.mat);
    points.frustumCulled = false;

    // An invisible sleeve along the line for hovering and clicking.
    this.sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1, 8, 1, true), new THREE.MeshBasicMaterial({ visible: false }));
    this.haze.scale.setScalar(1.2);
    this.object.add(this.core, points, this.haze, this.sleeve, this.mid);
    this.body = {
      id: PETROVA_LINE.id,
      facts: null,
      name: PETROVA_LINE.title,
      kind: PETROVA_LINE.source,
      blurb: PETROVA_LINE.blurb,
      group: this.mid,
      pickProxy: this.sleeve,
      radius: 1,
      upgrade: () => undefined,
      available: () => this.object.visible,
      rows: () => [
        ['From', 'The Sun'],
        ['To', 'Venus'],
        ['Seen in', 'Infrared'],
        ['The Sun', 'Slowly dimming'],
      ],
    };
  }

  update(elapsed: number) {
    this.bodies.positionOf('venus', this.venus);
    const axis = this.venus.clone().sub(SUN);
    const len = axis.length();
    axis.divideScalar(len);
    // Leave from the Sun's surface, not its centre.
    this.from.copy(SUN).addScaledVector(axis, SUN_RADIUS * 1.02);
    this.mat.uniforms.uFrom.value.copy(this.from);
    this.mat.uniforms.uTo.value.copy(this.venus);
    this.mat.uniforms.uTime.value = elapsed;
    const span = len - SUN_RADIUS;
    this.mid.position.copy(this.from).addScaledVector(axis, span / 2);
    this.sleeve.position.copy(this.mid.position);
    this.sleeve.quaternion.setFromUnitVectors(UP, axis);
    this.sleeve.scale.set(1, span, 1);
    this.core.position.copy(this.mid.position);
    this.core.quaternion.copy(this.sleeve.quaternion);
    this.core.scale.set(1, span, 1);
    this.core.material.opacity = 0.12 + 0.03 * Math.sin(elapsed * 1.7);
    // Breeding haze round Venus.
    this.haze.position.copy(this.venus);
    this.haze.material.opacity = 0.16 + 0.06 * Math.sin(elapsed * 0.9);
  }
}

// ---- The Expanse --------------------------------------------------------------------------

const xyz = { x: 0, y: 0, z: 0 };

/** A faint line round a real orbit, like Pluto's. */
function orbitLine(o: CometElements) {
  const pts = sampleOrbit(o.q / (1 - o.e), o.e, o.i, o.node, o.argPeri, 256).map((p) => {
    toWorld(p.x, p.y, p.z, xyz);
    return new THREE.Vector3(xyz.x, xyz.y, xyz.z);
  });
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.16, depthWrite: false }),
  );
}

/** World position of a body on a real orbit at `simMs`; returns its distance from the Sun (AU). */
function placeOnOrbit(o: CometElements, simMs: number, out: THREE.Vector3) {
  const p = cometPosition(o, new Date(simMs));
  toWorld(p.x, p.y, p.z, xyz);
  out.set(xyz.x, xyz.y, xyz.z);
  return p.r;
}

/** An Expanse place: everything it draws, the part that moves (camera target) and its card. */
abstract class ExpansePlace {
  readonly object = new THREE.Group();
  readonly anchor = new THREE.Group();
  body!: Body;
  protected sunDistance = 0;

  constructor(protected entry: FictionEntry) {
    this.object.name = entry.id;
    this.object.add(this.anchor);
  }

  protected makeBody(proxyRadius: number, radius: number, rows: () => [string, string][]) {
    const proxy = pickProxy(proxyRadius);
    this.anchor.add(proxy);
    this.body = {
      id: this.entry.id,
      facts: null,
      name: this.entry.title,
      kind: this.entry.source,
      blurb: this.entry.blurb,
      group: this.anchor,
      pickProxy: proxy,
      radius,
      upgrade: () => undefined,
      available: () => this.object.visible,
      rows,
    };
  }

  abstract update(simMs: number, elapsed: number): void;
}

/** Ceres, hollowed and spun up: a docking spindle through its poles, city lights across its face. */
class CeresStationPlace extends ExpansePlace {
  private spin = new THREE.Group();

  constructor(mats: Materials) {
    super(CERES_STATION);
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0 });
    new ProgressiveTexture('ceres', (t) => ((mat.map = t), (mat.needsUpdate = true)), THREE.SRGBColorSpace, false).start('1k');
    sunlit(mat);
    this.spin.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 48, 32), mat));
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 8), mats.brass);
    this.spin.add(spindle);
    for (const y of [0.19, -0.19]) {
      const dock = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.005, 6, 20), mats.brassDark);
      dock.rotation.x = Math.PI / 2;
      dock.position.y = y;
      this.spin.add(dock);
    }
    for (let i = 0; i < 36; i++) {
      const light = glow(0xffd27a, 0.7);
      light.scale.setScalar(0.016 + Math.random() * 0.01);
      light.position.copy(new THREE.Vector3().randomDirection()).multiplyScalar(0.143);
      this.spin.add(light);
    }
    this.anchor.add(this.spin);
    this.object.add(orbitLine(CERES_ORBIT));
    this.makeBody(0.3, 0.15, () => [
      ['Orbits', 'The Sun, in the Belt'],
      ['From Sun', `${this.sunDistance.toFixed(2)} AU`],
      ['Port of', 'The Belt'],
    ]);
  }

  update(simMs: number, elapsed: number) {
    this.sunDistance = placeOnOrbit(CERES_ORBIT, simMs, this.anchor.position);
    this.spin.rotation.y = elapsed * 0.15;
  }
}

/** Eros: a lumpy rock, its surface lit from within by blue protomolecule glow. */
class ErosPlace extends ExpansePlace {
  private rock: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private glows: THREE.Sprite[] = [];

  constructor() {
    super(EROS);
    const geo = new THREE.IcosahedronGeometry(1, 3);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const bump = 1 + 0.12 * Math.sin(v.x * 5 + v.y * 3) * Math.cos(v.z * 4 - v.x * 2) + 0.06 * Math.sin(v.y * 11 + v.z * 7);
      v.multiplyScalar(bump);
      pos.setXYZ(i, v.x * 0.12, v.y * 0.05, v.z * 0.055);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x7d6a58, roughness: 1, envMapIntensity: 0, emissive: 0x2a6bff, emissiveIntensity: 0.05 });
    sunlit(mat);
    this.rock = new THREE.Mesh(geo, mat);
    this.anchor.add(this.rock);
    for (let i = 0; i < 9; i++) {
      const g = glow(0x5aa8ff, 0);
      g.scale.setScalar(0.04 + Math.random() * 0.04);
      const d = new THREE.Vector3().randomDirection();
      g.position.set(d.x * 0.12, d.y * 0.05, d.z * 0.055);
      this.glows.push(g);
      this.rock.add(g);
    }
    this.object.add(orbitLine(EROS_ORBIT));
    this.makeBody(0.25, 0.12, () => [
      ['Orbit', 'Crosses Mars’s'],
      ['From Sun', `${this.sunDistance.toFixed(2)} AU`],
      ['Infected by', 'The protomolecule'],
    ]);
  }

  update(simMs: number, elapsed: number) {
    this.sunDistance = placeOnOrbit(EROS_ORBIT, simMs, this.anchor.position);
    this.rock.rotation.set(0.4, 0, elapsed * 0.3);
    this.rock.material.emissiveIntensity = 0.05 + 0.04 * Math.sin(elapsed * 1.3);
    this.glows.forEach((g, i) => (g.material.opacity = 0.35 + 0.35 * Math.sin(elapsed * (0.9 + i * 0.13) + i * 2)));
  }
}

/** Tycho Station: a brass hub, a spinning habitat ring on spokes, booms holding a hull. */
class TychoStationPlace extends ExpansePlace {
  private ring = new THREE.Group();
  private sparks: THREE.Sprite[] = [];

  constructor(mats: Materials) {
    super(TYCHO_STATION);
    const station = new THREE.Group();
    station.rotation.set(0.25, 0, 0.15);
    station.add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 16), mats.brass));
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.013, 8, 48), mats.brassDark);
    torus.rotation.x = Math.PI / 2;
    this.ring.add(torus);
    const spoke = new THREE.CylinderGeometry(0.004, 0.004, 0.13, 6);
    spoke.rotateZ(Math.PI / 2);
    spoke.translate(0.065, 0, 0);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(spoke, mats.brass);
      m.rotation.y = (i * Math.PI) / 2;
      this.ring.add(m);
    }
    station.add(this.ring);
    // Construction booms reaching out to a hull in the making.
    const boom = new THREE.CylinderGeometry(0.004, 0.004, 0.24, 6);
    boom.rotateZ(Math.PI / 2);
    for (const y of [0.03, -0.03]) {
      const m = new THREE.Mesh(boom, mats.brass);
      m.position.set(0.14, y, 0);
      station.add(m);
    }
    const hull = new THREE.CapsuleGeometry(0.024, 0.12, 6, 12);
    hull.rotateZ(Math.PI / 2);
    const h = new THREE.Mesh(hull, mats.copper);
    h.position.set(0.2, 0, 0);
    station.add(h);
    for (let i = 0; i < 5; i++) {
      const s = glow(i % 2 ? 0xfff2c8 : 0x9fd8ff, 0);
      s.scale.setScalar(0.025);
      s.position.set(0.15 + i * 0.025, Math.sin(i * 2.1) * 0.025, Math.cos(i * 1.7) * 0.025);
      this.sparks.push(s);
      station.add(s);
    }
    this.anchor.add(station);
    this.makeBody(0.3, 0.2, () => [
      ['Orbits', 'The Sun, in the Belt'],
      ['From Sun', `${TYCHO_ORBIT.a.toFixed(2)} AU`],
      ['Builds', 'Ships'],
    ]);
  }

  update(simMs: number, elapsed: number) {
    const days = julianDate(new Date(simMs)) - J2000;
    const period = 365.25 * TYCHO_ORBIT.a ** 1.5;
    const lon = (TYCHO_ORBIT.lonAtJ2000 + (360 * days) / period) * DEG;
    const r = TYCHO_ORBIT.a;
    toWorld(r * Math.cos(lon), r * Math.sin(lon), r * Math.sin(TYCHO_ORBIT.i * DEG) * Math.sin(lon), xyz);
    this.anchor.position.set(xyz.x, xyz.y, xyz.z);
    this.ring.rotation.y = elapsed * 0.5;
    this.sparks.forEach((s, i) => {
      const flicker = Math.sin(elapsed * (8 + i * 1.7) + i * 3.3) * Math.sin(elapsed * 3.1 + i);
      s.material.opacity = Math.max(0, flicker) ** 3 * 1.4;
    });
  }
}

/** The slow zone seen through the Ring: deep blue, rippling outward, brighter toward the rim. */
class SlowZoneMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float ripple = 0.5 + 0.5 * sin(r * 28.0 - uTime * 1.2);
          float swirl = (0.5 + 0.5 * sin(atan(p.y, p.x) * 6.0 + r * 10.0 - uTime * 0.3)) * smoothstep(0.0, 0.4, r);
          // (Linear colour: the output pass brightens these a lot.)
          vec3 col = mix(vec3(0.001, 0.002, 0.007), vec3(0.015, 0.045, 0.16), pow(ripple, 3.0) * 0.6 + swirl * 0.25);
          col += vec3(0.15, 0.3, 0.7) * pow(r, 10.0) * 0.5;
          gl_FragColor = vec4(col, 0.9);
        }
      `,
    });
  }
}

/** The Ring: dark alien metal round a shimmering disc, facing the Sun, beyond Uranus. */
class RingGatePlace extends ExpansePlace {
  private zone = new SlowZoneMaterial();
  private halo = glow(0x6fa0ff, 0.1);

  constructor() {
    super(RING_GATE);
    const au = RING_GATE_AT.au;
    const lon = RING_GATE_AT.lonDeg * DEG;
    toWorld(au * Math.cos(lon), au * Math.sin(lon), 0, xyz);
    this.anchor.position.set(xyz.x, xyz.y, xyz.z);
    const gate = new THREE.Group();
    gate.add(
      new THREE.Mesh(
        new THREE.TorusGeometry(0.8, 0.06, 16, 96),
        new THREE.MeshStandardMaterial({ color: 0x2c3138, metalness: 0.85, roughness: 0.35 }),
      ),
      new THREE.Mesh(new THREE.CircleGeometry(0.76, 64), this.zone),
    );
    this.halo.scale.setScalar(2.2);
    this.anchor.add(this.halo, gate);
    // Face the Sun (once attached, so it aims from where it actually is).
    gate.lookAt(SUN);
    this.makeBody(0.9, 0.85, () => [
      ['Beyond', 'The orbit of Uranus'],
      ['From Sun', `${RING_GATE_AT.au} AU`],
      ['Leads to', 'The slow zone'],
    ]);
  }

  update(_simMs: number, elapsed: number) {
    this.zone.uniforms.uTime.value = elapsed;
  }
}

// ---- Fiction mode -----------------------------------------------------------------------

export class Fiction {
  readonly root = new THREE.Group();
  readonly bodies: Body[];
  private wotw: WarOfTheWorlds;
  private breakaway: Breakaway;
  private demolition: Demolition;
  private utopia: UtopiaPlanitia;
  private wormhole: Wormhole;
  /** The always-on places: what each one shows, and how it moves. */
  private places: { id: string; object: THREE.Object3D; update: (simMs: number, elapsed: number) => void }[];
  /**
   * Fiction mode proper: shows the places and the catalogue. The dated events
   * run regardless, whenever the clock is in one (a Thursday morning, the
   * August volley), mode or no mode.
   */
  private on = false;
  /** Places switched off from the catalogue. */
  private hiddenPlaces = new Set<string>();
  /** Entry whose scene is playing: everything else steps aside. */
  private playing: string | null = null;

  constructor(bodies: Bodies, mats: Materials) {
    this.root.name = 'fiction';
    this.wotw = new WarOfTheWorlds(bodies, mats);
    this.root.add(this.wotw.group);
    this.breakaway = new Breakaway(bodies);
    this.root.add(this.breakaway.group);
    this.demolition = new Demolition(bodies, mats);
    this.root.add(this.demolition.group);
    this.utopia = new UtopiaPlanitia(bodies.surfaceFrame('mars')!, mats);
    this.wormhole = new Wormhole(bodies);
    this.root.add(this.wormhole.anchor);
    const petrova = new PetrovaLine(bodies);
    this.root.add(petrova.object);
    const expanse = [new CeresStationPlace(mats), new ErosPlace(), new TychoStationPlace(mats), new RingGatePlace()];
    this.root.add(...expanse.map((p) => p.object));
    this.places = [
      { id: UTOPIA_PLANITIA.id, object: this.utopia.anchor, update: (_ms, elapsed) => this.utopia.update(elapsed) },
      { id: WORMHOLE.id, object: this.wormhole.anchor, update: (_ms, elapsed) => this.wormhole.update(elapsed) },
      { id: PETROVA_LINE.id, object: petrova.object, update: (_ms, elapsed) => petrova.update(elapsed) },
      ...expanse.map((p) => ({ id: p.body.id, object: p.object, update: (ms: number, elapsed: number) => p.update(ms, elapsed) })),
    ];
    this.bodies = [
      this.wotw.body,
      this.breakaway.body,
      this.demolition.body,
      this.demolition.bypassBody,
      this.demolition.fleetBody,
      this.utopia.body,
      this.wormhole.body,
      petrova.body,
      ...expanse.map((p) => p.body),
    ];
    this.setEnabled(false);
  }

  get enabled() {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
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
    for (const p of this.places) p.object.visible = this.on && this.placeShown(p.id) && inScene(p.id);
    this.wotw.suppressed = !inScene(WAR_OF_THE_WORLDS.id);
    this.breakaway.suppressed = !inScene(SPACE_1999.id);
    this.demolition.suppressed = !inScene(VOGON_DEMOLITION.id);
    // Suppressed scenes stop updating, so give the real Earth and Moon back now.
    if (this.demolition.suppressed) this.demolition.release();
    if (this.breakaway.suppressed) this.breakaway.release();
  }

  update(simMs: number, dt: number, elapsed: number, jumped: boolean, camera: THREE.Camera) {
    this.wotw.update(simMs, dt, jumped);
    this.breakaway.update(simMs, dt, jumped);
    this.demolition.update(simMs, dt, jumped, camera);
    for (const p of this.places) if (p.object.visible) p.update(simMs, elapsed);
  }

  /** Camera shake from fiction (the planet exploding), 0..1. */
  get quake() {
    return this.demolition.quake;
  }

  /** A camera beat a scene wants at `simMs` (a new key means fly to frame its points), or null. */
  sceneBeat(id: string, simMs: number): { key: string; points: THREE.Vector3[]; duration: number } | null {
    return id === VOGON_DEMOLITION.id ? this.demolition.beat(simMs) : null;
  }

  /** The replay speed a scene wants at `simMs` (sim seconds per second), or null to leave it be. */
  scenePace(id: string, simMs: number): number | null {
    return id === VOGON_DEMOLITION.id ? this.demolition.pace(simMs) : null;
  }

  /**
   * When (sim ms) the camera should stop framing a scene and ride along with
   * its body instead, or null to keep the framed view.
   */
  followFrom(id: string): number | null {
    return id === SPACE_1999.id ? BREAKAWAY + 0.06 * DAY : null;
  }

  /** Points a camera should frame to watch an entry play out (empty: just focus its body). */
  framePoints(id: string): THREE.Vector3[] {
    if (id === WAR_OF_THE_WORLDS.id) return this.wotw.framePoints();
    if (id === SPACE_1999.id) return this.breakaway.framePoints();
    if (id === VOGON_DEMOLITION.id) return this.demolition.framePoints();
    return [];
  }
}
