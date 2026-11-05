import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, min, screenDPR, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Shared uniforms for every distance-sized particle system (rimfall, dust,
 * comet tails, astrophage, embers). Their sizes are tuned for the desktop
 * camera; in VR the eye buffers, field of view and world scale all differ,
 * and the player can stand right inside a cloud of them, where unclamped
 * points balloon to fill the view (and the GPU's fill rate). VR sets
 * `uPointView` to rescale and `uPointMax` to cap them.
 */
export const POINT_UNIFORMS = {
  uPointView: uniform(1),
  uPointMax: uniform(4096),
};

/**
 * A desktop-tuned point size in device pixels (what gl_PointSize took),
 * adjusted for the current view, as the logical-pixel size PointsNodeMaterial
 * expects (it multiplies by the pixel ratio itself).
 */
export function pointSize(devicePx: Node<'float'>) {
  return min(devicePx.mul(POINT_UNIFORMS.uPointView), POINT_UNIFORMS.uPointMax).div(screenDPR);
}

/** Per-particle attributes for an instanced particle sprite. */
export function particleFloat(array: Float32Array) {
  const attr = new THREE.InstancedBufferAttribute(array, 1);
  return { attr, node: instancedBufferAttribute(attr) as unknown as Node<'float'> };
}
export function particleVec3(array: Float32Array, dynamic = false) {
  const attr = new THREE.InstancedBufferAttribute(array, 3);
  if (dynamic) attr.setUsage(THREE.DynamicDrawUsage);
  return { attr, node: instancedBufferAttribute(attr) as unknown as Node<'vec3'> };
}

/**
 * A particle system: one sprite drawn `count` times. WebGPU has no sized
 * points, so particles are camera-facing quads; the material's positionNode
 * places each one, its sizeNode sizes it, and `uv()` stands in for
 * gl_PointCoord. Additive and soft by default.
 */
export function particles(count: number, setup: (mat: THREE.PointsNodeMaterial) => void) {
  const mat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false,
  });
  mat.alphaToCoverage = false;
  setup(mat);
  const sprite = new THREE.Sprite(mat);
  sprite.count = count;
  sprite.frustumCulled = false;
  // Not something to hover or click.
  sprite.raycast = () => undefined;
  return { sprite, mat };
}
