import * as THREE from 'three/webgpu';
import type { Materials } from '../materials';
import { SlowZoneMaterial } from '../fictionShaders';
import { sunlit, type Body } from '../bodies';
import { toWorld } from '../layout';
import { cometPosition, sampleOrbit, type CometElements } from '../../astro/orbits';
import { J2000, julianDate } from '../../astro/time';
import { ProgressiveTexture } from '../textures';
import {
  CERES_ORBIT,
  CERES_STATION,
  EROS,
  EROS_ORBIT,
  RING_GATE,
  RING_GATE_AT,
  TYCHO_ORBIT,
  TYCHO_STATION,
  type FictionEntry,
} from '../../fiction/catalog';
import { DEG, SUN, glow, pickProxy } from './shared';

// ---- The Expanse --------------------------------------------------------------------------

const xyz = { x: 0, y: 0, z: 0 };

/** A faint line round a real orbit, like Pluto's. */
function orbitLine(o: CometElements) {
  const pts = sampleOrbit(o.q / (1 - o.e), o.e, o.i, o.node, o.argPeri, 256).map((p) => {
    toWorld(p.x, p.y, p.z, xyz);
    return new THREE.Vector3(xyz.x, xyz.y, xyz.z);
  });
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.16, depthWrite: false }),
  );
}

/** World position of a body on a real orbit at `simMs`; returns its distance from the Sun (AU). */
function placeOnOrbit(o: CometElements, simMs: number, out: THREE.Vector3) {
  const p = cometPosition(o, new Date(simMs));
  toWorld(p.x, p.y, p.z, xyz);
  out.set(xyz.x, xyz.y, xyz.z);
  return p.r;
}

/** An Expanse place: everything it draws, the part that moves (camera target) and its card. */
abstract class ExpansePlace {
  readonly object = new THREE.Group();
  readonly anchor = new THREE.Group();
  body!: Body;
  protected sunDistance = 0;

  constructor(protected entry: FictionEntry) {
    this.object.name = entry.id;
    this.object.add(this.anchor);
  }

  protected makeBody(proxyRadius: number, radius: number, rows: () => [string, string][]) {
    const proxy = pickProxy(proxyRadius);
    this.anchor.add(proxy);
    this.body = {
      id: this.entry.id,
      facts: null,
      name: this.entry.title,
      kind: this.entry.source,
      blurb: this.entry.blurb,
      group: this.anchor,
      pickProxy: proxy,
      radius,
      upgrade: () => undefined,
      available: () => this.object.visible,
      rows,
    };
  }

  abstract update(simMs: number, elapsed: number): void;
}

/** Ceres, hollowed and spun up: a docking spindle through its poles, city lights across its face. */
export class CeresStationPlace extends ExpansePlace {
  private spin = new THREE.Group();

  constructor(mats: Materials) {
    super(CERES_STATION);
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0 });
    new ProgressiveTexture('ceres', (t) => ((mat.map = t), (mat.needsUpdate = true)), THREE.SRGBColorSpace, false).start('1k');
    sunlit(mat);
    this.spin.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 48, 32), mat));
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 8), mats.brass);
    this.spin.add(spindle);
    for (const y of [0.19, -0.19]) {
      const dock = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.005, 6, 20), mats.brassDark);
      dock.rotation.x = Math.PI / 2;
      dock.position.y = y;
      this.spin.add(dock);
    }
    for (let i = 0; i < 36; i++) {
      const light = glow(0xffd27a, 0.7);
      light.scale.setScalar(0.016 + Math.random() * 0.01);
      light.position.copy(new THREE.Vector3().randomDirection()).multiplyScalar(0.143);
      this.spin.add(light);
    }
    this.anchor.add(this.spin);
    this.object.add(orbitLine(CERES_ORBIT));
    this.makeBody(0.3, 0.15, () => [
      ['Orbits', 'The Sun, in the Belt'],
      ['From Sun', `${this.sunDistance.toFixed(2)} AU`],
      ['Port of', 'The Belt'],
    ]);
  }

  update(simMs: number, elapsed: number) {
    this.sunDistance = placeOnOrbit(CERES_ORBIT, simMs, this.anchor.position);
    this.spin.rotation.y = elapsed * 0.15;
  }
}

/** Eros: a lumpy rock, its surface lit from within by blue protomolecule glow. */
export class ErosPlace extends ExpansePlace {
  private rock: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private glows: THREE.Sprite[] = [];

  constructor() {
    super(EROS);
    const geo = new THREE.IcosahedronGeometry(1, 3);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const bump = 1 + 0.12 * Math.sin(v.x * 5 + v.y * 3) * Math.cos(v.z * 4 - v.x * 2) + 0.06 * Math.sin(v.y * 11 + v.z * 7);
      v.multiplyScalar(bump);
      pos.setXYZ(i, v.x * 0.12, v.y * 0.05, v.z * 0.055);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x7d6a58,
      roughness: 1,
      envMapIntensity: 0,
      emissive: 0x2a6bff,
      emissiveIntensity: 0.05,
    });
    sunlit(mat);
    this.rock = new THREE.Mesh(geo, mat);
    this.anchor.add(this.rock);
    for (let i = 0; i < 9; i++) {
      const g = glow(0x5aa8ff, 0);
      g.scale.setScalar(0.04 + Math.random() * 0.04);
      const d = new THREE.Vector3().randomDirection();
      g.position.set(d.x * 0.12, d.y * 0.05, d.z * 0.055);
      this.glows.push(g);
      this.rock.add(g);
    }
    this.object.add(orbitLine(EROS_ORBIT));
    this.makeBody(0.25, 0.12, () => [
      ['Orbit', 'Crosses Mars’s'],
      ['From Sun', `${this.sunDistance.toFixed(2)} AU`],
      ['Infected by', 'The protomolecule'],
    ]);
  }

  update(simMs: number, elapsed: number) {
    this.sunDistance = placeOnOrbit(EROS_ORBIT, simMs, this.anchor.position);
    this.rock.rotation.set(0.4, 0, elapsed * 0.3);
    this.rock.material.emissiveIntensity = 0.05 + 0.04 * Math.sin(elapsed * 1.3);
    this.glows.forEach((g, i) => (g.material.opacity = 0.35 + 0.35 * Math.sin(elapsed * (0.9 + i * 0.13) + i * 2)));
  }
}

