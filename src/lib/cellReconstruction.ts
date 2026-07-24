import type { PixelBuffer } from "./gridDetection";

export type SourceCellRange = readonly [number, number];
export type RgbaColor = readonly [number, number, number, number];
export type ReconstructionPaletteColor =
  | string
  | readonly [number, number, number];

export type ReconstructionCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CellReconstructionOptions = {
  /**
   * A logical image aligned with the selected source ranges. When supplied,
   * its alpha channel is preserved for every output pixel.
   */
  current?: PixelBuffer;
  /**
   * One byte per logical output pixel. Non-zero entries preserve all four
   * channels from `current` and are never palette-mapped or refined.
   */
  protectedMask?: Uint8Array;
  /**
   * Optional output palette. Mapping happens after local source evidence has
   * been resolved and never affects protected pixels or the locked alpha.
   */
  palette?: readonly ReconstructionPaletteColor[];
  /**
   * Select a logical sub-rectangle from the complete source range mapping.
   * The optional `current` and mask describe this cropped output, not the
   * uncropped mapping.
   */
  crop?: ReconstructionCrop;
  /**
   * Decision diagnostics are useful to tests and callers that explain each
   * cell. Production reconstruction can omit them to avoid retaining one
   * object per output pixel.
   */
  includeDecisions?: boolean;
};

export type CellDecisionReason =
  | "dominant-local-mode"
  | "centered-local-detail"
  | "ambiguous-local-mode"
  | "neighbor-consensus"
  | "kept-current-ambiguous"
  | "kept-current-transparent"
  | "protected";

export type CellReconstructionDecision = {
  x: number;
  y: number;
  /** Final color after alpha locking and optional palette mapping. */
  color: RgbaColor;
  /** Actual source sample selected before output constraints, or null if protected. */
  sourceColor: RgbaColor | null;
  /** Zero-to-one separation of the selected local mode from its alternatives. */
  confidence: number;
  candidateCount: number;
  refinedByNeighbors: boolean;
  reason: CellDecisionReason;
};

export type CellReconstructionResult = PixelBuffer & {
  decisions: CellReconstructionDecision[];
  crop: ReconstructionCrop;
};

type NormalizedRange = readonly [number, number];

type ColorBin = {
  key: number;
  count: number;
  weight: number;
  coreWeight: number;
  evidence: number;
  firstOffset: number;
  vectorRed: number;
  vectorGreen: number;
  vectorBlue: number;
  vectorAlpha: number;
};

type LocalCandidate = {
  key: number;
  count: number;
  weight: number;
  coreWeight: number;
  evidence: number;
  sourceOffset: number;
  color: RgbaColor;
};

type CellAnalysis = {
  candidates: LocalCandidate[];
  candidateCount: number;
  selectedIndex: number;
  confidence: number;
  ambiguous: boolean;
  reason: CellDecisionReason;
  refinedByNeighbors: boolean;
  protectedColor: RgbaColor | null;
};

const MAX_LOCAL_CANDIDATES = 4;
const SAMPLE_GRID_SIZE = 9;
export const MAX_RECONSTRUCTION_CELLS = 250_000;
const CORE_EVIDENCE_BONUS = 3;
const AMBIGUOUS_CONFIDENCE = 0.34;
const STABLE_NEIGHBOR_CONFIDENCE = 0.42;
const EPSILON = 1e-9;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function assertImage(image: PixelBuffer, label: string) {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1
  ) {
    throw new RangeError(`${label} has invalid dimensions.`);
  }

  if (image.data.length < image.width * image.height * 4) {
    throw new RangeError(`${label} pixel buffer is incomplete.`);
  }
}

function normalizeRanges(
  ranges: readonly SourceCellRange[],
  sourceLength: number,
  label: string,
) {
  if (ranges.length === 0) {
    throw new RangeError(`${label} must contain at least one source cell.`);
  }

  return ranges.map((range, index): NormalizedRange => {
    if (
      range.length !== 2 ||
      !Number.isFinite(range[0]) ||
      !Number.isFinite(range[1]) ||
      range[1] <= range[0]
    ) {
      throw new RangeError(`${label} ${index} is invalid.`);
    }

    const start = Math.max(
      0,
      Math.min(sourceLength - 1, Math.round(range[0])),
    );
    const end = Math.max(
      start + 1,
      Math.min(sourceLength, Math.round(range[1])),
    );
    return [start, end];
  });
}

