import * as THREE from 'three/webgpu';
import { GasConeMaterial } from '../fictionShaders';
import { MOON_SYSTEMS, moonSize, sunlit, type Bodies, type Body } from '../bodies';
import { ARMS } from '../layout';
import { ProgressiveTexture } from '../textures';
import { moonLongitude } from '../../astro/sky';
import { BREAKAWAY, BREAKAWAY_DAYS, SPACE_1999 } from '../../fiction/catalog';
import { CONE, DAY, DEG, DOWN, fmtDate, glow, pickProxy, SUN, UP } from './shared';

// ---- Space: 1999 ----------------------------------------------------------------------

const BLAST_BLUE = new THREE.Color(0xcfe4ff);
const DEBRIS = 28;

/**
 * Breakaway: the Moon's waste dumps explode, a white-blue flash and a shell of
 * debris, and the Moon tumbles out of orbit, climbing out of the planets'
 * plane on a plume of blue-white gas until it is lost among the stars. A
 * stand-in Moon plays the part (so it appears even with moons switched off)
 * while the real one is hidden.
 */
export class Breakaway {
  readonly group = new THREE.Group();
  readonly body: Body;
  suppressed = false;
  active = false;
  /** Carries the stand-in Moon along its path (camera target). */
  private holder = new THREE.Group();
  private moon: THREE.Mesh;
  private flash = glow(BLAST_BLUE);
  private debris: { sprite: THREE.Sprite; dir: THREE.Vector3 }[] = [];
  private cone = new THREE.Mesh(CONE, new GasConeMaterial(BLAST_BLUE));
  private flashAge = Infinity;
  private lastSim: number | null = null;
  private since = -1;
  private time = 0;
  private readonly orbit: number;
  private earth = new THREE.Vector3();
  private blastAt = new THREE.Vector3();

