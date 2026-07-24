# Pixelloid

Pixelloid detects the enlarged pseudo-pixel grid in AI-generated pixel art and
rebuilds the image at its true 1:1 resolution.

The pixel editor also includes **Magic Fix**, a deterministic source-grid
restoration pass. It examines the original pixels represented by every logical
cell, rejects interpolation fringes and isolated noise, and selects a coherent
source color without inventing new artwork. Processing is local, offline, and
does not require a model download. Ambiguous cells and manually edited pixels
are preserved; palette locking is optional.

## Development

```sh
npm install
npm run tauri dev
```

Use `npm run dev` to run only the Vite frontend in a browser.
