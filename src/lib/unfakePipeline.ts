import type { PixelBuffer } from "./gridDetection";
import type { PixelizedBuffer } from "./pixelizeCore";
import initUnfakeCore, {
  detect_tiled,
  quantize_packed,
} from "../vendor/unfake-core/unfake_wasm.js";

let coreInitialization: Promise<WebAssembly.Exports> | null = null;

function initializeCore() {
  coreInitialization ??= initUnfakeCore();
  return coreInitialization;
}

function unpackQuantizedImage(packed: Uint8Array): PixelBuffer {
  const view = new DataView(
    packed.buffer,
    packed.byteOffset,
    packed.byteLength,
  );
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const paletteLength = view.getUint32(8, true);
  const imageOffset = 12 + paletteLength * 4;
  const data = new Uint8ClampedArray(
    packed.buffer,
    packed.byteOffset + imageOffset,
    width * height * 4,
  ).slice();

  return { width, height, data };
}

function countOpaqueColors(source: PixelBuffer, stopAfter: number) {
  const colors = new Set<number>();

  for (let offset = 0; offset < source.data.length; offset += 4) {
    if (source.data[offset + 3] >= 128) {
      colors.add(
        (source.data[offset] << 16) |
          (source.data[offset + 1] << 8) |
          source.data[offset + 2],
      );
      if (colors.size > stopAfter) break;
    }
  }

  return colors.size;
}

function finalizeAlphaOnlyWhenPresent(source: PixelBuffer) {
  let containsTransparency = false;
  for (let offset = 3; offset < source.data.length; offset += 4) {
    if (source.data[offset] < 255) {
      containsTransparency = true;
      break;
    }
  }
  if (!containsTransparency) return source;

  for (let offset = 0; offset < source.data.length; offset += 4) {
    if (source.data[offset + 3] >= 128) {
      source.data[offset + 3] = 255;
    } else {
      source.data[offset] = 0;
      source.data[offset + 1] = 0;
      source.data[offset + 2] = 0;
      source.data[offset + 3] = 0;
    }
  }

  return source;
}

/** unfake.js' tiled Sobel/autocorrelation detector, used as a second opinion. */
export async function detectScaleWithUnfake(source: PixelBuffer) {
  await initializeCore();
  return detect_tiled(
    new Uint8Array(
      source.data.buffer,
      source.data.byteOffset,
      source.data.byteLength,
    ),
    source.width,
    source.height,
  );
}

/**
 * Optional post-downscale palette reduction using unfake-core's imagequant.
 * Sampling, grid geometry, and alpha are already settled before this runs.
 */
export async function quantizePixelizedBufferWithUnfake(
  source: PixelizedBuffer,
  maximumColors: number,
): Promise<PixelizedBuffer> {
  const colorLimit = Math.max(2, Math.min(256, Math.round(maximumColors)));
  if (countOpaqueColors(source, colorLimit) <= colorLimit) return source;

  await initializeCore();
  const quantized = finalizeAlphaOnlyWhenPresent(
    unpackQuantizedImage(
      quantize_packed(
        new Uint8Array(
          source.data.buffer,
          source.data.byteOffset,
          source.data.byteLength,
        ),
        source.width,
        source.height,
        colorLimit,
        new Uint8Array(0),
      ),
    ),
  );

  return {
    ...source,
    ...quantized,
    passthrough: false,
  };
}
