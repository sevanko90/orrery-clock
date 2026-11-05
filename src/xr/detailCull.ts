import * as THREE from 'three/webgpu';

/** Layer culled details are moved to: the cameras don't draw it (and rays don't hit it). */
const CULLED = 7;

/**
 * Skips drawing meshes too small to see from where the player is: rivets,
 * gear teeth, ear details, distant moons. Each costs a draw call per eye
 * whatever its size on screen, and draw calls are what the headset runs out
 * of. Works through layers rather than `visible`, so it never fights the code
 * that shows and hides things.
 */
export class DetailCuller {
  private meshes: { mesh: THREE.Mesh; centre: THREE.Vector3; radius: number }[] = [];
  private roots: THREE.Object3D[] = [];
  private frame = 0;
  private tmp = new THREE.Vector3();

  /** Watch these subtrees (rebuilds the list if they changed). */
  setRoots(roots: THREE.Object3D[]) {
    if (roots.length === this.roots.length && roots.every((r, i) => r === this.roots[i])) return;
    this.restore();
    this.roots = roots;
    this.meshes = [];
    for (const root of roots) {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
        // Pick proxies are invisible meshes that rays must always find.
        const mat = m.material as THREE.Material;
        if (!Array.isArray(m.material) && mat.visible === false) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const s = m.geometry.boundingSphere!;
        this.meshes.push({ mesh: m, centre: s.center.clone(), radius: s.radius });
      });
    }
  }

  /**
   * Cull anything whose bounding sphere subtends less than `minAngle`
   * (radians) from `eye`. Spread over a few frames to keep it cheap.
   */
  update(eye: THREE.Vector3, minAngle: number) {
    const n = this.meshes.length;
    if (!n) return;
    const share = 4;
    const part = this.frame++ % share;
    for (let i = part; i < n; i += share) {
      const { mesh, centre, radius } = this.meshes[i];
      const e = mesh.matrixWorld.elements;
      const scale = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
      const at = this.tmp.copy(centre).applyMatrix4(mesh.matrixWorld);
      const big = radius * scale > at.distanceTo(eye) * minAngle;
      if (big) mesh.layers.set(0);
      else mesh.layers.set(CULLED);
    }
  }

  /** Put everything back on the default layer. */
  restore() {
    for (const { mesh } of this.meshes) mesh.layers.set(0);
  }
}
