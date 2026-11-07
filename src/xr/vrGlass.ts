import * as THREE from 'three/webgpu';
import { abs, dot, float, normalize, normalView, positionView, pow, vec3 } from 'three/tsl';

/**
 * The glass drum, cheaply, for the headset. The desktop glass is a lit,
 * double-sided transparent PBR material: drawn twice (back faces, then
 * front) and lit per pixel, over the whole drum. At the hub viewpoint, close
 * to the drum, it was the costliest pixel work in the scene (hiding it took
 * 52 → 61 fps).
 *
 * The cheap glass is unlit and additive: a faint tint everywhere and a
 * reflection-like sheen toward the grazing edges (Fresnel), which is what
 * the eye reads as glass. Additive light sums in any order, so one pass
 * draws both sides. Swapped on the meshes named 'glass'; `set(false)`
 * restores the original material (telemetry `glass` switches it live).
 */
export class VrGlass {
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private cheap: THREE.MeshBasicNodeMaterial;
  on = false;

  constructor(private root: THREE.Object3D) {
    const facing = abs(dot(normalize(normalView), normalize(positionView.negate())));
    const sheen = pow(float(1).sub(facing), float(3));
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    m.forceSinglePass = true;
    // Cool, slightly blue-white, like the desktop glass's colour; sheen strongest at the edges.
    m.colorNode = vec3(0.86, 0.91, 0.95).mul(sheen.mul(0.24).add(0.03));
    m.name = 'vr-glass';
    this.cheap = m;
  }

  set(on: boolean) {
    this.on = on;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.name !== 'glass') return;
      if (on) {
        if (!this.originals.has(mesh)) this.originals.set(mesh, mesh.material);
        mesh.material = this.cheap;
      } else {
        const was = this.originals.get(mesh);
        if (was) mesh.material = was;
      }
    });
  }
}
