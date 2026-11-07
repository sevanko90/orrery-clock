import * as THREE from 'three/webgpu';
import { float, fract, modelViewMatrix, smoothstep, step, uniform, uv, vec3, vec4 } from 'three/tsl';
import { particleFloat, particleVec3, particles, pointSize } from './pointSize';
import { PLANET_FACTS, SUN_FACTS, COMETS, type BodyFacts, type CometDef } from '../astro/bodies';
import { cometPosition, planetPosition, sampleOrbit, PLANET_ELEMENTS, type PlanetId } from '../astro/orbits';
import { MOONS, type MoonDef } from '../astro/moons';
import { moonLongitude } from '../astro/sky';
import { J2000, julianDate } from '../astro/time';
import { ARMS, PLANE_Y, PLUTO_SIZE, SUN_RADIUS, toWorld } from './layout';
import { ProgressiveTexture, type TextureTier } from './textures';
import { NIGHT_FILL, SUN_COLOR, SUN_LIGHTS, sunlit } from './sunlit';

export { sunlit };
import type { ArmRig } from './orrery';

const DEG = Math.PI / 180;
const tmp = { x: 0, y: 0, z: 0 };

export interface Body {
  id: string;
  facts: BodyFacts | null;
  name: string;
  /** Moves with the body; camera focus target. */
  group: THREE.Group;
  /** Invisible, generously sized sphere used for picking. */
  pickProxy: THREE.Mesh;
  /** Size for framing and picking (Saturn's includes its rings). */
  radius: number;
  /** Load the highest resolution texture (on focus). */
  upgrade(): void;
  /** Extra info for comets. */
  blurb?: string;
  /** Set for moons. */
  moon?: MoonDef;
  /** Card heading in place of the facts' kind (e.g. a fiction's source). */
  kind?: string;
  /** Live card rows in place of the computed ones. */
  rows?: () => [string, string][];
  /** False while the body is not on show (so it can't be picked). */
  available?: () => boolean;
  /** Hover text in place of the name (e.g. a fleet whose card is its scene's). */
  hoverLabel?: string;
  /** Further pick targets standing for the same body (e.g. each ship of a fleet). */
  extraProxies?: THREE.Object3D[];
}

function glowTexture(inner: string, outer: string) {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.25, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function pickProxy(radius: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  return m;
}

/** Ring geometry with UVs running radially (u = 0 inner edge → 1 outer). */
function radialRingGeometry(inner: number, outer: number, segments = 128) {
  const geo = new THREE.RingGeometry(inner, outer, segments, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    uv.setXY(i, (v.length() - inner) / (outer - inner), 0.5);
  }
  geo.rotateX(-Math.PI / 2);
  return geo;
}

interface PlanetVisual {
  id: string;
  group: THREE.Group;
  /** Tilted frame (pole direction fixed in space). */
  tilt: THREE.Group;
  spin: THREE.Group;
  rotationHours: number;
  textures: ProgressiveTexture[];
}

function makePlanet(
  id: string,
  size: number,
  facts: BodyFacts,
  fullTier: TextureTier,
  allow4k: boolean,
): PlanetVisual {
  const group = new THREE.Group();
  group.name = id;
  const tilt = new THREE.Group();
  // Tilt the pole toward ecliptic longitude 90° (correct for Earth's seasons).
  tilt.rotation.x = -facts.tiltDeg * DEG;
  const spin = new THREE.Group();
  tilt.add(spin);
  group.add(tilt);

  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.0 });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 64, 48), mat);
  sphere.castShadow = true;
  sphere.receiveShadow = false;
  spin.add(sphere);

  const has4k = allow4k && ['mercury', 'venus', 'earth', 'mars'].includes(id);
  const textures: ProgressiveTexture[] = [];
  const surface = new ProgressiveTexture(
    id,
    (t) => {
      mat.map = t;
      mat.needsUpdate = true;
    },
    THREE.SRGBColorSpace,
    has4k,
  );
  surface.start(fullTier);
  textures.push(surface);

  if (id === 'earth') {
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      envMapIntensity: 0,
      opacity: 0.9,
    });
    cloudMat.visible = false;
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(size * 1.012, 64, 48), cloudMat);
    clouds.name = 'clouds';
    spin.add(clouds);
    new ProgressiveTexture(
      'earth-clouds',
      (t) => {
        cloudMat.alphaMap = t;
        cloudMat.visible = true;
        cloudMat.needsUpdate = true;
      },
      THREE.NoColorSpace,
      false,
    ).start(fullTier === '4k' ? '2k' : fullTier);

    // Thin atmospheric rim.
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(size * 1.06, 48, 32),
      new THREE.MeshBasicMaterial({
        color: 0x6fa8ff,
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    group.add(atmo);
  }

  if (id === 'saturn') {
    // Unlit: the rings sit edge-on to the Sun here, and real ring ice
    // scatters light strongly, so physically-lit shading looks far too dark.
    const ringMat = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      color: new THREE.Color(0.9, 0.86, 0.78),
    });
    ringMat.visible = false;
    const ring = new THREE.Mesh(radialRingGeometry(size * 1.24, size * 2.27), ringMat);
    ring.receiveShadow = true;
    tilt.add(ring);
    new ProgressiveTexture(
      'saturn-ring',
      (t) => {
        ringMat.map = t;
        ringMat.visible = true;
        ringMat.needsUpdate = true;
      },
      THREE.SRGBColorSpace,
      false,
      false,
    ).start('2k');
  }

  return { id, group, tilt, spin, rotationHours: facts.rotationHours, textures };
}

