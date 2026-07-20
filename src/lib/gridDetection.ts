export type PixelGridDetection = {
  pixelSize: number;
  confidence: number;
  offsetX: number;
  offsetY: number;
};

export type PixelGridSettings = {
  pixelSize: number;
  offsetX: number;
  offsetY: number;
};

export type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

type AnalysisRegion = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  foregroundMask: Uint8Array | null;
  anchorX: number;
  anchorY: number;
  hasLightNeutralCanvas: boolean;
};

type AxisEnergy = {
  coordinateStart: number;
  values: Float32Array;
};

type AxisPitchScore = {
  score: number;
  alignment: number;
  correlation: number;
  boundarySupport: number;
  interiorFlatness: number;
  offset: number;
};

type PitchScore = {
  pitch: number;
  score: number;
  weakestAxis: number;
  boundarySupport: number;
  interiorFlatness: number;
  offsetX: number;
  offsetY: number;
};

const MIN_GRID_REPEATS = 3;
const MAX_ANALYSIS_PERIOD = 128;
const MIN_AXIS_ALIGNMENT = 0.075;
const MIN_FINAL_SCORE = 0.19;
const MIN_BOUNDARY_SUPPORT = 0.68;
const MIN_INTERIOR_FLATNESS = 0.22;
const MIN_RELIABLE_ANALYSIS_PITCH = 2.95;
const EPSILON = 1e-7;
const axisPeakCache = new WeakMap<AxisEnergy, number[]>();
const axisStatisticsCache = new WeakMap<
  AxisEnergy,
  ReturnType<typeof signalStatistics>
>();

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function colorDistance(
  pixels: Uint8ClampedArray,
  first: number,
  second: number,
) {
  const alphaFirst = pixels[first + 3] / 255;
  const alphaSecond = pixels[second + 3] / 255;
  const red = Math.abs(
    pixels[first] * alphaFirst - pixels[second] * alphaSecond,
  );
  const green = Math.abs(
    pixels[first + 1] * alphaFirst - pixels[second + 1] * alphaSecond,
  );
  const blue = Math.abs(
    pixels[first + 2] * alphaFirst - pixels[second + 2] * alphaSecond,
  );
  const alpha = Math.abs(pixels[first + 3] - pixels[second + 3]);

  return red * 0.3 + green * 0.48 + blue * 0.22 + alpha * 0.32;
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

/**
 * White and transparent canvases contain far more background than artwork.
 * Restricting the energy profiles to the foreground keeps the canvas border
 * and transparency checker from becoming the strongest apparent period. The
 * coordinates stay in canvas space so a shifted grid keeps its real phase.
 */
function findAnalysisRegion(image: PixelBuffer): AnalysisRegion {
  const { width, height, data } = image;
  const totalPixels = width * height;
  let transparentPixels = 0;
  let lightNeutralBorderPixels = 0;
  let borderPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 245) transparentPixels += 1;

      if (y !== 0 && y !== height - 1 && x !== 0 && x !== width - 1) {
        continue;
      }

      const pixel = pixelCharacteristics(data, offset);
      if (pixel.luminance > 225 && pixel.chroma < 22) {
        lightNeutralBorderPixels += 1;
      }
      borderPixels += 1;
    }
  }

  const hasTransparency = transparentPixels / Math.max(1, totalPixels) > 0.01;
  const hasLightNeutralCanvas =
    lightNeutralBorderPixels / Math.max(1, borderPixels) > 0.8;

  if (!hasTransparency && !hasLightNeutralCanvas) {
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      foregroundMask: null,
      anchorX: 0,
      anchorY: 0,
      hasLightNeutralCanvas: false,
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

  const foregroundRatio = foregroundPixels / Math.max(1, totalPixels);
  const usableMask = hasTransparency
    ? foregroundPixels > 0
    : foregroundRatio > 0.002 && foregroundRatio < 0.72;

  if (!usableMask || right - left < 8 || bottom - top < 8) {
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      foregroundMask: null,
      anchorX: 0,
      anchorY: 0,
      hasLightNeutralCanvas: false,
    };
  }

  return {
    left: Math.max(0, left - 2),
    top: Math.max(0, top - 2),
    right: Math.min(width, right + 2),
    bottom: Math.min(height, bottom + 2),
    foregroundMask,
    anchorX: left,
    anchorY: top,
    hasLightNeutralCanvas,
  };
}

