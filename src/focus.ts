/**
 * Focus helpers.
 *
 * The pass itself only ever wants one number — how far away the sharp plane
 * is — plus, for the tilted model, how that plane is turned. These are the
 * ways of arriving at that number that came up often enough to be worth
 * shipping. All of them are optional: setting `focusDistance` by hand is a
 * perfectly good way to use the library.
 */
import * as THREE from 'three';

const _forward = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/**
 * Distance to a world point along the CAMERA'S VIEW AXIS — not the straight
 * line to it.
 *
 * This matters and is easy to get wrong: the pass compares against linear
 * view-space depth, so a point off to the side of the frame is nearer than
 * its straight-line distance suggests. Using `.distanceTo()` here puts things
 * at the edge of frame slightly out of focus, which reads as a soft lens
 * rather than as a bug, and is therefore hard to track down later.
 */
export function viewDepthTo(camera: THREE.Camera, point: THREE.Vector3): number {
  camera.getWorldPosition(_camPos);
  _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return _v.copy(point).sub(_camPos).dot(_forward);
}

/** The same, for whatever an object's bounding box is centred on. */
export function viewDepthToObject(camera: THREE.Camera, object: THREE.Object3D): number {
  _box.setFromObject(object);
  if (_box.isEmpty()) return viewDepthTo(camera, object.getWorldPosition(_v.clone()));
  return viewDepthTo(camera, _box.getCenter(_v));
}

/**
 * Focus on whatever is under a normalised device coordinate — `pointer` in
 * three's own convention, x and y each -1..1, which is what you get from
 * `(clientX / width) * 2 - 1` and `-(clientY / height) * 2 + 1`.
 *
 * Returns null when the ray hits nothing, so the caller can decide whether to
 * hold the last distance or fall back to something else. Holding is usually
 * right: racking focus to infinity every time the pointer crosses the sky is
 * far more distracting than staying put.
 */
export function focusDistanceAtPointer(
  camera: THREE.Camera,
  scene: THREE.Object3D,
  pointer: THREE.Vector2,
  raycaster = new THREE.Raycaster(),
): number | null {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(scene, true);
  for (const hit of hits) {
    // skip helpers and anything opted out
    if (hit.object.userData?.noFocus) continue;
    if (!hit.object.visible) continue;
    return viewDepthTo(camera, hit.point);
  }
  return null;
}

/**
 * The tilted focus plane, in world space: a point on it and its normal.
 *
 * Pitch and yaw are applied in CAMERA space and then rotated into the world,
 * so "10 degrees of tilt" means the same thing wherever the camera is looking
 * — which is what anyone reaching for a tilt-shift lens expects.
 */
export function computeFocusPlane(
  camera: THREE.Camera,
  focusDistance: number,
  pitchRad: number,
  yawRad: number,
  out: { point: THREE.Vector3; normal: THREE.Vector3 },
): void {
  const forward = _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  out.point.copy(camera.getWorldPosition(_camPos)).addScaledVector(forward, focusDistance);
  const n = _v.set(0, 0, -1);
  const euler = new THREE.Euler(pitchRad, yawRad, 0, 'YXZ');
  n.applyEuler(euler).applyQuaternion(camera.quaternion).normalize();
  out.normal.copy(n);
}

/**
 * A critically damped spring, for moving focus without it snapping.
 *
 * A real lens takes time to rack, and the eye reads an instant change as a cut
 * rather than as a focus pull. Critically damped means it never overshoots,
 * which a focus puller also never does.
 */
export class FocusSpring {
  velocity = 0;

  constructor(public value: number, public stiffness = 42, public damping = 13) {}

  /** Step toward `target` by `dt` seconds. Returns the new value. */
  update(target: number, dt: number): number {
    const step = Math.min(dt, 1 / 30); // one long frame must not launch it
    const a = (target - this.value) * this.stiffness - this.velocity * this.damping;
    this.velocity += a * step;
    this.value += this.velocity * step;
    return this.value;
  }

  /** Jump straight there — for scene changes, where a rack would be wrong. */
  reset(value: number): void {
    this.value = value;
    this.velocity = 0;
  }
}
