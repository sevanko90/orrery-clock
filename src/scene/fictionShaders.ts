import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  abs,
  atan,
  cameraPosition,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  modelViewMatrix,
  normalViewGeometry,
  normalWorld,
  normalize,
  positionLocal,
  positionViewDirection,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { particleFloat, particleVec3, particles, pointSize } from './pointSize';

/**
 * The fiction scenes' custom effects, in TSL (three's node shading language)
 * so they run on WebGPU and on the WebGL 2 fallback alike. Each material keeps
 * a `uniforms` object of uniform nodes, so scene code sets `.value` as it
 * always has. Colour and opacity are kept apart as the GLSL versions had
 * them (`vec4(colour * a, a)`), so the additive blending adds up the same.
 */

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type UF = THREE.UniformNode<'float', number>;
type UC = THREE.UniformNode<'color', THREE.Color>;

/** 1 − smoothstep(a, b, x): what GLSL's reversed smoothstep(b, a, x) was used for. */
const fadeOut = (a: number, b: number, x: F) => smoothstep(a, b, x).oneMinus();

/** |N·V| in view space, from the geometry's own normal (not flipped on back faces). */
const facing = () => abs(dot(normalize(normalViewGeometry), normalize(positionViewDirection)));

interface GlowOptions {
  side?: THREE.Side;
  additive?: boolean;
  depthWrite?: boolean;
}

