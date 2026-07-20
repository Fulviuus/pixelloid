export type PixelGridDetection = {
  pixelSize: number;
  confidence: number;
  outputWidth: number;
  outputHeight: number;
  offsetX: number;
  offsetY: number;
};

export type PixelizeResult = {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    baseWidth: number;
    baseHeight: number;
  };
};

export type PixelGridSettings = {
  pixelSize: number;
  offsetX: number;
  offsetY: number;
};

type PeriodScore = {
  period: number;
  score: number;
  offsetX: number;
  offsetY: number;
};

type AnalysisRegion = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  foregroundMask: Uint8Array | null;
  prefersCanvasAlignedGrid: boolean;
};

const MAX_ANALYSIS_DIMENSION = 1024;
const MAX_PERIOD = 96;
const MIN_GRID_REPEATS = 4;

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function colorDistance(
  pixels: Uint8ClampedArray,
  first: number,
  second: number,
) {
  const red = Math.abs(pixels[first] - pixels[second]);
  const green = Math.abs(pixels[first + 1] - pixels[second + 1]);
  const blue = Math.abs(pixels[first + 2] - pixels[second + 2]);
  const alpha = Math.abs(pixels[first + 3] - pixels[second + 3]);

  return red * 0.3 + green * 0.48 + blue * 0.22 + alpha * 0.12;
}

function smoothEnergy(values: Float32Array) {
  if (values.length < 3) return values;

  const smoothed = new Float32Array(values.length);
  smoothed[0] = values[0] * 0.75 + values[1] * 0.25;
  smoothed[values.length - 1] =
    values[values.length - 1] * 0.75 + values[values.length - 2] * 0.25;

  for (let index = 1; index < values.length - 1; index += 1) {
    smoothed[index] =
      values[index - 1] * 0.2 +
      values[index] * 0.6 +
      values[index + 1] * 0.2;
  }

  return smoothed;
}

function pixelCharacteristics(data: Uint8ClampedArray, offset: number) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);

  return {
    luminance: (red + green + blue) / 3,
    chroma: maximum - minimum,
    alpha: data[offset + 3],
  };
}

function findAnalysisRegion(image: ImageData): AnalysisRegion {
  const { width, height, data } = image;
  const totalPixels = width * height;
  let transparentPixels = 0;
  let lightNeutralBorderPixels = 0;
  let borderPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorder =
        y === 0 || y === height - 1 || x === 0 || x === width - 1;
      const offset = (y * width + x) * 4;

      if (data[offset + 3] < 245) transparentPixels += 1;
      if (!isBorder) continue;

      const pixel = pixelCharacteristics(data, offset);
      if (pixel.luminance > 225 && pixel.chroma < 22) {
        lightNeutralBorderPixels += 1;
      }
      borderPixels += 1;
    }
  }

  const hasTransparency = transparentPixels / totalPixels > 0.01;
  const hasLightNeutralCanvas =
    lightNeutralBorderPixels / Math.max(1, borderPixels) > 0.8;

  if (!hasTransparency && !hasLightNeutralCanvas) {
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      foregroundMask: null,
      prefersCanvasAlignedGrid: false,
    };
  }

  const foregroundMask = new Uint8Array(totalPixels);
  let foregroundPixels = 0;
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const pixel = pixelCharacteristics(data, pixelIndex * 4);
      const isForeground = hasTransparency
        ? pixel.alpha > 24
        : pixel.luminance < 235 || pixel.chroma > 18;

      if (!isForeground) continue;
      foregroundMask[pixelIndex] = 1;
      foregroundPixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }

  const foregroundRatio = foregroundPixels / totalPixels;
  const usableMask = hasTransparency
    ? foregroundPixels > 0
    : foregroundRatio > 0.002 && foregroundRatio < 0.7;

  if (!usableMask || right - left < 12 || bottom - top < 12) {
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      foregroundMask: null,
      prefersCanvasAlignedGrid: false,
    };
  }

  return {
    left: Math.max(0, left - 1),
    top: Math.max(0, top - 1),
    right: Math.min(width, right + 1),
    bottom: Math.min(height, bottom + 1),
    foregroundMask,
    prefersCanvasAlignedGrid: hasLightNeutralCanvas && !hasTransparency,
  };
}

