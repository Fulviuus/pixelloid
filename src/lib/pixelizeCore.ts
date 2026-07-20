import {
  buildCellRanges,
  type PixelBuffer,
  type PixelGridSettings,
} from "./gridDetection";

export type CellRange = [number, number];

export type PixelizedBuffer = PixelBuffer & {
  /** Exact inclusive/exclusive source intervals represented by each output column. */
  xRanges: CellRange[];
  /** Exact inclusive/exclusive source intervals represented by each output row. */
  yRanges: CellRange[];
  /** True when the source pixels can be used unchanged. */
  passthrough: boolean;
};

const MAX_SAMPLE_COUNT = 7 * 7;
const IDENTITY_EPSILON = 1e-6;

type MedianScratch = {
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
  alpha: Uint8Array;
};

function swap(values: Uint8Array, first: number, second: number) {
  const value = values[first];
  values[first] = values[second];
  values[second] = value;
}

/** Select the nth value in-place without sorting or allocating a new array. */
function selectNth(values: Uint8Array, length: number, nth: number) {
  let left = 0;
  let right = length - 1;

  while (left < right) {
    // A middle pivot is deterministic and performs well for the tiny (<= 49)
    // channel buffers used here. Three-way partitioning avoids pathological
    // loops on flat-color cells where every value is identical.
    const pivot = values[(left + right) >>> 1];
    let lower = left;
    let cursor = left;
    let upper = right;

    while (cursor <= upper) {
      const value = values[cursor];

      if (value < pivot) {
        swap(values, lower, cursor);
        lower += 1;
        cursor += 1;
      } else if (value > pivot) {
        swap(values, cursor, upper);
        upper -= 1;
      } else {
        cursor += 1;
      }
    }

    if (nth < lower) {
      right = lower - 1;
    } else if (nth > upper) {
      left = upper + 1;
    } else {
      return values[nth];
    }
  }

  return values[left] ?? 0;
}

function sampleCellInto(
  source: PixelBuffer,
  left: number,
  top: number,
  right: number,
  bottom: number,
  output: Uint8ClampedArray,
  outputOffset: number,
  scratch: MedianScratch,
) {
  const { width, height, data } = source;
  const boundedLeft = Math.max(0, Math.min(width - 1, Math.round(left)));
  const boundedTop = Math.max(0, Math.min(height - 1, Math.round(top)));
  const boundedRight = Math.max(
    boundedLeft + 1,
    Math.min(width, Math.round(right)),
  );
  const boundedBottom = Math.max(
    boundedTop + 1,
    Math.min(height, Math.round(bottom)),
  );
  const insetX = Math.floor((boundedRight - boundedLeft) * 0.14);
  const insetY = Math.floor((boundedBottom - boundedTop) * 0.14);
  const sampleLeft = Math.min(boundedRight - 1, boundedLeft + insetX);
  const sampleTop = Math.min(boundedBottom - 1, boundedTop + insetY);
  const sampleRight = Math.max(sampleLeft + 1, boundedRight - insetX);
  const sampleBottom = Math.max(sampleTop + 1, boundedBottom - insetY);
  const xSteps = Math.min(7, sampleRight - sampleLeft);
  const ySteps = Math.min(7, sampleBottom - sampleTop);
  let sampleCount = 0;

  for (let sampleY = 0; sampleY < ySteps; sampleY += 1) {
    const y = Math.min(
      sampleBottom - 1,
      Math.floor(
        sampleTop +
          ((sampleY + 0.5) * (sampleBottom - sampleTop)) / ySteps,
      ),
    );

    for (let sampleX = 0; sampleX < xSteps; sampleX += 1) {
      const x = Math.min(
        sampleRight - 1,
        Math.floor(
          sampleLeft +
            ((sampleX + 0.5) * (sampleRight - sampleLeft)) / xSteps,
        ),
      );
      const sourceOffset = (y * width + x) * 4;

      scratch.red[sampleCount] = data[sourceOffset];
      scratch.green[sampleCount] = data[sourceOffset + 1];
      scratch.blue[sampleCount] = data[sourceOffset + 2];
      scratch.alpha[sampleCount] = data[sourceOffset + 3];
      sampleCount += 1;
    }
  }

  // Match the original robust sampler's upper median for even sample counts.
  const medianIndex = Math.floor(sampleCount / 2);
  output[outputOffset] = selectNth(scratch.red, sampleCount, medianIndex);
  output[outputOffset + 1] = selectNth(
    scratch.green,
    sampleCount,
    medianIndex,
  );
  output[outputOffset + 2] = selectNth(
    scratch.blue,
    sampleCount,
    medianIndex,
  );
  output[outputOffset + 3] = selectNth(
    scratch.alpha,
    sampleCount,
    medianIndex,
  );
}

function assertUsableSource(source: PixelBuffer) {
  if (
    !Number.isInteger(source.width) ||
    !Number.isInteger(source.height) ||
    source.width < 1 ||
    source.height < 1
  ) {
    throw new RangeError("The source pixel buffer has invalid dimensions.");
  }

  const requiredLength = source.width * source.height * 4;
  if (source.data.length < requiredLength) {
    throw new RangeError("The source pixel buffer is incomplete.");
  }
}

/**
 * Rebuild an RGBA buffer with one output pixel per inferred source cell.
 *
 * This function has no DOM dependencies and is safe to call from a worker.
 * The four 49-byte median buffers are allocated once per conversion and reused
 * for every cell. In the exact 1:1 case `data` aliases the source buffer; callers
 * must copy it first if they need an independently mutable result.
 */
export function pixelizeBuffer(
  source: PixelBuffer,
  settings: PixelGridSettings,
): PixelizedBuffer {
  assertUsableSource(source);

  const xRanges = buildCellRanges(
    source.width,
    settings.pixelSize,
    settings.offsetX,
  ) as CellRange[];
  const yRanges = buildCellRanges(
    source.height,
    settings.pixelSize,
    settings.offsetY,
  ) as CellRange[];
  const isIdentity =
    Math.abs(settings.pixelSize - 1) < IDENTITY_EPSILON &&
    Math.abs(settings.offsetX) < IDENTITY_EPSILON &&
    Math.abs(settings.offsetY) < IDENTITY_EPSILON;

  if (isIdentity) {
    const requiredLength = source.width * source.height * 4;
    return {
      width: source.width,
      height: source.height,
      data:
        source.data.length === requiredLength
          ? source.data
          : source.data.subarray(0, requiredLength),
      xRanges,
      yRanges,
      passthrough: true,
    };
  }

  const width = xRanges.length;
  const height = yRanges.length;
  const data = new Uint8ClampedArray(width * height * 4);
  const scratch: MedianScratch = {
    red: new Uint8Array(MAX_SAMPLE_COUNT),
    green: new Uint8Array(MAX_SAMPLE_COUNT),
    blue: new Uint8Array(MAX_SAMPLE_COUNT),
    alpha: new Uint8Array(MAX_SAMPLE_COUNT),
  };

  for (let y = 0; y < height; y += 1) {
    const yRange = yRanges[y];

    for (let x = 0; x < width; x += 1) {
      const xRange = xRanges[x];
      sampleCellInto(
        source,
        xRange[0],
        yRange[0],
        xRange[1],
        yRange[1],
        data,
        (y * width + x) * 4,
        scratch,
      );
    }
  }

  return {
    width,
    height,
    data,
    xRanges,
    yRanges,
    passthrough: false,
  };
}