function verticalEnergy(image: PixelBuffer, region: AnalysisRegion): AxisEnergy {
  const { width, data } = image;
  const start = Math.max(1, region.left + 1);
  const values = new Float32Array(Math.max(0, region.right - start));

  for (let x = start; x < region.right; x += 1) {
    let total = 0;
    let samples = 0;

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
      samples += 1;
    }

    values[x - start] = samples > 0 ? total / samples : 0;
  }

  return { coordinateStart: start, values };
}

function horizontalEnergy(
  image: PixelBuffer,
  region: AnalysisRegion,
): AxisEnergy {
  const { width, data } = image;
  const start = Math.max(1, region.top + 1);
  const values = new Float32Array(Math.max(0, region.bottom - start));

  for (let y = start; y < region.bottom; y += 1) {
    let total = 0;
    let samples = 0;

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
      samples += 1;
    }

    values[y - start] = samples > 0 ? total / samples : 0;
  }

  return { coordinateStart: start, values };
}

function interpolatedValue(values: Float32Array, index: number) {
  const floor = Math.floor(index);
  const fraction = index - floor;
  const first = values[Math.max(0, Math.min(values.length - 1, floor))];
  const second =
    values[Math.max(0, Math.min(values.length - 1, floor + 1))];
  return first * (1 - fraction) + second * fraction;
}

function normalizedAutocorrelation(values: Float32Array, lag: number) {
  const count = Math.floor(values.length - lag);
  if (lag < 1 || count < 6) return 0;

  let firstMean = 0;
  let secondMean = 0;

  for (let index = 0; index < count; index += 1) {
    firstMean += values[index];
    secondMean += interpolatedValue(values, index + lag);
  }

  firstMean /= count;
  secondMean /= count;

  let numerator = 0;
  let firstVariance = 0;
  let secondVariance = 0;

  for (let index = 0; index < count; index += 1) {
    const first = values[index] - firstMean;
    const second = interpolatedValue(values, index + lag) - secondMean;
    numerator += first * second;
    firstVariance += first * first;
    secondVariance += second * second;
  }

  const denominator = Math.sqrt(firstVariance * secondVariance);
  return denominator > EPSILON ? clamp01(numerator / denominator) : 0;
}

function signalStatistics(values: Float32Array) {
  let total = 0;
  let squaredTotal = 0;
  let totalVariation = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    total += value;
    squaredTotal += value * value;
    if (index > 0) totalVariation += Math.abs(value - values[index - 1]);
  }

  const mean = total / Math.max(1, values.length);
  const variance = Math.max(
    0,
    squaredTotal / Math.max(1, values.length) - mean * mean,
  );

  return {
    total,
    mean,
    deviation: Math.sqrt(variance),
    // Narrow boundary impulses have much more variation per unit energy than
    // the broad lobes of a sinusoid or another continuous tone gradient.
    sharpness: totalVariation / Math.max(EPSILON, total * 2),
  };
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function phaseDistance(coordinate: number, pitch: number, offset: number) {
  const remainder = positiveModulo(coordinate - offset, pitch);
  return Math.min(remainder, pitch - remainder);
}

function strongestCoordinates(axis: AxisEnergy, maximum = 14) {
  const cached = axisPeakCache.get(axis);
  if (cached) return cached.slice(0, maximum);

  const candidates: Array<{ coordinate: number; value: number }> = [];
  const { values, coordinateStart } = axis;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const previous = index > 0 ? values[index - 1] : Number.NEGATIVE_INFINITY;
    const next =
      index + 1 < values.length
        ? values[index + 1]
        : Number.NEGATIVE_INFINITY;
    if (value >= previous && value >= next) {
      candidates.push({ coordinate: coordinateStart + index, value });
    }
  }

  const coordinates = candidates
    .sort((first, second) => second.value - first.value)
    .slice(0, 20)
    .map(({ coordinate }) => coordinate);
  axisPeakCache.set(axis, coordinates);
  return coordinates.slice(0, maximum);
}

