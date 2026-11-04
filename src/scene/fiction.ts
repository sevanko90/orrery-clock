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
const CHUNKS = 40;
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

interface Chunk {
  mesh: THREE.Mesh;
  size: number;
  dir: THREE.Vector3;
  speed: number;
  spin: THREE.Vector3;
}

/**
 * Every Thursday the Vogon fleet drops out of hyperspace over Earth, takes up
 * formation, locks on its beams and at ten o'clock demolishes the planet: a
 * flash, a shockwave and the pieces tumbling away. The fleet leaves, a
 * hyperspace bypass shimmers through where Earth was, and Earth is quietly
 * back on its arm once the scene ends.
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
  private ships: {
    ship: THREE.Group;
    streak: THREE.Mesh<THREE.ConeGeometry, GasConeMaterial>;
    beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  }[] = [];
  private chunks: Chunk[] = [];
  private flash = glow(0xfff3d0);
  private shock: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private lane: THREE.Mesh<THREE.CylinderGeometry, LaneMaterial>;
  private traffic: THREE.Sprite[] = [];
  private focus = new THREE.Group();
  private flashAge = Infinity;
  private lastSim: number | null = null;
  private hours = -1;
  private start = 0;
  private time = 0;
  private earth = new THREE.Vector3();

  constructor(
    private bodies: Bodies,
    mats: Materials,
  ) {
    this.group.name = 'vogons';
    const enamel = new THREE.MeshStandardMaterial({ color: 0xd9b43a, metalness: 0.5, roughness: 0.45 });
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    for (let i = 0; i < SHIPS; i++) {
      const ship = vogonShip(mats, enamel);
      const streak = new THREE.Mesh(CONE, new GasConeMaterial(VOGON_YELLOW));
      streak.frustumCulled = false;
      const beam = new THREE.Mesh(
        beamGeo,
        new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.ships.push({ ship, streak, beam });
      this.group.add(ship, streak, beam);
    }

    // The pieces: ocean, land, desert, ice, rock and a few glowing with magma.
    const palette = [0x2b5d9b, 0x2b5d9b, 0x4f7d3a, 0xb89a5e, 0xe8eef2, 0x6e5a48];
    const chunkGeo = new THREE.IcosahedronGeometry(1, 0);
    for (let i = 0; i < CHUNKS; i++) {
      const magma = i % 6 === 0;
      const mat = new THREE.MeshStandardMaterial({
        color: magma ? 0x7a2a10 : palette[i % palette.length],
        emissive: magma ? 0xff6a1a : 0x000000,
        emissiveIntensity: magma ? 1.4 : 0,
        roughness: 1,
        flatShading: true,
        envMapIntensity: 0,
      });
      if (!magma) sunlit(mat);
      const mesh = new THREE.Mesh(chunkGeo, mat);
      this.chunks.push({
        mesh,
        size: 0.025 + Math.random() * 0.05,
        dir: new THREE.Vector3().randomDirection(),
        speed: 0.6 + Math.random(),
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8),
      });
      this.group.add(mesh);
    }

    this.shock = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.shock.rotation.x = -Math.PI / 2;

    // The hyperspace bypass, with traffic already using it.
    this.lane = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 10, 1, true), new LaneMaterial());
    this.lane.frustumCulled = false;
    for (let i = 0; i < 14; i++) {
      const car = glow(0xd8f0ff, 0);
      car.scale.setScalar(0.07);
      this.traffic.push(car);
      this.group.add(car);
    }
    this.group.add(this.flash, this.shock, this.lane, this.focus, this.bypassFocus);

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
  }

  /** Where ship `i` sits in the formation over Earth. */
  private station(i: number, out: THREE.Vector3) {
    const a = (i / SHIPS) * Math.PI * 2 + 0.3;
    return out.set(Math.cos(a) * 1.05, 0.55 + 0.12 * Math.sin(i * 2.1), Math.sin(a) * 1.05).add(this.earth);
  }

  /** Give the real Earth back. */
  release() {
    this.bodies.setPlanetHidden('earth', false);
  }

  update(simMs: number, dt: number, jumped: boolean) {
    const start = vogonOccurrence(simMs);
    const h = (simMs - start) / HOUR;
    this.start = start;
    this.hours = h;
    this.active = h >= 0 && h <= VOGON.end;
    this.time += dt;

    const prev = this.lastSim;
    this.lastSim = simMs;
    const blast = start + VOGON.demolish * HOUR;
    if (prev !== null && !jumped && Math.abs(simMs - prev) < 2 * DAY) {
      if (blast > Math.min(prev, simMs) && blast <= Math.max(prev, simMs)) this.flashAge = 0;
    }
    this.flashAge += dt;

    const show = !this.suppressed && this.active;
    this.group.visible = show || (!this.suppressed && this.flashAge < 3);
    this.bodies.setPlanetHidden('earth', show && h >= VOGON.demolish);
    if (!this.group.visible) return;

    this.bodies.positionOf('earth', this.earth);
    this.focus.position.copy(this.earth);
    const spot = new THREE.Vector3();
    const dir = new THREE.Vector3();

    // The fleet: down out of hyperspace, hold station, beams, and away again.
    this.ships.forEach(({ ship, streak, beam }, i) => {
      const lag = i * 0.08;
      const arrive = ramp(h, lag, VOGON.inPlace - 0.4 + lag);
      const leave = ramp(h, VOGON.depart + lag * 0.5, VOGON.depart + 0.5 + lag * 0.5);
      ship.visible = this.active && arrive > 0 && leave < 1;
      streak.visible = beam.visible = false;
      if (!ship.visible) return;
      this.station(i, spot);
      const rise = 8 * ((1 - arrive) ** 2 + leave ** 2);
      ship.position.copy(spot).addScaledVector(UP, rise + 0.015 * Math.sin(this.time * 0.8 + i));
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

      // Demolition beams: lock on, brighten, cut out at the blast.
      const power = ramp(h, VOGON.beams, VOGON.demolish) * (1 - ramp(h, VOGON.demolish, VOGON.demolish + 0.08));
      if (power > 0.01) {
        beam.visible = true;
        dir.copy(this.earth).sub(ship.position);
        const len = dir.length();
        beam.position.copy(ship.position).addScaledVector(dir, 0.5);
        beam.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
        const w = 0.004 + 0.01 * power;
        beam.scale.set(w, len, w);
        beam.material.opacity = power * (0.7 + 0.3 * Math.sin(this.time * 20 + i));
      }
    });

    // The blast: flash in real time; shockwave and pieces in sim time.
    const f = Math.exp(-this.flashAge * 1.1);
    this.flash.visible = f > 0.01;
    this.flash.position.copy(this.earth);
    this.flash.scale.setScalar(0.8 + 3.2 * Math.exp(-this.flashAge * 2));
    this.flash.material.opacity = f;

    const since = h - VOGON.demolish;
    const shock = since >= 0 && since < 0.7 ? since / 0.7 : -1;
    this.shock.visible = shock >= 0 && this.active;
    if (this.shock.visible) {
      this.shock.position.copy(this.earth);
      this.shock.scale.setScalar(0.4 + 2.6 * shock);
      this.shock.material.opacity = (1 - shock) ** 2 * 0.8;
    }
    const scatter = since >= 0 && this.active;
    for (const c of this.chunks) {
      c.mesh.visible = scatter;
      if (!scatter) continue;
      const out = 0.15 + c.speed * 0.9 * Math.pow(since, 0.7);
      c.mesh.position.copy(this.earth).addScaledVector(c.dir, out);
      c.mesh.rotation.set(c.spin.x * since, c.spin.y * since, c.spin.z * since);
      const fade = 1 - ramp(since, 1.2, VOGON.end - VOGON.demolish);
      c.mesh.visible = fade > 0.02;
      c.mesh.scale.setScalar(c.size * fade);
    }

    // The bypass: a straight lane through where Earth was, along its old
    // orbit, right across the orrery; traffic already on it.
    const open = this.active ? ramp(h, VOGON.depart, VOGON.depart + 0.4) : 0;
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
    const status =
      h < VOGON.inPlace ? 'Fleet arriving' : h < VOGON.demolish ? 'Fleet in position' : h < VOGON.depart ? 'Demolished' : 'Bypass open';
    return [
      ['Demolition', when(VOGON.demolish)],
      ['Status', status],
      ['Earth back', when(VOGON.end)],
    ];
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
    for (const p of this.places) p.object.visible = this.on && this.placeShown(p.id) && inScene(p.id);
    this.wotw.suppressed = !inScene(WAR_OF_THE_WORLDS.id);
    this.breakaway.suppressed = !inScene(SPACE_1999.id);
    this.demolition.suppressed = !inScene(VOGON_DEMOLITION.id);
    if (!this.on || this.demolition.suppressed) this.demolition.release();
    // Not updated while fiction is off, so give the real Moon back now.
    if (!this.on || this.breakaway.suppressed) this.breakaway.release();
  }

  update(simMs: number, dt: number, elapsed: number, jumped: boolean) {
    if (!this.on) return;
    this.wotw.update(simMs, dt, jumped);
    this.breakaway.update(simMs, dt, jumped);
    this.demolition.update(simMs, dt, jumped);
    for (const p of this.places) if (p.object.visible) p.update(simMs, elapsed);
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