/**
 * A comet tail: particles streaming back from the head, spreading as they go.
 * Positions are worked out on the GPU from the head, the tail's direction and
 * its length, so only those uniforms change each frame.
 */
class Tail {
  readonly uniforms = {
    uHead: uniform(new THREE.Vector3()),
    uDir: uniform(new THREE.Vector3(1, 0, 0)),
    uLen: uniform(0),
    uTime: uniform(0),
  };
  readonly sprite: THREE.Sprite;

  constructor(color: THREE.Color, spread: number, count: number) {
    const t = new Float32Array(count);
    const seed = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      t[i] = Math.random();
      const v = new THREE.Vector3().randomDirection().multiplyScalar(Math.random());
      seed.set([v.x, v.y, v.z], i * 3);
    }
    const aT = particleFloat(t).node;
    const aSeed = particleVec3(seed).node;
    const u = this.uniforms;
    this.sprite = particles(count, (mat) => {
      const k = fract(aT.add(u.uTime.mul(0.05)));
      const p = u.uHead.add(u.uDir.mul(k.mul(u.uLen))).add(aSeed.mul(k.mul(spread).add(0.03)).mul(u.uLen));
      mat.positionNode = p;
      const depth = modelViewMatrix.mul(vec4(p, 1)).z.negate();
      mat.sizeNode = pointSize(float(300).mul(k.oneMinus().mul(0.1).add(0.06)).div(depth));
      const a = smoothstep(0, 0.5, uv().sub(0.5).length()).oneMinus().mul(k.oneMinus().pow(2)).mul(step(0.001, u.uLen)).mul(0.35);
      mat.colorNode = vec3(color.r, color.g, color.b).mul(a);
      mat.opacityNode = a;
    }).sprite;
  }
}

interface CometVisual {
  def: CometDef;
  group: THREE.Group;
  coma: THREE.Sprite;
  tails: Tail[];
}

