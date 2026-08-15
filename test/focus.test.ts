import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeFocusPlane, FocusSpring, viewDepthTo } from '../src/focus';

const cam = (pos: [number, number, number], lookAt: [number, number, number]) => {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  c.position.set(...pos);
  c.lookAt(new THREE.Vector3(...lookAt));
  c.updateMatrixWorld(true);
  return c;
};

describe('viewDepthTo', () => {
  it('measures along the view axis, not straight-line distance', () => {
    const c = cam([0, 0, 10], [0, 0, 0]);
    // straight ahead: the two agree
    expect(viewDepthTo(c, new THREE.Vector3(0, 0, 0))).toBeCloseTo(10, 5);
    // off to the side: the straight line is longer than the depth
    const off = new THREE.Vector3(6, 0, 0);
    expect(viewDepthTo(c, off)).toBeCloseTo(10, 5);
    expect(c.position.distanceTo(off)).toBeGreaterThan(11);
  });

  it('is negative behind the camera', () => {
    const c = cam([0, 0, 10], [0, 0, 0]);
    expect(viewDepthTo(c, new THREE.Vector3(0, 0, 12))).toBeLessThan(0);
  });
});

describe('computeFocusPlane', () => {
  const out = () => ({ point: new THREE.Vector3(), normal: new THREE.Vector3() });

  it('puts the plane at the focus distance, facing the camera', () => {
    const c = cam([0, 0, 10], [0, 0, 0]);
    const o = out();
    computeFocusPlane(c, 4, 0, 0, o);
    expect(o.point.z).toBeCloseTo(6, 5);
    expect(o.normal.z).toBeCloseTo(-1, 5);
  });

  it('tilts in camera space, so the angle means the same thing anywhere', () => {
    const o1 = out();
    const o2 = out();
    computeFocusPlane(cam([0, 0, 10], [0, 0, 0]), 4, Math.PI / 6, 0, o1);
    computeFocusPlane(cam([10, 0, 0], [0, 0, 0]), 4, Math.PI / 6, 0, o2);
    const fwd1 = new THREE.Vector3(0, 0, -1);
    const fwd2 = new THREE.Vector3(-1, 0, 0);
    // same angle to each camera's own forward
    expect(o1.normal.angleTo(fwd1)).toBeCloseTo(o2.normal.angleTo(fwd2), 5);
  });

  it('is unit length whatever the tilt', () => {
    const o = out();
    for (const [p, y] of [[0, 0], [0.4, 0], [0, 0.7], [0.9, -0.5]]) {
      computeFocusPlane(cam([1, 2, 3], [0, 0, 0]), 5, p, y, o);
      expect(o.normal.length()).toBeCloseTo(1, 6);
    }
  });
});

describe('FocusSpring', () => {
  it('reaches the target without overshooting it', () => {
    const s = new FocusSpring(0);
    let max = 0;
    for (let i = 0; i < 400; i++) max = Math.max(max, s.update(10, 1 / 60));
    expect(s.value).toBeCloseTo(10, 2);
    expect(max).toBeLessThanOrEqual(10.001); // critically damped: no overshoot
  });

  it('cannot be launched by one long frame', () => {
    const s = new FocusSpring(0);
    s.update(100, 5); // a five second "frame"
    expect(Math.abs(s.value)).toBeLessThan(100);
  });

  it('resets without a rack', () => {
    const s = new FocusSpring(0);
    s.update(10, 0.5);
    s.reset(3);
    expect(s.value).toBe(3);
    expect(s.velocity).toBe(0);
  });
});
