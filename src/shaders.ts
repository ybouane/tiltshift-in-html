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

export const TILEMAX_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;   // downsample output (coc in alpha, normalized)
uniform vec2 uTexelSize;    // texel of INPUT
void main() {
  float m = 0.0;
  for (int y = -3; y <= 3; y += 2) {
    for (int x = -3; x <= 3; x += 2) {
      float c = texture2D(tInput, vUv + vec2(float(x), float(y)) * uTexelSize).a;
      m = max(m, abs(c)); // either field can scatter over neighbours
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

export const DILATE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexelSize;
void main() {
  float m = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      m = max(m, texture2D(tInput, vUv + vec2(float(x), float(y)) * uTexelSize).x);
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

/** Poisson disc (unit radius). Trimmed at runtime by uTaps. */
const POISSON = [
  [0.0, 0.0],
  [0.5411, 0.1747], [-0.2138, 0.5219], [-0.5556, -0.1852], [0.1228, -0.5578],
  [0.8358, -0.2905], [0.2825, 0.8455], [-0.7962, 0.4243], [-0.6392, -0.6501],
  [0.4816, -0.7583], [0.9532, 0.2856], [-0.1655, 0.9573], [-0.9772, -0.0398],
  [0.0559, -0.9868], [0.7053, 0.6349], [-0.5920, 0.7699], [-0.3646, -0.8901],
  [0.3128, 0.3925], [-0.0788, -0.3253], [0.3714, -0.2314], [-0.4290, 0.1275],
  [0.1697, 0.6688], [-0.6642, 0.1409], [0.6555, -0.0577], [-0.1112, -0.7370],
  [0.2937, -0.6455], [0.6836, 0.3549], [-0.3796, 0.6208], [-0.7703, -0.3737],
  [0.0459, 0.2741], [0.5155, -0.4577], [-0.2077, 0.2404], [-0.1274, -0.1214],
  [0.8441, 0.0879], [-0.4986, -0.4625], [0.1268, 0.9948], [-0.9218, 0.2711],
];
