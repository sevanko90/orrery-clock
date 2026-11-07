import * as THREE from 'three/webgpu';
import { BRDF_Lambert, F_Schlick, diffuseContribution, lights, normalView, positionViewDirection, specularColor, specularF90, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

type V3 = Node<'vec3'>;

/**
 * Planet lighting. A body is lit like a world in sunlight, so it shows a day
 * side and a terminator: the Sun (a point light) at full strength and, in
 * place of the scene's fill (hemisphere light and room environment, which
 * light it evenly from all round), a flat dim glow on the night side.
 * Directional lights, there for the woodwork and the Discworld stack, don't
 * reach it.
 */

/** The only light sunlit bodies see. Bodies registers the Sun with it. */
export const SUN_LIGHTS = lights();

/** How far past 90° the sunlight eases out (as an atmosphere scatters it). */
const TERMINATOR_WRAP = 0.25;

/**
 * Direct light with a soft terminator: instead of Lambert's cos, which stops
 * dead at 90° and reads as a hard line against the flat night fill, the
 * diffuse light eases out a little past the terminator. Diffuse only:
 * easing the specular term too makes it spike into flashing glints at the
 * limb. The night side gets a flat fill in place of any environment light.
 */
class SunlitLightingModel extends THREE.PhysicalLightingModel {
  constructor(private night: THREE.Color) {
    super();
  }

  direct(input: Parameters<THREE.PhysicalLightingModel['direct']>[0], builder: Parameters<THREE.PhysicalLightingModel['direct']>[1]) {
    const light = input as unknown as { lightDirection: V3; lightColor: V3; reflectedLight: { directDiffuse: V3; directSpecular: V3 } };
    const { lightDirection, lightColor, reflectedLight } = light;
    // Specular as standard: let the physical model add it, but set its diffuse aside.
    const keep = reflectedLight.directDiffuse;
    reflectedLight.directDiffuse = vec3(0).toVar();
    super.direct(input, builder);
    reflectedLight.directDiffuse = keep;

    const wrap = normalView.dot(lightDirection).add(TERMINATOR_WRAP).div(1 + TERMINATOR_WRAP).saturate();
    const halfDir = lightDirection.add(positionViewDirection).normalize();
    const dotVH = positionViewDirection.dot(halfDir).saturate();
    const F = F_Schlick({ f0: specularColor, f90: specularF90, dotVH }) as unknown as V3;
    const lambert = BRDF_Lambert({ diffuseColor: diffuseContribution }) as unknown as V3;
    keep.addAssign(lightColor.mul(wrap.mul(wrap)).mul(lambert).mul(F.oneMinus()));
  }

  indirect(builder: Parameters<THREE.PhysicalLightingModel['indirect']>[0]) {
    // No environment, no hemisphere: just the night-side fill.
    const ctx = (builder as unknown as { context: { reflectedLight: { indirectDiffuse: V3 } } }).context;
    const lambert = BRDF_Lambert({ diffuseColor: diffuseContribution }) as unknown as V3;
    ctx.reflectedLight.indirectDiffuse.addAssign(vec3(this.night.r, this.night.g, this.night.b).mul(lambert));
  }
}

/** Sunlight colour; the night fill takes the same hue so a body's colour holds across the terminator. */
export const SUN_COLOR = new THREE.Color(0xfff0dd);
/** Flat light on a body's night side, so it stays readable (aesthetics over realism). */
export const NIGHT_FILL = 0.6;

/**
 * Light a body as a world in sunlight. Works on an ordinary
 * MeshStandardMaterial: the WebGPU renderer turns it into a node material at
 * build time, copying its properties across, these overrides included.
 */
export function sunlit(mat: THREE.MeshStandardMaterial, fill = NIGHT_FILL, mirrorSouth = false) {
  const night = SUN_COLOR.clone().multiplyScalar(fill);
  const m = mat as unknown as Record<string, unknown>;
  m.lightsNode = SUN_LIGHTS;
  m.setupEnvironment = () => null;
  m.setupLightingModel = () => new SunlitLightingModel(night);
  // (Tells a VR uber batch which sunlit materials shade alike.)
  mat.userData.sunlit = `${fill}|${mirrorSouth}`;
  if (mirrorSouth) mirrorUnmappedSouth(mat);
}

/**
 * Pluto's map (and a few moons') is black where no spacecraft imaged it.
 * Fill those texels from the mirrored northern hemisphere, blended softly,
 * whenever a map is set.
 */
function mirrorUnmappedSouth(mat: THREE.MeshStandardMaterial) {
  let current: THREE.Texture | null = mat.map;
  Object.defineProperty(mat, 'map', {
    enumerable: true,
    configurable: true,
    get: () => current,
    set: (t: THREE.Texture | null) => {
      current = t ? mirrored(t) : t;
    },
  });
  mat.map = current;
}

function mirrored(t: THREE.Texture): THREE.Texture {
  const img = t.image as CanvasImageSource & { width: number; height: number };
  if (!img?.width) return t;
  const { width: w, height: h } = img;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  // Texture images are stored top row first; with flipY the top row is v = 1 (north).
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  // The threshold is on linear luminance, as the GPU would sample an sRGB map.
  const lin = Array.from({ length: 256 }, (_, v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const smooth = (x: number) => {
    const k = Math.min(1, Math.max(0, (x - 0.01) / 0.04));
    return k * k * (3 - 2 * k);
  };
  for (let y = 0; y < h; y++) {
    const my = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * lin[px[i]] + 0.7152 * lin[px[i + 1]] + 0.0722 * lin[px[i + 2]];
      const k = smooth(lum);
      if (k >= 1) continue;
      const j = (my * w + x) * 4;
      // (Blended in stored sRGB values: close enough for a soft seam.)
      for (let ch = 0; ch < 3; ch++) px[i + ch] = px[j + ch] + (px[i + ch] - px[j + ch]) * k;
    }
  }
  ctx.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(c);
  out.colorSpace = t.colorSpace;
  out.anisotropy = t.anisotropy;
  out.wrapS = t.wrapS;
  out.wrapT = t.wrapT;
  return out;
}
