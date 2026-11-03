import * as THREE from 'three';
import { PLANET_FACTS, SUN_FACTS, COMETS, type BodyFacts, type CometDef } from '../astro/bodies';
import { cometPosition, planetPosition, sampleOrbit, PLANET_ELEMENTS, type PlanetId } from '../astro/orbits';
import { ARMS, PLANE_Y, PLUTO_SIZE, SUN_RADIUS, toWorld } from './layout';
import { ProgressiveTexture, type TextureTier } from './textures';
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
  radius: number;
  /** Load the highest resolution texture (on focus). */
  upgrade(): void;
  /** Extra info for comets. */
  blurb?: string;
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
  // Mercury's true colour is a slightly warmer, browner grey than the Moon.
  if (id === 'mercury') mat.color.set('#e6d6c0');
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

class TailMaterial extends THREE.ShaderMaterial {
  constructor(color: THREE.Color, spread: number) {
    super({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uHead: { value: new THREE.Vector3() },
        uDir: { value: new THREE.Vector3(1, 0, 0) },
        uLen: { value: 0 },
        uTime: { value: 0 },
        uColor: { value: color },
        uSpread: { value: spread },
        uScale: { value: 300 },
      },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute vec3 aSeed;
        uniform vec3 uHead; uniform vec3 uDir; uniform float uLen; uniform float uTime;
        uniform float uSpread; uniform float uScale;
        varying float vAlpha;
        void main() {
          float t = fract(aT + uTime * 0.05);
          vec3 p = uHead + uDir * (t * uLen) + aSeed * (0.03 + t * uSpread) * uLen;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * (0.06 + 0.1 * (1.0 - t)) / -mv.z;
          vAlpha = (1.0 - t) * (1.0 - t) * step(0.001, uLen);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vAlpha * 0.35;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });
  }
}

interface CometVisual {
  def: CometDef;
  group: THREE.Group;
  coma: THREE.Sprite;
  tails: TailMaterial[];
}

function makeComet(def: CometDef, particles: number): { visual: CometVisual; tailPoints: THREE.Points[]; orbit: THREE.Line } {
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

  const tails: TailMaterial[] = [];
  const tailPoints: THREE.Points[] = [];
  const specs: [string, number][] = [
    ['#bcd7ff', 0.06], // ion tail: narrow, blue
    ['#fff1d6', 0.18], // dust tail: broad, warm
  ];
  for (const [color, spread] of specs) {
    const geo = new THREE.BufferGeometry();
    const t = new Float32Array(particles);
    const seed = new Float32Array(particles * 3);
    for (let i = 0; i < particles; i++) {
      t[i] = Math.random();
      const v = new THREE.Vector3().randomDirection().multiplyScalar(Math.random());
      seed.set([v.x, v.y, v.z], i * 3);
    }
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    // Positions are computed in the shader; give three a dummy attribute + bounds.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particles * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new TailMaterial(new THREE.Color(color), spread);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    tails.push(mat);
    tailPoints.push(pts);
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

export interface BodiesOptions {
  lowQuality: boolean;
}

/**
 * Flat light on a body's night side (irradiance), so it stays readable.
 * Aesthetics over realism: dark worlds and small rocks get extra so they
 * never vanish against the night.
 */
const NIGHT_FILL = 0.6;
const NIGHT_FILL_BOOST: Record<string, number> = { pluto: 1.2, mercury: 0.9, belt: 1.0 };

/** The lighting chunk with directional lights switched off (see sunlit()). */
const SUNLIT_LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.replace(
  'directionalLight = directionalLights[ i ];',
  'directionalLight = directionalLights[ i ];\n\t\tdirectionalLight.color = vec3( 0.0 );',
);

/**
 * Direct light with a soft terminator: instead of Lambert's cos, which stops
 * dead at 90° and reads as a hard line against the flat night fill, the
 * light eases out a little past the terminator (as an atmosphere scatters
 * it). Diffuse only: easing the specular term too makes it spike into
 * flashing glints at the limb, where the specular maths expects no light.
 */
const TERMINATOR_WRAP = 0.25;
const SUNLIT_DIRECT = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
  'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );',
  `float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + ${TERMINATOR_WRAP.toFixed(2)} ) / ${(1 + TERMINATOR_WRAP).toFixed(2)} );
	reflectedLight.directDiffuse += wrapNL * wrapNL * directLight.color * diffuseBRDF * ( 1.0 - F );`,
);

/**
 * Pluto's map is black where New Horizons never imaged it (much of the south).
 * Fill those texels from the mirrored northern hemisphere, blended softly, so
 * Pluto never shows a black hemisphere.
 */
const MIRROR_UNMAPPED_SOUTH = THREE.ShaderChunk.map_fragment.replace(
  'vec4 sampledDiffuseColor = texture2D( map, vMapUv );',
  `vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	vec4 mirroredNorth = texture2D( map, vec2( vMapUv.x, 1.0 - vMapUv.y ) );
	float mappedLum = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	sampledDiffuseColor = mix( mirroredNorth, sampledDiffuseColor, smoothstep( 0.01, 0.05, mappedLum ) );`,
);

if (MIRROR_UNMAPPED_SOUTH === THREE.ShaderChunk.map_fragment || SUNLIT_DIRECT === THREE.ShaderChunk.lights_physical_pars_fragment || SUNLIT_LIGHTS_BEGIN === THREE.ShaderChunk.lights_fragment_begin) {
  console.warn('sunlit(): three.js lighting chunks changed; planet terminators are not applied');
}

/**
 * Light a body like a world in sunlight, so it shows a day side and a
 * terminator: the Sun (a point light) at full strength, and in place of the
 * scene's fill (hemisphere light and the room environment, which light it
 * evenly from all round) a flat, dim glow on the night side. Directional
 * lights, which are there for the woodwork and the Discworld stack, are
 * ignored. (`envMapIntensity: 0` alone doesn't do it: a material without its
 * own envMap takes the scene's environmentIntensity.)
 */
function sunlit(mat: THREE.MeshStandardMaterial, fill = NIGHT_FILL, mirrorSouth = false) {
  mat.onBeforeCompile = (shader) => {
    if (mirrorSouth) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', MIRROR_UNMAPPED_SOUTH);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', SUNLIT_DIRECT)
      .replace('#include <lights_fragment_begin>', SUNLIT_LIGHTS_BEGIN)
      .replace(
        '#include <lights_fragment_end>',
        `irradiance = vec3( ${fill.toFixed(3)} );
iblIrradiance = vec3( 0.0 );
#if defined( RE_IndirectSpecular )
\tradiance = vec3( 0.0 );
#endif
#include <lights_fragment_end>`,
      );
  };
  mat.customProgramCacheKey = () => `sunlit-${fill}${mirrorSouth ? '-mirror' : ''}`;
}

export class Bodies {
  readonly root = new THREE.Group();
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

  constructor(
    private arms: ArmRig[],
    opts: BodiesOptions,
  ) {
    const fullTier: TextureTier = '2k';
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

    this.sunLight = new THREE.PointLight(0xfff0dd, 2.2, 0, 0);
    this.sunLight.position.copy(this.sunMesh.position);
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
