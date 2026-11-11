import * as THREE from 'three/webgpu';
import type { Materials } from '../materials';
import {
  BeamMaterial,
  CracksMaterial,
  FireballMaterial,
  GasConeMaterial,
  HoloGlobeMaterial,
  HoloSignMaterial,
  LaneMaterial,
  ShockwaveMaterial,
  SurveyLineMaterial,
  emberCloud,
} from '../fictionShaders';
import { sunlit, type Bodies, type Body } from '../bodies';
import { TABLE_RADIUS } from '../layout';
import { ProgressiveTexture } from '../textures';
import { VOGON, VOGON_DEMOLITION, vogonOccurrence } from '../../fiction/catalog';
import { CONE, DAY, DOWN, glow, pickProxy, softPanelTexture, SUN, UP } from './shared';

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

/** Fades the bypass traffic the same way as the lane. */
const laneFade = (p: THREE.Vector3) => 1 - THREE.MathUtils.smoothstep(Math.hypot(p.x, p.z), TABLE_RADIUS * 0.5, TABLE_RADIUS);

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

const CHUNK_DUMMY = new THREE.Object3D();

interface Chunk {
  /** Which instanced mesh holds it, and its slot there. */
  mesh: THREE.InstancedMesh;
  slot: number;
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
export class Demolition {
  readonly group = new THREE.Group();
  readonly body: Body;
  /**
   * Set once per occurrence when the fleet arrives: the owner should compile
   * the whole scene's shaders now, so the explosion's first frame (flash,
   * fireball, shockwaves, pieces, embers, all drawn for the first time)
   * doesn't stall.
   */
  warmupDue = false;
  private warmedFor = -1;
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
  /** The chunks, drawn as two instanced meshes (Earth's surface, molten rock). */
  private chunkMeshes: THREE.InstancedMesh[] = [];
  private embers: { dir: THREE.Vector3; speed: number }[] = [];
  /** The embers, one point cloud. */
  private emberCloud: ReturnType<typeof emberCloud>;
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
  /** Smallest the construction hologram may look (radians across): bigger in the tabletop, to be read. */
  minSignAngle = 0.078;
  /** Tabletop: the whole solar system is in view, the Sun always near the sign, so the smoked glass stays on. */
  tabletop = false;
  private parentQ = new THREE.Quaternion();
  private scrim = new THREE.Mesh(
    // Big enough that its full-strength middle (the soft rim takes ~20% each side) covers the whole sign.
    new THREE.PlaneGeometry(1.75, 0.75),
    new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: softPanelTexture(), transparent: true, opacity: 0, depthWrite: false }),
  );
  private sun = new THREE.Vector3();
  private sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.43), new HoloSignMaterial(constructionSignTexture()));
  private survey = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6, 1, true), new SurveyLineMaterial(TABLE_RADIUS));

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
    const molten = new THREE.MeshStandardMaterial({
      color: 0x5a1e0a,
      emissive: 0xff5a14,
      emissiveIntensity: 0.8,
      roughness: 1,
      flatShading: true,
    });
    // One draw call per material rather than one per chunk (they all move by hand,
    // so their bounds are never up to date: no culling).
    const chunkGeo = new THREE.IcosahedronGeometry(1, 0);
    const hotCount = Math.ceil(CHUNKS / 5);
    const [cold, hotMesh] = [
      new THREE.InstancedMesh(chunkGeo, surface, CHUNKS - hotCount),
      new THREE.InstancedMesh(chunkGeo, molten, hotCount),
    ];
    this.chunkMeshes = [cold, hotMesh];
    for (const m of this.chunkMeshes) {
      m.visible = false;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    let coldSlot = 0,
      hotSlot = 0;
    for (let i = 0; i < CHUNKS; i++) {
      const hot = i % 5 === 0;
      const r = () => 0.45 + Math.random() * 0.9;
      this.chunks.push({
        mesh: hot ? hotMesh : cold,
        slot: hot ? hotSlot++ : coldSlot++,
        size: (hot ? 0.015 : 0.02) + Math.random() * 0.04,
        shape: new THREE.Vector3(r(), r() * 0.6, r()),
        dir: new THREE.Vector3().randomDirection(),
        speed: 0.5 + Math.random() * 0.9,
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4),
      });
    }
    const emberColors = new Float32Array(EMBERS * 3);
    const c = new THREE.Color();
    for (let i = 0; i < EMBERS; i++) {
      this.embers.push({ dir: new THREE.Vector3().randomDirection(), speed: 1 + Math.random() * 2 });
      c.set(i % 3 ? 0xff8a30 : 0xffe0a0).toArray(emberColors, i * 3);
    }
    this.emberCloud = emberCloud(emberColors);
    this.group.add(this.emberCloud.sprite);

    // Shockwaves lie a little off the plane, at different tilts, for depth.
    this.shock.rotation.set(-Math.PI / 2 + 0.28, 0, 0.2);
    this.echo.rotation.set(-Math.PI / 2 - 0.35, 0.3, 0);
    this.shock.frustumCulled = this.echo.frustumCulled = false;
    this.cracks.renderOrder = 2;

    // The hyperspace bypass, with traffic already using it.
    this.lane = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 1, 10, 1, true), new LaneMaterial(TABLE_RADIUS));
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
        new THREE.MeshBasicMaterial({
          color: 0xffe27a,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      this.ripples.push(ring);
      this.group.add(ring);
    }
    this.teleCore.frustumCulled = this.teleGlow.frustumCulled = false;
    this.group.add(this.teleGlow, this.teleCore, ...this.hitchhikers, this.arrival);
    for (const m of [this.ghost, this.sign, this.survey]) m.frustumCulled = false;
    this.group.add(this.ghost, this.survey, this.sign);
    // Smoked glass behind the hologram, faded in when the Sun is behind it from
    // the viewer (the glare washed the lettering out). Just behind the sign, so
    // it sorts between the Sun's glow and the sign.
    this.scrim.name = 'holo-scrim';
    this.sign.name = 'holo-sign';
    this.scrim.position.z = -0.02;
    // Both after every glow (additive sprites, render order ≤ 4): drawn before the Sun's
    // glow, the glow's light went straight back over the darkening.
    this.scrim.renderOrder = 5;
    this.sign.renderOrder = 6;
    this.scrim.frustumCulled = false;
    this.scrim.visible = false;
    this.sign.add(this.scrim);
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

    if (show && toBlast < 0 && this.warmedFor !== start) {
      this.warmedFor = start;
      this.warmupDue = true;
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
        // The trail streams behind the ship: above it coming down, below it going up.
        streak.quaternion.setFromUnitVectors(DOWN, leave > 0 ? DOWN : UP);
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
    const beamOn =
      toBlast < 0 && tp.visible ? ramp(toBlast, TELEPORT.on, TELEPORT.on + 1) * (1 - ramp(toBlast, TELEPORT.arrive, TELEPORT.off)) : 0;
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
    this.emberCloud.sprite.visible = e < 1;
    if (e < 1) {
      const pos = this.emberCloud.positions;
      const p = new THREE.Vector3();
      this.embers.forEach((em, i) => {
        p.copy(this.earth).addScaledVector(em.dir, 0.3 + em.speed * (1 - Math.exp(-age * 1.3)) * 1.1);
        pos.setXYZ(i, p.x, p.y, p.z);
      });
      pos.needsUpdate = true;
      const u = this.emberCloud.uniforms;
      u.uSize.value = 0.05 * (1 - e) + 0.01;
      u.uOpacity.value = (1 - e) ** 1.5;
    }

    // The pieces: a fast burst (real time, if it was seen), then a slow drift and fade (sim time).
    const hoursSince = h - VOGON.demolish;
    const scatter = toBlast >= 0 && this.active;
    const burst = 1 - Math.exp(-(seen ? age : 99) * 0.9);
    const fade = 1 - ramp(hoursSince, 1.2, VOGON.end - VOGON.demolish);
    const scattering = scatter && fade > 0.02;
    for (const m of this.chunkMeshes) m.visible = scattering;
    if (scattering) {
      const o = CHUNK_DUMMY;
      for (const c of this.chunks) {
        const out = 0.22 + c.speed * (1.1 * burst + 0.12 * hoursSince);
        o.position.copy(this.earth).addScaledVector(c.dir, out);
        const turn = Math.min(seen ? age : 30, 30) * 0.4 + hoursSince * 3;
        o.rotation.set(c.spin.x * turn, c.spin.y * turn, c.spin.z * turn);
        o.scale.copy(c.shape).multiplyScalar(c.size * fade);
        o.updateMatrix();
        c.mesh.setMatrixAt(c.slot, o.matrix);
      }
      for (const m of this.chunkMeshes) m.instanceMatrix.needsUpdate = true;
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
      // Never smaller than `minSignAngle` across (1.3 units wide): seen from far off, or with the
      // world at tabletop size, it would shrink to a few pixels. It grows, lifted clear of Earth to match.
      const boost = Math.max(1, (camera.position.distanceTo(this.earth) * this.minSignAngle) / 1.3);
      this.sign.scale.setScalar(boost);
      this.sign.position.copy(this.earth).addScaledVector(UP, 0.72 * boost);
      // Face the viewer: their rotation, taken into the sign's parent's space (copying it as is is
      // only right while nothing above the sign is turned).
      (this.sign.parent ?? this.group).getWorldQuaternion(this.parentQ).invert().multiply(camera.quaternion);
      this.sign.quaternion.copy(this.parentQ);
      this.sign.material.uniforms.uReveal.value = signIn;
      this.sign.material.uniforms.uOpacity.value = site;
      // Darken behind it while the Sun is within ~12–25° of it as seen from the viewer.
      this.bodies.positionOf('sun', this.sun);
      const toSign = this.sign.position.clone().sub(camera.position).normalize();
      const toSun = this.sun.clone().sub(camera.position).normalize();
      const glare = this.tabletop
        ? 1
        : THREE.MathUtils.smoothstep(toSign.dot(toSun), Math.cos(THREE.MathUtils.degToRad(25)), Math.cos(THREE.MathUtils.degToRad(12)));
      // (Stronger in the tabletop: at 60% it was hard to see against the room and the Sun.)
      this.scrim.material.opacity = (this.tabletop ? 0.85 : 0.6) * glare * site * signIn;
      this.scrim.visible = this.scrim.material.opacity > 0.01;
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
      new Date(this.start + hours * HOUR).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
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