function boundarySlotMetrics(
  axis: AxisEnergy,
  pitch: number,
  offset: number,
  statistics: ReturnType<typeof signalStatistics>,
) {
  const { values, coordinateStart } = axis;
  const coordinateEnd = coordinateStart + values.length - 1;
  const firstSlot = Math.ceil((coordinateStart - offset) / pitch);
  const lastSlot = Math.floor((coordinateEnd - offset) / pitch);
  const threshold = Math.max(
    0.35,
    statistics.mean * 0.55,
    statistics.deviation * 0.08,
  );
  const supportedSlots: boolean[] = [];
  let boundaryBandEnergy = 0;
  let boundaryBandSamples = 0;

  for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
    const boundary = offset + slot * pitch;
    const center = boundary - coordinateStart;
    const firstIndex = Math.max(0, Math.ceil(center - 1.05));
    const lastIndex = Math.min(values.length - 1, Math.floor(center + 1.05));
    let maximum = 0;
    let bandEnergy = 0;

    for (let index = firstIndex; index <= lastIndex; index += 1) {
      maximum = Math.max(maximum, values[index]);
      bandEnergy += values[index];
      boundaryBandSamples += 1;
    }

    supportedSlots.push(maximum >= threshold);
    boundaryBandEnergy += bandEnergy;
  }

  if (supportedSlots.length < 2) {
    return { boundarySupport: 0, interiorFlatness: 0 };
  }

  const coverage =
    supportedSlots.filter(Boolean).length / supportedSlots.length;
  let residueCoverage = 1;

  // A divisor can capture every real edge while inserting a regularly empty
  // slot between them. Inspect residue classes explicitly so that alternating
  // empty slots cannot disappear into an otherwise strong aggregate score.
  for (let divisor = 2; divisor <= 5; divisor += 1) {
    if (supportedSlots.length < divisor * 3) continue;

    for (let residue = 0; residue < divisor; residue += 1) {
      let groupSlots = 0;
      let groupSupported = 0;
      for (let index = residue; index < supportedSlots.length; index += divisor) {
        groupSlots += 1;
        if (supportedSlots[index]) groupSupported += 1;
      }
      residueCoverage = Math.min(
        residueCoverage,
        groupSupported / Math.max(1, groupSlots),
      );
    }
  }

  const boundaryBandMean =
    boundaryBandEnergy / Math.max(1, boundaryBandSamples);
  const flatThreshold = Math.max(0.08, boundaryBandMean * 0.2);
  const flatCells: boolean[] = [];

  for (let slot = firstSlot; slot < lastSlot; slot += 1) {
    const cellStart = offset + slot * pitch;
    const cellEnd = cellStart + pitch;
    const firstIndex = Math.max(0, Math.ceil(cellStart - coordinateStart));
    const lastIndex = Math.min(
      values.length - 1,
      Math.floor(cellEnd - coordinateStart),
    );
    let interiorSamples = 0;
    let flatInteriorSamples = 0;

    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const coordinate = coordinateStart + index;
      if (Math.min(coordinate - cellStart, cellEnd - coordinate) <= 1.25) {
        continue;
      }
      interiorSamples += 1;
      if (values[index] <= flatThreshold) flatInteriorSamples += 1;
    }

    flatCells.push(
      interiorSamples === 0 ||
        flatInteriorSamples / interiorSamples >= 0.25,
    );
  }

  const flatCellCoverage =
    flatCells.filter(Boolean).length / Math.max(1, flatCells.length);
  let flatResidueCoverage = 1;
  for (let divisor = 2; divisor <= 5; divisor += 1) {
    if (flatCells.length < divisor * 3) continue;
    for (let residue = 0; residue < divisor; residue += 1) {
      let groupCells = 0;
      let groupFlatCells = 0;
      for (let index = residue; index < flatCells.length; index += divisor) {
        groupCells += 1;
        if (flatCells[index]) groupFlatCells += 1;
      }
      flatResidueCoverage = Math.min(
        flatResidueCoverage,
        groupFlatCells / Math.max(1, groupCells),
      );
    }
  }

  return {
    boundarySupport: Math.min(coverage, residueCoverage),
    // Enlarged pixels still contain a low-variation interior even when their
    // transition is several pixels wide. A codec seam laid over a continuous
    // gradient has nonzero variation at essentially every interior position.
    interiorFlatness: Math.min(flatCellCoverage, flatResidueCoverage),
  };
}

