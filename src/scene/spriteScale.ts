import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

/**
 * Sprites that keep their size relative to the scene at any VR world scale.
 *
 * VR world scale scales the player's rig, so the view itself carries a scale
 * (metres per world unit). three sizes a sprite from its object's own world
 * scale and adds that size after the view transform, so the view's scale
 * never reaches it: at tabletop scale (0.02 m/unit) every glow, marker and
 * label came out ~33× too big against the scene, the Sun's glow swallowing
 * the planets. Every sprite's size is multiplied by `SPRITE_SCALE`: 1 on the
 * desktop and at the default VR scale (so nothing tuned there changes),
 * following the world scale away from it.
 */
export const SPRITE_SCALE = uniform(1);

class ScaledSpriteNodeMaterial extends THREE.SpriteNodeMaterial {
  constructor(parameters?: ConstructorParameters<typeof THREE.SpriteNodeMaterial>[0]) {
    super(parameters);
    this.scaleNode = SPRITE_SCALE;
  }
}

/** Make every plain SpriteMaterial the renderer converts take `SPRITE_SCALE` (sprites with node materials apply it themselves). */
export function installSpriteScale(renderer: THREE.WebGPURenderer) {
  // (addMaterial() refuses to redefine a type, so replace the entry itself.)
  (renderer.library as unknown as { materialNodes: Map<string, unknown> }).materialNodes.set('SpriteMaterial', ScaledSpriteNodeMaterial);
}
