import * as THREE from 'three/webgpu';
import { BATCHED_LAYER } from '../scene/batch';
import type { Occluders } from './occlusion';

/** Layer culled details are moved to: the cameras don't draw it (and rays don't hit it). */
const CULLED = 7;
/**
 * The occlusion test (scrunch) runs every frame but may see world matrices a
 * frame old: pad it by more than anything moves in a frame (Discworld's
 * elephants rise at ~26 units/s while it assembles: 0.4 units a frame).
 */
const OCCLUSION_MARGIN = 0.6;

/**
 * Skips drawing meshes too small to see from where the player is: rivets,
 * gear teeth, ear details, distant moons. Each costs a draw call per eye
 * whatever its size on screen, and draw calls are what the headset runs out
 * of. Works through layers rather than `visible`, so it never fights the code
 * that shows and hides things.
 */
export class DetailCuller {
  private meshes: { mesh: THREE.Mesh; centre: THREE.Vector3; radius: number; box: THREE.Box3; big: boolean; instanced: boolean }[] = [];
  private box = new THREE.Box3();
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
        if (!m.isMesh || (m as THREE.BatchedMesh).isBatchedMesh) return;
        // Instanced meshes (rivets) are only ever tested for occlusion, as a whole.
        const instanced = !!(m as THREE.InstancedMesh).isInstancedMesh;
        // Batched parts are drawn (and culled) by their batch.
        if (m.layers.isEnabled(BATCHED_LAYER)) return;
        // Pick proxies are invisible meshes that rays must always find.
        const mat = m.material as THREE.Material;
        if (!Array.isArray(m.material) && mat.visible === false) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const s = m.geometry.boundingSphere!;
        let box: THREE.Box3;
        if (instanced) {
          (m as THREE.InstancedMesh).computeBoundingBox();
          box = (m as THREE.InstancedMesh).boundingBox!.clone();
        } else {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          box = m.geometry.boundingBox!;
        }
        this.meshes.push({ mesh: m, centre: s.center.clone(), radius: s.radius, box, big: true, instanced });
      });
    }
  }

  /**
   * Cull anything whose bounding sphere subtends less than `minAngle`
   * (radians) from `eye`; the size test is spread over a few frames to keep
   * it cheap. With `occ` (scrunch), also cull, every frame, what it finds
   * certainly hidden.
   */
  update(eye: THREE.Vector3, minAngle: number, occ?: Occluders) {
    const n = this.meshes.length;
    if (!n) return;
    const share = 4;
    const part = this.frame++ % share;
    for (let i = 0; i < n; i++) {
      const m = this.meshes[i];
      const { mesh, centre, radius } = m;
      if (!m.instanced && i % share === part) {
        const e = mesh.matrixWorld.elements;
        const scale = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
        const at = this.tmp.copy(centre).applyMatrix4(mesh.matrixWorld);
        m.big = radius * scale > at.distanceTo(eye) * minAngle;
      } else if (!occ && i % share !== part) continue;
      let show = m.big;
      if (show && occ && !transparent(mesh)) {
        const b = this.box.copy(m.box).applyMatrix4(mesh.matrixWorld).expandByScalar(OCCLUSION_MARGIN);
        show = !occ.hiddenBox(b);
      }
      mesh.layers.set(show ? 0 : CULLED);
    }
  }

  /** Put everything back on the default layer. */
  restore() {
    for (const m of this.meshes) {
      m.mesh.layers.set(0);
      m.big = true;
    }
  }
}

/** Transparent things (the Rimfall's spray, glass) are never treated as hidden: they may straddle what hides them. */
function transparent(m: THREE.Mesh) {
  const mat = m.material as THREE.Material | THREE.Material[];
  return Array.isArray(mat) ? mat.some((x) => x.transparent) : mat.transparent;
}