function scoreAxisPitch(
  axis: AxisEnergy,
  pitch: number,
  preferredOffset?: number,
): AxisPitchScore {
  const { values, coordinateStart } = axis;
  if (pitch < 1.35 || values.length < pitch * 2.4) {
    return {
      score: 0,
      alignment: 0,
      correlation: 0,
      boundarySupport: 0,
      interiorFlatness: 0,
      offset: 0,
    };
  }

  let statistics = axisStatisticsCache.get(axis);
  if (!statistics) {
    statistics = signalStatistics(values);
    axisStatisticsCache.set(axis, statistics);
  }
  if (statistics.deviation < 0.08 || statistics.total < 0.5) {
    return {
      score: 0,
      alignment: 0,
      correlation: 0,
      boundarySupport: 0,
      interiorFlatness: 0,
      offset: 0,
    };
  }

  const offsetCandidates = new Map<string, number>();
  const addOffset = (value: number) => {
    const offset = positiveModulo(value, pitch);
    offsetCandidates.set(offset.toFixed(4), offset);
  };

  if (preferredOffset !== undefined) addOffset(preferredOffset);
  addOffset(0);
  for (const coordinate of strongestCoordinates(axis)) {
    const base = positiveModulo(coordinate, pitch);
    addOffset(base);
    addOffset(base - 0.2);
    addOffset(base + 0.2);
  }

  const sigma = Math.max(0.52, Math.min(1.15, pitch * 0.075));
  let bestAlignment = 0;
  let bestOffset = 0;
  let preferredAlignment = 0;
  let preferredPhase = 0;

  for (const offset of offsetCandidates.values()) {
    let weightedEnergy = 0;
    let weightTotal = 0;

    for (let index = 0; index < values.length; index += 1) {
      const coordinate = coordinateStart + index;
      const distance = phaseDistance(coordinate, pitch, offset);
      const weight = Math.exp(-0.5 * (distance / sigma) ** 2);
      weightedEnergy += values[index] * weight;
      weightTotal += weight;
    }

    if (weightTotal < EPSILON || weightTotal >= values.length - EPSILON) {
      continue;
    }

    const insideMean = weightedEnergy / weightTotal;
    const outsideMean =
      (statistics.total - weightedEnergy) / (values.length - weightTotal);
    const contrast = Math.max(
      0,
      (insideMean - outsideMean) / Math.max(0.5, statistics.deviation),
    );
    const contrastScore = 1 - Math.exp(-contrast / 1.15);
    const captured = weightedEnergy / Math.max(EPSILON, statistics.total);
    const baseline = weightTotal / values.length;
    const captureScore = clamp01(
      (captured - baseline) / Math.max(EPSILON, 1 - baseline),
    );
    const alignment = Math.sqrt(contrastScore * captureScore);

    if (
      preferredOffset !== undefined &&
      phaseDistance(offset, pitch, preferredOffset) < 0.01 &&
      alignment > preferredAlignment
    ) {
      preferredAlignment = alignment;
      preferredPhase = offset;
    }

    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      bestOffset = offset;
    }
  }

  // On white/transparent canvases the foreground bound is an observed edge,
  // not an assumption that the grid begins at canvas coordinate zero. Prefer
  // that measured phase when it explains virtually the same repeated energy;
  // this removes the sub-pixel drift caused by rasterized fractional edges.
  if (preferredAlignment >= bestAlignment * 0.84) {
    bestAlignment = preferredAlignment;
    bestOffset = preferredPhase;
  }

  const correlation = normalizedAutocorrelation(values, pitch);
  const sharpnessSupport = clamp01((statistics.sharpness - 0.08) / 0.14);
  const score =
    bestAlignment * (0.76 + correlation * 0.24) * sharpnessSupport;
  const slotMetrics = boundarySlotMetrics(
    axis,
    pitch,
    bestOffset,
    statistics,
  );

  return {
    score,
    alignment: bestAlignment,
    correlation,
    ...slotMetrics,
    offset: bestOffset,
  };
}