function normalizeCrop(
  crop: ReconstructionCrop | undefined,
  width: number,
  height: number,
): ReconstructionCrop {
  const selected = crop ?? { x: 0, y: 0, width, height };

  if (
    !Number.isInteger(selected.x) ||
    !Number.isInteger(selected.y) ||
    !Number.isInteger(selected.width) ||
    !Number.isInteger(selected.height) ||
    selected.x < 0 ||
    selected.y < 0 ||
    selected.width < 1 ||
    selected.height < 1 ||
    selected.x + selected.width > width ||
    selected.y + selected.height > height
  ) {
    throw new RangeError("The reconstruction crop is outside the source grid.");
  }

  return { ...selected };
}

function rgbaAt(data: Uint8ClampedArray, offset: number): RgbaColor {
  return [
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  ];
}

/**
 * Alpha-premultiplied RGB avoids treating hidden transparent RGB as visible
 * evidence. Rec. 601 channel weights provide a cheap perceptual approximation
 * while the explicit alpha component keeps opacity modes discrete.
 */
function perceptualVector(
  red: number,
  green: number,
  blue: number,
  alpha: number,
) {
  const opacity = alpha / 255;
  return [
    red * opacity * Math.sqrt(0.299),
    green * opacity * Math.sqrt(0.587),
    blue * opacity * Math.sqrt(0.114),
    alpha * Math.sqrt(1.15),
  ] as const;
}

function perceptualDistanceSquared(
  first: RgbaColor,
  second: RgbaColor,
) {
  const firstVector = perceptualVector(...first);
  const secondVector = perceptualVector(...second);
  let distance = 0;

  for (let channel = 0; channel < 4; channel += 1) {
    const delta = firstVector[channel] - secondVector[channel];
    distance += delta * delta;
  }

  return distance;
}

function perceptualDistanceAt(
  data: Uint8ClampedArray,
  firstOffset: number,
  secondOffset: number,
) {
  const firstAlpha = data[firstOffset + 3];
  const secondAlpha = data[secondOffset + 3];
  const firstOpacity = firstAlpha / 255;
  const secondOpacity = secondAlpha / 255;
  const red =
    (data[firstOffset] * firstOpacity -
      data[secondOffset] * secondOpacity) *
    Math.sqrt(0.299);
  const green =
    (data[firstOffset + 1] * firstOpacity -
      data[secondOffset + 1] * secondOpacity) *
    Math.sqrt(0.587);
  const blue =
    (data[firstOffset + 2] * firstOpacity -
      data[secondOffset + 2] * secondOpacity) *
    Math.sqrt(0.114);
  const alpha = (firstAlpha - secondAlpha) * Math.sqrt(1.15);
  return red * red + green * green + blue * blue + alpha * alpha;
}

function alphaClass(alpha: number) {
  if (alpha < 32) return 0;
  if (alpha >= 224) return 7;
  return 1 + Math.floor((alpha - 32) / 32);
}

function colorKey(data: Uint8ClampedArray, offset: number) {
  const alpha = alphaClass(data[offset + 3]);
  if (alpha === 0) return 0;

  return (
    (alpha << 12) |
    ((data[offset] >> 4) << 8) |
    ((data[offset + 1] >> 4) << 4) |
    (data[offset + 2] >> 4)
  );
}

function localGradient(
  source: PixelBuffer,
  x: number,
  y: number,
  offset: number,
) {
  let total = 0;
  const neighborOffsets: number[] = [];
  if (x > 0) neighborOffsets.push(offset - 4);
  if (x + 1 < source.width) neighborOffsets.push(offset + 4);
  if (y > 0) neighborOffsets.push(offset - source.width * 4);
  if (y + 1 < source.height) {
    neighborOffsets.push(offset + source.width * 4);
  }

  for (const neighborOffset of neighborOffsets) {
    total += Math.sqrt(
      perceptualDistanceAt(source.data, offset, neighborOffset),
    );
  }

  return total / Math.max(1, neighborOffsets.length);
}

