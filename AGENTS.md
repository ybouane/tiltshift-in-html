# AGENTS.md

Notes for an agent working with this library — what it is, how to wire it into
someone else's project, and the mistakes that cost real time when they happen.

## What this package is

A single post-processing pass for Three.js that applies **depth-aware
tilt-shift optics**. It reads the scene's depth buffer, computes a signed
circle of confusion per pixel, and blurs accordingly.

It is **not**: a CSS filter, a screen-space blur, a bloom/DOF suite, or a
renderer. It has exactly one runtime dependency — `three`, as a peer.

## The whole integration

```javascript
import { TiltShift } from 'tiltshift-in-html';

const tilt = new TiltShift(renderer, { model: 'plane', planePitch: 24, aperture: 64 });

// in the loop, INSTEAD of renderer.render(scene, camera):
tilt.render(scene, camera);

// on resize, AFTER renderer.setSize():
tilt.syncSize();
```

If you are integrating this and find yourself writing more than about ten
lines, stop and re-read — the API is deliberately this small.

## Choosing a model

The most common mistake is reaching for `physical` and then wondering why the
result does not look like a miniature.

- `physical` is a normal lens. The sharp region is a slab perpendicular to the
  view axis. Correct, and not what people mean by "tilt-shift".
- `plane` tilts that slab. Because the sharp band now cuts **across** depth, a
  full-size scene reads as a scale model. This is the one to use for the
  miniature effect. Start with `planePitch: 20-30`, `aperture: 50-70`.
- `band` ignores depth entirely and keeps a strip of the frame sharp. Cheapest,
  and honest about what it is — good for a scene with no useful depth range.

## Sharp edges, in the order they usually bite

1. **`setSize` takes drawing-buffer pixels.** Not CSS pixels. On a retina
   display, passing `innerWidth/innerHeight` renders the entire pass at half
   resolution — the image is *soft everywhere*, including where it should be
   sharp, and it looks like a quality bug rather than a sizing bug. Prefer
   `tilt.syncSize()`.
2. **View-axis depth, not distance.** `viewDepthTo()` projects onto the
   camera's forward vector. If you compute focus distance yourself with
   `camera.position.distanceTo(target)`, objects at the edge of frame end up
   slightly out of focus. It looks like a soft lens. It is not.
3. **Perspective cameras only.** An orthographic camera has no meaningful
   focus plane; the linearisation assumes a perspective projection.
4. **The pass renders the scene.** It cannot take an already-rendered texture,
   because it needs the matching depth buffer. To chain further passes, render
   into a target: `tilt.render(scene, camera, target)`.
5. **`maxCoc` is the cost knob.** It sets how far the gather reaches.
   `aperture` only decides how quickly that ceiling is reached. If the pass is
   slow, lower `maxCoc` (or `quality`), not `aperture`.
6. **Focus should be sprung, not set.** Jumping `focusDistance` between frames
   reads as a cut. `FocusSpring` is critically damped — it never overshoots,
   which is also true of a focus puller.

## Reading the pipeline

`src/pipeline.ts` owns the targets and passes; `src/shaders.ts` is the GLSL.
The order is: scene → downsample (CoC into alpha) → tileMax → dilate → gather →
tent → composite.

The one convention that holds the whole thing together: **CoC is signed, in
full-resolution pixels, negative in the near field.** Every pass agrees on
that. If you change one of them and the near and far fields appear to swap, a
sign was dropped.

The near-field dilation (steps 3–4) is what stops out-of-focus foreground
objects having sharp silhouettes. It is the difference between "blurred" and
"out of focus", and it is the first thing to check if the result looks wrong in
a way you cannot name.

## Debugging

`debug: 'coc'` renders the circle of confusion instead of the image; `'depth'`,
`'near'` and `'far'` show the linear depth and the two field masks. If the
image looks wrong, look at `'coc'` first — nearly every problem is visible
there, and none of them are visible in the final image.

## What is NOT in this package

The demo at <https://tiltshift-in-html.ybouane.com/> renders **real, live,
interactive HTML inside the WebGL scene** — actual DOM forms lying on the floor
of a diorama, blurred by these same optics. That uses the experimental
[HTML-in-Canvas API](https://github.com/WICG/html-in-canvas)
(`<canvas layoutsubtree>`, `gl.texElementImage2D`, `canvas.requestPaint()`),
which is behind a flag in Chrome 148+ and exists in no other engine.

It is deliberately **not** part of this library, and should not be added to it:

- it would make a library that works everywhere depend on an API that works
  almost nowhere;
- the HTML surface work is a different problem (layout, hit-testing, stacking,
  paint events) that has nothing to do with optics;
- this pass is useful to people who will never enable that flag.

If you are asked to build something with HTML-in-Canvas, the demo repository is
the reference implementation and carries a findings document covering the
alignment traps, capability detection, and version-specific behaviour:
<https://github.com/ybouane/tiltshift-in-html-demo>.

## Conventions in this repo

- TypeScript, strict, ESM only. `npm run build` emits `dist/` with types.
- `npm test` runs vitest over pure logic — optics maths, the focus helpers, the
  adaptive quality ladder. Anything that needs a GPU is not unit tested here;
  it is verified in the demo.
- No runtime dependency may be added. `three` stays a peer dependency, and the
  package must keep working with any `three` from r160 up.