function combinedPitchScore(
  xEnergy: AxisEnergy,
  yEnergy: AxisEnergy,
  pitch: number,
  preferredOffsets?: { x: number; y: number },
): PitchScore {
  const x = scoreAxisPitch(xEnergy, pitch, preferredOffsets?.x);
  const y = scoreAxisPitch(yEnergy, pitch, preferredOffsets?.y);
  const strongest = Math.max(x.score, y.score);
  const weakest = Math.min(x.score, y.score);
  const weakestAlignment = Math.min(x.alignment, y.alignment);

  // A genuine pixel grid leaves repeated boundaries on both axes. This hard
  // weak-axis requirement is what keeps stripes and smooth ramps from being
  // mistaken for square pixels.
  const score =
    weakestAlignment < MIN_AXIS_ALIGNMENT
      ? 0
      : strongest * 0.38 + weakest * 0.62;

  return {
    pitch,
    score,
    weakestAxis: weakest,
    boundarySupport: Math.min(x.boundarySupport, y.boundarySupport),
    interiorFlatness: Math.min(x.interiorFlatness, y.interiorFlatness),
    offsetX: x.offset,
    offsetY: y.offset,
  };
}

function addPitch(
  candidates: Map<string, number>,
  pitch: number,
  maximum: number,
) {
  if (!Number.isFinite(pitch) || pitch < 1.35 || pitch > maximum) return;
  candidates.set(pitch.toFixed(4), pitch);
}

function denseBoundaryPitch(axis: AxisEnergy) {
  let statistics = axisStatisticsCache.get(axis);
  if (!statistics) {
    statistics = signalStatistics(axis.values);
    axisStatisticsCache.set(axis, statistics);
  }

  const threshold = Math.max(
    0.5,
    statistics.mean + statistics.deviation * 0.25,
  );
  const coordinates: number[] = [];

  for (let index = 0; index < axis.values.length; index += 1) {
    const value = axis.values[index];
    const previous = index > 0 ? axis.values[index - 1] : 0;
    const next = index + 1 < axis.values.length ? axis.values[index + 1] : 0;
    if (value >= threshold && value > previous && value >= next) {
      coordinates.push(axis.coordinateStart + index);
    }
  }

  if (coordinates.length < 8) return null;
  const gaps: number[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const gap = coordinates[index] - coordinates[index - 1];
    if (gap >= 1 && gap <= 12) gaps.push(gap);
  }
  if (gaps.length < 7) return null;

  const sortedGaps = [...gaps].sort((first, second) => first - second);
  const baseGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  if (baseGap < 1 || baseGap > 5) return null;

  let totalDistance = 0;
  let totalIntervals = 0;
  for (const gap of gaps) {
    const intervals = Math.max(1, Math.round(gap / baseGap));
    if (intervals > 4) continue;
    totalDistance += gap;
    totalIntervals += intervals;
  }

  const pitch = totalDistance / Math.max(1, totalIntervals);
  return pitch >= 1.35 && pitch <= 5 ? pitch : null;
}

function candidatePitches(
  xEnergy: AxisEnergy,
  yEnergy: AxisEnergy,
  width: number,
  height: number,
) {
  const maximum = Math.min(
    MAX_ANALYSIS_PERIOD,
    Math.max(
      2,
      Math.floor(Math.max(xEnergy.values.length, yEnergy.values.length) / 3),
    ),
  );
  const coarse: PitchScore[] = [];

  for (let period = 2; period <= maximum; period += 1) {
    coarse.push(combinedPitchScore(xEnergy, yEnergy, period));
  }

  coarse.sort((first, second) => second.score - first.score);
  const seeds = coarse.filter(({ score }) => score > 0.04).slice(0, 7);
  const candidates = new Map<string, number>();
  const denseX = denseBoundaryPitch(xEnergy);
  const denseY = denseBoundaryPitch(yEnergy);

  if (denseX !== null && denseY !== null && Math.abs(denseX - denseY) <= 0.3) {
    const densePitch = (denseX + denseY) / 2;
    for (let delta = -0.12; delta <= 0.1201; delta += 0.01) {
      addPitch(candidates, densePitch + delta, maximum);
    }
    for (const length of [width, height]) {
      const cells = Math.max(MIN_GRID_REPEATS, Math.round(length / densePitch));
      addPitch(candidates, length / cells, maximum);
    }
  }

  for (const seed of seeds) {
    addPitch(candidates, seed.pitch, maximum);

    // Integer scanning cannot represent fractional upscales. Search around
    // every plausible peak and its first few sub-harmonics; 12.5 is thereby
    // evaluated even when its exact 25px harmonic is the integer winner.
    for (let divisor = 1; divisor <= 5; divisor += 1) {
      const center = seed.pitch / divisor;
      if (center < 1.35) continue;
      for (let delta = -1; delta <= 1.0001; delta += 0.1) {
        addPitch(candidates, center + delta, maximum);
      }
      if (center >= 2.85 && center <= 4) {
        for (let delta = -0.5; delta <= 0.5001; delta += 0.025) {
          addPitch(candidates, center + delta, maximum);
        }
      }

      // Full-bleed grids have an additional exact constraint: the canvas
      // contains an integer number of cells. Derive the complete uncertainty
      // window from ±1 analysis pixel instead of the old arbitrary ±3 cells.
      for (const length of [width, height]) {
        const lowPitch = Math.max(1.35, center - 1);
        const highPitch = center + 1;
        const minimumCells = Math.max(
          MIN_GRID_REPEATS,
          Math.floor(length / highPitch) - 1,
        );
        const maximumCells = Math.ceil(length / lowPitch) + 1;

        // Bound pathological tiny-pitch windows while retaining every count
        // around the coarse uncertainty for normal pseudo-pixel art.
        if (maximumCells - minimumCells <= 90) {
          for (
            let cells = minimumCells;
            cells <= maximumCells;
            cells += 1
          ) {
            addPitch(candidates, length / cells, maximum);
          }
        }
      }
    }
  }

  return [...candidates.values()];
}

