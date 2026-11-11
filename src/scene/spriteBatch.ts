import * as THREE from 'three/webgpu';
import { SPRITE_SCALE } from './spriteScale';
import { instancedBufferAttribute, texture, uv } from 'three/tsl';

/** Layer the batched sprites move to: kept as handles for their animation, never drawn themselves. */
export const SPRITE_BATCHED_LAYER = 8;

/**
 * Draws many additive glow sprites as one (VR scrunch: fiction mode's
 * Martian cylinders, Ceres's city lights, the drive flares, ~130 sprites,
 * each its own material and draw call).
 *
 * Every sprite under the roots that uses the same additive glow texture is
 * gathered into one instanced sprite; each frame its instances copy the
 * originals' world position, world scale, colour, opacity and visibility.
 * Additive blending is order-independent, so drawing them together instead
 * of depth-sorted one by one gives the same sum. The originals stay in the
 * scene (on a layer nobody draws) so the scene code keeps animating them.
 */
export class SpriteBatch {
  readonly sprite: THREE.Sprite;
  private items: THREE.Sprite[] = [];
  private offset: THREE.InstancedBufferAttribute;
  private scale: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;
  private tmp = new THREE.Vector3();

  constructor(
    roots: THREE.Object3D[],
    private parent: THREE.Object3D,
  ) {
    let map: THREE.Texture | null = null;
    let renderOrder = 0;
    for (const root of roots) {
      root.traverse((o) => {
        const s = o as THREE.Sprite;
        if (!s.isSprite || s.count > 1) return;
        const m = s.material as THREE.SpriteMaterial;
        if (
          !(m as unknown as { isSpriteMaterial?: boolean }).isSpriteMaterial ||
          m.blending !== THREE.AdditiveBlending ||
          m.depthWrite ||
          !m.map
        )
          return;
        if (m.rotation !== 0 || !m.sizeAttenuation || s.center.x !== 0.5 || s.center.y !== 0.5) return;
        if (map && m.map !== map) return;
        map = m.map;
        renderOrder = s.renderOrder;
        this.items.push(s);
      });
    }
    const n = Math.max(1, this.items.length);
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.scale = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.offset, this.scale, this.tint]) a.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const tint = instancedBufferAttribute(this.tint) as unknown as THREE.Node<'vec4'>;
    const tex = map ? texture(map as THREE.Texture, uv()) : null;
    mat.positionNode = instancedBufferAttribute(this.offset) as unknown as THREE.Node<'vec3'>;
    mat.scaleNode = (instancedBufferAttribute(this.scale) as unknown as THREE.Node<'vec2'>).mul(SPRITE_SCALE);
    // As SpriteMaterial: colour × map, opacity × map alpha.
    mat.colorNode = tex ? tex.rgb.mul(tint.xyz) : tint.xyz;
    mat.opacityNode = tex ? tex.a.mul(tint.w) : tint.w;
    this.sprite = new THREE.Sprite(mat);
    this.sprite.name = 'sprite-batch';
    this.sprite.count = this.items.length;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = renderOrder;
    // Never hit by rays.
    this.sprite.raycast = () => undefined;
    for (const s of this.items) s.layers.set(SPRITE_BATCHED_LAYER);
    if (this.items.length) parent.add(this.sprite);
  }

  get size() {
    return this.items.length;
  }

  /** Copy the originals into the instances (after world matrices are up to date). */
  sync() {
    const off = this.offset.array as Float32Array;
    const sc = this.scale.array as Float32Array;
    const ti = this.tint.array as Float32Array;
    for (let i = 0; i < this.items.length; i++) {
      const s = this.items[i];
      const m = s.material;
      let shown = m.visible && m.opacity > 0;
      for (let o: THREE.Object3D | null = s; shown && o && o !== this.parent; o = o.parent) if (!o.visible) shown = false;
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
    this.sprite.visible = this.items.length > 0;
  }
}
