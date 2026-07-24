# Pixelloid

Pixelloid detects the enlarged pseudo-pixel grid in AI-generated pixel art and
rebuilds the image at its true 1:1 resolution.

The pixel editor also includes **Magic Fix**, an optional local image-to-image
pass powered by FLUX.2 Klein 4B plus the
[`Limbicnation/pixel-art-lora`](https://huggingface.co/Limbicnation/pixel-art-lora)
adapter. Pixelloid sends the current true-pixel edit and its aligned source
reference to the model, then deterministically collapses the generated image
back onto the existing pixel grid. The source and result stay on the Mac.
The adapter is the most-downloaded Hugging Face pixel-art model trained for the
same FLUX.2 Klein 4B base, so it preserves the existing two-reference editor
instead of replacing it with an incompatible text-to-image pipeline.

## Development

```sh
npm install
npm run tauri dev
```

Use `npm run dev` to run only the Vite frontend in a browser.

## Local Magic Fix runtime

Magic Fix currently requires:

- An Apple Silicon Mac.
- [`uv`](https://docs.astral.sh/uv/) available on `PATH`.
- Roughly 16.5 GB of free disk space for the first-run model downloads.

Pixelloid pins MFLUX `0.18.0`. FLUX.2 Klein and the approximately 325 MB
pixel-art adapter are downloaded on the first Magic Fix run and reused from the
local caches afterward. Cached generation is forced offline. Set
`PIXELLOID_HF_HOME` to use a custom Hugging Face cache location.

Third-party model and runtime notices are in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