function pitchesAreSameCandidate(first: number, second: number) {
  return Math.abs(first - second) < 0.18;
}

function harmonicMultiple(larger: number, smaller: number) {
  if (larger <= smaller || smaller < 1.35) return null;
  const ratio = larger / smaller;
  const multiple = Math.round(ratio);
  return multiple >= 2 && multiple <= 6 && Math.abs(ratio - multiple) < 0.035
    ? multiple
    : null;
}

function selectSupportedFundamental(
  ranked: PitchScore[],
  allowSparseForeground: boolean,
) {
  const hasBaseEvidence = (candidate: PitchScore) =>
    candidate.score >= MIN_FINAL_SCORE && candidate.weakestAxis >= 0.1;
  const hasStructuralEvidence = (candidate: PitchScore) =>
    hasBaseEvidence(candidate) &&
    candidate.boundarySupport >= MIN_BOUNDARY_SUPPORT &&
    candidate.interiorFlatness >= MIN_INTERIOR_FLATNESS;
  const structurallySupported = ranked.filter(hasStructuralEvidence);
  let strongest = allowSparseForeground
    ? ranked.find(hasBaseEvidence)
    : structurallySupported[0];

  if (!strongest) return undefined;

  // Sparse sprite geometry naturally leaves many phase slots empty. Preserve
  // its raw best candidate, but if that candidate is itself an unsupported
  // divisor and a structurally complete larger harmonic explains almost the
  // same evidence, promote the smallest such complete grid.
  if (allowSparseForeground && !hasStructuralEvidence(strongest)) {
    const supportedLarger = structurallySupported
      .filter(
        (candidate) =>
          harmonicMultiple(candidate.pitch, strongest!.pitch) !== null &&
          candidate.score >= strongest!.score * 0.68,
      )
      .sort((first, second) => first.pitch - second.pitch);
    strongest = supportedLarger[0] ?? strongest;
  }

  if (!strongest) return undefined;

  const supportFloor = Math.max(MIN_FINAL_SCORE, strongest.score * 0.78);
  const supportedSubharmonics = structurallySupported
    .filter(
      (candidate) =>
        harmonicMultiple(strongest.pitch, candidate.pitch) !== null &&
        candidate.score >= supportFloor &&
        candidate.weakestAxis >= 0.1,
    )
    .sort((first, second) => first.pitch - second.pitch);

  // The smallest candidate that still explains at least 78% of the strongest
  // repeated structure is the grid fundamental. This retains weak intervening
  // boundaries instead of allowing their exact 2x harmonic to merge cells.
  return supportedSubharmonics[0] ?? strongest;
}