function verticalEnergy(image: ImageData, region: AnalysisRegion) {
  const { width, data } = image;
  const start = Math.max(1, region.left + 1);
  const values = new Float32Array(Math.max(0, region.right - start));
  const divisor = Math.max(1, region.bottom - region.top);

  for (let x = start; x < region.right; x += 1) {
    let total = 0;

    for (let y = region.top; y < region.bottom; y += 1) {
      const rightPixel = y * width + x;
      const leftPixel = rightPixel - 1;

      if (
        region.foregroundMask &&
        !region.foregroundMask[leftPixel] &&
        !region.foregroundMask[rightPixel]
      ) {
        continue;
      }

      total += colorDistance(data, leftPixel * 4, rightPixel * 4);
    }

    values[x - start] = total / divisor;
  }

  return {
    coordinateStart: start,
    values: smoothEnergy(values),
  };
}

function horizontalEnergy(image: ImageData, region: AnalysisRegion) {
  const { width, data } = image;
  const start = Math.max(1, region.top + 1);
  const values = new Float32Array(Math.max(0, region.bottom - start));
  const divisor = Math.max(1, region.right - region.left);

  for (let y = start; y < region.bottom; y += 1) {
    let total = 0;

    for (let x = region.left; x < region.right; x += 1) {
      const belowPixel = y * width + x;
      const abovePixel = belowPixel - width;

      if (
        region.foregroundMask &&
        !region.foregroundMask[abovePixel] &&
        !region.foregroundMask[belowPixel]
      ) {
        continue;
      }

      total += colorDistance(data, abovePixel * 4, belowPixel * 4);
    }

    values[y - start] = total / divisor;
  }

  return {
    coordinateStart: start,
    values: smoothEnergy(values),
  };
}

function normalizedAutocorrelation(values: Float32Array, lag: number) {
  const count = Math.floor(values.length - lag);
  if (count < 4) return 0;

  let firstMean = 0;
  let secondMean = 0;

  for (let index = 0; index < count; index += 1) {
    const shiftedIndex = index + lag;
    const shiftedFloor = Math.floor(shiftedIndex);
    const shiftedFraction = shiftedIndex - shiftedFloor;
    const shifted =
      values[shiftedFloor] * (1 - shiftedFraction) +
      values[Math.min(values.length - 1, shiftedFloor + 1)] *
        shiftedFraction;
    firstMean += values[index];
    secondMean += shifted;
  }

  firstMean /= count;
  secondMean /= count;

  let numerator = 0;
  let firstVariance = 0;
  let secondVariance = 0;

  for (let index = 0; index < count; index += 1) {
    const shiftedIndex = index + lag;
    const shiftedFloor = Math.floor(shiftedIndex);
    const shiftedFraction = shiftedIndex - shiftedFloor;
    const shifted =
      values[shiftedFloor] * (1 - shiftedFraction) +
      values[Math.min(values.length - 1, shiftedFloor + 1)] *
        shiftedFraction;
    const first = values[index] - firstMean;
    const second = shifted - secondMean;
    numerator += first * second;
    firstVariance += first * first;
    secondVariance += second * second;
  }

  const denominator = Math.sqrt(firstVariance * secondVariance);
  return denominator > 0 ? Math.max(0, numerator / denominator) : 0;
}

function scoreAxisPeriod(
  values: Float32Array,
  period: number,
  coordinateStart: number,
) {
  const phaseTotals = new Float64Array(period);
  const phaseCounts = new Uint32Array(period);
  let total = 0;
  let squaredTotal = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const phase = (index + coordinateStart) % period;
    phaseTotals[phase] += value;
    phaseCounts[phase] += 1;
    total += value;
    squaredTotal += value * value;
  }

  const mean = total / Math.max(1, values.length);
  const variance = Math.max(
    0,
    squaredTotal / Math.max(1, values.length) - mean * mean,
  );
  const deviation = Math.sqrt(variance);

  let bestPhase = 0;
  let bestMean = Number.NEGATIVE_INFINITY;
  let remainingTotal = 0;
  let remainingPhases = 0;

  for (let phase = 0; phase < period; phase += 1) {
    const phaseMean =
      phaseCounts[phase] > 0 ? phaseTotals[phase] / phaseCounts[phase] : 0;

    if (phaseMean > bestMean) {
      bestMean = phaseMean;
      bestPhase = phase;
    }
  }

  for (let phase = 0; phase < period; phase += 1) {
    if (phase === bestPhase || phaseCounts[phase] === 0) continue;
    remainingTotal += phaseTotals[phase] / phaseCounts[phase];
    remainingPhases += 1;
  }

  const otherMean = remainingTotal / Math.max(1, remainingPhases);
  const contrast = (bestMean - otherMean) / Math.max(2, deviation);
  const boundaryCount = phaseCounts[bestPhase];
  const reliability = Math.min(1, boundaryCount / 5);

  return {
    score: contrast * reliability,
    offset: bestPhase,
  };
}

