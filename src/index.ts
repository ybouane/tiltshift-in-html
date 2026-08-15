/**
 * tiltshift-in-html — depth-aware tilt-shift optics for Three.js.
 *
 * https://github.com/ybouane/tiltshift-in-html
 * Live demo: https://tiltshift-in-html.ybouane.com/
 */
export { TiltShift } from './TiltShift';
export {
  DEFAULT_OPTIONS,
  type TiltShiftOptions,
  type FocusModel,
  type DebugView,
  type QualityLevel,
} from './types';
export {
  viewDepthTo,
  viewDepthToObject,
  focusDistanceAtPointer,
  computeFocusPlane,
  FocusSpring,
} from './focus';
export { QUALITY_PRESETS, AdaptiveQuality, type QualitySettings } from './quality';