/** An unlit material whose colour and opacity come from nodes, plus its uniforms. */
class EffectMaterial<U extends Record<string, { value: unknown }>> extends THREE.MeshBasicNodeMaterial {
  constructor(
    readonly uniforms: U,
    { side = THREE.FrontSide, additive = true, depthWrite = false }: GlowOptions = {},
  ) {
    super({ transparent: true, depthWrite, side, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
  }

  /** Set the output as colour and opacity (the GLSL `vec4(colour * a, a)`). */
  protected output(colour: V3 | Node<'color'>, opacity: F) {
    this.colorNode = colour;
    this.opacityNode = opacity;
  }
}

// ---- Noise (value noise and fBm, as the GLSL had it) ----------------------------------

function hash12(p: V2): F {
  const p0 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const p3 = p0.add(dot(p0, p0.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
}

function vnoise(p: V2): F {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash12(i);
  const b = hash12(i.add(vec2(1, 0)));
  const c = hash12(i.add(vec2(0, 1)));
  const d = hash12(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Five octaves of value noise (unrolled). */
function fbm(p: V2): F {
  let v: F = float(0);
  let q = p;
  let a = 0.5;
  for (let i = 0; i < 5; i++) {
    v = v.add(vnoise(q).mul(a));
    q = q.mul(2.03);
    a *= 0.5;
  }
  return v;
}

function hash13(p0: V3): F {
  const q = fract(p0.mul(0.1031));
  const p = q.add(dot(q, q.zyx.add(31.32)));
  return fract(p.x.add(p.y).mul(p.z));
}

function vnoise3(p: V3): F {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const h = (x: number, y: number, z: number) => hash13(i.add(vec3(x, y, z)));
  return mix(
    mix(mix(h(0, 0, 0), h(1, 0, 0), u.x), mix(h(0, 1, 0), h(1, 1, 0), u.x), u.y),
    mix(mix(h(0, 0, 1), h(1, 0, 1), u.x), mix(h(0, 1, 1), h(1, 1, 1), u.x), u.y),
    u.z,
  );
}

// ---- The War of the Worlds -------------------------------------------------------------

/**
 * A cone of glowing gas: brightest at the apex (the head of the shot),
 * fading toward the open tail and toward its silhouette edges, with a slow
 * shimmer running down it. Additive and double-sided, so it reads as a
 * volume of light rather than a solid.
 */
export class GasConeMaterial extends EffectMaterial<{ uColor: UC; uTime: UF; uOpacity: UF }> {
  constructor(color: THREE.ColorRepresentation) {
    super({ uColor: uniform(new THREE.Color(color)), uTime: uniform(0), uOpacity: uniform(1) }, { side: THREE.DoubleSide });
    const { uColor, uTime, uOpacity } = this.uniforms;
    const along = uv().y; // 1 at the head, 0 at the tail
    const core = pow(facing(), 1.6);
    const shimmer = sin(along.mul(18).sub(uTime.mul(4)).add(uv().x.mul(12.566))).mul(0.3).add(0.7);
    const a = pow(along, 1.6).mul(core).mul(shimmer).mul(uOpacity).mul(0.9);
    this.output(uColor.mul(a), a);
  }
}

// ---- Interstellar ------------------------------------------------------------------------

function starHash(p0: V3): F {
  const p = fract(p0.mul(0.3183099).add(0.1)).mul(17);
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
}

/** Point stars on the sky in direction d. */
function stars(d: V3, scale: number, density: number): V3 {
  const g = d.mul(scale);
  const c = floor(g);
  const f = fract(g).sub(0.5);
  const h = starHash(c);
  const s = step(1 - density, h).mul(fadeOut(0, 0.22, length(f)));
  const tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), starHash(c.add(7)));
  return tint.mul(s).mul(starHash(c.add(3)).mul(0.5).add(0.5));
}

/** The other galaxy: a warm, mottled band with a bright core. */
function galaxy(d: V3): V3 {
  const axis = normalize(vec3(0.3, 1.0, 0.2));
  const lat = dot(d, axis);
  const band = exp(lat.mul(lat).mul(-40));
  // Fine mottling, and a dark dust lane down the middle of the band.
  const mottle = sin(d.x.mul(31).add(d.z.mul(17))).mul(sin(d.y.mul(29).sub(d.x.mul(13)))).mul(0.28).add(0.72);
  const lane = exp(lat.mul(lat).mul(-900)).mul(0.7).oneMinus();
  const toCore = max(dot(d, normalize(vec3(0.8, 0.1, -0.5))), 0);
  const core = pow(toCore, 400);
  const bulge = pow(toCore, 30);
  return vec3(0.95, 0.72, 0.48)
    .mul(band)
    .mul(bulge.mul(0.5).add(0.3))
    .mul(mottle)
    .mul(lane)
    .add(vec3(1.0, 0.9, 0.75).mul(core).mul(1.4));
}

/**
 * The wormhole: a sphere showing another galaxy, bent and flipped as through
 * a glass ball; round its edge our own sky is wrapped into a thin, bright
 * lensing ring. Both depend on the viewing direction, so the view shifts as
 * the camera moves round it. Faint wisps of light drift over the surface.
 */
export class WormholeMaterial extends EffectMaterial<{ uTime: UF }> {
  constructor() {
    super({ uTime: uniform(0) }, { additive: false, depthWrite: true });
    const { uTime } = this.uniforms;
    const N = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(positionWorld));
    const mu = dot(N, V).clamp(0, 1);

    // Through the throat, a fish-eye view of the far side.
    const through = normalize(N.negate().sub(V.mul(0.35)));
    const far = galaxy(through).add(stars(through, 160, 0.05).mul(1.4)).add(vec3(0.01, 0.01, 0.025));

    // Round the edge, our own sky wrapped into a thin bright ring.
    const around = reflect(V.negate(), N);
    const rim = pow(mu.oneMinus(), 6);
    const ring = mu.sub(0.06).div(0.04);
    const lensed = mix(far, stars(around, 90, 0.08).mul(1.6).add(vec3(0.45, 0.55, 1.0).mul(0.18)), rim).add(
      vec3(0.9, 0.95, 1.0).mul(exp(ring.mul(ring).negate())).mul(1.1),
    );

    // Thin streaks of light swirling slowly over the surface.
    const p = normalize(positionLocal);
    const a = atan(p.z, p.x);
    const swirl = sin(a.mul(2).add(p.y.mul(7)).sub(uTime.mul(0.3)));
    const streak = pow(max(swirl, 0), 24).mul(sin(a.mul(5).sub(p.y.mul(3)).add(uTime.mul(0.2))).mul(0.5).add(0.5));
    this.colorNode = lensed.add(vec3(0.6, 0.72, 1.0).mul(streak).mul(0.35).mul(mu.oneMinus().mul(0.75).add(0.25)));
    this.opacityNode = smoothstep(0, 0.1, mu);
  }
}

// ---- The demolition of Earth ---------------------------------------------------------------

/**
 * The hyperspace bypass: a glowing lane that fades out with distance from the
 * orrery's centre, so it runs right across the table and dies away at the rim.
 */
export class LaneMaterial extends EffectMaterial<{ uColor: UC; uOpacity: UF; uRadius: UF }> {
  constructor(radius: number) {
    super({ uColor: uniform(new THREE.Color(0x9fd8ff)), uOpacity: uniform(0), uRadius: uniform(radius) });
    const { uColor, uOpacity, uRadius } = this.uniforms;
    const fade = smoothstep(uRadius.mul(0.5), uRadius, length(positionWorld.xz)).oneMinus();
    const a = uOpacity.mul(fade);
    this.output(uColor.mul(a), a);
  }
}

/**
 * The shockwave: a turbulent ring racing outward on a 2×2 plane. White-hot at
 * the front, cooling through orange to blue as it spreads and fades, with a
 * ragged, wobbling edge and haze trailing behind it.
 */
export class ShockwaveMaterial extends EffectMaterial<{ uAge: UF; uFront: UF; uSeed: UF }> {
  constructor(seed: number) {
    super({ uAge: uniform(0), uFront: uniform(0), uSeed: uniform(seed) }, { side: THREE.DoubleSide });
    const { uAge, uFront, uSeed } = this.uniforms;
    const p = uv().mul(2).sub(1);
    const r = length(p);
    const dir = p.div(max(r, 1e-4));
    const wobble = fbm(dir.mul(3).add(uSeed)).sub(0.5).mul(0.18).mul(uFront);
    const d = r.sub(uFront.add(wobble));
    const width = uAge.mul(0.1).add(0.02);
    const ring = exp(d.mul(d).div(width.mul(width)).negate());
    const haze = step(d, 0).mul(exp(d.div(uFront.mul(0.3).add(0.01))));
    const tex = fbm(p.mul(7).add(vec2(uAge.mul(2), uSeed))).mul(1.1).add(0.35);
    const heat = uAge.oneMinus();
    const cool = vec3(0.35, 0.55, 1.0);
    const warm = vec3(1.0, 0.5, 0.15);
    const hot = vec3(1.0, 0.95, 0.8);
    const col = mix(mix(cool, warm, smoothstep(0, 0.6, heat)), hot, smoothstep(0.65, 1, heat));
    const a = ring.mul(1.7).add(haze.mul(0.3)).mul(tex).mul(pow(uAge.oneMinus(), 1.3));
    this.output(col.mul(a), a);
  }
}

/** The fireball: an expanding shell, brightest round its rim. */
export class FireballMaterial extends EffectMaterial<{ uFade: UF }> {
  constructor() {
    super({ uFade: uniform(0) });
    const { uFade } = this.uniforms;
    const mu = facing();
    const a = pow(mu.oneMinus(), 2).mul(0.75).add(0.25).mul(uFade);
    const col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.75), uFade);
    this.output(col.mul(a), a);
  }
}

/** Glowing cracks spreading over the planet in its last seconds. */
export class CracksMaterial extends EffectMaterial<{ uIntensity: UF; uTime: UF }> {
  constructor() {
    super({ uIntensity: uniform(0), uTime: uniform(0) });
    const { uIntensity, uTime } = this.uniforms;
    const p = normalize(positionLocal);
    const n = vnoise3(p.mul(5)).mul(0.6).add(vnoise3(p.mul(11).add(3.1)).mul(0.4));
    const w = uIntensity.mul(0.06).add(0.012);
    const crack = smoothstep(0, w, abs(n.sub(0.5))).oneMinus();
    const flicker = sin(uTime.mul(23).add(n.mul(40))).mul(0.15).add(0.85);
    const a = crack.mul(1.6).add(0.12).mul(uIntensity).mul(flicker);
    const col = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.4), crack.mul(uIntensity));
    this.output(col.mul(a), a);
  }
}