function sampleCoordinates(start: number, end: number) {
  const length = end - start;
  const steps = Math.max(1, Math.min(SAMPLE_GRID_SIZE, length));

  if (steps === 1) return [start];
  return Array.from({ length: steps }, (_, index) =>
    Math.round(start + (index * (length - 1)) / (steps - 1)),
  );
}

function positionWeights(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  const halfWidth = Math.max(0.5, (right - left) / 2);
  const halfHeight = Math.max(0.5, (bottom - top) / 2);
  const normalizedX = Math.abs(x + 0.5 - (left + right) / 2) / halfWidth;
  const normalizedY = Math.abs(y + 0.5 - (top + bottom) / 2) / halfHeight;
  const radius = Math.max(normalizedX, normalizedY);
  const centrality = clamp01(1 - radius);

  return {
    center: 1 + centrality * centrality * 2.5,
    core: radius <= 0.36,
  };
}

function analyzeLocalCell(
  source: PixelBuffer,
  xRange: NormalizedRange,
  yRange: NormalizedRange,
): CellAnalysis {
  const [left, right] = xRange;
  const [top, bottom] = yRange;
  const sampleX = sampleCoordinates(left, right);
  const sampleY = sampleCoordinates(top, bottom);
  const bins = new Map<number, ColorBin>();
  const centerX = Math.round((left + right - 1) / 2);
  const centerY = Math.round((top + bottom - 1) / 2);
  const centerOffset = (centerY * source.width + centerX) * 4;
  const centerKey = colorKey(source.data, centerOffset);

  for (const y of sampleY) {
    for (const x of sampleX) {
      const offset = (y * source.width + x) * 4;
      const key = colorKey(source.data, offset);
      const position = positionWeights(x, y, left, top, right, bottom);
      const inverseGradient =
        1 / (1 + localGradient(source, x, y, offset) / 24);
      // Retain a small floor so a genuine one-pixel line is not eliminated
      // merely because every sample in it lies on an edge.
      const weight = position.center * (0.24 + inverseGradient * 0.76);
      const vector = perceptualVector(
        source.data[offset],
        source.data[offset + 1],
        source.data[offset + 2],
        source.data[offset + 3],
      );
      let bin = bins.get(key);

      if (!bin) {
        bin = {
          key,
          count: 0,
          weight: 0,
          coreWeight: 0,
          evidence: 0,
          firstOffset: offset,
          vectorRed: 0,
          vectorGreen: 0,
          vectorBlue: 0,
          vectorAlpha: 0,
        };
        bins.set(key, bin);
      }

      bin.count += 1;
      bin.weight += weight;
      if (position.core) bin.coreWeight += weight;
      bin.vectorRed += vector[0] * weight;
      bin.vectorGreen += vector[1] * weight;
      bin.vectorBlue += vector[2] * weight;
      bin.vectorAlpha += vector[3] * weight;
    }
  }

  for (const bin of bins.values()) {
    bin.evidence = bin.weight + bin.coreWeight * CORE_EVIDENCE_BONUS;
  }

  const rankedBins = [...bins.values()].sort(
    (first, second) =>
      second.evidence - first.evidence ||
      second.weight - first.weight ||
      first.key - second.key ||
      first.firstOffset - second.firstOffset,
  );
  const selectedBins = rankedBins.slice(0, MAX_LOCAL_CANDIDATES);
  const centerBin = bins.get(centerKey);

  if (
    centerBin &&
    !selectedBins.some(({ key }) => key === centerKey)
  ) {
    if (selectedBins.length === MAX_LOCAL_CANDIDATES) selectedBins.pop();
    selectedBins.push(centerBin);
  }

  const selectedByKey = new Map(
    selectedBins.map((bin) => [bin.key, bin]),
  );
  const medoidDistance = new Map<number, number>();
  const medoidOffset = new Map<number, number>();

  for (const bin of selectedBins) {
    medoidDistance.set(bin.key, Number.POSITIVE_INFINITY);
    medoidOffset.set(bin.key, bin.firstOffset);
  }

  for (const y of sampleY) {
    for (const x of sampleX) {
      const offset = (y * source.width + x) * 4;
      const key = colorKey(source.data, offset);
      const bin = selectedByKey.get(key);
      if (!bin) continue;

      const vector = perceptualVector(
        source.data[offset],
        source.data[offset + 1],
        source.data[offset + 2],
        source.data[offset + 3],
      );
      const red = vector[0] - bin.vectorRed / bin.weight;
      const green = vector[1] - bin.vectorGreen / bin.weight;
      const blue = vector[2] - bin.vectorBlue / bin.weight;
      const alpha = vector[3] - bin.vectorAlpha / bin.weight;
      const distance =
        red * red + green * green + blue * blue + alpha * alpha;
      const bestDistance = medoidDistance.get(key)!;
      const bestOffset = medoidOffset.get(key)!;

      if (
        distance < bestDistance - EPSILON ||
        (Math.abs(distance - bestDistance) <= EPSILON && offset < bestOffset)
      ) {
        medoidDistance.set(key, distance);
        medoidOffset.set(key, offset);
      }
    }
  }

  const candidates = selectedBins
    .map(
      (bin): LocalCandidate => ({
        key: bin.key,
        count: bin.count,
        weight: bin.weight,
        coreWeight: bin.coreWeight,
        evidence: bin.evidence,
        sourceOffset: medoidOffset.get(bin.key)!,
        color: rgbaAt(source.data, medoidOffset.get(bin.key)!),
      }),
    )
    .sort(
      (first, second) =>
        second.evidence - first.evidence ||
        second.weight - first.weight ||
        first.key - second.key ||
        first.sourceOffset - second.sourceOffset,
    );
  let selectedIndex = 0;
  const strongest = candidates[0];
  const centerCandidateIndex = candidates.findIndex(
    ({ key }) => key === centerKey,
  );
  const centerCandidate = candidates[centerCandidateIndex];
  const pixelCount = sampleX.length * sampleY.length;
  const promotesCenteredDetail =
    centerCandidateIndex > 0 &&
    centerCandidate.count < pixelCount * 0.5 &&
    centerCandidate.coreWeight /
      Math.max(EPSILON, centerCandidate.weight) >=
      0.8 &&
    centerCandidate.evidence >= strongest.evidence * 0.45;

  if (promotesCenteredDetail) selectedIndex = centerCandidateIndex;

  const best = candidates[selectedIndex];
  const runnerUp = candidates.find(
    (_, candidateIndex) => candidateIndex !== selectedIndex,
  );
  const totalEvidence = rankedBins.reduce(
    (total, bin) => total + bin.evidence,
    0,
  );
  const dominance = best.evidence / Math.max(EPSILON, totalEvidence);
  const margin = runnerUp
    ? (best.evidence - runnerUp.evidence) /
      Math.max(EPSILON, best.evidence)
    : 1;
  const confidence = promotesCenteredDetail
    ? clamp01(
        0.24 +
          ((best.evidence / Math.max(EPSILON, strongest.evidence) - 0.45) /
            0.55) *
            0.46,
      )
    : runnerUp
      ? clamp01(margin * 0.72 + Math.max(0, dominance - 0.5) * 0.56)
      : 1;
  const centeredDetail =
    best.count < pixelCount * 0.5 &&
    best.coreWeight / Math.max(EPSILON, best.weight) >= 0.55;
  const ambiguous =
    candidates.length > 1 &&
    confidence < AMBIGUOUS_CONFIDENCE &&
    !centeredDetail &&
    !promotesCenteredDetail;

  return {
    candidates,
    candidateCount: candidates.length,
    selectedIndex,
    confidence,
    ambiguous,
    reason: centeredDetail || promotesCenteredDetail
      ? "centered-local-detail"
      : ambiguous
        ? "ambiguous-local-mode"
        : "dominant-local-mode",
    refinedByNeighbors: false,
    protectedColor: null,
  };
}