function scoreCanvasAlignment(
  values: Float32Array,
  period: number,
  coordinateStart: number,
) {
  if (period < 1 || values.length === 0) return 0;

  const sigma = Math.max(0.65, period * 0.08);
  let weightedEnergy = 0;
  let totalEnergy = 0;
  let expectedWeight = 0;

  for (let index = 0; index < values.length; index += 1) {
    const coordinate = index + coordinateStart;
    const remainder = ((coordinate % period) + period) % period;
    const distance = Math.min(remainder, period - remainder);
    const weight = Math.exp(-0.5 * (distance / sigma) ** 2);
    const energy = values[index];

    weightedEnergy += energy * weight;
    totalEnergy += energy;
    expectedWeight += weight;
  }

  const captured = weightedEnergy / Math.max(totalEnergy, 1e-6);
  const randomBaseline = expectedWeight / values.length;

  return Math.max(
    0,
    (captured - randomBaseline) / Math.max(1 - randomBaseline, 1e-6),
  );
}

function boundaryFit(coordinate: number, period: number) {
  const cellCoordinate = coordinate / period;
  const distance = Math.abs(cellCoordinate - Math.round(cellCoordinate));
  const tolerance = 0.18;
  return Math.exp(-0.5 * (distance / tolerance) ** 2);
}

function refineCanvasAlignedPitch(
  sourceWidth: number,
  sourceHeight: number,
  analysisWidth: number,
  analysisHeight: number,
  coarsePeriod: number,
  region: AnalysisRegion,
  xEnergy: ReturnType<typeof verticalEnergy>,
  yEnergy: ReturnType<typeof horizontalEnergy>,
  minimumCorrelation: number,
) {
  if (!region.prefersCanvasAlignedGrid) return null;

  const scaleX = analysisWidth / sourceWidth;
  const scaleY = analysisHeight / sourceHeight;
  const averageScale = (scaleX + scaleY) / 2;
  const coarseSourcePitch = coarsePeriod / averageScale;
  const candidatePitches = new Map<string, number>();

  for (const length of [sourceWidth, sourceHeight]) {
    const estimatedCellCount = Math.round(length / coarseSourcePitch);

    for (let delta = -3; delta <= 3; delta += 1) {
      const cellCount = estimatedCellCount + delta;
      if (cellCount < MIN_GRID_REPEATS) continue;
      const pitch = length / cellCount;
      candidatePitches.set(pitch.toFixed(6), pitch);
    }
  }

  let best: { pitch: number; score: number } | null = null;

  for (const pitch of candidatePitches.values()) {
    const xPeriod = pitch * scaleX;
    const yPeriod = pitch * scaleY;
    const xCorrelation = normalizedAutocorrelation(
      xEnergy.values,
      xPeriod,
    );
    const yCorrelation = normalizedAutocorrelation(
      yEnergy.values,
      yPeriod,
    );
    const correlation =
      Math.max(xCorrelation, yCorrelation) * 0.42 +
      Math.min(xCorrelation, yCorrelation) * 0.58;

    // Fractional candidates must still explain essentially the same repeated
    // structure as the coarse integer estimate.
    if (correlation < minimumCorrelation * 0.85) continue;

    const xAlignment = scoreCanvasAlignment(
      xEnergy.values,
      xPeriod,
      xEnergy.coordinateStart,
    );
    const yAlignment = scoreCanvasAlignment(
      yEnergy.values,
      yPeriod,
      yEnergy.coordinateStart,
    );
    const alignment =
      Math.max(xAlignment, yAlignment) * 0.42 +
      Math.min(xAlignment, yAlignment) * 0.58;
    const regionLeft = region.left + 1;
    const regionRight = region.right - 1;
    const regionTop = region.top + 1;
    const regionBottom = region.bottom - 1;
    const bounds =
      (boundaryFit(regionLeft, xPeriod) +
        boundaryFit(regionRight, xPeriod) +
        boundaryFit(regionTop, yPeriod) +
        boundaryFit(regionBottom, yPeriod)) /
      4;
    const score = alignment * 0.65 + bounds * 0.35;

    if (!best || score > best.score) {
      best = { pitch, score };
    }
  }

  return best && best.score >= 0.18 ? best.pitch : null;
}