function makeComet(def: CometDef, count: number): { visual: CometVisual; tailPoints: THREE.Sprite[]; orbit: THREE.Line } {
  const group = new THREE.Group();
  group.name = def.id;
  const nucleus = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 1, emissive: 0x222222 }),
  );
  group.add(nucleus);
  const coma = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture('rgba(220,240,255,1)', 'rgba(120,180,255,0.35)'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  coma.scale.setScalar(0.8);
  group.add(coma);

  const tails: Tail[] = [];
  const tailPoints: THREE.Sprite[] = [];
  const specs: [string, number][] = [
    ['#bcd7ff', 0.06], // ion tail: narrow, blue
    ['#fff1d6', 0.18], // dust tail: broad, warm
  ];
  for (const [color, spread] of specs) {
    const tail = new Tail(new THREE.Color(color), spread, count);
    tails.push(tail);
    tailPoints.push(tail.sprite);
  }

  const a = def.elements.q / (1 - def.elements.e);
  const orbitPts = sampleOrbit(a, def.elements.e, def.elements.i, def.elements.node, def.elements.argPeri, 512).map(
    (p) => {
      toWorld(p.x, p.y, p.z, tmp);
      return new THREE.Vector3(tmp.x, tmp.y, tmp.z);
    },
  );
  const orbit = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(orbitPts),
    new THREE.LineBasicMaterial({ color: 0x7fa6c9, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  return { visual: { def, group, coma, tails }, tailPoints, orbit };
}

/**
 * Display layout of each moon system: the innermost and outermost orbit
 * radii, as multiples of the planet's display size. Moons between are spaced
 * half by rank and half by log distance, so close-packed inner moons (Saturn's)
 * stay apart while the far ones (Iapetus, Callisto) don't run into the
 * neighbouring planets.
 */
export const MOON_SYSTEMS: Partial<Record<PlanetId, [number, number]>> = {
  earth: [2.5, 2.5],
  mars: [1.8, 2.8],
  jupiter: [1.45, 2.2],
  saturn: [2.4, 3.3],
  uranus: [1.7, 2.7],
  neptune: [2.1, 2.1],
  pluto: [2.8, 2.8],
};

/** Moon sphere size: compressed hard, so Phobos is visible and Ganymede doesn't rival Mercury. */
export const moonSize = (km: number) => 0.025 + 0.03 * Math.sqrt(km / 1000);

/** Largest angle (radians) any moon may move in one frame; faster and the system slows down together. */
const MOON_MAX_STEP = 0.15;

interface MoonVisual {
  def: MoonDef;
  /** Moves with the moon (Body group). */
  group: THREE.Group;
  mesh: THREE.Mesh;
  orbitRadius: number;
  /** Current orbital angle, radians. */
  angle: number;
  /** rad/day, signed. */
  rate: number;
}

interface MoonSystem {
  root: THREE.Group;
  moons: MoonVisual[];
}

export interface BodiesOptions {
  lowQuality: boolean;
}

/** Dark worlds and small rocks get extra night fill so they never vanish against the night. */
const NIGHT_FILL_BOOST: Record<string, number> = { pluto: 1.2, mercury: 0.9, belt: 1.0 };

export class Bodies {
  readonly root = Object.assign(new THREE.Group(), { name: 'bodies' });
  readonly bodies: Body[] = [];
  readonly sunLight: THREE.PointLight;
  private planets: PlanetVisual[] = [];
  private pluto: PlanetVisual;
  private comets: CometVisual[] = [];
  private belt: THREE.InstancedMesh;
  private beltData: Float32Array; // a(AU), phase(rad), n(rad/day), height, scale, rotSpeed
  private lastSimMs: number | null = null;
  private sunMesh: THREE.Mesh;
  private sunGlow: THREE.Sprite;
  private moonSystems: MoonSystem[] | null = null;
  private moonsOn = false;
  /** Moons hidden while something else (a fiction scene) stands in for them. */
  private hiddenMoons = new Set<string>();
  private fullTier: TextureTier;

  constructor(
    private arms: ArmRig[],
    opts: BodiesOptions,
  ) {
    const fullTier: TextureTier = '2k';
    this.fullTier = fullTier;
    const allow4k = !opts.lowQuality;

    // ---- Sun ----
    const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5.6, 4.3, 3.0) });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 64, 48), sunMat);
    this.sunMesh.position.set(0, PLANE_Y, 0);
    const sunTex = new ProgressiveTexture('sun', (t) => {
      sunMat.map = t;
      sunMat.needsUpdate = true;
    });
    sunTex.start(fullTier);
    this.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture('rgba(255,220,150,0.9)', 'rgba(255,140,40,0.25)'),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.sunGlow.scale.setScalar(SUN_RADIUS * 7);
    this.sunMesh.add(this.sunGlow);
    this.root.add(this.sunMesh);

    this.sunLight = new THREE.PointLight(SUN_COLOR, 2.2, 0, 0);
    this.sunLight.position.copy(this.sunMesh.position);
    this.sunLight.name = 'sun-light';
    SUN_LIGHTS.setLights([this.sunLight]);
    this.sunLight.castShadow = !opts.lowQuality;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = SUN_RADIUS + 0.05;
    this.sunLight.shadow.camera.far = 60;
    this.sunLight.shadow.bias = -0.002;
    this.root.add(this.sunLight);

    const sunGroup = new THREE.Group();
    sunGroup.position.copy(this.sunMesh.position);
    const sunProxy = pickProxy(SUN_RADIUS * 1.05);
    sunGroup.add(sunProxy);
    this.root.add(sunGroup);
    this.bodies.push({
      id: 'sun',
      facts: SUN_FACTS,
      name: 'Sun',
      group: sunGroup,
      pickProxy: sunProxy,
      radius: SUN_RADIUS,
      upgrade: () => sunTex.upgrade(),
    });

    // ---- Planets on arms ----
    for (const spec of ARMS) {
      const facts = PLANET_FACTS[spec.id];
      const pv = makePlanet(spec.id, spec.size, facts, fullTier, allow4k);
      const proxy = pickProxy(Math.max(spec.size * 1.6, 0.45));
      pv.group.add(proxy);
      this.root.add(pv.group);
      this.planets.push(pv);
      this.bodies.push({
        id: spec.id,
        facts,
        name: facts.name,
        group: pv.group,
        pickProxy: proxy,
        radius: spec.id === 'saturn' ? spec.size * 2.3 : spec.size,
        upgrade: () => pv.textures.forEach((t) => t.upgrade()),
      });
    }

    // ---- Pluto (free-flying, no arm) ----
    this.pluto = makePlanet('pluto', PLUTO_SIZE, PLANET_FACTS.pluto, fullTier, false);
    const plutoProxy = pickProxy(0.45);
    this.pluto.group.add(plutoProxy);
    this.root.add(this.pluto.group);
    this.bodies.push({
      id: 'pluto',
      facts: PLANET_FACTS.pluto,
      name: 'Pluto',
      group: this.pluto.group,
      pickProxy: plutoProxy,
      radius: PLUTO_SIZE,
      upgrade: () => undefined,
    });
    const pe = PLANET_ELEMENTS.pluto;
    const plutoOrbit = sampleOrbit(pe.a[0], pe.e[0], pe.I[0], pe.node[0], pe.peri[0] - pe.node[0], 512).map((p) => {
      toWorld(p.x, p.y, p.z, tmp);
      return new THREE.Vector3(tmp.x, tmp.y, tmp.z);
    });
    this.root.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(plutoOrbit),
        new THREE.LineBasicMaterial({ color: 0xc9a36a, transparent: true, opacity: 0.22, depthWrite: false }),
      ),
    );

    // ---- Comets ----
    for (const def of COMETS) {
      const { visual, tailPoints, orbit } = makeComet(def, opts.lowQuality ? 250 : 700);
      const proxy = pickProxy(0.45);
      visual.group.add(proxy);
      this.root.add(visual.group, orbit, ...tailPoints);
      this.comets.push(visual);
      this.bodies.push({
        id: def.id,
        facts: null,
        name: def.name,
        group: visual.group,
        pickProxy: proxy,
        radius: 0.1,
        upgrade: () => undefined,
        blurb: def.blurb,
      });
    }

    // ---- Asteroid belt ----
    const count = opts.lowQuality ? 600 : 1800;
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x8b7f72,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0,
      flatShading: true,
    });
    this.belt = new THREE.InstancedMesh(rockGeo, rockMat, count);
    this.belt.name = 'belt';
    this.belt.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beltData = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      // Skewed toward the belt's core with a gap near the 3:1 Kirkwood resonance.
      let a = 2.1 + Math.pow(Math.random(), 1.3) * 1.25;
      if (Math.abs(a - 2.5) < 0.03) a += 0.08;
      this.beltData.set(
        [
          a,
          Math.random() * Math.PI * 2,
          ((0.9856076686 / Math.pow(a, 1.5)) * Math.PI) / 180,
          (Math.random() - 0.5) * 0.5 * (Math.random() + 0.3),
          0.018 + Math.pow(Math.random(), 4) * 0.07,
          (Math.random() - 0.5) * 4,
        ],
        i * 6,
      );
    }
    this.root.add(this.belt);

    // ---- Faint orbit rings at the planets' plane ----
    for (const spec of ARMS) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(spec.radius - 0.008, spec.radius + 0.008, 256),
        new THREE.MeshBasicMaterial({ color: 0xe0c38a, transparent: true, opacity: 0.12, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = PLANE_Y;
      this.root.add(ring);
    }

    // Day and night sides: everything lit (planets, clouds, rocks, comets).
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!(m instanceof THREE.MeshStandardMaterial)) return;
      let fill = NIGHT_FILL;
      let pluto = false;
      for (let a: THREE.Object3D | null = o; a; a = a.parent) {
        if (a.name in NIGHT_FILL_BOOST) fill = NIGHT_FILL_BOOST[a.name];
        if (a.name === 'pluto') pluto = true;
      }
      sunlit(m, fill, pluto);
    });
  }


  /** A planet's spinning frame: things fixed to its surface turn with it. */
  surfaceFrame(id: string): THREE.Object3D | null {
    const pv = id === 'pluto' ? this.pluto : this.planets.find((p) => p.id === id);
    return pv?.spin ?? null;
  }

  /** World position of a body's centre. */
  positionOf(id: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bodies.find((b) => b.id === id)!.group.getWorldPosition(out);
  }

  /**
   * Hide a planet's globe (with its clouds, air and rings) while a fiction
   * scene has it gone; its moons and its arm stay.
   */
  setPlanetHidden(id: string, hidden: boolean) {
    const pv = id === 'pluto' ? this.pluto : this.planets.find((p) => p.id === id);
    if (!pv) return;
    for (const child of pv.group.children) {
      if (!child.name.endsWith('-moons')) child.visible = !hidden;
    }
  }

  /** Hide one moon (its orbit ring stays) while a stand-in takes its place. */
  setMoonHidden(id: string, hidden: boolean) {
    if (hidden) this.hiddenMoons.add(id);
    else this.hiddenMoons.delete(id);
  }

  get moonsVisible() {
    return this.moonsOn;
  }

  /** Show or hide the major moons; they are built (and their maps fetched) on first use. */
  setMoonsVisible(on: boolean) {
    if (on && !this.moonSystems) this.moonSystems = this.buildMoons();
    this.moonsOn = on;
    this.moonSystems?.forEach((s) => (s.root.visible = on));
    // Snap them straight to their places rather than easing from wherever they were.
    if (on && this.lastSimMs !== null) this.updateMoons(new Date(this.lastSimMs), 0);
  }

  private buildMoons(): MoonSystem[] {
    const visuals = new Map<string, { pv: PlanetVisual; size: number }>();
    ARMS.forEach((spec, i) => visuals.set(spec.id, { pv: this.planets[i], size: spec.size }));
    visuals.set('pluto', { pv: this.pluto, size: PLUTO_SIZE });

    const systems: MoonSystem[] = [];
    for (const [parent, [inner, outer]] of Object.entries(MOON_SYSTEMS) as [PlanetId, [number, number]][]) {
      const host = visuals.get(parent);
      const defs = MOONS.filter((m) => m.parent === parent).sort((a, b) => a.aKm - b.aKm);
      if (!host || !defs.length) continue;
      const root = new THREE.Group();
      root.name = `${parent}-moons`;
      // Earth's Moon keeps close to the ecliptic, so it hangs off the untilted
      // frame; the others orbit in their planet's equator (Uranus's on edge).
      (parent === 'earth' ? host.pv.group : host.pv.tilt).add(root);

      const a0 = defs[0].aKm;
      const aN = defs[defs.length - 1].aKm;
      const moons = defs.map((def, i) => {
        const f = defs.length > 1 ? 0.5 * (i / (defs.length - 1) + Math.log(def.aKm / a0) / Math.log(aN / a0)) : 0;
        const orbitRadius = host.size * (inner + (outer - inner) * f);
        const size = moonSize(def.radiusKm);

        const plane = new THREE.Group();
        plane.rotation.x = def.incDeg * DEG;
        root.add(plane);

        const ring: THREE.Vector3[] = [];
        // A closed line (the WebGPU renderer has no LineLoop): the last point repeats the first.
        for (let k = 0; k <= 128; k++) {
          const t = (k / 128) * Math.PI * 2;
          ring.push(new THREE.Vector3(Math.cos(t) * orbitRadius, 0, Math.sin(t) * orbitRadius));
        }
        plane.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(ring),
            new THREE.LineBasicMaterial({ color: 0xe0c38a, transparent: true, opacity: 0.14, depthWrite: false }),
          ),
        );

        const group = new THREE.Group();
        group.name = def.id;
        const mat = new THREE.MeshStandardMaterial({ color: def.color ?? 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0 });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 32, 24), mat);
        group.add(mesh);
        if (def.textured) {
          new ProgressiveTexture(
            def.id,
            (t) => {
              mat.map = t;
              mat.needsUpdate = true;
            },
            THREE.SRGBColorSpace,
            false,
          ).start(this.fullTier === '256' ? '256' : '1k');
        }
        sunlit(mat, NIGHT_FILL_BOOST[def.parent] ?? NIGHT_FILL, def.partialMap);
        const proxy = pickProxy(Math.max(size * 2.5, 0.12));
        group.add(proxy);
        plane.add(group);

        const parentName = PLANET_FACTS[def.parent].name;
        this.bodies.push({
          id: def.id,
          facts: {
            id: def.id,
            name: def.name,
            kind: `Moon of ${parentName}`,
            radiusKm: def.radiusKm,
            // Tidally locked: one turn per orbit.
            rotationHours: def.periodDays * 24,
            tiltDeg: 0,
            moons: null,
            blurb: def.blurb,
          },
          name: def.name,
          group,
          pickProxy: proxy,
          radius: size,
          upgrade: () => undefined,
          moon: def,
        });
        return { def, group, mesh, orbitRadius, angle: 0, rate: (Math.PI * 2) / def.periodDays };
      });
      systems.push({ root, moons });
    }
    return systems;
  }

  /**
   * Moons ride round at their true periods. At high speeds a system slows
   * down together (keeping the inner moons fastest) instead of strobing; once
   * time runs gently again they snap back to their proper places.
   */
  private updateMoons(date: Date, dDays: number) {
    if (!this.moonSystems || !this.moonsOn) return;
    const sinceJ2000 = julianDate(date) - J2000;
    for (const sys of this.moonSystems) {
      const fastest = Math.max(...sys.moons.map((m) => Math.abs(m.rate * dDays)));
      const k = fastest > MOON_MAX_STEP ? MOON_MAX_STEP / fastest : 1;
      for (const m of sys.moons) {
        if (k === 1) {
          m.angle = m.def.id === 'moon' ? moonLongitude(date) * DEG : m.def.l0 * DEG + m.rate * sinceJ2000;
        } else {
          m.angle += m.rate * dDays * k;
        }
        m.group.position.set(Math.cos(m.angle) * m.orbitRadius, 0, -Math.sin(m.angle) * m.orbitRadius);
        m.group.visible = !this.hiddenMoons.has(m.def.id);
        // Tidally locked: the same face always toward the planet.
        m.mesh.rotation.y = m.angle;
      }
    }
  }

  update(simMs: number, realDt: number, elapsed: number) {
    const date = new Date(simMs);
    const days = simMs / 86_400_000;
    const dDays = this.lastSimMs === null ? 0 : (simMs - this.lastSimMs) / 86_400_000;
    this.lastSimMs = simMs;

    // Planets follow their arm anchors; axes stay fixed in space.
    const wp = new THREE.Vector3();
    for (let i = 0; i < this.planets.length; i++) {
      const pv = this.planets[i];
      this.arms[i].anchor.getWorldPosition(wp);
      pv.group.position.copy(wp);
      this.spin(pv, dDays);
    }

    // Pluto: true 3D position.
    const pp = planetPosition('pluto' as PlanetId, date);
    toWorld(pp.x, pp.y, pp.z, tmp);
    this.pluto.group.position.set(tmp.x, tmp.y, tmp.z);
    this.spin(this.pluto, dDays);
    this.updateMoons(date, dDays);

    // Comets.
    const sun = this.sunMesh.position;
    for (const c of this.comets) {
      const p = cometPosition(c.def.elements, date);
      toWorld(p.x, p.y, p.z, tmp);
      c.group.position.set(tmp.x, tmp.y, tmp.z);
      const activity = THREE.MathUtils.clamp(1.6 / p.r - 0.25, 0, 1);
      const len = activity * Math.min(7, 3.2 / Math.max(p.r, 0.3));
      const dir = c.group.position.clone().sub(sun).normalize();
      for (const tail of c.tails) {
        tail.uniforms.uHead.value.copy(c.group.position);
        tail.uniforms.uDir.value.copy(dir);
        tail.uniforms.uLen.value = len;
        tail.uniforms.uTime.value = elapsed;
      }
      c.coma.scale.setScalar(0.15 + activity * 0.9);
      (c.coma.material as THREE.SpriteMaterial).opacity = 0.25 + activity * 0.75;
    }

    // Asteroid belt (each rock on its own Keplerian circle).
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const d = this.beltData;
    for (let i = 0; i < this.belt.count; i++) {
      const o = i * 6;
      const angle = d[o + 1] + d[o + 2] * days;
      const r = toWorldRadius(d[o]);
      pos.set(Math.cos(angle) * r, PLANE_Y + d[o + 3], -Math.sin(angle) * r);
      e.set(d[o + 5] * elapsed * 0.2, d[o + 5] * elapsed * 0.13 + i, 0);
      q.setFromEuler(e);
      s.setScalar(d[o + 4]);
      m.compose(pos, q, s);
      this.belt.setMatrixAt(i, m);
    }
    this.belt.instanceMatrix.needsUpdate = true;

    // Sun: slow rotation and a gentle shimmer.
    this.sunMesh.rotation.y = (days / 25.4) * Math.PI * 2;
    this.sunGlow.material.rotation = elapsed * 0.02;
    const pulse = 1 + Math.sin(elapsed * 0.8) * 0.02;
    this.sunGlow.scale.setScalar(SUN_RADIUS * 7 * pulse);
    void realDt;
  }

  private spin(pv: PlanetVisual, dDays: number) {
    // Cap angular speed so fast-forwarding doesn't strobe.
    const rate = (Math.PI * 2 * 24) / pv.rotationHours; // rad/day
    const delta = THREE.MathUtils.clamp(rate * dDays, -0.12, 0.12);
    pv.spin.rotation.y += delta;
    const clouds = pv.spin.getObjectByName('clouds');
    if (clouds) clouds.rotation.y += delta * 0.08;
  }
}

function toWorldRadius(au: number) {
  toWorld(au, 0, 0, tmp);
  return tmp.x;
}
