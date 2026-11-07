import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, texture, uv } from 'three/tsl';

/** Layer the batched sprites move to: kept as handles for their animation, never drawn themselves. */
export const SPRITE_BATCHED_LAYER = 8;

/**
 * Draws many additive glow sprites as a few (VR scrunch: fiction mode's
 * Martian cylinders, Ceres's city lights, the drive flares, the shipyard's
 * sparks over Mars, the true-position markers: ~150 sprites, each its own
 * material and draw call).
 *
 * Sprites under the roots that use the same additive glow texture are
 * gathered into one instanced sprite per texture; each frame its instances
 * copy the originals' world position, world scale, colour, opacity and
 * visibility. Additive blending is order-independent, so drawing them
 * together instead of depth-sorted one by one gives the same sum. The
 * originals stay in the scene (on a layer nobody draws) so the scene code
 * keeps animating them.
 */
export class SpriteBatch {
  private buckets: Bucket[] = [];

  constructor(
    roots: THREE.Object3D[],
    private parent: THREE.Object3D,
  ) {
    const groups = new Map<string, THREE.Sprite[]>();
    for (const root of roots) {
      root.traverse((o) => {
        const s = o as THREE.Sprite;
        if (!s.isSprite || s.count > 1 || s.layers.isEnabled(SPRITE_BATCHED_LAYER)) return;
        const m = s.material as THREE.SpriteMaterial;
        if (!(m as unknown as { isSpriteMaterial?: boolean }).isSpriteMaterial || m.blending !== THREE.AdditiveBlending || m.depthWrite || !m.map) return;
        if (m.rotation !== 0 || !m.sizeAttenuation || s.center.x !== 0.5 || s.center.y !== 0.5) return;
        const key = `${m.map.uuid}|${s.renderOrder}|${m.depthTest}|${m.fog}|${m.toneMapped}`;
        const list = groups.get(key);
        if (list) list.push(s);
        else groups.set(key, [s]);
      });
    }
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      this.buckets.push(new Bucket(items, parent));
    }
  }

  get size() {
    return this.buckets.reduce((n, b) => n + b.items.length, 0);
  }

  get objects(): THREE.Object3D[] {
    return this.buckets.map((b) => b.sprite);
  }

  /** Copy the originals into the instances (after world matrices are up to date). */
  sync() {
    for (const b of this.buckets) b.sync(this.parent);
  }

  /** Put the originals back and drop the batches. */
  dispose() {
    for (const b of this.buckets) {
      for (const s of b.items) s.layers.set(0);
      this.parent.remove(b.sprite);
      (b.sprite.material as THREE.Material).dispose();
      b.sprite.geometry.dispose();
    }
    this.buckets = [];
  }
}

/** One texture's sprites, drawn as one instanced sprite. */
class Bucket {
  readonly sprite: THREE.Sprite;
  private offset: THREE.InstancedBufferAttribute;
  private scale: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;
  private tmp = new THREE.Vector3();
  /** Drawn on its first frames even with nothing shown, so its shader is built at once, not on first use. */
  private warm = 3;

  constructor(
    readonly items: THREE.Sprite[],
    parent: THREE.Object3D,
  ) {
    const m0 = items[0].material as THREE.SpriteMaterial;
    const map = m0.map!;
    const n = items.length;
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.scale = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.offset, this.scale, this.tint]) a.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: m0.depthTest, fog: m0.fog, toneMapped: m0.toneMapped, blending: THREE.AdditiveBlending });
    const tint = instancedBufferAttribute(this.tint) as unknown as THREE.Node<'vec4'>;
    const tex = texture(map as THREE.Texture, uv());
    mat.positionNode = instancedBufferAttribute(this.offset) as unknown as THREE.Node<'vec3'>;
    mat.scaleNode = instancedBufferAttribute(this.scale) as unknown as THREE.Node<'vec2'>;
    // As SpriteMaterial: colour × map, opacity × map alpha.
    mat.colorNode = tex.rgb.mul(tint.xyz);
    mat.opacityNode = tex.a.mul(tint.w);
    this.sprite = new THREE.Sprite(mat);
    this.sprite.name = 'sprite-batch';
    this.sprite.count = n;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = items[0].renderOrder;
    // Never hit by rays.
    this.sprite.raycast = () => undefined;
    for (const s of items) s.layers.set(SPRITE_BATCHED_LAYER);
    parent.add(this.sprite);
  }

  sync(parent: THREE.Object3D) {
    const off = this.offset.array as Float32Array;
    const sc = this.scale.array as Float32Array;
    const ti = this.tint.array as Float32Array;
    let any = false;
    for (let i = 0; i < this.items.length; i++) {
      const s = this.items[i];
      const m = s.material;
      let shown = m.visible && m.opacity > 0;
      for (let o: THREE.Object3D | null = s; shown && o && o !== parent; o = o.parent) if (!o.visible) shown = false;
      any ||= shown;
      const e = s.matrixWorld.elements;
      off[i * 3] = e[12];
      off[i * 3 + 1] = e[13];
      off[i * 3 + 2] = e[14];
      // Hidden sprites collapse to nothing.
      sc[i * 2] = shown ? this.tmp.set(e[0], e[1], e[2]).length() : 0;
      sc[i * 2 + 1] = shown ? this.tmp.set(e[4], e[5], e[6]).length() : 0;
      ti[i * 4] = m.color.r;
      ti[i * 4 + 1] = m.color.g;
      ti[i * 4 + 2] = m.color.b;
      ti[i * 4 + 3] = shown ? m.opacity : 0;
    }
    this.offset.needsUpdate = this.scale.needsUpdate = this.tint.needsUpdate = true;
    this.sprite.visible = any || this.warm-- > 0;
  }
}
