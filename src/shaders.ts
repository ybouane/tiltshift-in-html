/**
 * GLSL for the depth-aware tilt-shift / DoF pipeline (WebGL2 / GLSL ES 3.0 via three).
 *
 * Passes:
 *  1. downsample  — half-res color + signed CoC (computed from depth) in alpha
 *  2. tileMax     — 1/8-res max of near-field CoC (for foreground scatter dilation)
 *  3. tileDilate  — 3x3 dilate of tileMax
 *  4. gather      — half-res poisson-disc scatter-as-gather blur
 *  5. composite   — full-res depth-aware blend of sharp + blurred, debug views
 *
 * CoC convention: signed, in *full-res pixels*. Negative = near field.
 */

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared: view-space reconstruction + CoC. Appended to fragment shaders. */
export const COC_COMMON = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform mat4 uProjInverse;

// focus model: 0 = physical distance, 1 = tilted plane, 2 = screen-space band
uniform int uFocusModel;
uniform float uFocusDistance;
uniform float uAperture;
uniform float uFocusRange;
uniform float uMaxCoc;
uniform float uNearBoost;
// tilted plane (view space)
uniform vec3 uPlanePoint;
uniform vec3 uPlaneNormal;
uniform float uPlaneThickness;
uniform float uPlaneNearTransition;
uniform float uPlaneFarTransition;
// screen band
uniform float uBandCenter;   // 0..1 (v coordinate)
uniform float uBandHalfWidth; // 0..1
uniform float uBandAngle;    // radians, 0 = horizontal band
uniform float uBandFeather;  // 0..1

float linearDepthAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float zNdc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - zNdc * (uFar - uNear));
}

vec3 viewPosAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 vp = uProjInverse * ndc;
  return vp.xyz / vp.w;
}

// Signed CoC in full-res pixels at uv.
float signedCocAt(vec2 uv) {
  if (uFocusModel == 2) {
    // artistic screen-space band (not depth aware) — rotated distance from band line
    vec2 p = uv - vec2(0.5, uBandCenter);
    float c = cos(uBandAngle), s = sin(uBandAngle);
    float dist = abs(-s * p.x + c * p.y);
    float t = clamp((dist - uBandHalfWidth) / max(uBandFeather, 1e-4), 0.0, 1.0);
    float sm = t * t * (3.0 - 2.0 * t);
    return sm * uMaxCoc;
  }
  if (uFocusModel == 1) {
    vec3 vp = viewPosAt(uv);
    float sd = dot(vp - uPlanePoint, uPlaneNormal);
    float half_ = uPlaneThickness * 0.5;
    float a = abs(sd);
    if (a <= half_) return 0.0;
    float transition = sd < 0.0 ? uPlaneNearTransition : uPlaneFarTransition;
    float t = clamp((a - half_) / max(transition, 1e-4), 0.0, 1.0);
    float sm = t * t * (3.0 - 2.0 * t);
    return (sd < 0.0 ? -1.0 : 1.0) * sm * uMaxCoc;
  }
  // physical
  float z = linearDepthAt(uv);
  float delta = z - uFocusDistance;
  float a = abs(delta);
  if (a <= uFocusRange) return 0.0;
  float eff = a - uFocusRange;
  float coc = uAperture * eff / max(z, 1e-4);
  if (delta < 0.0) coc *= uNearBoost;
  coc = min(coc, uMaxCoc);
  return delta < 0.0 ? -coc : coc;
}
`;

export const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uFullTexel;
${'' /* COC_COMMON appended by material factory */}
__COC_COMMON__
void main() {
  // CoC-aware downsample: plain bilinear averaging mixes foreground and
  // background color across depth edges BEFORE the blur, which reads as a
  // halo around 3D silhouettes. Weight the 4 source pixels by how similar
  // their CoC is to this texel's CoC so edges stay unmixed.
  float cocC = signedCocAt(vUv);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 3 ? uFullTexel.x : -uFullTexel.x,
                  i >= 2 ? uFullTexel.y : -uFullTexel.y) * 0.5;
    vec3 col = texture2D(tColor, vUv + o).rgb;
    float coc = signedCocAt(vUv + o);
    float w = 1.0 / (0.15 + abs(coc - cocC) / max(uMaxCoc, 1e-4));
    acc += col * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-5), cocC / max(uMaxCoc, 1e-4));
}
`;

/** 3x3 bilateral tent filter over the gather output — hides poisson noise and
 *  smooths bokeh edges without re-bleeding across blur-amount discontinuities. */
export const TENT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexelSize;
void main() {
  vec4 c = texture2D(tInput, vUv);
  vec4 acc = c * 4.0;
  float wsum = 4.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      float g = (x == 0 || y == 0) ? 2.0 : 1.0; // tent kernel
      vec4 tap = texture2D(tInput, vUv + vec2(float(x), float(y)) * uTexelSize);
      float w = g / (0.25 + abs(tap.a - c.a) * 4.0);
      acc += tap * w;
      wsum += w;
    }
  }
  gl_FragColor = acc / wsum;
}
`;