function confidenceFromFinalScores(best: PitchScore, runnerUp?: PitchScore) {
  const absolute = clamp01((best.score - MIN_FINAL_SCORE) / 0.5);
  const weakAxis = clamp01((best.weakestAxis - 0.1) / 0.55);
  const separation = runnerUp
    ? clamp01((best.score - runnerUp.score) / 0.14)
    : 1;
  const scoredConfidence = Math.round(
    (absolute * 0.58 + weakAxis * 0.27 + separation * 0.15) * 100,
  );
  const hasValidatedStructure =
    best.boundarySupport >= MIN_BOUNDARY_SUPPORT &&
    best.interiorFlatness >= MIN_INTERIOR_FLATNESS;

  // A wide antialias transition can lower correlation/separation even when
  // every boundary slot and every cell plateau independently validate. That
  // direct structural evidence is strong enough to clear the app's acceptance
  // threshold, while rejected codec/gradient candidates never reach this path.
  return hasValidatedStructure ? Math.max(25, scoredConfidence) : scoredConfidence;
}

function normalizedSourceOffset(offset: number, pitch: number, scale: number) {
  // An energy sample at integer coordinate x represents the boundary between
  // raster pixels x-1 and x. Its unbiased continuous coordinate is x-0.5.
  let sourceOffset = positiveModulo((offset - 0.5) / scale, pitch);
  // Rasterized fractional grids put their first boundary within half a source
  // pixel of the canvas edge. Treat those equivalent phases as zero so range
  // construction cannot invent an almost-full leading fragment.
  const sourcePixelUncertainty = 0.8 / Math.max(scale, EPSILON);
  if (
    Math.min(sourceOffset, pitch - sourceOffset) <= sourcePixelUncertainty
  ) {
    sourceOffset = 0;
  }
  if (Math.abs(pitch - Math.round(pitch)) < 0.001) {
    const rounded = Math.round(sourceOffset);
    if (Math.abs(sourceOffset - rounded) <= sourcePixelUncertainty) {
      sourceOffset = rounded;
    }
  }
  return Math.round(sourceOffset * 1000) / 1000;
}

export function buildCellRanges(
  length: number,
  pixelSize: number,
  offset: number,
) {
  const period =
    Number.isFinite(pixelSize) && pixelSize > 0 ? Math.max(1, pixelSize) : 1;
  const safeOffset = Number.isFinite(offset) ? offset : 0;
  const normalizedOffset = positiveModulo(safeOffset, period);
  const minimumFragment = period * 0.5;
  const ranges: Array<[number, number]> = [];

  if (normalizedOffset + EPSILON >= minimumFragment) {
    const fragmentEnd = Math.min(length, Math.round(normalizedOffset));
    if (fragmentEnd > 0) ranges.push([0, fragmentEnd]);
  }

  const cellCount = Math.max(
    0,
    Math.ceil((length - normalizedOffset) / period - EPSILON),
  );

  for (let index = 0; index < cellCount; index += 1) {
    const logicalStart = normalizedOffset + index * period;
    const logicalEnd = Math.min(
      length,
      normalizedOffset + (index + 1) * period,
    );
    if (logicalEnd - logicalStart + EPSILON < minimumFragment) continue;

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
    width: buildCellRanges(width, settings.pixelSize, settings.offsetX).length,
    height: buildCellRanges(height, settings.pixelSize, settings.offsetY).length,
  };
}

/**
 * Detect a square source-pixel grid from already-rasterized analysis pixels.
 * `sourceWidth`/`sourceHeight` may be larger than the buffer when the browser
 * downscaled a very large image for analysis.
 */
