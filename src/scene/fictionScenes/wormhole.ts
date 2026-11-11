import * as THREE from 'three/webgpu';
import { WormholeMaterial } from '../fictionShaders';
import type { Bodies, Body } from '../bodies';
import { WORMHOLE } from '../../fiction/catalog';
import { SUN, UP, glow, pickProxy } from './shared';

// ---- Interstellar -----------------------------------------------------------------------

export class Wormhole {
  readonly anchor = new THREE.Group();
  readonly body: Body;
  private sphere = new THREE.Mesh(new THREE.SphereGeometry(0.55, 64, 48), new WormholeMaterial());
  private halo = glow(0x8fa8ff, 0.3);
  private saturn = new THREE.Vector3();

  constructor(private bodies: Bodies) {
    this.anchor.name = 'wormhole';
    this.halo.scale.setScalar(1.9);
    this.anchor.add(this.halo, this.sphere);
    const proxy = pickProxy(0.6);
    this.anchor.add(proxy);
    this.body = {
      id: WORMHOLE.id,
      facts: null,
      name: WORMHOLE.title,
      kind: WORMHOLE.source,
      blurb: WORMHOLE.blurb,
      group: this.anchor,
      pickProxy: proxy,
      radius: 0.6,
      upgrade: () => undefined,
      available: () => this.anchor.visible,
      rows: () => [
        ['Near', 'Saturn'],
        ['Leads to', 'Another galaxy'],
      ],
    };
  }

  update(elapsed: number) {
    // Keeps pace with Saturn, a little ahead of it and above the plane.
    this.bodies.positionOf('saturn', this.saturn);
    this.anchor.position.copy(this.saturn).sub(SUN).applyAxisAngle(UP, 0.24).add(SUN);
    this.anchor.position.y += 0.9;
    this.sphere.rotation.y = elapsed * 0.04;
    this.sphere.material.uniforms.uTime.value = elapsed;
    this.halo.material.opacity = 0.26 + 0.05 * Math.sin(elapsed * 0.7);
  }
}