function confidenceFromScores(best: PeriodScore, runnerUp?: PeriodScore) {
  const absolute = Math.max(0, Math.min(1, (best.score - 0.12) / 0.55));
  const separation = runnerUp
    ? Math.max(0, Math.min(1, (best.score - runnerUp.score) / 0.18))
    : 1;

  return Math.round((absolute * 0.75 + separation * 0.25) * 100);
}

function buildCellRanges(length: number, pixelSize: number, offset: number) {
  const period =
    Number.isFinite(pixelSize) && pixelSize > 0
      ? Math.max(1, pixelSize)
      : 1;
  const safeOffset = Number.isFinite(offset) ? offset : 0;
  const normalizedOffset =
    ((safeOffset % period) + period) % period;
  const minimumFragment = period * 0.5;
  const epsilon = 1e-7;
  const ranges: Array<[number, number]> = [];

  // A cropped image can begin partway through a logical source pixel. Keep
  // that fragment only when at least half of the original cell is present.
  if (normalizedOffset + epsilon >= minimumFragment) {
    const fragmentEnd = Math.min(length, Math.round(normalizedOffset));
    if (fragmentEnd > 0) ranges.push([0, fragmentEnd]);
  }

  const cellCount = Math.max(
    0,
    Math.ceil((length - normalizedOffset) / period - epsilon),
  );

  for (let index = 0; index < cellCount; index += 1) {
    const logicalStart = normalizedOffset + index * period;
    const logicalEnd = Math.min(
      length,
      normalizedOffset + (index + 1) * period,
    );
    if (logicalEnd - logicalStart + epsilon < minimumFragment) continue;

    const start = Math.max(0, Math.min(length, Math.round(logicalStart)));
    const end = Math.max(start, Math.min(length, Math.round(logicalEnd)));
    if (end > start) ranges.push([start, end]);
  }

  if (ranges.length === 0) ranges.push([0, length]);
  return ranges;
}

export function getPixelGridDimensions(
  width: number,
  height: number,
  settings: PixelGridSettings,
) {
  return {
    width: buildCellRanges(
      width,
      settings.pixelSize,
      settings.offsetX,
    ).length,
    height: buildCellRanges(
      height,
      settings.pixelSize,
      settings.offsetY,
    ).length,
  };
}

/**
 * Estimates the enlarged source-pixel size by measuring how strongly color
 * transitions repeat at each possible grid interval on both axes.
 */
