import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, length, smoothstep, uniform, uv, vec2 } from 'three/tsl';

/** Layer a moon's sphere moves to while its dot stands in (nothing draws it; rays still find its proxy). */
export const MOON_DOT_LAYER = 9;
/** A moon becomes a dot below this angular radius (radians, ~0.2°: a few pixels on Quest), and a sphere again above the higher one. */
const DOT_BELOW = 0.0035,
  SPHERE_ABOVE = 0.0047;

interface Item {
  mesh: THREE.Mesh;
  colour: THREE.Color;
  /** The colour has been taken from the moon's map (once it loaded). */
  fromMap: boolean;
  dot: boolean;
}

/**
 * Headset: the moons as one draw when they're tiny. Each moon sphere was its
 * own draw call (~22), and at tabletop size a moon is a few pixels across:
 * there, its sphere is swapped for a disc in one instanced sprite, its true
 * size and colour, lit by its phase as seen from the eye (flat, with a little
 * limb darkening: at a few pixels the terminator can't be seen). Close up
 * (VR, or leaning in) the sphere comes back.
 */
export class MoonDots {
  readonly sprite: THREE.Sprite;
  /** Testing: every moon a dot whatever its size. */
  forceDots = false;
  /** Brightness of the full lit face, to match the lit spheres. */
  day = 1.25;
  private items: Item[] = [];
  private offset: THREE.InstancedBufferAttribute;
  private size: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;
  private seen = new WeakSet<THREE.Mesh>();
  private v = new THREE.Vector3();
  private toEye = new THREE.Vector3();
  private toSun = new THREE.Vector3();
  /** Metres per world unit in a headset (the rig's scale), 1 on the desktop. */
  private viewScale = uniform(1);

  constructor(
    private capacity = 64,
    private night = 0.06,
  ) {
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.offset, this.size, this.tint]) a.setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.SpriteNodeMaterial({ transparent: false, depthWrite: true });
    mat.positionNode = instancedBufferAttribute(this.offset) as unknown as THREE.Node<'vec3'>;
    const s = instancedBufferAttribute(this.size) as unknown as THREE.Node<'float'>;
    // (× the view's scale: in a headset the player's rig is scaled, metres per world unit, and
    // three adds a sprite's size after the view transform, so the rig's scale never reaches
    // it; without this the dots came out ~60x too big in the tabletop. Unlike the glows'
    // SPRITE_SCALE, which is 1 at the default VR scale, the dots must be their true size.)
    mat.scaleNode = vec2(s.mul(2), s.mul(2)).mul(this.viewScale);
    // A disc, edge-darkened a little like a lit sphere seen whole.
    const r = length(uv().sub(0.5)).mul(2);
    mat.maskNode = r.lessThan(1);
    mat.colorNode = (instancedBufferAttribute(this.tint) as unknown as THREE.Node<'vec3'>).mul(
      float(1).sub(smoothstep(0.55, 1, r).mul(0.35)),
    );
    this.sprite = new THREE.Sprite(mat);
    this.sprite.name = 'moon-dots';
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.raycast = () => undefined;
  }

  /** Take on these moon spheres (new ones only). */
  add(meshes: { mesh: THREE.Mesh; colour: number | undefined }[]) {
    for (const { mesh, colour } of meshes) {
      if (this.seen.has(mesh) || this.items.length >= this.capacity) continue;
      this.seen.add(mesh);
      this.items.push({ mesh, colour: new THREE.Color(colour ?? 0xb8b0a4), fromMap: false, dot: false });
    }
  }

  /**
   * Per frame, after world matrices: each moon a dot or a sphere by its size
   * as seen from `eye` (world); dots placed, sized and lit from `sun` (world).
   */
  update(eye: THREE.Vector3, sun: THREE.Vector3, viewScale = 1) {
    this.viewScale.value = viewScale;
    const off = this.offset.array as Float32Array;
    const size = this.size.array as Float32Array;
    const tint = this.tint.array as Float32Array;
    let n = 0;
    for (const it of this.items) {
      const m = it.mesh;
      let shown = true;
      for (let o: THREE.Object3D | null = m.parent; o; o = o.parent) if (!o.visible) shown = false;
      const at = this.v.setFromMatrixPosition(m.matrixWorld);
      const e = m.matrixWorld.elements;
      const r = (m.geometry as THREE.SphereGeometry).parameters.radius * Math.hypot(e[0], e[1], e[2]);
      const angle = r / Math.max(1e-6, at.distanceTo(eye));
      it.dot = this.forceDots || (it.dot ? angle < SPHERE_ABOVE : angle < DOT_BELOW);
      m.layers.set(it.dot ? MOON_DOT_LAYER : 0);
      if (!it.dot || !shown || !m.visible) continue;
      if (!it.fromMap) this.colourFromMap(it);
      // How much of the lit half faces the eye (0 new, 1 full), and a little night fill.
      const phase = (1 + this.toEye.copy(eye).sub(at).normalize().dot(this.toSun.copy(sun).sub(at).normalize())) / 2;
      const light = this.night + (this.day - this.night) * phase;
      off[n * 3] = at.x;
      off[n * 3 + 1] = at.y;
      off[n * 3 + 2] = at.z;
      size[n] = r;
      tint[n * 3] = it.colour.r * light;
      tint[n * 3 + 1] = it.colour.g * light;
      tint[n * 3 + 2] = it.colour.b * light;
      n++;
    }
    this.sprite.count = n;
    this.sprite.visible = n > 0;
    this.offset.needsUpdate = this.size.needsUpdate = this.tint.needsUpdate = true;
  }

  /** Back to spheres (leaving the headset). */
  restore() {
    for (const it of this.items) {
      it.mesh.layers.set(0);
      it.dot = false;
    }
    this.sprite.visible = false;
  }

  /** The moon's average colour from its map, once it has loaded (its plain colour until then). */
  private colourFromMap(it: Item) {
    const map = (it.mesh.material as THREE.MeshStandardMaterial).map;
    const img = map?.image as CanvasImageSource | undefined;
    if (!map || !img) return;
    it.fromMap = true;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data;
      let r = 0,
        gr = 0,
        b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        gr += d[i + 1];
        b += d[i + 2];
      }
      const k = 64 * 255;
      // The map is sRGB; the tint works in linear (× the material's own colour).
      it.colour.setRGB(r / k, gr / k, b / k, THREE.SRGBColorSpace).multiply((it.mesh.material as THREE.MeshStandardMaterial).color);
    } catch {
      /* keep the plain colour */
    }
  }
}