/** Tycho Station: a brass hub, a spinning habitat ring on spokes, booms holding a hull. */
export class TychoStationPlace extends ExpansePlace {
  private ring = new THREE.Group();
  private sparks: THREE.Sprite[] = [];

  constructor(mats: Materials) {
    super(TYCHO_STATION);
    const station = new THREE.Group();
    station.rotation.set(0.25, 0, 0.15);
    station.add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 16), mats.brass));
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.013, 8, 48), mats.brassDark);
    torus.rotation.x = Math.PI / 2;
    this.ring.add(torus);
    const spoke = new THREE.CylinderGeometry(0.004, 0.004, 0.13, 6);
    spoke.rotateZ(Math.PI / 2);
    spoke.translate(0.065, 0, 0);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(spoke, mats.brass);
      m.rotation.y = (i * Math.PI) / 2;
      this.ring.add(m);
    }
    station.add(this.ring);
    // Construction booms reaching out to a hull in the making.
    const boom = new THREE.CylinderGeometry(0.004, 0.004, 0.24, 6);
    boom.rotateZ(Math.PI / 2);
    for (const y of [0.03, -0.03]) {
      const m = new THREE.Mesh(boom, mats.brass);
      m.position.set(0.14, y, 0);
      station.add(m);
    }
    const hull = new THREE.CapsuleGeometry(0.024, 0.12, 6, 12);
    hull.rotateZ(Math.PI / 2);
    const h = new THREE.Mesh(hull, mats.copper);
    h.position.set(0.2, 0, 0);
    station.add(h);
    for (let i = 0; i < 5; i++) {
      const s = glow(i % 2 ? 0xfff2c8 : 0x9fd8ff, 0);
      s.scale.setScalar(0.025);
      s.position.set(0.15 + i * 0.025, Math.sin(i * 2.1) * 0.025, Math.cos(i * 1.7) * 0.025);
      this.sparks.push(s);
      station.add(s);
    }
    this.anchor.add(station);
    this.makeBody(0.3, 0.2, () => [
      ['Orbits', 'The Sun, in the Belt'],
      ['From Sun', `${TYCHO_ORBIT.a.toFixed(2)} AU`],
      ['Builds', 'Ships'],
    ]);
  }

  update(simMs: number, elapsed: number) {
    const days = julianDate(new Date(simMs)) - J2000;
    const period = 365.25 * TYCHO_ORBIT.a ** 1.5;
    const lon = (TYCHO_ORBIT.lonAtJ2000 + (360 * days) / period) * DEG;
    const r = TYCHO_ORBIT.a;
    toWorld(r * Math.cos(lon), r * Math.sin(lon), r * Math.sin(TYCHO_ORBIT.i * DEG) * Math.sin(lon), xyz);
    this.anchor.position.set(xyz.x, xyz.y, xyz.z);
    this.ring.rotation.y = elapsed * 0.5;
    this.sparks.forEach((s, i) => {
      const flicker = Math.sin(elapsed * (8 + i * 1.7) + i * 3.3) * Math.sin(elapsed * 3.1 + i);
      s.material.opacity = Math.max(0, flicker) ** 3 * 1.4;
    });
  }
}

/** The Ring: dark alien metal round a shimmering disc, facing the Sun, beyond Uranus. */
export class RingGatePlace extends ExpansePlace {
  private zone = new SlowZoneMaterial();
  private halo = glow(0x6fa0ff, 0.1);

  constructor() {
    super(RING_GATE);
    const au = RING_GATE_AT.au;
    const lon = RING_GATE_AT.lonDeg * DEG;
    toWorld(au * Math.cos(lon), au * Math.sin(lon), 0, xyz);
    this.anchor.position.set(xyz.x, xyz.y, xyz.z);
    const gate = new THREE.Group();
    gate.add(
      new THREE.Mesh(
        new THREE.TorusGeometry(0.8, 0.06, 16, 96),
        new THREE.MeshStandardMaterial({ color: 0x2c3138, metalness: 0.85, roughness: 0.35 }),
      ),
      new THREE.Mesh(new THREE.CircleGeometry(0.76, 64), this.zone),
    );
    this.halo.scale.setScalar(2.2);
    this.anchor.add(this.halo, gate);
    // Face the Sun (once attached, so it aims from where it actually is).
    gate.lookAt(SUN);
    this.makeBody(0.9, 0.85, () => [
      ['Beyond', 'The orbit of Uranus'],
      ['From Sun', `${RING_GATE_AT.au} AU`],
      ['Leads to', 'The slow zone'],
    ]);
  }

  update(_simMs: number, elapsed: number) {
    this.zone.uniforms.uTime.value = elapsed;
  }
}
