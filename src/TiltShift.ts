/**
 * TiltShift — depth-aware tilt-shift optics for a Three.js scene.
 *
 * Drop-in: wherever you called `renderer.render(scene, camera)`, call
 * `tiltShift.render(scene, camera)` instead. Everything else is options.
 */
import * as THREE from 'three';
import { Pipeline, type UniformState } from './pipeline';
import { AdaptiveQuality, QUALITY_PRESETS, resolveQuality, type QualitySettings } from './quality';
import { computeFocusPlane } from './focus';
import { DEFAULT_OPTIONS, type TiltShiftOptions } from './types';

const _planePoint = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _viewPoint = new THREE.Vector3();
const _viewNormal = new THREE.Vector3();
const _quatInv = new THREE.Quaternion();

export class TiltShift {
  /** Current options. Read freely; change them with `set()`. */
  readonly options: TiltShiftOptions;

  private pipeline: Pipeline;
  private adaptive = new AdaptiveQuality();
  private quality: QualitySettings = QUALITY_PRESETS.high;
  private width = 0;
  private height = 0;
  private lastFrameAt = 0;
  private disposed = false;

  /**
   * @param renderer  an existing WebGLRenderer. The pass renders into its own
   *                  targets and composites to whatever target you ask for, so
   *                  it does not care how the renderer was configured — except
   *                  that it must be WebGL2, which three has required since
   *                  r163 anyway.
   */
  constructor(private renderer: THREE.WebGLRenderer, options: Partial<TiltShiftOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.pipeline = new Pipeline(renderer);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
  }

  /**
   * Change any subset of the options.
   *
   * Cheap — nothing is reallocated unless the quality level moves — so calling
   * it every frame from a UI binding is fine.
   */
  set(patch: Partial<TiltShiftOptions>): this {
    const qualityChanged = patch.quality !== undefined && patch.quality !== this.options.quality;
    Object.assign(this.options, patch);
    if (qualityChanged) this.applyQuality(true);
    return this;
  }

  /**
   * Resize the internal targets. Give it DRAWING BUFFER pixels, not CSS
   * pixels: `renderer.getDrawingBufferSize()` is the number you want, and
   * passing CSS pixels on a retina display renders the whole pass at half
   * resolution and looks like a mysterious loss of sharpness.
   */
  setSize(width: number, height: number): this {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pipeline.setSize(this.width, this.height, this.quality.blurScale);
    this.pipeline.setTaps(this.quality.dofTaps);
    return this;
  }

  /** Follow the renderer's current size. Call it from your resize handler. */
  syncSize(): this {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x !== this.width || size.y !== this.height) this.setSize(size.x, size.y);
    return this;
  }

  /**
   * Render the scene with tilt-shift applied.
   *
   * @param target  where to composite; null (the default) is the canvas. Pass
   *                a render target to keep going with your own passes.
   */
  render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    target: THREE.WebGLRenderTarget | null = null,
  ): this {
    if (this.disposed) return this;
    const now = performance.now();
    const frameMs = this.lastFrameAt ? now - this.lastFrameAt : 16.7;
    this.lastFrameAt = now;
    if (this.options.quality === 'auto' && this.adaptive.update(frameMs)) this.applyQuality(false);

    const o = this.options;

    // The tilted plane is derived in camera space and handed to the shader in
    // VIEW space, because that is the space the depth buffer is already in —
    // converting the other way, per pixel, would cost a matrix multiply for
    // every fragment to arrive at the same answer.
    computeFocusPlane(
      camera,
      o.focusDistance,
      THREE.MathUtils.degToRad(o.planePitch),
      THREE.MathUtils.degToRad(o.planeYaw),
      { point: _planePoint, normal: _planeNormal },
    );
    _viewPoint.copy(_planePoint).applyMatrix4(camera.matrixWorldInverse);
    _quatInv.copy(camera.quaternion).invert();
    _viewNormal.copy(_planeNormal).applyQuaternion(_quatInv);

    const state: UniformState = {
      focusModel: o.model,
      focusDistance: o.focusDistance,
      aperture: o.aperture,
      focusRange: o.focusRange,
      maxCoc: o.maxCoc,
      nearBoost: o.nearBoost,
      planePointView: _viewPoint,
      planeNormalView: _viewNormal,
      planeThickness: o.planeThickness,
      planeNearTransition: o.nearTransition,
      planeFarTransition: o.farTransition,
      bandCenter: o.bandCenter,
      bandHalfWidth: o.bandHalfWidth,
      bandAngle: THREE.MathUtils.degToRad(o.bandAngle),
      bandFeather: o.bandFeather,
      debug: o.debug,
    };
    this.pipeline.updateUniforms(camera, state);
    this.pipeline.render(scene, camera, target);
    return this;
  }

  /** The focus plane in world space, for drawing a helper or debugging. */
  getFocusPlane(camera: THREE.Camera, out = { point: new THREE.Vector3(), normal: new THREE.Vector3() }) {
    computeFocusPlane(
      camera,
      this.options.focusDistance,
      THREE.MathUtils.degToRad(this.options.planePitch),
      THREE.MathUtils.degToRad(this.options.planeYaw),
      out,
    );
    return out;
  }

  /** Which preset is in force — useful when `quality: 'auto'` is driving. */
  get activeQuality(): QualitySettings & { level: string } {
    return { ...this.quality, level: this.options.quality === 'auto' ? this.adaptive.level : this.options.quality };
  }

  /** The colour target the scene was rendered into, with its depth texture. */
  get sceneTarget(): THREE.WebGLRenderTarget {
    return this.pipeline.sceneRT;
  }

  private applyQuality(reset: boolean): void {
    this.quality = resolveQuality(this.options.quality, this.adaptive);
    if (reset && this.options.quality !== 'auto') {
      this.adaptive.level = this.options.quality;
    }
    this.pipeline.setSize(this.width, this.height, this.quality.blurScale);
    this.pipeline.setTaps(this.quality.dofTaps);
  }

  dispose(): void {
    this.disposed = true;
    this.pipeline.dispose();
  }
}
