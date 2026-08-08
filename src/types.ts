/**
 * Public option types for the tilt-shift pass.
 *
 * Everything here is a plain value, so options can be serialised into a URL, a
 * dat.gui, a React prop or an LLM's function call without any translation.
 */

/**
 * How the circle of confusion is decided for a pixel.
 *
 * - `physical` — a real lens: blur grows with distance from the focus plane,
 *   measured along the view axis. What a camera does.
 * - `plane`    — a *tilted* focus plane, the Scheimpflug principle a tilt-shift
 *   lens actually implements. This is the one that makes a real scene look like
 *   a scale model, because the sharp band cuts across depth instead of
 *   following it.
 * - `band`     — an artistic screen-space band. No depth involved; a strip of
 *   the frame stays sharp and everything else blurs. Cheap, and often what
 *   people actually mean by "tilt-shift" on a photograph.
 */
export type FocusModel = 'physical' | 'plane' | 'band';

/** Intermediate buffers, for looking at what the pass is thinking. */
export type DebugView = 'none' | 'depth' | 'coc' | 'near' | 'far';

export type QualityLevel = 'low' | 'medium' | 'high' | 'auto';

export interface TiltShiftOptions {
  /** which model decides the blur — see FocusModel */
  model: FocusModel;

  /** distance from the camera to the sharp plane, in world units */
  focusDistance: number;
  /**
   * Aperture. Not f-stops: this is a direct multiplier on the circle of
   * confusion, so bigger means blurrier. 2 is almost pinhole, 120 is extreme.
   */
  aperture: number;
  /**
   * Depth of field, in world units either side of `focusDistance`, that stays
   * perfectly sharp before the blur starts growing. `physical` only.
   */
  focusRange: number;
  /** Blur ceiling, in full-resolution pixels. The cost knob. */
  maxCoc: number;
  /**
   * Extra blur for the near field. Foreground bokeh is larger than background
   * bokeh at the same distance on a real lens, and the eye notices when it
   * is not.
   */
  nearBoost: number;

  /** Tilt of the focus plane, in degrees. `plane` only. */
  planePitch: number;
  /** Swing of the focus plane, in degrees. `plane` only. */
  planeYaw: number;
  /** Thickness of the sharp slab either side of the plane, in world units. */
  planeThickness: number;
  /** World units over which the near side fades from sharp to fully blurred. */
  nearTransition: number;
  /** The same, on the far side. */
  farTransition: number;

  /** Centre of the sharp band, 0..1 from the top of the frame. `band` only. */
  bandCenter: number;
  /** Half-height of the fully sharp part of the band, 0..1. `band` only. */
  bandHalfWidth: number;
  /** Rotation of the band, in degrees. `band` only. */
  bandAngle: number;
  /** How far past the band the blur takes to reach maximum, 0..1. */
  bandFeather: number;

  /**
   * `auto` watches frame time and steps between the presets on its own; the
   * fixed levels pin the blur resolution and tap count.
   */
  quality: QualityLevel;

  /** Show an intermediate buffer instead of the image. */
  debug: DebugView;
}

export const DEFAULT_OPTIONS: TiltShiftOptions = {
  model: 'physical',
  focusDistance: 6,
  aperture: 42,
  focusRange: 0.35,
  maxCoc: 26,
  nearBoost: 1.15,
  planePitch: 0,
  planeYaw: 0,
  planeThickness: 0.9,
  nearTransition: 1.6,
  farTransition: 2.6,
  bandCenter: 0.5,
  bandHalfWidth: 0.12,
  bandAngle: 0,
  bandFeather: 0.25,
  quality: 'auto',
  debug: 'none',
};