function selectedColor(analysis: CellAnalysis) {
  return (
    analysis.protectedColor ??
    analysis.candidates[analysis.selectedIndex]?.color ??
    ([0, 0, 0, 0] as const)
  );
}

function boundaryAffinity(
  source: PixelBuffer,
  xRanges: readonly NormalizedRange[],
  yRanges: readonly NormalizedRange[],
  x: number,
  y: number,
  neighborX: number,
  neighborY: number,
) {
  let firstX: number;
  let firstY: number;
  let secondX: number;
  let secondY: number;
  let sampleLength: number;
  let horizontal: boolean;

  if (neighborX !== x) {
    const leftCell = Math.min(x, neighborX);
    const rightCell = Math.max(x, neighborX);
    firstX = Math.max(0, Math.min(source.width - 1, xRanges[leftCell][1] - 1));
    secondX = Math.max(0, Math.min(source.width - 1, xRanges[rightCell][0]));
    firstY = yRanges[y][0];
    secondY = firstY;
    sampleLength = yRanges[y][1] - yRanges[y][0];
    horizontal = false;
  } else {
    const topCell = Math.min(y, neighborY);
    const bottomCell = Math.max(y, neighborY);
    firstY = Math.max(0, Math.min(source.height - 1, yRanges[topCell][1] - 1));
    secondY = Math.max(0, Math.min(source.height - 1, yRanges[bottomCell][0]));
    firstX = xRanges[x][0];
    secondX = firstX;
    sampleLength = xRanges[x][1] - xRanges[x][0];
    horizontal = true;
  }

  const steps = Math.max(1, Math.min(17, sampleLength));
  let distance = 0;

  for (let step = 0; step < steps; step += 1) {
    const along = Math.min(
      sampleLength - 1,
      Math.floor(((step + 0.5) * sampleLength) / steps),
    );
    const firstOffset = horizontal
      ? (firstY * source.width + firstX + along) * 4
      : ((firstY + along) * source.width + firstX) * 4;
    const secondOffset = horizontal
      ? (secondY * source.width + secondX + along) * 4
      : ((secondY + along) * source.width + secondX) * 4;
    distance += Math.sqrt(
      perceptualDistanceAt(source.data, firstOffset, secondOffset),
    );
  }

  const meanDistance = distance / steps;
  return clamp01((48 - meanDistance) / 36);
}

