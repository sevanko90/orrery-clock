import * as THREE from 'three/webgpu';

/**
 * Exact occlusion by the two big opaque slabs of the VR scene (scrunch only):
 *
 *  - The hall's floor and walls. The player is always inside the hall and
 *    above its floor; the floor is opaque across the whole hall and the walls
 *    run from it to the roof, so any ray from the eye down to a point under
 *    the floor leaves through floor or wall. Anything wholly under the floor
 *    can't be seen (most of Discworld's turtle and elephants: ~70k triangles).
 *  - The walnut table's top: a solid disc. From above it, a part whose
 *    bounds all project (from the eye) onto that disc is hidden by it.
 *
 * Both are conservative tests on bounding spheres: nothing that could show a
 * pixel is skipped. The transparent particles (Rimfall) are never culled here.
 */
export class Occluders {
  /** Hall interior (world units); null when the hall isn't drawn. */
  hall: { floorY: number; half: number } | null = null;
  /** Table top: an opaque disc at height y. */
  table: { y: number; r: number } | null = null;
  private eye = new THREE.Vector3();
  private active = false;
  /** Parts skipped in the last frame (for the readout). */
  hiddenCount = 0;

  /** Set the eye for this frame (null: test nothing). */
  begin(eye: THREE.Vector3 | null) {
    this.hiddenCount = 0;
    this.active = !!eye;
    if (eye) this.eye.copy(eye);
  }

  private box = new THREE.Box3();

  /** Is a world-space bounding sphere certainly hidden from the eye? */
  hidden(c: THREE.Vector3, r: number): boolean {
    this.box.min.set(c.x - r, c.y - r, c.z - r);
    this.box.max.set(c.x + r, c.y + r, c.z + r);
    return this.hiddenBox(this.box);
  }

  /** Is a world-space box certainly hidden from the eye? */
  hiddenBox(b: THREE.Box3): boolean {
    if (!this.active) return false;
    const e = this.eye;
    const h = this.hall;
    if (h && e.y > h.floorY && Math.abs(e.x) < h.half && Math.abs(e.z) < h.half && b.max.y < h.floorY) {
      this.hiddenCount++;
      return true;
    }
    const t = this.table;
    if (t && e.y > t.y && b.max.y < t.y) {
      // All eight corners of the box must land on the disc, seen from the eye.
      // (The box is convex and wholly below the plane, so then all of it is behind the disc.)
      const r2 = t.r * t.r;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? b.max.x : b.min.x,
          y = i & 2 ? b.max.y : b.min.y,
          z = i & 4 ? b.max.z : b.min.z;
        const k = (e.y - t.y) / (e.y - y);
        const px = e.x + (x - e.x) * k,
          pz = e.z + (z - e.z) * k;
        if (px * px + pz * pz >= r2) return false;
      }
      this.hiddenCount++;
      return true;
    }
    return false;
  }
}
