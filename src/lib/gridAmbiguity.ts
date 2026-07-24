import {
  getPixelGridDimensions,
  type PixelGridDetection,
  type PixelGridSettings,
} from "./gridDetection";

export const MIN_AMBIGUOUS_CONFIDENCE = 20;
export const MAX_AMBIGUOUS_CONFIDENCE = 25;

const GRID_PRECISION = 1000;
const FRACTIONAL_PITCH_EPSILON = 0.08;

export type PixelGridCandidate = Pick<
  PixelGridSettings,
  "pixelSize" | "offsetX" | "offsetY"
> & {
  width: number;
  height: number;
  kind: "integer" | "detected";
};

export type PixelGridAmbiguity = {
  confidence: number | null;
  candidates: [PixelGridCandidate, PixelGridCandidate];
};

function roundGridValue(value: number) {
  return Math.round(value * GRID_PRECISION) / GRID_PRECISION;
}

function positiveModulo(value: number, period: number) {
  return ((value % period) + period) % period;
}

function centeredGridOffset(length: number, pixelSize: number) {
  const cellCount = Math.max(1, Math.round(length / pixelSize));
  const uncovered = length - cellCount * pixelSize;
  return roundGridValue(positiveModulo(uncovered / 2, pixelSize));
}

function createCandidate(
  width: number,
  height: number,
  pixelSize: number,
  offsetX: number,
  offsetY: number,
  kind: PixelGridCandidate["kind"],
): PixelGridCandidate {
  const normalizedOffsetX = roundGridValue(
    positiveModulo(offsetX, pixelSize),
  );
  const normalizedOffsetY = roundGridValue(
    positiveModulo(offsetY, pixelSize),
  );
  const dimensions = getPixelGridDimensions(width, height, {
    pixelSize,
    offsetX: normalizedOffsetX,
    offsetY: normalizedOffsetY,
  });

  return {
    pixelSize,
    offsetX: normalizedOffsetX,
    offsetY: normalizedOffsetY,
    width: dimensions.width,
    height: dimensions.height,
    kind,
  };
}

/**
 * A weak fractional pitch is not precise enough to justify discarding rows or
 * columns. Offer the next finer integer lattice alongside the detector's exact
 * estimate and recommend the information-preserving integer candidate first.
 */
export function getPixelGridAmbiguity(
  detection: PixelGridDetection,
  width: number,
  height: number,
): PixelGridAmbiguity | null {
  if (
    !Number.isFinite(detection.pixelSize) ||
    !Number.isFinite(detection.offsetX) ||
    !Number.isFinite(detection.offsetY) ||
    !Number.isFinite(detection.confidence) ||
    detection.pixelSize <= 1 ||
    detection.confidence < MIN_AMBIGUOUS_CONFIDENCE ||
    detection.confidence > MAX_AMBIGUOUS_CONFIDENCE
  ) {
    return null;
  }

  const detectedPixelSize = roundGridValue(detection.pixelSize);
  if (
    Math.abs(detectedPixelSize - Math.round(detectedPixelSize)) <=
    FRACTIONAL_PITCH_EPSILON
  ) {
    return null;
  }

  const integerPixelSize = Math.max(1, Math.floor(detectedPixelSize));
  if (integerPixelSize >= detectedPixelSize) return null;

  const integerCandidate = createCandidate(
    width,
    height,
    integerPixelSize,
    centeredGridOffset(width, integerPixelSize),
    centeredGridOffset(height, integerPixelSize),
    "integer",
  );
  const detectedCandidate = createCandidate(
    width,
    height,
    detectedPixelSize,
    detection.offsetX,
    detection.offsetY,
    "detected",
  );

  if (
    integerCandidate.width === detectedCandidate.width &&
    integerCandidate.height === detectedCandidate.height
  ) {
    return null;
  }

  return {
    confidence: Math.round(Math.max(0, Math.min(100, detection.confidence))),
    candidates: [integerCandidate, detectedCandidate],
  };
}