function refineAmbiguousCells(
  source: PixelBuffer,
  xRanges: readonly NormalizedRange[],
  yRanges: readonly NormalizedRange[],
  analyses: CellAnalysis[],
) {
  const width = xRanges.length;
  const height = yRanges.length;
  const initialColors = analyses.map(selectedColor);
  const stable = analyses.map(
    (analysis) =>
      analysis.protectedColor !== null ||
      (!analysis.ambiguous &&
        analysis.confidence >= STABLE_NEIGHBOR_CONFIDENCE),
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const analysis = analyses[index];

      // Centered minority modes represent deliberate local detail and should
      // not be flattened merely because a surrounding color is more common.
      if (
        !analysis.ambiguous ||
        analysis.reason === "centered-local-detail" ||
        analysis.candidates.length < 2
      ) {
        continue;
      }

      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const;
      const usableNeighbors: Array<{
        color: RgbaColor;
        affinity: number;
        confidence: number;
      }> = [];

      for (const [neighborX, neighborY] of neighbors) {
        if (
          neighborX < 0 ||
          neighborY < 0 ||
          neighborX >= width ||
          neighborY >= height
        ) {
          continue;
        }
        const neighborIndex = neighborY * width + neighborX;
        if (!stable[neighborIndex]) continue;
        const affinity = boundaryAffinity(
          source,
          xRanges,
          yRanges,
          x,
          y,
          neighborX,
          neighborY,
        );
        if (affinity < 0.2) continue;

        usableNeighbors.push({
          color: initialColors[neighborIndex],
          affinity,
          confidence: analyses[neighborIndex].protectedColor
            ? 1
            : analyses[neighborIndex].confidence,
        });
      }

      const totalNeighborWeight = usableNeighbors.reduce(
        (total, neighbor) =>
          total + neighbor.affinity * neighbor.confidence,
        0,
      );
      if (totalNeighborWeight < 0.65) continue;

      const localBest = analysis.candidates[analysis.selectedIndex];
      const neighborScore = (candidate: LocalCandidate) =>
        usableNeighbors.reduce((total, neighbor) => {
          const distance = perceptualDistanceSquared(
            candidate.color,
            neighbor.color,
          );
          const similarity = 1 / (1 + distance / (28 * 28));
          return (
            total +
            similarity * neighbor.affinity * neighbor.confidence
          );
        }, 0) / totalNeighborWeight;
      const originalNeighborScore = neighborScore(localBest);
      let bestIndex = analysis.selectedIndex;
      let bestObjective = 0.7 + originalNeighborScore * 0.3;
      let bestNeighborScore = originalNeighborScore;

      for (
        let candidateIndex = 0;
        candidateIndex < analysis.candidates.length;
        candidateIndex += 1
      ) {
        if (candidateIndex === analysis.selectedIndex) continue;
        const candidate = analysis.candidates[candidateIndex];
        const localRatio =
          candidate.evidence / Math.max(EPSILON, localBest.evidence);
        if (localRatio < 0.82) continue;

        const candidateNeighborScore = neighborScore(candidate);
        const objective =
          Math.min(1, localRatio) * 0.7 + candidateNeighborScore * 0.3;
        if (
          candidateNeighborScore >= originalNeighborScore + 0.22 &&
          objective > bestObjective + 0.045
        ) {
          bestIndex = candidateIndex;
          bestObjective = objective;
          bestNeighborScore = candidateNeighborScore;
        }
      }

      if (bestIndex === analysis.selectedIndex) continue;
      analysis.selectedIndex = bestIndex;
      analysis.refinedByNeighbors = true;
      analysis.reason = "neighbor-consensus";
      analysis.confidence = clamp01(
        Math.max(
          analysis.confidence,
          0.34 + (bestNeighborScore - originalNeighborScore) * 0.5,
        ),
      );
    }
  }
}