/**
 * A demolition beam: a hot core with pulses of energy racing down toward
 * Earth, flickering, growing heavier as the moment comes. The cylinder runs
 * from the ship (v = 0) to Earth (v = 1).
 */
export class BeamMaterial extends EffectMaterial<{
  uPower: UF;
  uTime: UF;
  uSeed: UF;
  uEdge: UC;
  uCore: UC;
}> {
  constructor(seed: number, edge = new THREE.Color(1.0, 0.8, 0.35), core = new THREE.Color(1.0, 1.0, 0.92)) {
    super({ uPower: uniform(0), uTime: uniform(0), uSeed: uniform(seed), uEdge: uniform(edge), uCore: uniform(core) });
    const { uPower, uTime, uSeed, uEdge, uCore } = this.uniforms;
    const c = pow(facing(), 2);
    const pulses = pow(sin(uv().y.mul(40).sub(uTime.mul(14)).add(uSeed)).mul(0.5).add(0.5), 8);
    const flick = sin(uTime.mul(37).add(uSeed.mul(3))).mul(0.2).add(0.8);
    const a = uPower.mul(c.mul(0.7).add(0.3)).mul(pulses.mul(1.3).add(0.55)).mul(flick);
    const col = mix(uEdge, uCore, c);
    this.output(col.mul(a), a);
  }
}

