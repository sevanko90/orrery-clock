import * as THREE from 'three/webgpu';
import { astrophageStream } from '../fictionShaders';
import type { Bodies, Body } from '../bodies';
import { SUN_RADIUS } from '../layout';
import { PETROVA_LINE } from '../../fiction/catalog';
import { SUN, UP, glow } from './shared';

// ---- Project Hail Mary: the Petrova line --------------------------------------------------

const ASTROPHAGE = 600;

export class PetrovaLine {
  readonly object = new THREE.Group();
  readonly body: Body;
  private stream: ReturnType<typeof astrophageStream>;
  private haze = glow(0xff4a35, 0.2);
  private sleeve: THREE.Mesh;
  /** A faint continuous glow along the line, under the particles. */
  private core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 1, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff3b2e, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  private mid = new THREE.Group();
  private venus = new THREE.Vector3();
  private from = new THREE.Vector3();

  constructor(private bodies: Bodies) {
    this.object.name = PETROVA_LINE.id;
    const t = new Float32Array(ASTROPHAGE);
    const dir = new Float32Array(ASTROPHAGE);
    const seed = new Float32Array(ASTROPHAGE * 3);
    for (let i = 0; i < ASTROPHAGE; i++) {
      t[i] = Math.random();
      dir[i] = i % 2 ? 1 : -1;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(Math.random());
      // The two flows keep slightly apart, so the line has a little body.
      v.y += dir[i] * 0.15;
      seed.set([v.x, v.y, v.z], i * 3);
    }
    this.stream = astrophageStream(ASTROPHAGE, t, dir, seed);
    const points = this.stream.sprite;

    // An invisible sleeve along the line for hovering and clicking.
    this.sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1, 8, 1, true), new THREE.MeshBasicMaterial({ visible: false }));
    this.haze.scale.setScalar(1.2);
    this.object.add(this.core, points, this.haze, this.sleeve, this.mid);
    this.body = {
      id: PETROVA_LINE.id,
      facts: null,
      name: PETROVA_LINE.title,
      kind: PETROVA_LINE.source,
      blurb: PETROVA_LINE.blurb,
      group: this.mid,
      pickProxy: this.sleeve,
      radius: 1,
      upgrade: () => undefined,
      available: () => this.object.visible,
      rows: () => [
        ['From', 'The Sun'],
        ['To', 'Venus'],
        ['Seen in', 'Infrared'],
        ['The Sun', 'Slowly dimming'],
      ],
    };
  }

  update(elapsed: number) {
    this.bodies.positionOf('venus', this.venus);
    const axis = this.venus.clone().sub(SUN);
    const len = axis.length();
    axis.divideScalar(len);
    // Leave from the Sun's surface, not its centre.
    this.from.copy(SUN).addScaledVector(axis, SUN_RADIUS * 1.02);
    this.stream.uniforms.uFrom.value.copy(this.from);
    this.stream.uniforms.uTo.value.copy(this.venus);
    this.stream.uniforms.uTime.value = elapsed;
    const span = len - SUN_RADIUS;
    this.mid.position.copy(this.from).addScaledVector(axis, span / 2);
    this.sleeve.position.copy(this.mid.position);
    this.sleeve.quaternion.setFromUnitVectors(UP, axis);
    this.sleeve.scale.set(1, span, 1);
    this.core.position.copy(this.mid.position);
    this.core.quaternion.copy(this.sleeve.quaternion);
    this.core.scale.set(1, span, 1);
    this.core.material.opacity = 0.12 + 0.03 * Math.sin(elapsed * 1.7);
    // Breeding haze round Venus.
    this.haze.position.copy(this.venus);
    this.haze.material.opacity = 0.16 + 0.06 * Math.sin(elapsed * 0.9);
  }
}