export function detectPixelGridData(
  image: PixelBuffer,
  sourceWidth = image.width,
  sourceHeight = image.height,
): PixelGridDetection {
  const region = findAnalysisRegion(image);
  const xEnergy = verticalEnergy(image, region);
  const yEnergy = horizontalEnergy(image, region);
  const fullCanvasRegion: AnalysisRegion | null = region.hasLightNeutralCanvas
    ? {
        left: 0,
        top: 0,
        right: image.width,
        bottom: image.height,
        foregroundMask: null,
        anchorX: 0,
        anchorY: 0,
        hasLightNeutralCanvas: false,
      }
    : null;
  const canvasXEnergy = fullCanvasRegion
    ? verticalEnergy(image, fullCanvasRegion)
    : null;
  const canvasYEnergy = fullCanvasRegion
    ? horizontalEnergy(image, fullCanvasRegion)
    : null;
  const candidates = candidatePitches(
    xEnergy,
    yEnergy,
    image.width,
    image.height,
  );

  if (candidates.length === 0) {
    return {
      pixelSize: 1,
      confidence: 0,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const ranked = candidates
    .map((pitch) =>
      combinedPitchScore(xEnergy, yEnergy, pitch, {
        x: region.anchorX,
        y: region.anchorY,
      }),
    )
    .sort((first, second) => second.score - first.score);
  const best = selectSupportedFundamental(
    ranked,
    region.foregroundMask !== null,
  );

  if (
    !best ||
    best.pitch < MIN_RELIABLE_ANALYSIS_PITCH ||
    best.score < MIN_FINAL_SCORE ||
    best.weakestAxis < 0.1
  ) {
    return {
      pixelSize: 1,
      confidence: 0,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const runnerUp = ranked.find(
    ({ pitch }) => !pitchesAreSameCandidate(pitch, best.pitch),
  );
  const scaleX = image.width / sourceWidth;
  const scaleY = image.height / sourceHeight;
  // Browser/worker rasterization applies one uniform scale, but rounding the
  // short axis can make its measured ratio noticeably different (for example
  // 4096x65 -> 2048x33). The long axis defines the actual raster scale.
  const sourceScale =
    sourceWidth >= sourceHeight ? scaleX : scaleY;
  let pixelSize = best.pitch / sourceScale;
  const nearestInteger = Math.round(pixelSize);
  let snappedToInteger = false;

  // The uncertainty of an analysis-space boundary is one source pixel divided
  // by the analysis scale. Exact integer pitches remain exact after downscale.
  if (Math.abs(pixelSize - nearestInteger) <= 0.075 / sourceScale) {
    pixelSize = nearestInteger;
    snappedToInteger = true;
  }

  if (region.foregroundMask === null && !snappedToInteger) {
    const horizontalCells = Math.round(sourceWidth / pixelSize);
    const verticalCells = Math.round(sourceHeight / pixelSize);

    if (
      horizontalCells >= MIN_GRID_REPEATS &&
      verticalCells >= MIN_GRID_REPEATS
    ) {
      const horizontalPitch = sourceWidth / horizontalCells;
      const verticalPitch = sourceHeight / verticalCells;
      const canvasPitch = (horizontalPitch + verticalPitch) / 2;
      const countAgreement = Math.abs(horizontalPitch - verticalPitch);
      const refinementWindow = Math.max(0.08, pixelSize * 0.01);

      // When both canvas axes independently imply the same integer cell count,
      // use that exact full-bleed constraint. Requiring agreement on both axes
      // avoids forcing partial-cell banners to canvasLength / N.
      if (
        countAgreement <= Math.max(0.04, pixelSize * 0.003) &&
        Math.abs(canvasPitch - pixelSize) <= refinementWindow
      ) {
        pixelSize = canvasPitch;
      }
    }
  }
  pixelSize = Math.max(1, Math.round(pixelSize * 1000) / 1000);

  let detectedOffsetX = best.offsetX;
  let detectedOffsetY = best.offsetY;

  // A light canvas may itself contain a subtle checker/grid (the real 1254px
  // fixture does). Use that full-canvas signal only to recover phase; pitch is
  // still chosen from foreground structure, so a plain shifted white sprite
  // cannot be pulled toward canvasWidth / N again.
  if (canvasXEnergy && canvasYEnergy) {
    const canvasX = scoreAxisPitch(canvasXEnergy, best.pitch, 0);
    const canvasY = scoreAxisPitch(canvasYEnergy, best.pitch, 0);
    if (canvasX.alignment >= MIN_AXIS_ALIGNMENT) {
      detectedOffsetX = canvasX.offset;
    }
    if (canvasY.alignment >= MIN_AXIS_ALIGNMENT) {
      detectedOffsetY = canvasY.offset;
    }
  }

  const offsetX = normalizedSourceOffset(detectedOffsetX, pixelSize, scaleX);
  const offsetY = normalizedSourceOffset(detectedOffsetY, pixelSize, scaleY);
  return {
    pixelSize,
    confidence: confidenceFromFinalScores(best, runnerUp),
    offsetX,
    offsetY,
  };
}
