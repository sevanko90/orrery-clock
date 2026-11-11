import * as THREE from 'three/webgpu';
import type { Materials } from '../materials';
import { mergeStaticMeshes } from '../merge';
import type { Body } from '../bodies';
import { UTOPIA_LONGITUDE, UTOPIA_PLANITIA } from '../../fiction/catalog';
import { glow, pickProxy } from './shared';

// ---- Utopia Planitia -----------------------------------------------------------------

/**
 * A brass drydock: an open cage of rails and hoops with a hull inside,
 * welding sparks flickering over it, parked above Utopia Planitia so it
 * turns with Mars.
 */
export class UtopiaPlanitia {
  readonly anchor = new THREE.Group();
  readonly body: Body;
  private sparks: THREE.Sprite[] = [];
  private beacons: THREE.Sprite[] = [];

  constructor(frame: THREE.Object3D, mats: Materials) {
    this.anchor.name = 'utopia';
    // Sphere UVs put the map's longitude L at angle (L + 180)° from −x.
    const phi = ((UTOPIA_LONGITUDE + 180) / 360) * Math.PI * 2;
    const radial = new THREE.Vector3(-Math.cos(phi), 0, Math.sin(phi));
    this.anchor.position.copy(radial).multiplyScalar(0.62);
    // Lie along the orbit: the model's long (x) axis on the tangent.
    const tangent = new THREE.Vector3(-radial.z, 0, radial.x);
    this.anchor.rotation.y = Math.atan2(-tangent.z, tangent.x);
    frame.add(this.anchor);

    const dock = new THREE.Group();
    dock.scale.setScalar(1.15);
    this.anchor.add(dock);

    // Cage: four rails and five hoops.
    const rail = new THREE.CylinderGeometry(0.0035, 0.0035, 0.24, 6);
    rail.rotateZ(Math.PI / 2);
    for (const [y, z] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const m = new THREE.Mesh(rail, mats.brass);
      m.position.set(0, y * 0.04, z * 0.04);
      dock.add(m);
    }
    const hoop = new THREE.TorusGeometry(0.0566, 0.004, 6, 24);
    hoop.rotateY(Math.PI / 2);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(hoop, i % 2 ? mats.brassDark : mats.brass);
      m.position.x = -0.11 + i * 0.055;
      dock.add(m);
    }
    // Gantry arms reaching in to the hull.
    const arm = new THREE.CylinderGeometry(0.002, 0.002, 0.04, 5);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(arm, mats.brassDark);
      m.position.set(-0.06 + i * 0.04, i % 2 ? 0.03 : -0.03, 0);
      dock.add(m);
    }

    // The hull taking shape: a long body and two outboard pods on struts.
    const hull = new THREE.CapsuleGeometry(0.019, 0.1, 6, 14);
    hull.rotateZ(Math.PI / 2);
    dock.add(new THREE.Mesh(hull, mats.copper));
    const band = new THREE.TorusGeometry(0.0195, 0.003, 6, 20);
    band.rotateY(Math.PI / 2);
    for (const x of [-0.03, 0.02]) {
      const m = new THREE.Mesh(band, mats.brass);
      m.position.x = x;
      dock.add(m);
    }
    const pod = new THREE.CapsuleGeometry(0.007, 0.06, 4, 10);
    pod.rotateZ(Math.PI / 2);
    const strut = new THREE.CylinderGeometry(0.0025, 0.0025, 0.03, 5);
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(pod, mats.brassDark);
      m.position.set(-0.03, 0.022, side * 0.03);
      dock.add(m);
      const s = new THREE.Mesh(strut, mats.brass);
      s.position.set(-0.03, 0.012, side * 0.016);
      s.rotation.x = side * 0.9;
      dock.add(s);
    }

    // Welding sparks and red beacons at the cage's ends.
    for (let i = 0; i < 7; i++) {
      const s = glow(i % 2 ? 0xfff2c8 : 0x9fd8ff, 0);
      s.scale.setScalar(0.02);
      s.position.set(-0.07 + i * 0.023, Math.sin(i * 1.7) * 0.022, Math.cos(i * 2.3) * 0.022);
      this.sparks.push(s);
      dock.add(s);
    }
    for (const x of [-0.125, 0.125]) {
      const b = glow(0xff5040, 0);
      b.scale.setScalar(0.03);
      b.position.set(x, 0.04, 0.04);
      this.beacons.push(b);
      dock.add(b);
    }

    // The dock's ~21 static parts drawn as one mesh per material (a speck at tabletop size, it was ~21 draws).
    mergeStaticMeshes(dock);

    const proxy = pickProxy(0.16);
    this.anchor.add(proxy);
    this.body = {
      id: UTOPIA_PLANITIA.id,
      facts: null,
      name: UTOPIA_PLANITIA.title,
      kind: UTOPIA_PLANITIA.source,
      blurb: UTOPIA_PLANITIA.blurb,
      group: this.anchor,
      pickProxy: proxy,
      radius: 0.15,
      upgrade: () => undefined,
      available: () => this.anchor.visible,
      rows: () => [
        ['Orbits', 'Mars'],
        ['Station', `Above ${UTOPIA_LONGITUDE}° E`],
        ['Builds', 'Starships'],
      ],
    };
  }

  update(elapsed: number) {
    this.sparks.forEach((s, i) => {
      const flicker = Math.sin(elapsed * (9 + i * 1.3) + i * 4.1) * Math.sin(elapsed * 3.7 + i * 2.2);
      s.material.opacity = Math.max(0, flicker) ** 3 * 1.4;
    });
    const blink = elapsed % 1.6 < 0.18 ? 1 : 0;
    this.beacons.forEach((b) => (b.material.opacity = blink * 0.9));
  }
}
