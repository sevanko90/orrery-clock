import * as THREE from 'three/webgpu';

/**
 * The hall the orrery hangs in, for VR. Placeholder architecture for the
 * proof of concept: a dark polished floor with a brass compass rose under the
 * instrument, ribbed walls, and an open lattice of roof trusses with the stars
 * showing through. Built in orrery units from the instrument's footprint, so
 * it follows the orrery whatever scale the player is at.
 */
export interface HangarSpec {
  /** Floor height (orrery units). */
  floorY: number;
  /** Half-width of the square hall. */
  half: number;
  /** Roof height (orrery units). */
  roofY: number;
  /** Radius of the instrument's table, for the compass rose. */
  tableRadius: number;
}

export function buildHangar(spec: HangarSpec): THREE.Group {
  const { floorY, half, roofY, tableRadius } = spec;
  const g = new THREE.Group();
  g.name = 'hangar';
  const height = roofY - floorY;

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x141110, roughness: 0.32, metalness: 0.15 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = floorY;
  floor.receiveShadow = true;
  g.add(floor);

  // Brass compass rose inlaid in the floor beneath the instrument.
  // Pulled toward the viewer in depth so it never fights the floor beneath it.
  const brass = new THREE.MeshStandardMaterial({
    color: 0xb08a4a,
    roughness: 0.38,
    metalness: 0.9,
    emissive: 0x2a1a06,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const inlay = new THREE.Group();
  inlay.position.y = floorY + 0.01;
  for (const [r, w] of [
    [tableRadius * 1.08, 0.12],
    [tableRadius * 1.0, 0.09],
    [tableRadius * 0.55, 0.09],
    [tableRadius * 0.12, 0.08],
  ] as const) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 128), brass);
    ring.rotation.x = -Math.PI / 2;
    inlay.add(ring);
  }
  for (let i = 0; i < 16; i++) {
    const long = i % 4 === 0;
    const len = tableRadius * (long ? 1.25 : i % 2 === 0 ? 0.95 : 0.75);
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(long ? 0.14 : 0.09, len), brass);
    ray.rotation.x = -Math.PI / 2;
    ray.position.z = -len / 2;
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / 16) * Math.PI * 2;
    pivot.add(ray);
    inlay.add(pivot);
  }
  g.add(inlay);

  // Walls: dark panels between tall iron ribs, a lit band along the foot.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0d0b0a, roughness: 0.85, metalness: 0.1, side: THREE.BackSide });
  const walls = new THREE.Mesh(new THREE.BoxGeometry(half * 2, height, half * 2), wallMat);
  walls.position.y = floorY + height / 2;
  // Keep only the four sides: open to the stars on top, and no bottom face
  // lying on the floor (the two would flicker against each other).
  const idx = walls.geometry.index!;
  const [, , top, bottom] = walls.geometry.groups;
  const inFace = (i: number, f: { start: number; count: number }) => i >= f.start && i < f.start + f.count;
  const kept = Array.from(idx.array).filter((_, i) => !inFace(i, top) && !inFace(i, bottom));
  walls.geometry.setIndex(kept);
  walls.geometry.clearGroups();
  walls.receiveShadow = true;
  g.add(walls);

  const iron = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.55, metalness: 0.7 });
  const ribEvery = half / 4;
  const rib = new THREE.BoxGeometry(0.35, height, 0.35);
  for (let side = 0; side < 4; side++) {
    for (let k = -4; k <= 4; k++) {
      const m = new THREE.Mesh(rib, iron);
      const along = k * ribEvery;
      const off = half - 0.18;
      if (side === 0) m.position.set(along, 0, -off);
      if (side === 1) m.position.set(along, 0, off);
      if (side === 2) m.position.set(-off, 0, along);
      if (side === 3) m.position.set(off, 0, along);
      m.position.y = floorY + height / 2;
      g.add(m);
    }
  }

  // A warm glow strip at the foot of the walls, so the edges of the hall read in the dark.
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb35a, transparent: true, opacity: 0.35 });
  for (let side = 0; side < 4; side++) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 0.06), glowMat);
    strip.position.y = floorY + 0.4;
    strip.rotation.y = (side * Math.PI) / 2;
    strip.position.x = side === 1 ? -half + 0.08 : side === 3 ? half - 0.08 : 0;
    strip.position.z = side === 0 ? -half + 0.08 : side === 2 ? half - 0.08 : 0;
    g.add(strip);
  }

  // Roof trusses: arched iron girders spanning the hall, open to the sky.
  const truss = new THREE.Group();
  const arch = new THREE.EllipseCurve(0, 0, half, height * 0.18, 0, Math.PI, false);
  const pts = arch.getPoints(48).map((p) => new THREE.Vector3(p.x, p.y, 0));
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.22, 6, false);
  for (let k = -4; k <= 4; k++) {
    const m = new THREE.Mesh(tube, iron);
    m.position.set(0, roofY, k * ribEvery);
    truss.add(m);
  }
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, half * 2), iron);
  spine.position.y = roofY + height * 0.18;
  truss.add(spine);
  g.add(truss);

  g.visible = false;
  return g;
}
