<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="./src/assets/pixelloid-wordmark-dark.png"
    />
    <source
      media="(prefers-color-scheme: light)"
      srcset="./src/assets/pixelloid-wordmark.png"
    />
    <img
      alt="Pixelloid"
      src="./src/assets/pixelloid-wordmark.png"
      width="420"
    />
  </picture>
</p>

<p align="center">
  Turn enlarged, almost-pixel art into a true 1:1 pixel image.
</p>

## Screenshots

<p align="center">
  <img
    alt="Pixelloid converting pseudo-pixel art into a true-resolution image"
    src="./docs/screenshots/converter-medoid.png"
    width="100%"
  />
</p>

<p align="center">
  <em>Detect the source grid, remove the background, and compare the true-resolution result using the Medoid sampler.</em>
</p>

<p align="center">
  <img
    alt="Pixelloid pixel editor with drawing tools and a source-derived color palette"
    src="./docs/screenshots/pixel-editor-medoid.jpeg"
    width="100%"
  />
</p>

<p align="center">
  <em>Edit individual pixels with pencil, fill, eyedropper, eraser, crop, zoom, and the source palette.</em>
</p>

## What is Pixelloid?

AI-generated pixel art often only looks pixel-perfect. Its apparent pixels are
actually made from many source pixels, softened by interpolation, halos, color
noise, or inconsistent edges.

Pixelloid detects that hidden grid, creates an image at the grid's native
resolution, and resolves every logical cell into one real output pixel. The
entire process runs locally on your computer.

## Features

- Automatic pseudo-pixel grid detection. Weak fractional detections show both
  the information-preserving integer grid and the exact detected grid as
  side-by-side previews.
- Reversible, edge-connected background removal on the source image before grid
  detection and conversion, preserving enclosed artwork.
- Manual source-pixel-size adjustment before conversion.
- Robust medoid sampling by default, plus exact FFmpeg-style nearest sampling.
- Adaptive Smart sampling compares nearest, medoid, and dominant source colors
  inside every logical cell, keeping the least-destructive reconstruction.
- Optional 64- or 32-color post-downscale imagequant for Smart results. Palette
  reduction is off by default and never changes the source before sampling.
- Local conversion to a true-resolution indexed PNG whenever the result fits
  a 256-color palette, with RGBA PNG fallback for larger palettes.
- Exact SVG vector export of the current result, including editor changes and
  crops. Equal-color pixels are merged into crisp vector paths; no raster image
  is embedded.
- Side-by-side source and result previews.
- Pixel editor with pencil, fill, eyedropper, eraser, crop, undo, custom colors,
  and source-derived palettes.
- Scroll-wheel and button zoom controls.
- A resolution-matched original-image overlay for checking edits.
- Persistent application settings for dark/light themes, the transparency
  chroma-key color, and optional Smart palette reduction.
- PNG, JPEG, WebP, GIF, AVIF, and BMP import. GIF import uses one frame.
- No image uploads, accounts, cloud APIs, or model downloads.

## How conversion works

Pixelloid first estimates the apparent source-pixel pitch and output
resolution. Its primary detector measures repeated boundaries, flat cell
interiors, and two-axis consistency. The unfake.js tiled edge detector is kept
as a second opinion only when Pixelloid cannot produce a reliable detection or
advisory estimate.

Smart mode uses the already-selected Pixelloid grid without cropping or
independently changing its phase. For every logical cell it builds nearest,
medoid, and dominant candidates from complete source pixels, measures how well
each candidate reconstructs the cell, and retains Medoid unless another
candidate is materially better. It does not morph, quantize, or clean the
full-resolution source. Alpha is made binary only when the source actually
contains transparency. Optional 64- or 32-color imagequant runs after
downscaling.

Nearest mode matches FFmpeg/libswscale point sampling. After background
removal, it fits the opaque foreground independently and places it back on the
original logical canvas so transparent padding cannot shift its pixels. Medoid
mode chooses a robust complete RGBA sample observed inside each inferred cell.
All modes are deterministic and never generate new artwork.

SVG export works from the final true-resolution result rather than retracing
the noisy source. Horizontal runs and vertically matching runs are merged into
rectangles, then rectangles sharing an RGBA color are emitted as one SVG path.
This keeps every pixel boundary exact while producing a compact, scalable file.

## Development

### Requirements

- Node.js and npm
- A Rust toolchain
- The platform prerequisites required by Tauri 2

Install dependencies and launch the desktop app:

```sh
npm install
npm run tauri dev
```

Run only the Vite frontend:

```sh
npm run dev
```

Run the test suite:

```sh
npm test
```

Build the frontend:

```sh
npm run build
```

Create native release bundles:

```sh
npm run tauri build
```

Pushing a version tag such as `v0.1.0` runs the GitHub release workflow. It
tests the project, builds Linux and Windows x64 installers plus macOS Intel and
Apple Silicon bundles, then attaches them to one GitHub Release.

On macOS, release artifacts are written beneath:

```text
src-tauri/target/release/bundle/
```

## Project structure

```text
src/
├── components/              React UI and pixel editor
├── lib/
│   ├── backgroundRemoval.ts
│   ├── gridDetection.ts
│   ├── imageWorkerClient.ts
│   ├── indexedPng.ts
│   ├── pixelizeCore.ts
│   ├── unfakePipeline.ts
│   └── vectorExport.ts
├── vendor/unfake-core/       Pinned unfake-core WebAssembly distribution
└── workers/                 Off-main-thread image processing

src-tauri/                   Tauri application shell and native packaging
tests/                       Grid, pixelization, and background-removal tests
```

## Current limits

- Source images are limited to 40 million decoded pixels.
- Background removal is limited to 4.2 million source pixels to keep its
  full-resolution edge traversal within a safe memory bound.
- Grid suggestions are advisory when the source does not contain one clear,
  consistent lattice.

Pixelloid is currently in alpha.

## Acknowledgements

Pixelloid vendors the open-source
[unfake.js](https://github.com/jenissimo/unfake.js) WebAssembly core for its
secondary tiled scale detector and optional post-downscale imagequant. Grid
selection and all source-color samplers remain native to Pixelloid. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Pixelloid is available under the
[Mozilla Public License 2.0](LICENSE).
