import type * as THREE from 'three/webgpu';

/**
 * No glass in the drum for the headset. The desktop glass is a lit,
 * double-sided transparent PBR material, drawn twice over the whole drum;
 * at the hub viewpoint it was the costliest pixel work in the scene (hiding
 * it took 52 → 61 fps). In VR the player walks through it anyway, so the
 * mechanism stands open in its brass frame instead. (A cheap unlit glass
 * was tried first: +4 fps at hub, 3f009a1.)
 *
 * Hides the meshes named 'glass'; `set(false)` shows them again.
 */
export class VrGlass {
  on = false;

  constructor(private root: THREE.Object3D) {}

  /** true: no glass. */
  set(on: boolean) {
    this.on = on;
    this.root.traverse((o) => {
      if (o.name === 'glass') o.visible = !on;
    });
  }
}
