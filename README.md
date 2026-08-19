[![tiltshift-in-html](https://tiltshift-in-html.ybouane.com/og-banner.jpg)](https://tiltshift-in-html.ybouane.com/)

**Depth-aware tilt-shift optics for [Three.js](https://threejs.org).** A tilted
(Scheimpflug) focus plane, a physical depth of field, and an artistic screen
band — in one drop-in pass. See it running at
**[tiltshift-in-html.ybouane.com](https://tiltshift-in-html.ybouane.com/)**.

Not a blur filter. The pass reads the depth buffer, works out a signed circle
of confusion per pixel, and scatters the near field forward so foreground bokeh
spills over what is behind it — which is the part that makes a render look
photographed rather than post-processed.

## Demo

**[tiltshift-in-html.ybouane.com](https://tiltshift-in-html.ybouane.com/)** —
eighteen miniature dioramas, each one driving this library. (That demo also
renders live HTML inside the WebGL scene, which is a separate experiment and
**not** part of this package — see [AGENTS.md](./AGENTS.md) if you are curious.)

There is a self-contained example in [`examples/basic.html`](./examples/basic.html):
`npm run build`, then serve the folder.

## Installation

```bash
npm install tiltshift-in-html three
```

Or straight from a CDN, no build step:

```html
<script type="importmap">
  { "imports": {
      "three": "https://unpkg.com/three@0.185.1/build/three.module.js",
      "tiltshift-in-html": "https://unpkg.com/tiltshift-in-html/dist/index.js"
  } }
</script>
```

## Quick start

Wherever you called `renderer.render(scene, camera)`, call this instead:

```javascript
import { TiltShift } from 'tiltshift-in-html';

const tilt = new TiltShift(renderer, {
  model: 'plane',      // the tilted focus plane
  planePitch: 24,      // degrees
  aperture: 64,
  focusDistance: 13,
});

renderer.setAnimationLoop(() => {
  tilt.render(scene, camera);          // was: renderer.render(scene, camera)
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  tilt.syncSize();
});
```

That is the whole integration. Everything else is options.

## How it works

1. **Scene pass.** The scene is rendered into an offscreen colour target with a
   depth texture attached. The pass needs its own depth, which is why it takes
   the scene rather than an already-rendered image.
2. **Circle of confusion.** Depth is linearised into view space and turned into
   a *signed* CoC in full-resolution pixels — negative in the near field. All
   three focus models produce this same number, so everything downstream is
   model-agnostic.
3. **Near-field dilation.** The maximum near CoC is reduced to 1/8 resolution
   tiles and dilated 3×3. Without this, out-of-focus foreground objects have
   sharp silhouettes — the giveaway of a gather-only blur.
4. **Gather.** A Poisson-disc scatter-as-gather at half resolution, weighted so
   a neighbour only contributes where its own CoC says it should reach.
5. **Composite.** Sharp and blurred are blended by coverage at full resolution,
   so edges stay crisp where they should be.

## Focus models

| `model` | What it does | Use it for |
| --- | --- | --- |
| `physical` | Blur grows with distance from a focus plane perpendicular to the view axis | Ordinary depth of field |
| `plane` | A **tilted** focus plane — the Scheimpflug principle a real tilt-shift lens implements | The miniature look. The sharp band cuts *across* depth |
| `band` | A screen-space band, no depth involved | Cheap, and often what "tilt-shift" means on a photo |