const HOLO_CYAN = () => vec3(0.45, 0.9, 1.0);

const gridLine = (x: F, n: number) => {
  const d = abs(fract(x.mul(n)).sub(0.5)).oneMinus().sub(0.5);
  return smoothstep(0, 0.05, d).oneMinus();
};

/**
 * Hologram of the planet that was: a cyan lat-long wireframe with a glowing
 * rim, drawn in from the bottom by a bright scan line, flickering.
 */
export class HoloGlobeMaterial extends EffectMaterial<{ uReveal: UF; uOpacity: UF; uTime: UF }> {
  constructor() {
    super({ uReveal: uniform(0), uOpacity: uniform(0), uTime: uniform(0) }, { side: THREE.DoubleSide });
    const out = holoOut(this.uniforms);
    this.output(out.rgb, out.a);
  }
}

/** The globe's output as one vec4 node (discarding above the reveal line). */
function holoOut({ uReveal, uOpacity, uTime }: { uReveal: UF; uOpacity: UF; uTime: UF }) {
  return Fn(() => {
    const y = uv().y;
    If(y.greaterThan(uReveal), () => {
      Discard();
    });
    const grid = max(gridLine(y, 12), gridLine(uv().x, 24));
    const rim = pow(facing().oneMinus(), 2);
    const k = uReveal.sub(y).div(0.02);
    const edge = exp(k.mul(k).negate()).mul(step(uReveal, 0.999));
    const scan = sin(y.mul(200).sub(uTime.mul(6))).mul(0.15).add(0.85);
    const flicker = sin(uTime.mul(41)).mul(0.1).add(0.9);
    const a = grid.mul(0.8).add(rim.mul(0.35)).add(edge.mul(1.5)).mul(scan).mul(flicker).mul(uOpacity);
    return vec4(mix(HOLO_CYAN(), vec3(1), edge).mul(a), a);
  })();
}

/**
 * The survey line: a dashed holographic line marching along the route the
 * bypass will take, spreading out from Earth's position to the table's rim.
 */
export class SurveyLineMaterial extends EffectMaterial<{
  uReveal: UF;
  uOpacity: UF;
  uTime: UF;
  uRadius: UF;
}> {
  constructor(radius: number) {
    super({ uReveal: uniform(0), uOpacity: uniform(0), uTime: uniform(0), uRadius: uniform(radius) });
    const { uReveal, uOpacity, uTime, uRadius } = this.uniforms;
    const out = Fn(() => {
      const y = uv().y;
      If(abs(y.sub(0.5)).mul(2).greaterThan(uReveal), () => {
        Discard();
      });
      const dash = step(0.45, fract(y.mul(160).sub(uTime.mul(1.5))));
      const fade = smoothstep(uRadius.mul(0.5), uRadius, length(positionWorld.xz)).oneMinus();
      const a = dash.mul(fade).mul(uOpacity).mul(0.9);
      return vec4(mix(vec3(1.0, 0.85, 0.25), HOLO_CYAN(), 0.35).mul(a), a);
    })();
    this.output(out.rgb, out.a);
  }
}

/**
 * The construction sign, as a hologram: hazard stripes and lettering drawn
 * once to a canvas, shown with scanlines, flicker, an occasional glitch, and
 * wiped in from the left.
 */
export class HoloSignMaterial extends EffectMaterial<{ uReveal: UF; uOpacity: UF; uTime: UF }> {
  constructor(map: THREE.Texture) {
    super({ uReveal: uniform(0), uOpacity: uniform(0), uTime: uniform(0) }, { side: THREE.DoubleSide });
    const { uReveal, uOpacity, uTime } = this.uniforms;
    const out = Fn(() => {
      const x = uv().x;
      If(x.greaterThan(uReveal), () => {
        Discard();
      });
      // Now and then a band of the sign slips sideways.
      const glitch = step(0.93, fract(sin(floor(uTime.mul(7))).mul(43758.5453)));
      const shifted = vec2(x.add(glitch.mul(0.012).mul(sin(uv().y.mul(70).add(uTime.mul(30))))), uv().y);
      const tex = texture(map, shifted);
      const scan = sin(uv().y.mul(140).sub(uTime.mul(5))).mul(0.3).add(0.7);
      const flicker = sin(uTime.mul(37)).mul(sin(uTime.mul(13))).mul(0.12).add(0.88);
      const k = uReveal.sub(x).div(0.015);
      const edge = exp(k.mul(k).negate()).mul(step(uReveal, 0.999));
      const a = tex.a.mul(scan).mul(flicker).add(edge.mul(0.8)).mul(uOpacity);
      return vec4(tex.rgb.add(edge).mul(a), a);
    })();
    this.output(out.rgb, out.a);
  }
}

