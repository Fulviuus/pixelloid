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
const SWS_FIXED_POINT_SCALE = 1 << 16;
const FOREGROUND_ALPHA_THRESHOLD = 16;

type ForegroundFit = {
  sourceLeft: number;
  sourceTop: number;
  sourceRight: number;
  sourceBottom: number;
  outputLeft: number;
  outputTop: number;
  outputWidth: number;
  outputHeight: number;
};

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
  // Match FFmpeg/libswscale SWS_POINT sampling. libswscale advances through
  // source space with a truncated 16.16 fixed-point increment, starting at
  // half that increment. This differs from floating-point center mapping at
  // exact boundaries (for example, 10 -> 3 samples source indexes 1, 4, 8).
  const xIncrement = Math.floor(
    (source.width * SWS_FIXED_POINT_SCALE) / outputWidth,
  );
  const yIncrement = Math.floor(
    (source.height * SWS_FIXED_POINT_SCALE) / outputHeight,
  );
  const x = Math.min(
    source.width - 1,
    Math.floor(
      ((outputX * 2 + 1) * xIncrement) / (SWS_FIXED_POINT_SCALE * 2),
    ),
  );
  const y = Math.min(
    source.height - 1,
    Math.floor(
      ((outputY * 2 + 1) * yIncrement) / (SWS_FIXED_POINT_SCALE * 2),
    ),
  );

  copySourcePixel(source, x, y, output, outputOffset);
}

function fixedPointSourceIndex(
  sourceStart: number,
  sourceLength: number,
  outputIndex: number,
  outputLength: number,
) {
  const increment = Math.floor(
    (sourceLength * SWS_FIXED_POINT_SCALE) / outputLength,
  );
  return (
    sourceStart +
    Math.floor(
      ((outputIndex * 2 + 1) * increment) /
        (SWS_FIXED_POINT_SCALE * 2),
    )
  );
}

function findDominantOccupiedSpan(
  occupancy: Uint32Array,
  rawStart: number,
  rawEnd: number,
  minimumOccupancy: number,
): [number, number] {
  let bestStart = rawStart;
  let bestEnd = rawStart;
  let runStart = -1;

  for (let index = rawStart; index <= rawEnd; index += 1) {
    if (occupancy[index] >= minimumOccupancy) {
      if (runStart < 0) runStart = index;
      continue;
    }

    if (runStart >= 0 && index - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = index;
    }
    runStart = -1;
  }

  if (runStart >= 0 && rawEnd + 1 - runStart > bestEnd - bestStart) {
    bestStart = runStart;
    bestEnd = rawEnd + 1;
  }

  return bestEnd > bestStart
    ? [bestStart, bestEnd]
    : [rawStart, rawEnd + 1];
}

function findForegroundFit(
  source: PixelBuffer,
  pixelSize: number,
  outputWidth: number,
  outputHeight: number,
): ForegroundFit | null {
  const columnOccupancy = new Uint32Array(source.width);
  const rowOccupancy = new Uint32Array(source.height);
  let rawLeft = source.width;
  let rawTop = source.height;
  let rawRight = -1;
  let rawBottom = -1;
  let opaquePixels = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (
        source.data[(y * source.width + x) * 4 + 3] <
        FOREGROUND_ALPHA_THRESHOLD
      ) {
        continue;
      }
      columnOccupancy[x] += 1;
      rowOccupancy[y] += 1;
      rawLeft = Math.min(rawLeft, x);
      rawTop = Math.min(rawTop, y);
      rawRight = Math.max(rawRight, x);
      rawBottom = Math.max(rawBottom, y);
      opaquePixels += 1;
    }
  }

  if (
    opaquePixels === 0 ||
    opaquePixels === source.width * source.height ||
    rawRight < rawLeft ||
    rawBottom < rawTop
  ) {
    return null;
  }

  const rawWidth = rawRight - rawLeft + 1;
  const rawHeight = rawBottom - rawTop + 1;
  const fittedWidth = Math.max(1, Math.round(rawWidth / pixelSize));
  const fittedHeight = Math.max(1, Math.round(rawHeight / pixelSize));
  let [sourceLeft, sourceRight] = findDominantOccupiedSpan(
    columnOccupancy,
    rawLeft,
    rawRight,
    Math.max(2, Math.ceil(rawHeight * 0.01)),
  );
  let [sourceTop, sourceBottom] = findDominantOccupiedSpan(
    rowOccupancy,
    rawTop,
    rawBottom,
    Math.max(2, Math.ceil(rawWidth * 0.01)),
  );

  // An even source span resized to an even output has no single center texel.
  // Preserve one available trailing texel so libswscale's half-step mapping
  // remains centered instead of drifting toward the leading edge.
  if (
    (sourceRight - sourceLeft) % 2 === 0 &&
    fittedWidth % 2 === 0 &&
    sourceRight < rawRight + 1
  ) {
    sourceRight += 1;
  }
  if (
    (sourceBottom - sourceTop) % 2 === 0 &&
    fittedHeight % 2 === 0 &&
    sourceBottom < rawBottom + 1
  ) {
    sourceBottom += 1;
  }

  const outputLeft = Math.max(
    0,
    Math.min(outputWidth - fittedWidth, Math.round(rawLeft / pixelSize)),
  );
  const outputTop = Math.max(
    0,
    Math.min(outputHeight - fittedHeight, Math.round(rawTop / pixelSize)),
  );

  return {
    sourceLeft,
    sourceTop,
    sourceRight,
    sourceBottom,
    outputLeft,
    outputTop,
    outputWidth: Math.min(fittedWidth, outputWidth),
    outputHeight: Math.min(fittedHeight, outputHeight),
  };
}

