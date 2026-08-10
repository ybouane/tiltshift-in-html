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

export const GATHER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;      // half-res color + normalized signed coc in alpha
uniform sampler2D tTileNear;   // dilated near-coc tiles (normalized)
uniform vec2 uTexelSize;       // texel of INPUT (half res)
uniform float uMaxCocPx;       // max coc at FULL res in px
uniform float uBlurScale;      // blur-target resolution / full resolution
uniform int uTaps;
const int MAX_TAPS = ${POISSON.length};
const vec2 POISSON[MAX_TAPS] = vec2[](
${POISSON.map(([x, y]) => `  vec2(${x.toFixed(4)}, ${y.toFixed(4)})`).join(',\n')}
);

void main() {
  vec4 center = texture2D(tInput, vUv);
  float centerCoc = center.a * uMaxCocPx;          // signed, full-res px
  float tileSpread = texture2D(tTileNear, vUv).x * uMaxCocPx;
  // per-pixel rotation of the poisson disc (interleaved gradient noise) —
  // deterministic, breaks up banding; the tent post-filter smooths the noise
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float ca = cos(6.2831853 * ign);
  float sa = sin(6.2831853 * ign);
  mat2 discRot = mat2(ca, sa, -sa, ca);
  // gather radius: own blur, or anything nearby that scatters over us
  float radiusPx = min(max(abs(centerCoc), tileSpread), uMaxCocPx);
  if (radiusPx < 0.25) {
    gl_FragColor = vec4(center.rgb, 0.0);
    return;
  }
  vec2 radiusUv = radiusPx * uBlurScale * uTexelSize;

  // Scatter-as-gather with rough energy conservation: a defocused tap spreads
  // its energy over a disc, so its per-pixel contribution falls with its CoC
  // area; sharp taps only ever contribute to their own pixel. The alpha
  // channel accumulates COVERAGE — how much defocused light lands here — and
  // the composite blends sharp/blurred by that coverage, which is what makes
  // silhouettes melt smoothly instead of ringing.
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  float cover = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    if (i >= uTaps) break;
    vec2 offs = (discRot * POISSON[i]) * radiusUv;
    vec4 tap = texture2D(tInput, vUv + offs);
    float tapCoc = tap.a * uMaxCocPx;
    float tapDistPx = length(POISSON[i]) * radiusPx;
    // does this tap's blur disc reach us?
    float reach = i == 0 ? 1.0 : smoothstep(tapDistPx - 1.0, tapDistPx + 1.0, abs(tapCoc));
    // energy of a defocused tap is spread over its disc
    float energy = 1.0 / (1.0 + abs(tapCoc) * abs(tapCoc) * 0.15);
    float w = reach * energy;
    // Keep a floor on the centre only so wsum can never divide by zero. It
    // must stay far BELOW a typical tap weight: a large floor makes the sharp
    // centre pixel dominate the average as CoC grows (every tap's energy tends
    // to zero together), which reads as the unblurred image fading back in
    // underneath heavy blur.
    if (i == 0) w = max(w, 1e-4);
    acc += tap.rgb * w;
    wsum += w;
    cover += w * smoothstep(0.35, 1.1, abs(tapCoc));
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-5), clamp(cover / max(wsum, 1e-5), 0.0, 1.0));
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;     // full-res sharp
uniform sampler2D tBlur;      // half-res gather output (blend factor in alpha)
uniform sampler2D tTileNear;
uniform vec2 uFullTexel;
uniform float uMaxCocPx;
uniform float uBlurScale;
uniform int uDebug; // 0 none, 1 depth, 2 coc, 3 near mask, 4 far mask
__COC_COMMON__

void main() {
  vec3 sharp = texture2D(tColor, vUv).rgb;
  float coc = signedCocAt(vUv);
  float tileNear = texture2D(tTileNear, vUv).x * uMaxCocPx;

  if (uDebug == 1) {
    float z = linearDepthAt(vUv);
    float v = 1.0 - exp(-z * 0.08);
    gl_FragColor = vec4(vec3(v), 1.0); return;
  }
  if (uDebug == 2) {
    float n = clamp(-coc / uMaxCocPx, 0.0, 1.0);
    float f = clamp(coc / uMaxCocPx, 0.0, 1.0);
    gl_FragColor = vec4(n, 1.0 - n - f, f, 1.0); return; // near=red, focus=green, far=blue
  }
  if (uDebug == 3) { gl_FragColor = vec4(vec3(clamp(max(-coc, tileNear) / uMaxCocPx, 0.0, 1.0)), 1.0); return; }
  if (uDebug == 4) { gl_FragColor = vec4(vec3(clamp(coc / uMaxCocPx, 0.0, 1.0)), 1.0); return; }

  // Upsample the reduced-res blur: 3x3 gaussian taps, weighted toward taps
  // whose coverage matches the bilinear coverage at this point (keeps the
  // sharp/blurred boundary crisp without ringing).
  vec2 halfTexel = uFullTexel / max(uBlurScale, 0.05);
  float refCover = texture2D(tBlur, vUv).a;
  vec4 b = vec4(0.0);
  float bw = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float g = (i == 0 && j == 0) ? 4.0 : ((i == 0 || j == 0) ? 2.0 : 1.0);
      vec4 tap = texture2D(tBlur, vUv + vec2(float(i), float(j)) * halfTexel * 0.6);
      float w = g / (0.12 + abs(tap.a - refCover));
      b += tap * w; bw += w;
    }
  }
  vec4 blur = b / max(bw, 1e-5);

  // Coverage IS the blend factor: it already encodes both this pixel's own
  // defocus and any neighbour's light scattered over it (near or far field).
  float ownBlur = smoothstep(0.5, 1.6, abs(coc));
  float blend = clamp(max(smoothstep(0.04, 0.5, blur.a), ownBlur), 0.0, 1.0);
  vec3 col = mix(sharp, blur.rgb, blend);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function withCocCommon(frag: string): string {
  return frag.replace('__COC_COMMON__', COC_COMMON);
}
