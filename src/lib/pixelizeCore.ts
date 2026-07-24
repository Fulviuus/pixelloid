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

function getBoundedCell(
  source: PixelBuffer,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  const { width, height } = source;
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

  return { boundedLeft, boundedTop, boundedRight, boundedBottom };
}

function copySourcePixel(
  source: PixelBuffer,
  x: number,
  y: number,
  output: Uint8ClampedArray,
  outputOffset: number,
) {
  const sourceOffset = (y * source.width + x) * 4;
  output[outputOffset] = source.data[sourceOffset];
  output[outputOffset + 1] = source.data[sourceOffset + 1];
  output[outputOffset + 2] = source.data[sourceOffset + 2];
  output[outputOffset + 3] = source.data[sourceOffset + 3];
}

function sampleNearestCellInto(
  source: PixelBuffer,
  left: number,
  top: number,
  right: number,
  bottom: number,
  output: Uint8ClampedArray,
  outputOffset: number,
) {
  const { boundedLeft, boundedTop, boundedRight, boundedBottom } =
    getBoundedCell(source, left, top, right, bottom);
  const x = Math.min(
    boundedRight - 1,
    Math.floor((boundedLeft + boundedRight) / 2),
  );
  const y = Math.min(
    boundedBottom - 1,
    Math.floor((boundedTop + boundedBottom) / 2),
  );

  copySourcePixel(source, x, y, output, outputOffset);
}

function sampleNearestCanvasInto(
  source: PixelBuffer,
  outputX: number,
  outputY: number,
  outputWidth: number,
  outputHeight: number,
  output: Uint8ClampedArray,
  outputOffset: number,
) {
  // This is the nearest-neighbor coordinate transform used by conventional
  // image resizers: map the center of the output texel into source space.
  const x = Math.min(
    source.width - 1,
    Math.floor(((outputX + 0.5) * source.width) / outputWidth),
  );
  const y = Math.min(
    source.height - 1,
    Math.floor(((outputY + 0.5) * source.height) / outputHeight),
  );

  copySourcePixel(source, x, y, output, outputOffset);
}

function buildCanvasFitRanges(length: number, count: number): CellRange[] {
  return Array.from({ length: count }, (_, index) => [
    Math.floor((index * length) / count),
    Math.floor(((index + 1) * length) / count),
  ]);
}

function sampleMedoidCellInto(
  source: PixelBuffer,
  left: number,
  top: number,
  right: number,
  bottom: number,
  output: Uint8ClampedArray,
  outputOffset: number,
  samples: Uint8Array,
) {
  const { width, data } = source;
  const { boundedLeft, boundedTop, boundedRight, boundedBottom } =
    getBoundedCell(source, left, top, right, bottom);
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
      const sampleOffset = sampleCount * 4;

      samples[sampleOffset] = data[sourceOffset];
      samples[sampleOffset + 1] = data[sourceOffset + 1];
      samples[sampleOffset + 2] = data[sourceOffset + 2];
      samples[sampleOffset + 3] = data[sourceOffset + 3];
      sampleCount += 1;
    }
  }

  let bestSample = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  // The L1 medoid is robust to outliers but, unlike independent channel
  // medians, is guaranteed to be one complete RGBA pixel observed in-source.
  for (let candidate = 0; candidate < sampleCount; candidate += 1) {
    const candidateOffset = candidate * 4;
    let totalDistance = 0;

    for (let other = 0; other < sampleCount; other += 1) {
      const otherOffset = other * 4;
      totalDistance +=
        Math.abs(samples[candidateOffset] - samples[otherOffset]) +
        Math.abs(samples[candidateOffset + 1] - samples[otherOffset + 1]) +
        Math.abs(samples[candidateOffset + 2] - samples[otherOffset + 2]) +
        Math.abs(samples[candidateOffset + 3] - samples[otherOffset + 3]);
    }

    if (totalDistance < bestDistance) {
      bestDistance = totalDistance;
      bestSample = candidate;
    }
  }

  const bestOffset = bestSample * 4;
  output[outputOffset] = samples[bestOffset];
  output[outputOffset + 1] = samples[bestOffset + 1];
  output[outputOffset + 2] = samples[bestOffset + 2];
  output[outputOffset + 3] = samples[bestOffset + 3];
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
 * Nearest sampling either selects the center source texel of each detected,
 * phase-aligned source cell or, when requested, performs the conventional
 * whole-canvas nearest-neighbor coordinate transform.
 * Medoid sampling reuses one 49-pixel scratch buffer and always emits a complete
 * RGBA value observed in the source. In the exact 1:1 case `data` aliases the
 * source buffer; callers must copy it first if they need an independently
 * mutable result.
 */
export function pixelizeBuffer(
  source: PixelBuffer,
  settings: PixelGridSettings,
): PixelizedBuffer {
  assertUsableSource(source);

  const phaseXRanges = buildCellRanges(
    source.width,
    settings.pixelSize,
    settings.offsetX,
  ) as CellRange[];
  const phaseYRanges = buildCellRanges(
    source.height,
    settings.pixelSize,
    settings.offsetY,
  ) as CellRange[];
  const samplingMode =
    settings.samplingMode === "medoid" ? "medoid" : "nearest";
  const fitToCanvas =
    samplingMode === "nearest" && settings.fitToCanvas === true;
  const xRanges = fitToCanvas
    ? buildCanvasFitRanges(source.width, phaseXRanges.length)
    : phaseXRanges;
  const yRanges = fitToCanvas
    ? buildCanvasFitRanges(source.height, phaseYRanges.length)
    : phaseYRanges;
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
  const samples =
    samplingMode === "medoid"
      ? new Uint8Array(MAX_SAMPLE_COUNT * 4)
      : null;

  for (let y = 0; y < height; y += 1) {
    const yRange = yRanges[y];

    for (let x = 0; x < width; x += 1) {
      const xRange = xRanges[x];
      const outputOffset = (y * width + x) * 4;

      if (fitToCanvas) {
        sampleNearestCanvasInto(
          source,
          x,
          y,
          width,
          height,
          data,
          outputOffset,
        );
      } else if (samplingMode === "medoid" && samples) {
        sampleMedoidCellInto(
          source,
          xRange[0],
          yRange[0],
          xRange[1],
          yRange[1],
          data,
          outputOffset,
          samples,
        );
      } else {
        sampleNearestCellInto(
          source,
          xRange[0],
          yRange[0],
          xRange[1],
          yRange[1],
          data,
          outputOffset,
        );
      }
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
