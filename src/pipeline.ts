/**
 * The render targets and full-screen passes. Internal — the public surface is
 * TiltShift, which owns one of these.
 *
 * Passes, in order:
 *   1. scene      -> sceneRT      (colour + a depth texture)
 *   2. downsample -> halfRT       (half res colour, signed CoC packed in alpha)
 *   3. tileMax    -> tileRT       (1/8 res max of the NEAR field's CoC)
 *   4. dilate     -> tileDilateRT (3x3, so foreground bokeh can scatter outward)
 *   5. gather     -> gatherRT     (poisson-disc scatter-as-gather blur)
 *   6. tent       -> smoothRT     (cheap smoothing of the gather's noise)
 *   7. composite  -> screen       (depth-aware blend of sharp and blurred)
 *
 * The CoC convention throughout: signed, in FULL-RES pixels, negative in the
 * near field. Every pass agrees on that or the near/far fields swap.
 */
import * as THREE from 'three';
import {
  FULLSCREEN_VERT,
  DOWNSAMPLE_FRAG,
  TENT_FRAG,
  TILEMAX_FRAG,
  DILATE_FRAG,
  GATHER_FRAG,
  COMPOSITE_FRAG,
  withCocCommon,
} from './shaders';
import type { DebugView, FocusModel } from './types';

const FOCUS_MODEL_ID: Record<FocusModel, number> = { physical: 0, plane: 1, band: 2 };
const DEBUG_ID: Record<DebugView, number> = { none: 0, depth: 1, coc: 2, near: 3, far: 4 };

export interface UniformState {
  focusModel: FocusModel;
  focusDistance: number;
  aperture: number;
  focusRange: number;
  maxCoc: number;
  nearBoost: number;
  planePointView: THREE.Vector3;
  planeNormalView: THREE.Vector3;
  planeThickness: number;
  planeNearTransition: number;
  planeFarTransition: number;
  bandCenter: number;
  bandHalfWidth: number;
  bandAngle: number;
  bandFeather: number;
  debug: DebugView;
}

function makeFsQuad(material: THREE.ShaderMaterial): { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial } {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.PlaneGeometry(2, 2);
  scene.add(new THREE.Mesh(geo, material));
  return { scene, camera, material };
}

export class Pipeline {
  sceneRT: THREE.WebGLRenderTarget;
  halfRT: THREE.WebGLRenderTarget;
  gatherRT: THREE.WebGLRenderTarget;
  smoothRT: THREE.WebGLRenderTarget;
  tileRT: THREE.WebGLRenderTarget;
  tileDilateRT: THREE.WebGLRenderTarget;

  private down: ReturnType<typeof makeFsQuad>;
  private tent: ReturnType<typeof makeFsQuad>;
  private tile: ReturnType<typeof makeFsQuad>;
  private dilate: ReturnType<typeof makeFsQuad>;
  private gather: ReturnType<typeof makeFsQuad>;
  private composite: ReturnType<typeof makeFsQuad>;