  constructor(private bodies: Bodies) {
    this.group.name = 'space1999';
    this.orbit = ARMS.find((a) => a.id === 'earth')!.size * MOON_SYSTEMS.earth![0];
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0 });
    new ProgressiveTexture(
      'moon',
      (t) => {
        mat.map = t;
        mat.needsUpdate = true;
      },
      THREE.SRGBColorSpace,
      false,
    ).start('1k');
    sunlit(mat);
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(moonSize(1737.4), 32, 24), mat);
    this.cone.frustumCulled = false;
    this.holder.add(this.moon);
    this.group.add(this.holder, this.cone, this.flash);
    for (let i = 0; i < DEBRIS; i++) {
      const sprite = glow(i % 3 ? BLAST_BLUE : 0xffffff, 0);
      this.debris.push({ sprite, dir: new THREE.Vector3().randomDirection() });
      this.group.add(sprite);
    }
    const proxy = pickProxy(0.2);
    this.holder.add(proxy);
    this.body = {
      id: SPACE_1999.id,
      facts: null,
      name: SPACE_1999.title,
      kind: SPACE_1999.source,
      blurb: SPACE_1999.blurb,
      group: this.holder,
      pickProxy: proxy,
      radius: 0.15,
      upgrade: () => undefined,
      available: () => this.group.visible,
      rows: () => [
        ['Blast', fmtDate(BREAKAWAY)],
        ['Aboard', 'Moonbase Alpha, 311'],
        ['Moon', this.since < 0 ? 'In Earth orbit' : this.since < BREAKAWAY_DAYS * 0.9 ? 'Leaving Earth' : 'Lost to deep space'],
      ],
    };
  }

  /** Where the runaway Moon is, `days` after the blast (Earth-relative). */
  private flight(days: number, out: THREE.Vector3) {
    const lon = moonLongitude(new Date(BREAKAWAY)) * DEG;
    if (days <= 0) {
      const l = moonLongitude(new Date(BREAKAWAY + days * DAY)) * DEG;
      return out.set(Math.cos(l) * this.orbit, 0, -Math.sin(l) * this.orbit).add(this.earth);
    }
    // Flung out from where it was, swinging round to head away from the Sun
    // (out toward the dark and the stars), and climbing out of the plane.
    const start = new THREE.Vector3(Math.cos(lon), 0, -Math.sin(lon));
    const away = new THREE.Vector3(this.earth.x - SUN.x, 0, this.earth.z - SUN.z).normalize();
    const heading = start.lerp(away, THREE.MathUtils.smoothstep(days, 0, 0.35));
    if (heading.lengthSq() < 1e-4) heading.copy(away); // started dead sunward
    heading.normalize();
    // Steady at first so the departure can be watched, then away for good.
    const dist = this.orbit + 3 * days + 20 * days ** 3;
    return out
      .copy(heading)
      .multiplyScalar(dist)
      .add(this.earth)
      .addScaledVector(UP, 0.8 * (dist - this.orbit));
  }

  /** Stop standing in for the Moon. */
  release() {
    this.bodies.setMoonHidden('moon', false);
  }

  update(simMs: number, dt: number, jumped: boolean) {
    const since = (simMs - BREAKAWAY) / DAY;
    this.since = since;
    this.active = since >= -0.5 && since <= BREAKAWAY_DAYS;
    const prev = this.lastSim;
    this.lastSim = simMs;
    if (prev !== null && !jumped && Math.abs(simMs - prev) < 2 * DAY) {
      if (BREAKAWAY > Math.min(prev, simMs) && BREAKAWAY <= Math.max(prev, simMs)) this.flashAge = 0;
    }
    this.flashAge += dt;
    this.time += dt;

    const show = !this.suppressed && this.active;
    this.group.visible = show || (!this.suppressed && this.flashAge < 3);
    this.bodies.setMoonHidden('moon', show);
    if (!this.group.visible) return;

    this.bodies.positionOf('earth', this.earth);
    this.flight(0, this.blastAt);
    this.flight(since, this.holder.position);
    const lon = moonLongitude(new Date(simMs)) * DEG;
    // Tidally locked until the blast; then it tumbles.
    if (since <= 0) this.moon.rotation.set(0, lon, 0);
    else this.moon.rotation.set(since * 5, lon, since * 2.2);
    this.holder.visible = since < BREAKAWAY_DAYS * 0.95;

    // The blast: a flash that plays in real time, and a shell of debris in sim time.
    const f = Math.exp(-this.flashAge * 1.2);
    this.flash.visible = f > 0.01;
    this.flash.position.copy(this.blastAt);
    this.flash.scale.setScalar(0.45 + 2.4 * Math.exp(-this.flashAge * 2.5));
    this.flash.material.opacity = f;
    const burst = since >= 0 && since < 0.6 ? since / 0.6 : -1;
    for (const d of this.debris) {
      d.sprite.visible = burst >= 0;
      if (burst < 0) continue;
      d.sprite.position.copy(this.blastAt).addScaledVector(d.dir, 0.08 + 1.6 * burst);
      d.sprite.scale.setScalar(0.03 + 0.09 * burst);
      d.sprite.material.opacity = (1 - burst) ** 2 * 0.7;
    }

    // The plume streaming behind the runaway Moon.
    const tail = new THREE.Vector3();
    this.flight(Math.max(0, since - 0.12), tail);
    const back = tail.sub(this.holder.position);
    const len = back.length();
    this.cone.visible = since > 0 && this.holder.visible && len > 0.01;
    if (this.cone.visible) {
      this.cone.position.copy(this.holder.position);
      this.cone.quaternion.setFromUnitVectors(DOWN, back.divideScalar(len));
      const width = Math.min(0.2, len * 0.25);
      this.cone.scale.set(width, len, width);
      this.cone.material.uniforms.uTime.value = this.time;
      this.cone.material.uniforms.uOpacity.value = 1.8 * Math.min(1, since / 0.05) * (1 - since / BREAKAWAY_DAYS);
    }
  }

  /** Earth, and the Moon's path as it leaves. */
  framePoints(): THREE.Vector3[] {
    this.bodies.positionOf('earth', this.earth);
    return [this.earth.clone(), this.flight(0, new THREE.Vector3()), this.flight(0.55, new THREE.Vector3())];
  }
}