export function detectPixelGrid(image: CanvasImageSource): PixelGridDetection {
  const sourceWidth =
    image instanceof HTMLImageElement
      ? image.naturalWidth
      : (image as HTMLCanvasElement).width;
  const sourceHeight =
    image instanceof HTMLImageElement
      ? image.naturalHeight
      : (image as HTMLCanvasElement).height;

  const analysisScale = Math.min(
    1,
    MAX_ANALYSIS_DIMENSION / Math.max(sourceWidth, sourceHeight),
  );
  const width = Math.max(1, Math.round(sourceWidth * analysisScale));
  const height = Math.max(1, Math.round(sourceHeight * analysisScale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Canvas is not available on this system.");
  }

  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const analysisRegion = findAnalysisRegion(imageData);
  const xEnergy = verticalEnergy(imageData, analysisRegion);
  const yEnergy = horizontalEnergy(imageData, analysisRegion);
  const maxPeriod = Math.max(
    2,
    Math.min(
      MAX_PERIOD,
      Math.floor(
        Math.min(xEnergy.values.length, yEnergy.values.length) /
          MIN_GRID_REPEATS,
      ),
    ),
  );
  const scores: PeriodScore[] = [];

  for (let period = 2; period <= maxPeriod; period += 1) {
    const xPhase = scoreAxisPeriod(
      xEnergy.values,
      period,
      xEnergy.coordinateStart,
    );
    const yPhase = scoreAxisPeriod(
      yEnergy.values,
      period,
      yEnergy.coordinateStart,
    );
    const xCorrelation = normalizedAutocorrelation(xEnergy.values, period);
    const yCorrelation = normalizedAutocorrelation(yEnergy.values, period);
    const strongest = Math.max(xCorrelation, yCorrelation);
    const weakest = Math.min(xCorrelation, yCorrelation);

    // Requiring evidence on both axes avoids interpreting stripes as a grid,
    // while still allowing art with much more detail in one direction.
    const combined = strongest * 0.42 + weakest * 0.58;
    scores.push({
      period,
      score: combined,
      offsetX: xPhase.offset,
      offsetY: yPhase.offset,
    });
  }

  const rankedScores = [...scores].sort(
    (first, second) => second.score - first.score,
  );
  const topCandidate = rankedScores[0] ?? {
    period: 1,
    score: 0,
    offsetX: 0,
    offsetY: 0,
  };
  const fundamentalThreshold = topCandidate.score * 0.62;
  const harmonicThreshold = topCandidate.score * 0.5;
  const supportedFundamentals = scores
    .filter(
      (candidate) =>
        candidate.score >= fundamentalThreshold &&
        (candidate.period === topCandidate.period ||
          scores.some(
            (multiple) =>
              multiple.period > candidate.period &&
              multiple.period % candidate.period === 0 &&
              multiple.score >= harmonicThreshold,
          )),
    )
    .sort((first, second) => first.period - second.period);
  const strongest =
    topCandidate.score < 0.12
      ? {
          period: 1,
          score: 0,
          offsetX: 0,
          offsetY: 0,
        }
      : (supportedFundamentals[0] ?? topCandidate);

  // Multiples of the same grid are not independent runner-up candidates.
  const runnerUp = rankedScores.find(({ period }) => {
    if (period === strongest.period) return false;
    const larger = Math.max(period, strongest.period);
    const smaller = Math.min(period, strongest.period);
    return larger % smaller !== 0;
  });

  const scaleX = width / sourceWidth;
  const scaleY = height / sourceHeight;
  const averageScale = (scaleX + scaleY) / 2;
  const coarsePixelSize = strongest.period / averageScale;
  const canvasAlignedPitch =
    strongest.period === 1
      ? null
      : refineCanvasAlignedPitch(
          sourceWidth,
          sourceHeight,
          width,
          height,
          strongest.period,
          analysisRegion,
          xEnergy,
          yEnergy,
          strongest.score,
        );
  const nearestIntegerPitch = Math.round(coarsePixelSize);
  const unsnappedPixelSize =
    Math.abs(coarsePixelSize - nearestIntegerPitch) < 0.2
      ? nearestIntegerPitch
      : coarsePixelSize;
  const pixelSize = Math.max(
    1,
    Math.round((canvasAlignedPitch ?? unsnappedPixelSize) * 1000) / 1000,
  );
  const confidence =
    strongest.period === 1
      ? 0
      : confidenceFromScores(strongest, runnerUp);
  const offsetX = canvasAlignedPitch
    ? 0
    : Math.round((strongest.offsetX / scaleX) * 1000) / 1000;
  const offsetY = canvasAlignedPitch
    ? 0
    : Math.round((strongest.offsetY / scaleY) * 1000) / 1000;
  const dimensions = getPixelGridDimensions(sourceWidth, sourceHeight, {
    pixelSize,
    offsetX,
    offsetY,
  });

  return {
    pixelSize,
    confidence,
    outputWidth: dimensions.width,
    outputHeight: dimensions.height,
    offsetX,
    offsetY,
  };
}

function median(values: number[]) {
  values.sort((first, second) => first - second);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function sampleCellColor(
  image: ImageData,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  const { width, data } = image;
  left = Math.max(0, Math.min(width - 1, Math.round(left)));
  top = Math.max(0, Math.min(image.height - 1, Math.round(top)));
  right = Math.max(left + 1, Math.min(width, Math.round(right)));
  bottom = Math.max(
    top + 1,
    Math.min(image.height, Math.round(bottom)),
  );
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const alphas: number[] = [];
  const insetX = Math.floor((right - left) * 0.14);
  const insetY = Math.floor((bottom - top) * 0.14);
  const sampleLeft = Math.min(right - 1, left + insetX);
  const sampleTop = Math.min(bottom - 1, top + insetY);
  const sampleRight = Math.max(sampleLeft + 1, right - insetX);
  const sampleBottom = Math.max(sampleTop + 1, bottom - insetY);
  const xSteps = Math.min(7, sampleRight - sampleLeft);
  const ySteps = Math.min(7, sampleBottom - sampleTop);

  for (let sampleY = 0; sampleY < ySteps; sampleY += 1) {
    const y = Math.min(
      sampleBottom - 1,
      Math.floor(
        sampleTop + ((sampleY + 0.5) * (sampleBottom - sampleTop)) / ySteps,
      ),
    );

    for (let sampleX = 0; sampleX < xSteps; sampleX += 1) {
      const x = Math.min(
        sampleRight - 1,
        Math.floor(
          sampleLeft + ((sampleX + 0.5) * (sampleRight - sampleLeft)) / xSteps,
        ),
      );
      const offset = (y * width + x) * 4;
      reds.push(data[offset]);
      greens.push(data[offset + 1]);
      blues.push(data[offset + 2]);
      alphas.push(data[offset + 3]);
    }
  }

  return [median(reds), median(greens), median(blues), median(alphas)];
}

/**
 * Rebuilds the image with one output pixel per inferred source block.
 */
export async function pixelizeImage(
  image: HTMLImageElement,
  settings: PixelGridSettings,
): Promise<PixelizeResult> {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const xRanges = buildCellRanges(
    sourceWidth,
    settings.pixelSize,
    settings.offsetX,
  );
  const yRanges = buildCellRanges(
    sourceHeight,
    settings.pixelSize,
    settings.offsetY,
  );
  const outputWidth = xRanges.length;
  const outputHeight = yRanges.length;
  const sourceCanvas = createCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!sourceContext) {
    throw new Error("Canvas is not available on this system.");
  }

  sourceContext.drawImage(image, 0, 0);

  // Manual 1 px mode is already a true-resolution image. Avoid millions of
  // tiny sampling allocations and preserve the source pixels exactly.
  if (
    Math.abs(settings.pixelSize - 1) < 1e-6 &&
    Math.abs(settings.offsetX) < 1e-6 &&
    Math.abs(settings.offsetY) < 1e-6
  ) {
    const blob = await new Promise<Blob>((resolve, reject) => {
      sourceCanvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("The PNG could not be created."));
      }, "image/png");
    });

    return {
      blob,
      url: URL.createObjectURL(blob),
      width: sourceWidth,
      height: sourceHeight,
    };
  }

  const sourcePixels = sourceContext.getImageData(
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  const outputCanvas = createCanvas(outputWidth, outputHeight);
  const outputContext = outputCanvas.getContext("2d");

  if (!outputContext) {
    throw new Error("Canvas is not available on this system.");
  }

  const output = outputContext.createImageData(outputWidth, outputHeight);

  for (let y = 0; y < outputHeight; y += 1) {
    const [top, bottom] = yRanges[y];

    for (let x = 0; x < outputWidth; x += 1) {
      const [left, right] = xRanges[x];
      const color = sampleCellColor(
        sourcePixels,
        left,
        top,
        right,
        bottom,
      );
      const outputOffset = (y * outputWidth + x) * 4;

      output.data[outputOffset] = color[0];
      output.data[outputOffset + 1] = color[1];
      output.data[outputOffset + 2] = color[2];
      output.data[outputOffset + 3] = color[3];
    }
  }

  outputContext.putImageData(output, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    outputCanvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("The PNG could not be created."));
    }, "image/png");
  });

  return {
    blob,
    url: URL.createObjectURL(blob),
    width: outputWidth,
    height: outputHeight,
  };
}
