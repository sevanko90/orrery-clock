import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { surfaceUnder, type Surface } from './surfaces';

/** A 1 m square table top at height `y`, centred at (x, z). */
const table = (y: number, x = 0, z = -1): Surface => ({
  matrix: new THREE.Matrix4().makeTranslation(x, y, z),
  polygon: [
    { x: -0.5, z: -0.5 },
    { x: 0.5, z: -0.5 },
    { x: 0.5, z: 0.5 },
    { x: -0.5, z: 0.5 },
  ],
});
const floor: Surface = {
  ...table(0, 0, 0),
  polygon: [
    { x: -5, z: -5 },
    { x: 5, z: -5 },
    { x: 5, z: 5 },
    { x: -5, z: 5 },
  ],
};

describe('surfaces', () => {
  it('finds the table just under a point over it', () => {
    expect(surfaceUnder([table(0.72)], new THREE.Vector3(0.1, 0.8, -1.2), 0.15, 0.05)).toBeCloseTo(0.72);
  });
  it('ignores it when too high above, or off its edge', () => {
    expect(surfaceUnder([table(0.72)], new THREE.Vector3(0.1, 1.0, -1.2), 0.15, 0.05)).toBeNull();
    expect(surfaceUnder([table(0.72)], new THREE.Vector3(0.7, 0.75, -1), 0.15, 0.05)).toBeNull();
  });
  it('takes a little push into the surface', () => {
    expect(surfaceUnder([table(0.72)], new THREE.Vector3(0, 0.69, -1), 0.15, 0.05)).toBeCloseTo(0.72);
    expect(surfaceUnder([table(0.72)], new THREE.Vector3(0, 0.6, -1), 0.15, 0.05)).toBeNull();
  });
  it('picks the highest of those in range (the table, not the floor under it)', () => {
    expect(surfaceUnder([floor, table(0.1)], new THREE.Vector3(0, 0.12, -1), 0.15, 0.05)).toBeCloseTo(0.1);
  });
  it("works for Quest's planes, whose Y axis points down on floors and tables", () => {
    const t = table(0.72);
    t.matrix.multiply(new THREE.Matrix4().makeRotationX(Math.PI));
    expect(surfaceUnder([t], new THREE.Vector3(0.1, 0.8, -1.2), 0.15, 0.05)).toBeCloseTo(0.72);
    expect(surfaceUnder([t], new THREE.Vector3(0.1, 1.0, -1.2), 0.15, 0.05)).toBeNull();
    expect(surfaceUnder([t], new THREE.Vector3(0.1, 0.6, -1.2), 0.15, 0.05)).toBeNull();
  });

  it('works for a turned plane', () => {
    const t = table(0.72);
    t.matrix.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 4));
    // (0.6, 0) from the centre is outside the square unturned, inside it turned 45°.
    expect(surfaceUnder([t], new THREE.Vector3(0.6, 0.75, -1), 0.15, 0.05)).toBeCloseTo(0.72);
  });
});