function removeIsolatedLightEdgeFringe(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const fringe = new Uint8Array(width * height);

  function isLightNeutral(offset: number) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    return (
      luminance >= 145 &&
      Math.max(red, green, blue) - Math.min(red, green, blue) <= 24
    );
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * 4;
      if (
        data[offset + 3] < FOREGROUND_ALPHA_THRESHOLD ||
        !isLightNeutral(offset)
      ) {
        continue;
      }

      let touchesTransparency = false;
      let lightNeutralNeighbors = 0;

      for (
        let neighborY = Math.max(0, y - 1);
        neighborY <= Math.min(height - 1, y + 1);
        neighborY += 1
      ) {
        for (
          let neighborX = Math.max(0, x - 1);
          neighborX <= Math.min(width - 1, x + 1);
          neighborX += 1
        ) {
          if (neighborX === x && neighborY === y) continue;
          const neighborOffset = (neighborY * width + neighborX) * 4;
          if (data[neighborOffset + 3] < FOREGROUND_ALPHA_THRESHOLD) {
            touchesTransparency = true;
          } else if (isLightNeutral(neighborOffset)) {
            lightNeutralNeighbors += 1;
          }
        }
      }

      if (touchesTransparency && lightNeutralNeighbors <= 2) {
        fringe[pixelIndex] = 1;
      }
    }
  }

  for (let pixelIndex = 0; pixelIndex < fringe.length; pixelIndex += 1) {
    if (!fringe[pixelIndex]) continue;
    const offset = pixelIndex * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
  }
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
  const foregroundFit =
    samplingMode === "nearest" && settings.fitForeground === true
      ? findForegroundFit(source, settings.pixelSize, width, height)
      : null;
  const samples =
    samplingMode === "medoid"
      ? new Uint8Array(MAX_SAMPLE_COUNT * 4)
      : null;

  for (let y = 0; y < height; y += 1) {
    const yRange = yRanges[y];

    for (let x = 0; x < width; x += 1) {
      const xRange = xRanges[x];
      const outputOffset = (y * width + x) * 4;

      if (
        foregroundFit &&
        x >= foregroundFit.outputLeft &&
        x < foregroundFit.outputLeft + foregroundFit.outputWidth &&
        y >= foregroundFit.outputTop &&
        y < foregroundFit.outputTop + foregroundFit.outputHeight
      ) {
        const sourceX = fixedPointSourceIndex(
          foregroundFit.sourceLeft,
          foregroundFit.sourceRight - foregroundFit.sourceLeft,
          x - foregroundFit.outputLeft,
          foregroundFit.outputWidth,
        );
        const sourceY = fixedPointSourceIndex(
          foregroundFit.sourceTop,
          foregroundFit.sourceBottom - foregroundFit.sourceTop,
          y - foregroundFit.outputTop,
          foregroundFit.outputHeight,
        );
        copySourcePixel(
          source,
          Math.min(foregroundFit.sourceRight - 1, sourceX),
          Math.min(foregroundFit.sourceBottom - 1, sourceY),
          data,
          outputOffset,
        );
      } else if (foregroundFit) {
        // The background was explicitly removed, so leave the rest of the
        // logical canvas transparent instead of sampling stray RGB values.
        continue;
      } else if (fitToCanvas) {
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

  if (foregroundFit) {
    removeIsolatedLightEdgeFringe(data, width, height);
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