function parsePaletteColor(color: ReconstructionPaletteColor) {
  if (typeof color !== "string") {
    if (
      color.length !== 3 ||
      color.some(
        (channel) =>
          !Number.isInteger(channel) || channel < 0 || channel > 255,
      )
    ) {
      throw new TypeError("Palette tuples must contain three byte values.");
    }
    return [color[0], color[1], color[2]] as const;
  }

  const normalized = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return normalized
      .slice(1)
      .split("")
      .map((character) => Number.parseInt(character.repeat(2), 16)) as [
      number,
      number,
      number,
    ];
  }
  if (/^#[0-9a-f]{6}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(1, 3), 16),
      Number.parseInt(normalized.slice(3, 5), 16),
      Number.parseInt(normalized.slice(5, 7), 16),
    ] as const;
  }

  throw new TypeError(`Unsupported palette color: ${color}`);
}

function mapRgbToPalette(
  color: RgbaColor,
  palette: readonly (readonly [number, number, number])[],
) {
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of palette) {
    const red = color[0] - candidate[0];
    const green = color[1] - candidate[1];
    const blue = color[2] - candidate[2];
    const distance =
      red * red * 0.299 + green * green * 0.587 + blue * blue * 0.114;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Reconstruct one true output pixel per supplied source-cell range.
 *
 * Local candidates are always represented by actual source samples. A
 * deterministic neighbor pass can only select another candidate from the same
 * source cell; it never copies a neighboring color into that cell. Optional
 * palette mapping is an explicit final output constraint.
 */
export function reconstructSourceCells(
  source: PixelBuffer,
  xRanges: readonly SourceCellRange[],
  yRanges: readonly SourceCellRange[],
  options: CellReconstructionOptions = {},
): CellReconstructionResult {
  assertImage(source, "Source image");
  const normalizedX = normalizeRanges(xRanges, source.width, "X range");
  const normalizedY = normalizeRanges(yRanges, source.height, "Y range");
  const crop = normalizeCrop(
    options.crop,
    normalizedX.length,
    normalizedY.length,
  );
  const selectedX = normalizedX.slice(crop.x, crop.x + crop.width);
  const selectedY = normalizedY.slice(crop.y, crop.y + crop.height);
  const pixelCount = crop.width * crop.height;
  const current = options.current;
  const protectedMask = options.protectedMask;
  const includeDecisions = options.includeDecisions ?? true;

  if (pixelCount > MAX_RECONSTRUCTION_CELLS) {
    throw new RangeError(
      `Magic Fix supports up to ${MAX_RECONSTRUCTION_CELLS.toLocaleString()} logical pixels at a time. Crop the result or increase the source pixel size first.`,
    );
  }

  if (current) {
    assertImage(current, "Current logical image");
    if (current.width !== crop.width || current.height !== crop.height) {
      throw new RangeError(
        "Current logical image dimensions do not match the selected source grid.",
      );
    }
  }
  if (protectedMask) {
    if (!current) {
      throw new RangeError("A protected mask requires a current logical image.");
    }
    if (protectedMask.length < pixelCount) {
      throw new RangeError("The protected mask is incomplete.");
    }
  }

  const palette = options.palette?.map(parsePaletteColor);
  if (options.palette && (!palette || palette.length === 0)) {
    throw new RangeError("The reconstruction palette is empty.");
  }

  const analyses = new Array<CellAnalysis>(pixelCount);

  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const index = y * crop.width + x;
      if (protectedMask?.[index]) {
        const offset = index * 4;
        analyses[index] = {
          candidates: [],
          candidateCount: 0,
          selectedIndex: 0,
          confidence: 1,
          ambiguous: false,
          reason: "protected",
          refinedByNeighbors: false,
          protectedColor: rgbaAt(current!.data, offset),
        };
      } else {
        const analysis = analyzeLocalCell(
          source,
          selectedX[x],
          selectedY[y],
        );
        // Only ambiguous cells need alternate candidates during the neighbor
        // pass. Discarding stable alternatives keeps large reconstructions
        // bounded without changing their selected source color.
        if (!analysis.ambiguous && analysis.candidates.length > 1) {
          analysis.candidates = [
            analysis.candidates[analysis.selectedIndex],
          ];
          analysis.selectedIndex = 0;
        }
        analyses[index] = analysis;
      }
    }
  }

  refineAmbiguousCells(source, selectedX, selectedY, analyses);

  const data = new Uint8ClampedArray(pixelCount * 4);
  const decisions = includeDecisions
    ? new Array<CellReconstructionDecision>(pixelCount)
    : [];

  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const index = y * crop.width + x;
      const offset = index * 4;
      const analysis = analyses[index];
      const isProtected = analysis.protectedColor !== null;
      const sourceColor = isProtected
        ? null
        : analysis.candidates[analysis.selectedIndex].color;
      let finalColor = selectedColor(analysis);
      const keptCurrentBecauseAmbiguous =
        !isProtected &&
        current !== undefined &&
        analysis.ambiguous &&
        !analysis.refinedByNeighbors;
      const keptCurrentBecauseTransparent =
        !isProtected &&
        current !== undefined &&
        current.data[offset + 3] === 0;

      if (keptCurrentBecauseAmbiguous || keptCurrentBecauseTransparent) {
        finalColor = rgbaAt(current.data, offset);
      } else if (!isProtected && palette) {
        const mapped = mapRgbToPalette(finalColor, palette);
        finalColor = [
          mapped[0],
          mapped[1],
          mapped[2],
          finalColor[3],
        ];
      }
      if (
        !isProtected &&
        current &&
        !keptCurrentBecauseAmbiguous &&
        !keptCurrentBecauseTransparent
      ) {
        finalColor = [
          finalColor[0],
          finalColor[1],
          finalColor[2],
          current.data[offset + 3],
        ];
      }

      data.set(finalColor, offset);
      if (includeDecisions) {
        decisions[index] = {
          x,
          y,
          color: finalColor,
          sourceColor,
          confidence: analysis.confidence,
          candidateCount: analysis.candidateCount,
          refinedByNeighbors: analysis.refinedByNeighbors,
          reason: keptCurrentBecauseTransparent
            ? "kept-current-transparent"
            : keptCurrentBecauseAmbiguous
              ? "kept-current-ambiguous"
              : analysis.reason,
        };
      }
    }
  }

  return {
    width: crop.width,
    height: crop.height,
    data,
    decisions,
    crop,
  };
}
