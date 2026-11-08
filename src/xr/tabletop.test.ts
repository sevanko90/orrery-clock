import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TabletopHandling, TABLETOP_SCALE } from './tabletop';

/** A rig placing the orrery's centre (world origin) at `at` in the room, at `m` metres per unit. */
function setup(m = 0.016, at = new THREE.Vector3(0, 0.8, -0.8)) {
  const rig = new THREE.Object3D();
  rig.scale.setScalar(1 / m);
  rig.position.copy(at).multiplyScalar(-1 / m);
  let scale = m;
  const h = new TabletopHandling(rig, () => new THREE.Vector3(), (s) => {
    scale = s;
    rig.scale.setScalar(1 / s);
  });
  /** Where a world point is in the room (metres). */
  const inRoom = (p: THREE.Vector3) => {
    rig.updateMatrix();
    return p.clone().applyMatrix4(rig.matrix.clone().invert());
  };
  return { rig, h, inRoom, scale: () => scale };
}
const hand = (x: number, y: number, z: number, yaw = 0) => {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.set(0, yaw, 0);
  return o;
};
const still = () => ({ left: new THREE.Vector2(), right: new THREE.Vector2() });
const q = new THREE.Quaternion();

describe('tabletop handling', () => {
  it('one grip carries the orrery with the hand', () => {
    const { h, inRoom } = setup();
    const g = hand(0.1, 0.9, -0.5);
    expect(h.update(1 / 72, { ...still(), gripLeft: false, gripRight: true }, { left: null, right: g }, q)).toBe('grab');
    g.position.add(new THREE.Vector3(0.2, -0.1, 0.05));
    h.update(1 / 72, { ...still(), gripLeft: false, gripRight: true }, { left: null, right: g }, q);
    const c = inRoom(new THREE.Vector3());
    expect(c.x).toBeCloseTo(0.2);
    expect(c.y).toBeCloseTo(0.7);
    expect(c.z).toBeCloseTo(-0.75);
  });

  it('turning the hand turns the orrery about the hand, upright', () => {
    const { h, rig, inRoom } = setup();
    const g = hand(0, 0.8, -0.5);
    h.update(1 / 72, { ...still(), gripLeft: true, gripRight: false }, { left: g, right: null }, q);
    g.rotation.set(0, Math.PI / 2, 0);
    h.update(1 / 72, { ...still(), gripLeft: true, gripRight: false }, { left: g, right: null }, q);
    // The centre was 0.3 m in front of the hand (−z); a quarter turn left puts it 0.3 m to its left (−x).
    const c = inRoom(new THREE.Vector3());
    expect(c.x).toBeCloseTo(-0.3);
    expect(c.z).toBeCloseTo(-0.5);
    expect(rig.rotation.x).toBeCloseTo(0);
    expect(rig.rotation.z).toBeCloseTo(0);
  });

  it('tipping the hand back past straight up does not swing the orrery round (no yaw flip)', () => {
    const { h, inRoom } = setup();
    const g = hand(0, 0.8, -0.5);
    const one = { ...still(), gripLeft: false, gripRight: true };
    h.update(1 / 72, one, { left: null, right: g }, q);
    const before = inRoom(new THREE.Vector3());
    for (const deg of [45, 89, 91, 120, 150]) {
      g.rotation.set(THREE.MathUtils.degToRad(deg), 0, 0);
      h.update(1 / 72, one, { left: null, right: g }, q);
      expect(inRoom(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-6);
    }
  });

  it('two grips scale by the spread, within limits', () => {
    const { h, scale } = setup();
    const l = hand(-0.1, 0.9, -0.5);
    const r = hand(0.1, 0.9, -0.5);
    const both = { ...still(), gripLeft: true, gripRight: true };
    h.update(1 / 72, both, { left: l, right: r }, q);
    l.position.x = -0.2;
    r.position.x = 0.2;
    h.update(1 / 72, both, { left: l, right: r }, q);
    expect(scale()).toBeCloseTo(0.032);
    l.position.x = -5;
    r.position.x = 5;
    h.update(1 / 72, both, { left: l, right: r }, q);
    expect(scale()).toBeCloseTo(TABLETOP_SCALE.max);
  });

  it('floating, the left stick drives it away from the player; on a table it only turns', () => {
    const { h, inRoom } = setup();
    const input = { left: new THREE.Vector2(0, 1), right: new THREE.Vector2(), gripLeft: false, gripRight: false };
    h.update(1, input, { left: null, right: null }, q);
    expect(inRoom(new THREE.Vector3()).z).toBeCloseTo(-1.3);
    h.placement = 'table';
    expect(h.update(1, input, { left: null, right: null }, q)).toBe(false);
    expect(inRoom(new THREE.Vector3()).z).toBeCloseTo(-1.3);
  });

  it('settling floats it down onto the surface over a moment, not at once', () => {
    const { h, inRoom } = setup();
    const none = { left: new THREE.Vector2(), right: new THREE.Vector2(), gripLeft: false, gripRight: false };
    h.settle(new THREE.Vector3(), 0.7);
    expect(h.placement).toBe('table');
    h.update(1 / 72, none, { left: null, right: null }, q);
    const y1 = inRoom(new THREE.Vector3()).y;
    expect(y1).toBeLessThan(0.8);
    expect(y1).toBeGreaterThan(0.75);
    for (let i = 0; i < 144; i++) h.update(1 / 72, none, { left: null, right: null }, q);
    expect(inRoom(new THREE.Vector3()).y).toBeCloseTo(0.7, 4);
  });

  it('placeAt puts the base at a room point, turned and scaled as asked, and yaw reads the turn back', () => {
    const { h, inRoom, scale } = setup();
    const base = new THREE.Vector3(0, -2, 0);
    h.placeAt(base, new THREE.Vector3(0.4, 0.75, -1.1), 0.6, 0.02);
    const b = inRoom(base);
    expect(b.x).toBeCloseTo(0.4);
    expect(b.y).toBeCloseTo(0.75);
    expect(b.z).toBeCloseTo(-1.1);
    expect(scale()).toBeCloseTo(0.02);
    expect(h.yaw).toBeCloseTo(0.6);
    // A world point 10 units along +x from the base lands 0.2 m away, turned by 0.6 rad.
    const p = inRoom(new THREE.Vector3(10, -2, 0));
    expect(p.x - 0.4).toBeCloseTo(0.2 * Math.cos(0.6));
    expect(p.z + 1.1).toBeCloseTo(-0.2 * Math.sin(0.6));
  });

  it('the turn keeps the centre where it is', () => {
    const { h, inRoom } = setup();
    const before = inRoom(new THREE.Vector3());
    h.update(0.5, { left: new THREE.Vector2(), right: new THREE.Vector2(1, 0), gripLeft: false, gripRight: false }, { left: null, right: null }, q);
    const after = inRoom(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
    // ...and moves a point off-centre (it did turn).
    expect(inRoom(new THREE.Vector3(10, 0, 0)).distanceTo(before.clone().add(new THREE.Vector3(0.16, 0, 0)))).toBeGreaterThan(0.1);
  });
});