  constructor(private renderer: THREE.WebGLRenderer) {
    const depthTexture = new THREE.DepthTexture(4, 4);
    depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, {
      samples: 0,
      depthTexture,
      colorSpace: THREE.SRGBColorSpace,
    });
    const halfOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.halfRT = new THREE.WebGLRenderTarget(4, 4, halfOpts);
    this.gatherRT = new THREE.WebGLRenderTarget(4, 4, halfOpts);
    this.smoothRT = new THREE.WebGLRenderTarget(4, 4, halfOpts);
    this.tileRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.tileDilateRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });

    const cocUniforms = () => ({
      tDepth: { value: this.sceneRT.depthTexture },
      uNear: { value: 0.1 },
      uFar: { value: 100 },
      uProjInverse: { value: new THREE.Matrix4() },
      uFocusModel: { value: 0 },
      uFocusDistance: { value: 6 },
      uAperture: { value: 20 },
      uFocusRange: { value: 0.4 },
      uMaxCoc: { value: 24 },
      uNearBoost: { value: 1.1 },
      uPlanePoint: { value: new THREE.Vector3() },
      uPlaneNormal: { value: new THREE.Vector3(0, 0, -1) },
      uPlaneThickness: { value: 0.8 },
      uPlaneNearTransition: { value: 1.5 },
      uPlaneFarTransition: { value: 2.5 },
      uBandCenter: { value: 0.5 },
      uBandHalfWidth: { value: 0.12 },
      uBandAngle: { value: 0 },
      uBandFeather: { value: 0.25 },
    });

    this.down = makeFsQuad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCocCommon(DOWNSAMPLE_FRAG),
      uniforms: {
        tColor: { value: this.sceneRT.texture },
        uFullTexel: { value: new THREE.Vector2() },
        ...cocUniforms(),
      },
      depthTest: false, depthWrite: false,
    }));
    this.tent = makeFsQuad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: TENT_FRAG,
      uniforms: { tInput: { value: this.gatherRT.texture }, uTexelSize: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    }));
    this.tile = makeFsQuad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: TILEMAX_FRAG,
      uniforms: { tInput: { value: this.halfRT.texture }, uTexelSize: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    }));
    this.dilate = makeFsQuad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DILATE_FRAG,
      uniforms: { tInput: { value: this.tileRT.texture }, uTexelSize: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    }));
    this.gather = makeFsQuad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: GATHER_FRAG,
      uniforms: {
        tInput: { value: this.halfRT.texture },
        tTileNear: { value: this.tileDilateRT.texture },
        uTexelSize: { value: new THREE.Vector2() },
        uMaxCocPx: { value: 24 },
        uBlurScale: { value: 0.5 },
        uTaps: { value: 24 },
      },
      depthTest: false, depthWrite: false,
    }));
    this.composite = makeFsQuad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCocCommon(COMPOSITE_FRAG),
      uniforms: {
        tColor: { value: this.sceneRT.texture },
        tBlur: { value: this.smoothRT.texture },
        tTileNear: { value: this.tileDilateRT.texture },
        uFullTexel: { value: new THREE.Vector2() },
        uMaxCocPx: { value: 24 },
        uBlurScale: { value: 0.5 },
        uDebug: { value: 0 },
        ...cocUniforms(),
      },
      depthTest: false, depthWrite: false,
    }));
  }

  setSize(width: number, height: number, blurScale: number): void {
    this.gather.material.uniforms.uBlurScale.value = blurScale;
    this.composite.material.uniforms.uBlurScale.value = blurScale;
    this.sceneRT.setSize(width, height);
    const hw = Math.max(4, Math.round(width * blurScale));
    const hh = Math.max(4, Math.round(height * blurScale));
    this.halfRT.setSize(hw, hh);
    this.gatherRT.setSize(hw, hh);
    this.smoothRT.setSize(hw, hh);
    const tw = Math.max(2, Math.round(hw / 8)), th = Math.max(2, Math.round(hh / 8));
    this.tileRT.setSize(tw, th);
    this.tileDilateRT.setSize(tw, th);
    (this.down.material.uniforms.uFullTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    (this.tent.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (this.tile.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (this.dilate.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / tw, 1 / th);
    (this.gather.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (this.composite.material.uniforms.uFullTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }

  setTaps(taps: number): void {
    this.gather.material.uniforms.uTaps.value = taps;
  }

  updateUniforms(camera: THREE.PerspectiveCamera, s: UniformState): void {
    for (const quad of [this.down, this.composite]) {
      const u = quad.material.uniforms;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      (u.uProjInverse.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      u.uFocusModel.value = FOCUS_MODEL_ID[s.focusModel];
      u.uFocusDistance.value = s.focusDistance;
      u.uAperture.value = s.aperture;
      u.uFocusRange.value = s.focusRange;
      u.uMaxCoc.value = s.maxCoc;
      u.uNearBoost.value = s.nearBoost;
      (u.uPlanePoint.value as THREE.Vector3).copy(s.planePointView);
      (u.uPlaneNormal.value as THREE.Vector3).copy(s.planeNormalView);
      u.uPlaneThickness.value = s.planeThickness;
      u.uPlaneNearTransition.value = s.planeNearTransition;
      u.uPlaneFarTransition.value = s.planeFarTransition;
      u.uBandCenter.value = s.bandCenter;
      u.uBandHalfWidth.value = s.bandHalfWidth;
      u.uBandAngle.value = s.bandAngle;
      u.uBandFeather.value = s.bandFeather;
    }
    this.gather.material.uniforms.uMaxCocPx.value = s.maxCoc;
    this.composite.material.uniforms.uMaxCocPx.value = s.maxCoc;
    this.composite.material.uniforms.uDebug.value = DEBUG_ID[s.debug];
  }

  /** triangles drawn by the last scene pass (info resets per render call) */
  lastSceneTriangles = 0;

  /**
   * Render `scene` through the pipeline into `target` (null = the canvas).
   *
   * Note the first pass renders the scene itself: the pipeline needs its own
   * depth texture, and asking the caller to supply a matching colour+depth
   * pair is a much worse API than taking the scene.
   */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null = null): void {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    this.lastSceneTriangles = r.info.render.triangles;
    r.setRenderTarget(this.halfRT);
    r.render(this.down.scene, this.down.camera);
    r.setRenderTarget(this.tileRT);
    r.render(this.tile.scene, this.tile.camera);
    r.setRenderTarget(this.tileDilateRT);
    r.render(this.dilate.scene, this.dilate.camera);
    r.setRenderTarget(this.gatherRT);
    r.render(this.gather.scene, this.gather.camera);
    r.setRenderTarget(this.smoothRT);
    r.render(this.tent.scene, this.tent.camera);
    r.setRenderTarget(target);
    r.render(this.composite.scene, this.composite.camera);
  }

  dispose(): void {
    for (const rt of [this.sceneRT, this.halfRT, this.gatherRT, this.smoothRT, this.tileRT, this.tileDilateRT]) rt.dispose();
    for (const q of [this.down, this.tent, this.tile, this.dilate, this.gather, this.composite]) q.material.dispose();
  }
}