// ---- The Expanse ----------------------------------------------------------------------------

/** The slow zone seen through the Ring: deep blue, rippling outward, brighter toward the rim. */
export class SlowZoneMaterial extends EffectMaterial<{ uTime: UF }> {
  constructor() {
    super({ uTime: uniform(0) }, { side: THREE.DoubleSide, additive: false });
    const { uTime } = this.uniforms;
    const p = uv().mul(2).sub(1);
    const r = length(p);
    const ripple = sin(r.mul(28).sub(uTime.mul(1.2))).mul(0.5).add(0.5);
    const swirl = sin(atan(p.y, p.x).mul(6).add(r.mul(10)).sub(uTime.mul(0.3))).mul(0.5).add(0.5).mul(smoothstep(0, 0.4, r));
    // (Linear colour: the output pass brightens these a lot.)
    const col = mix(vec3(0.001, 0.002, 0.007), vec3(0.015, 0.045, 0.16), pow(ripple, 3).mul(0.6).add(swirl.mul(0.25))).add(
      vec3(0.15, 0.3, 0.7).mul(pow(r, 10)).mul(0.5),
    );
    this.output(col, float(0.9));
  }
}

// ---- Particles ------------------------------------------------------------------------------

/**
 * Astrophage in transit: points flowing between two ends, half outbound and
 * half returning, fanning out toward Venus. Positions are worked out on the
 * GPU from the two ends, so the stream follows Venus round its orbit.
 */
export function astrophageStream(count: number, t: Float32Array, dir: Float32Array, seed: Float32Array) {
  const uniforms = { uFrom: uniform(new THREE.Vector3()), uTo: uniform(new THREE.Vector3()), uTime: uniform(0) };
  const aT = particleFloat(t).node;
  const aDir = particleFloat(dir).node;
  const aSeed = particleVec3(seed).node;
  const colour = new THREE.Color(0xff3b2e);
  const { sprite } = particles(count, (mat) => {
    const k = fract(aT.add(uniforms.uTime.mul(0.035).mul(aDir)));
    const p = uniforms.uFrom.add(uniforms.uTo.sub(uniforms.uFrom).mul(k)).add(aSeed.mul(k.mul(k).mul(0.22).add(0.03)));
    mat.positionNode = p;
    const depth = modelViewMatrix.mul(vec4(p, 1)).z.negate();
    mat.sizeNode = pointSize(float(110).mul(fract(aT.mul(7.31)).mul(0.4).add(0.6)).div(depth));
    const life = smoothstep(0, 0.06, k).mul(fadeOut(0.9, 1, k));
    const a = pow(fadeOut(0, 0.5, length(uv().sub(0.5))), 1.5).mul(life).mul(0.6);
    mat.colorNode = vec3(colour.r, colour.g, colour.b).mul(a);
    mat.opacityNode = a;
  });
  return { sprite, uniforms };
}

/** The blast's embers: one cloud of soft additive points, sized in world units, positions set each frame. */
export function emberCloud(colors: Float32Array) {
  const count = colors.length / 3;
  const pos = particleVec3(new Float32Array(colors.length), true);
  const col = particleVec3(colors).node;
  const uniforms = { uSize: uniform(0.05), uOpacity: uniform(0) };
  // World units to pixels at unit distance for the desktop's 40° view.
  const scale = (innerHeight * Math.min(devicePixelRatio, 2)) / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
  const { sprite } = particles(count, (mat) => {
    mat.positionNode = pos.node;
    const depth = modelViewMatrix.mul(vec4(pos.node, 1)).z.negate();
    mat.sizeNode = pointSize(uniforms.uSize.mul(scale).div(depth));
    const soft = fadeOut(0, 0.5, length(uv().sub(0.5)));
    mat.colorNode = col.mul(soft);
    mat.opacityNode = soft.mul(uniforms.uOpacity);
  });
  sprite.visible = false;
  return { sprite, positions: pos.attr, uniforms };
}
