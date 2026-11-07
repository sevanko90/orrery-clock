import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hiddenByDisc, type DiscCap } from './discOcclusion';

// A solid cylinder (the table) from y = 0.12 to 0.26, radius 19.25 at the bottom, 19.5 at the top.
const caps: DiscCap[] = [
  { y: 0.26, radius: 19.5 },
  { y: 0.12, radius: 19.25 },
];
const R = (y: number) => 19.25 + ((y - 0.12) / 0.14) * 0.25;

/** Does the segment eye→p pass through the solid (sampled finely)? */
function blocked(eye: THREE.Vector3, p: THREE.Vector3) {
  const q = new THREE.Vector3();
  for (let i = 1; i < 4000; i++) {
    q.lerpVectors(eye, p, i / 4000);
    if (q.y >= 0.12 && q.y <= 0.26 && Math.hypot(q.x, q.z) <= R(q.y)) return true;
  }
  return false;
}

describe('Disc occlusion', () => {
  it('never hides a sphere any point of which the eye can see', () => {
    let rnd = 7;
    const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
    let hidden = 0;
    for (let n = 0; n < 400; n++) {
      const eye = new THREE.Vector3((rand() - 0.5) * 60, (rand() - 0.5) * 30, (rand() - 0.5) * 60);
      const c = new THREE.Vector3((rand() - 0.5) * 40, (rand() - 0.5) * 20, (rand() - 0.5) * 40);
      const r = rand() * 3;
      if (!hiddenByDisc(caps, eye, c, r)) continue;
      hidden++;
      // Every sampled point of the sphere's surface must be blocked.
      for (let k = 0; k < 60; k++) {
        const p = new THREE.Vector3().randomDirection().multiplyScalar(r).add(c);
        expect(blocked(eye, p)).toBe(true);
      }
    }
    expect(hidden).toBeGreaterThan(20);
  });

  it('hides the elephants from the deck and the planets from the shell', () => {
    const deck = new THREE.Vector3(8, 0.26 + 1.07, 0);
    expect(hiddenByDisc(caps, deck, new THREE.Vector3(9, -4, 3), 3)).toBe(true);
    const shell = new THREE.Vector3(0, -6, 0);
    expect(hiddenByDisc(caps, shell, new THREE.Vector3(-9, 7.9, -4.6), 1)).toBe(true);
    // From out past the rim, level with it: nothing hidden.
    expect(hiddenByDisc(caps, new THREE.Vector3(30, 0.2, 0), new THREE.Vector3(0, 8, 0), 1)).toBe(false);
  });
});
