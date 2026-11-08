import * as THREE from 'three/webgpu';
import { fract, smoothstep, step, uniform, uv, vec3 } from 'three/tsl';

/**
 * Tabletop: a dotted line on the floor from the player's feet to the spot
 * under the orrery, its dots drifting toward it, shown while the orrery is
 * out of view (put back where it was left, it may be behind the player or
 * across the room). In the room's space (metres): add it to the rig.
 */
export class FloorGuide {
  readonly mesh: THREE.Mesh;
  private length = uniform(1);
  private time = uniform(0);
  private opacity = uniform(0);
  private shown = 0;

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // Along the strip: a dot every 12 cm, drifting toward the far end; soft at both ends.
    const along = uv().x.mul(this.length);
    const dot = step(0.55, fract(along.div(0.12).sub(this.time.mul(2))));
    const across = smoothstep(0.5, 0.15, uv().y.sub(0.5).abs());
    const ends = smoothstep(0, 0.25, along).mul(smoothstep(this.length, this.length.sub(0.3), along));
    mat.colorNode = vec3(1.0, 0.78, 0.38);
    mat.opacityNode = dot.mul(across).mul(ends).mul(this.opacity);
    // A unit strip along +x, lying flat; stretched to the length each frame.
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.04).translate(0.5, 0, 0).rotateX(-Math.PI / 2), mat);
    this.mesh.renderOrder = 24;
    this.mesh.visible = false;
    this.mesh.name = 'floor-guide';
  }

  /**
   * Per frame: from the feet under `head` to the floor under `target` (room
   * metres), shown when `want` (fading in or out over ~0.4 s).
   */
  update(dt: number, head: THREE.Vector3, target: THREE.Vector3, want: boolean) {
    this.shown = THREE.MathUtils.clamp(this.shown + (want ? dt : -dt) / 0.4, 0, 1);
    this.opacity.value = this.shown * 0.85;
    this.mesh.visible = this.shown > 0.001;
    if (!this.mesh.visible) return;
    const dx = target.x - head.x,
      dz = target.z - head.z;
    const len = Math.max(0.01, Math.hypot(dx, dz));
    this.length.value = len;
    this.time.value = (performance.now() / 1000) % 600;
    this.mesh.position.set(head.x, 0.01, head.z);
    this.mesh.rotation.set(0, Math.atan2(-dz, dx), 0);
    this.mesh.scale.set(len, 1, 1);
  }
}
