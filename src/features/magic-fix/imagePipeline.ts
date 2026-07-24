import type {
  PixelizeResult,
  SourceGridMapping,
} from "../../lib/pixelize";

/**
 * The DOM's ImageData is structurally compatible with this type, while the
 * smaller type keeps the deterministic pipeline usable in workers and tests.
 */
export type RgbaImageData = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type MagicFixModelCanvas = {
  width: number;
  height: number;
  /** FLUX image dimensions must be aligned to the provider's latent grid. */
  dimensionMultiple?: number;
  /**
   * Keep every logical pixel the same whole-number size in the model input.
   * This avoids introducing an uneven pseudo-grid before inference.
   */
  preserveIntegerScale?: boolean;
  /**
   * Pixel art should normally only be enlarged for the model. Set this only
   * when a provider cannot accept a canvas at least as large as the edit.
   */
  allowDownscale?: boolean;
  paddingColor?: readonly [number, number, number, number];
};

export type MagicFixTransform = {
  logicalWidth: number;
  logicalHeight: number;
  modelWidth: number;
  modelHeight: number;
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  scaleX: number;
  scaleY: number;
};

export type PreparedMagicFixImage = {
  image: RgbaImageData;
  transform: MagicFixTransform;
};

type ResultCrop = NonNullable<PixelizeResult["crop"]>;

export type PrepareOriginalReferenceOptions = {
  sourceGrid?: SourceGridMapping;
  resultCrop?: ResultCrop;
  paddingColor?: readonly [number, number, number, number];
};

export type MagicFixPaletteColor =
  | string
  | readonly [number, number, number];

export type MagicFixPaletteOptions = {
  colors?: readonly MagicFixPaletteColor[];
  /** Defaults to true when palette mapping is enabled. */
  includeCurrentColors?: boolean;
};

export type CollapseMagicFixOptions = {
  palette?: MagicFixPaletteOptions;
  /**
   * The RGB color used to flatten transparent model inputs. When supplied,
   * generated colors are converted back to straight-alpha RGB before the
   * current edit's alpha mask is restored.
   */
  flattenedBackground?: readonly [number, number, number];
};

const DEFAULT_PADDING = [0, 0, 0, 0] as const;
const MAX_SAMPLES_PER_CELL = 7 * 7;
const SAMPLE_GRID_SIZE = 7;
const SAMPLE_INSET = 0.14;
const MAX_PALETTE_COLORS = 96;
const QUANTIZED_COLOR_COUNT = 32 * 32 * 32;

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

function assertImage(image: RgbaImageData, label: string) {
  assertPositiveInteger(image.width, `${label} width`);
  assertPositiveInteger(image.height, `${label} height`);

  if (image.data.length < image.width * image.height * 4) {
    throw new RangeError(`${label} pixel buffer is incomplete.`);
  }
}

function assertByte(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${label} must be an integer from 0 to 255.`);
  }
}

function validatePaddingColor(
  color: readonly [number, number, number, number],
) {
  color.forEach((channel, index) =>
    assertByte(channel, `Padding channel ${index + 1}`),
  );
}

function fillImage(
  data: Uint8ClampedArray,
  color: readonly [number, number, number, number],
) {
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
  }
}

function nearestSourceCoordinate(
  destinationCoordinate: number,
  sourceLength: number,
  destinationLength: number,
) {
  return Math.min(
    sourceLength - 1,
    Math.floor(
      ((destinationCoordinate + 0.5) * sourceLength) / destinationLength,
    ),
  );
}

function copyPixel(
  source: RgbaImageData,
  sourceX: number,
  sourceY: number,
  destination: Uint8ClampedArray,
  destinationOffset: number,
) {
  const sourceOffset = (sourceY * source.width + sourceX) * 4;
  destination[destinationOffset] = source.data[sourceOffset];
  destination[destinationOffset + 1] = source.data[sourceOffset + 1];
  destination[destinationOffset + 2] = source.data[sourceOffset + 2];
  destination[destinationOffset + 3] = source.data[sourceOffset + 3];
}

function fittedContentSize(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  if (sourceWidth * targetHeight >= sourceHeight * targetWidth) {
    return {
      width: targetWidth,
      height: Math.max(
        1,
        Math.min(
          targetHeight,
          Math.round((sourceHeight * targetWidth) / sourceWidth),
        ),
      ),
    };
  }

  return {
    width: Math.max(
      1,
      Math.min(
        targetWidth,
        Math.round((sourceWidth * targetHeight) / sourceHeight),
      ),
    ),
    height: targetHeight,
  };
}

/**
 * Expands the logical edit into a model canvas using nearest-neighbour
 * resampling and transparent (or caller-selected) letterboxing.
 */
export function prepareMagicFixEdit(
  current: RgbaImageData,
  modelCanvas: MagicFixModelCanvas,
): PreparedMagicFixImage {
  assertImage(current, "Current edit");
  assertPositiveInteger(modelCanvas.width, "Model canvas width");
  assertPositiveInteger(modelCanvas.height, "Model canvas height");

  const dimensionMultiple = modelCanvas.dimensionMultiple ?? 1;
  assertPositiveInteger(dimensionMultiple, "Model dimension multiple");

  if (
    modelCanvas.width % dimensionMultiple !== 0 ||
    modelCanvas.height % dimensionMultiple !== 0
  ) {
    throw new RangeError(
      `Model canvas dimensions must be multiples of ${dimensionMultiple}.`,
    );
  }

  if (
    !modelCanvas.allowDownscale &&
    (modelCanvas.width < current.width ||
      modelCanvas.height < current.height)
  ) {
    throw new RangeError(
      "The model canvas is smaller than the logical edit. Choose a larger canvas or explicitly allow downscaling.",
    );
  }

  const paddingColor = modelCanvas.paddingColor ?? DEFAULT_PADDING;
  validatePaddingColor(paddingColor);

  const integerScale = Math.floor(
    Math.min(
      modelCanvas.width / current.width,
      modelCanvas.height / current.height,
    ),
  );
  const content =
    modelCanvas.preserveIntegerScale && integerScale >= 1
      ? {
          width: current.width * integerScale,
          height: current.height * integerScale,
        }
      : fittedContentSize(
          current.width,
          current.height,
          modelCanvas.width,
          modelCanvas.height,
        );
  const contentX = Math.floor((modelCanvas.width - content.width) / 2);
  const contentY = Math.floor((modelCanvas.height - content.height) / 2);
  const data = new Uint8ClampedArray(
    modelCanvas.width * modelCanvas.height * 4,
  );
  fillImage(data, paddingColor);

  for (let destinationY = 0; destinationY < content.height; destinationY += 1) {
    const sourceY = nearestSourceCoordinate(
      destinationY,
      current.height,
      content.height,
    );

    for (
      let destinationX = 0;
      destinationX < content.width;
      destinationX += 1
    ) {
      const sourceX = nearestSourceCoordinate(
        destinationX,
        current.width,
        content.width,
      );
      const targetX = contentX + destinationX;
      const targetY = contentY + destinationY;
      copyPixel(
        current,
        sourceX,
        sourceY,
        data,
        (targetY * modelCanvas.width + targetX) * 4,
      );
    }
  }

  return {
    image: {
      width: modelCanvas.width,
      height: modelCanvas.height,
      data,
    },
    transform: {
      logicalWidth: current.width,
      logicalHeight: current.height,
      modelWidth: modelCanvas.width,
      modelHeight: modelCanvas.height,
      contentX,
      contentY,
      contentWidth: content.width,
      contentHeight: content.height,
      scaleX: content.width / current.width,
      scaleY: content.height / current.height,
    },
  };
}

function evenlyDividedRanges(length: number, count: number) {
  return Array.from({ length: count }, (_, index): [number, number] => [
    (index * length) / count,
    ((index + 1) * length) / count,
  ]);
}

function validRanges(
  ranges: Array<[number, number]>,
  requiredLength: number,
  sourceLength: number,
) {
  if (ranges.length < requiredLength) return false;

  return ranges.slice(0, requiredLength).every(([start, end]) => {
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start &&
      end <= sourceLength
    );
  });
}

function currentSourceRanges(
  original: RgbaImageData,
  transform: MagicFixTransform,
  sourceGrid?: SourceGridMapping,
  resultCrop?: ResultCrop,
) {
  const crop = resultCrop ?? {
    x: 0,
    y: 0,
    width: transform.logicalWidth,
    height: transform.logicalHeight,
    baseWidth: transform.logicalWidth,
    baseHeight: transform.logicalHeight,
  };

  assertPositiveInteger(crop.baseWidth, "Crop base width");
  assertPositiveInteger(crop.baseHeight, "Crop base height");

  if (
    !Number.isInteger(crop.x) ||
    !Number.isInteger(crop.y) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width !== transform.logicalWidth ||
    crop.height !== transform.logicalHeight ||
    crop.x + transform.logicalWidth > crop.baseWidth ||
    crop.y + transform.logicalHeight > crop.baseHeight
  ) {
    throw new RangeError("The result crop does not contain the logical edit.");
  }

  const fallbackX = evenlyDividedRanges(original.width, crop.baseWidth);
  const fallbackY = evenlyDividedRanges(original.height, crop.baseHeight);
  const mappedX =
    sourceGrid &&
    validRanges(sourceGrid.xRanges, crop.baseWidth, original.width)
      ? sourceGrid.xRanges
      : fallbackX;
  const mappedY =
    sourceGrid &&
    validRanges(sourceGrid.yRanges, crop.baseHeight, original.height)
      ? sourceGrid.yRanges
      : fallbackY;

  return {
    x: mappedX.slice(crop.x, crop.x + transform.logicalWidth),
    y: mappedY.slice(crop.y, crop.y + transform.logicalHeight),
  };
}

function mappedSourceCoordinate(
  destinationCoordinate: number,
  destinationLength: number,
  logicalLength: number,
  ranges: Array<[number, number]>,
) {
  const logicalPosition =
    ((destinationCoordinate + 0.5) * logicalLength) / destinationLength;
  const cell = Math.min(logicalLength - 1, Math.floor(logicalPosition));
  const cellProgress = logicalPosition - cell;
  const [start, end] = ranges[cell];

  return Math.min(
    Math.ceil(end) - 1,
    Math.max(Math.floor(start), Math.floor(start + cellProgress * (end - start))),
  );
}

/**
 * Warps the original source grid into the exact same letterbox transform as
 * the logical edit. Each original source cell maps to one logical cell, so a
 * cropped edit remains spatially aligned without discarding the source detail
 * inside that cell.
 */
export function prepareMagicFixOriginalReference(
  original: RgbaImageData,
  transform: MagicFixTransform,
  options: PrepareOriginalReferenceOptions = {},
): RgbaImageData {
  assertImage(original, "Original reference");
  assertTransform(transform);

  const paddingColor = options.paddingColor ?? DEFAULT_PADDING;
  validatePaddingColor(paddingColor);
  const ranges = currentSourceRanges(
    original,
    transform,
    options.sourceGrid,
    options.resultCrop,
  );
  const data = new Uint8ClampedArray(
    transform.modelWidth * transform.modelHeight * 4,
  );
  fillImage(data, paddingColor);

  for (
    let destinationY = 0;
    destinationY < transform.contentHeight;
    destinationY += 1
  ) {
    const sourceY = mappedSourceCoordinate(
      destinationY,
      transform.contentHeight,
      transform.logicalHeight,
      ranges.y,
    );

    for (
      let destinationX = 0;
      destinationX < transform.contentWidth;
      destinationX += 1
    ) {
      const sourceX = mappedSourceCoordinate(
        destinationX,
        transform.contentWidth,
        transform.logicalWidth,
        ranges.x,
      );
      const targetX = transform.contentX + destinationX;
      const targetY = transform.contentY + destinationY;
      copyPixel(
        original,
        sourceX,
        sourceY,
        data,
        (targetY * transform.modelWidth + targetX) * 4,
      );
    }
  }

  return {
    width: transform.modelWidth,
    height: transform.modelHeight,
    data,
  };
}

function assertTransform(transform: MagicFixTransform) {
  assertPositiveInteger(transform.logicalWidth, "Logical width");
  assertPositiveInteger(transform.logicalHeight, "Logical height");
  assertPositiveInteger(transform.modelWidth, "Model width");
  assertPositiveInteger(transform.modelHeight, "Model height");
  assertPositiveInteger(transform.contentWidth, "Content width");
  assertPositiveInteger(transform.contentHeight, "Content height");

  if (
    !Number.isInteger(transform.contentX) ||
    !Number.isInteger(transform.contentY) ||
    transform.contentX < 0 ||
    transform.contentY < 0 ||
    transform.contentX + transform.contentWidth > transform.modelWidth ||
    transform.contentY + transform.contentHeight > transform.modelHeight
  ) {
    throw new RangeError("The Magic Fix content transform is invalid.");
  }
}

function parsePaletteColor(color: MagicFixPaletteColor) {
  if (typeof color !== "string") {
    if (color.length !== 3) {
      throw new TypeError("Palette tuple colors must contain three channels.");
    }
    color.forEach((channel, index) =>
      assertByte(channel, `Palette channel ${index + 1}`),
    );
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

function paletteKey(red: number, green: number, blue: number) {
  return (red << 16) | (green << 8) | blue;
}

function quantizedPaletteKey(red: number, green: number, blue: number) {
  return ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
}

function buildPalette(
  current: RgbaImageData,
  options: MagicFixPaletteOptions,
) {
  const palette: Array<readonly [number, number, number]> = [];
  const seen = new Set<number>();

  function add(color: readonly [number, number, number]) {
    const key = paletteKey(color[0], color[1], color[2]);
    if (seen.has(key)) return;
    seen.add(key);
    palette.push(color);
  }

  for (const color of options.colors ?? []) {
    if (palette.length >= MAX_PALETTE_COLORS) break;
    add(parsePaletteColor(color));
  }

  if (
    (options.includeCurrentColors ?? true) &&
    palette.length < MAX_PALETTE_COLORS
  ) {
    const remaining = MAX_PALETTE_COLORS - palette.length;
    const exactCurrent = new Set<number>();
    const quantizedCounts = new Uint32Array(QUANTIZED_COLOR_COUNT);
    const quantizedRed = new Uint32Array(QUANTIZED_COLOR_COUNT);
    const quantizedGreen = new Uint32Array(QUANTIZED_COLOR_COUNT);
    const quantizedBlue = new Uint32Array(QUANTIZED_COLOR_COUNT);
    let exactOverflow = false;
    const requiredLength = current.width * current.height * 4;

    for (let offset = 0; offset < requiredLength; offset += 4) {
      if (current.data[offset + 3] === 0) continue;
      const red = current.data[offset];
      const green = current.data[offset + 1];
      const blue = current.data[offset + 2];
      const exactKey = paletteKey(red, green, blue);

      if (!seen.has(exactKey) && !exactCurrent.has(exactKey)) {
        if (exactCurrent.size < remaining) {
          exactCurrent.add(exactKey);
        } else {
          exactOverflow = true;
        }
      }

      const quantizedKey = quantizedPaletteKey(red, green, blue);
      quantizedCounts[quantizedKey] += 1;
      quantizedRed[quantizedKey] += red;
      quantizedGreen[quantizedKey] += green;
      quantizedBlue[quantizedKey] += blue;
    }

    if (!exactOverflow) {
      for (const key of exactCurrent) {
        add([
          (key >> 16) & 0xff,
          (key >> 8) & 0xff,
          key & 0xff,
        ]);
      }
    } else {
      const populatedBins: number[] = [];
      for (let index = 0; index < quantizedCounts.length; index += 1) {
        if (quantizedCounts[index] > 0) populatedBins.push(index);
      }
      populatedBins.sort(
        (left, right) =>
          quantizedCounts[right] - quantizedCounts[left] ||
          left - right,
      );

      for (const key of populatedBins) {
        if (palette.length >= MAX_PALETTE_COLORS) break;
        const count = quantizedCounts[key];
        add([
          Math.round(quantizedRed[key] / count),
          Math.round(quantizedGreen[key] / count),
          Math.round(quantizedBlue[key] / count),
        ]);
      }
    }
  }

  if (palette.length === 0) {
    throw new RangeError("Palette mapping needs at least one visible color.");
  }

  return palette;
}

function mapToPalette(
  red: number,
  green: number,
  blue: number,
  palette: Array<readonly [number, number, number]>,
  cache: Int16Array,
) {
  const cacheKey = quantizedPaletteKey(red, green, blue);
  const cachedIndex = cache[cacheKey];
  if (cachedIndex >= 0) return palette[cachedIndex];

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < palette.length; index += 1) {
    const candidate = palette[index];
    const redDelta = red - candidate[0];
    const greenDelta = green - candidate[1];
    const blueDelta = blue - candidate[2];
    const distance =
      redDelta * redDelta * 0.299 +
      greenDelta * greenDelta * 0.587 +
      blueDelta * blueDelta * 0.114;

    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }

  cache[cacheKey] = bestIndex;
  return palette[bestIndex];
}

function restoreStraightAlphaColor(
  color: readonly [number, number, number],
  alpha: number,
  background: readonly [number, number, number],
) {
  if (alpha >= 255) return color;
  const normalizedAlpha = alpha / 255;
  const inverseAlpha = 1 - normalizedAlpha;

  return color.map((channel, index) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(
          (channel - background[index] * inverseAlpha) /
            normalizedAlpha,
        ),
      ),
    ),
  ) as [number, number, number];
}

function histogramMedian(
  histogram: Uint16Array,
  sampleCount: number,
) {
  const medianIndex = Math.floor(sampleCount / 2);
  let seen = 0;

  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen > medianIndex) return value;
  }

  return 0;
}

type SampleScratch = {
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
  alpha: Uint8Array;
  redHistogram: Uint16Array;
  greenHistogram: Uint16Array;
  blueHistogram: Uint16Array;
};

function robustRepresentative(
  generated: RgbaImageData,
  left: number,
  top: number,
  right: number,
  bottom: number,
  fallback: readonly [number, number, number],
  scratch: SampleScratch,
) {
  const insetX = Math.min((right - left) * SAMPLE_INSET, (right - left) / 3);
  const insetY = Math.min((bottom - top) * SAMPLE_INSET, (bottom - top) / 3);
  const sampleLeft = left + insetX;
  const sampleTop = top + insetY;
  const sampleRight = right - insetX;
  const sampleBottom = bottom - insetY;
  const xSteps = Math.max(
    1,
    Math.min(SAMPLE_GRID_SIZE, Math.ceil(sampleRight - sampleLeft)),
  );
  const ySteps = Math.max(
    1,
    Math.min(SAMPLE_GRID_SIZE, Math.ceil(sampleBottom - sampleTop)),
  );
  let sampleCount = 0;
  let visibleCount = 0;

  for (let sampleY = 0; sampleY < ySteps; sampleY += 1) {
    const y = Math.max(
      0,
      Math.min(
        generated.height - 1,
        Math.floor(
          sampleTop +
            ((sampleY + 0.5) * (sampleBottom - sampleTop)) / ySteps,
        ),
      ),
    );

    for (let sampleX = 0; sampleX < xSteps; sampleX += 1) {
      const x = Math.max(
        0,
        Math.min(
          generated.width - 1,
          Math.floor(
            sampleLeft +
              ((sampleX + 0.5) * (sampleRight - sampleLeft)) / xSteps,
          ),
        ),
      );
      const sourceOffset = (y * generated.width + x) * 4;
      const alpha = generated.data[sourceOffset + 3];

      scratch.red[sampleCount] = generated.data[sourceOffset];
      scratch.green[sampleCount] = generated.data[sourceOffset + 1];
      scratch.blue[sampleCount] = generated.data[sourceOffset + 2];
      scratch.alpha[sampleCount] = alpha;
      if (alpha >= 16) visibleCount += 1;
      sampleCount += 1;
    }
  }

  if (visibleCount === 0) return fallback;

  scratch.redHistogram.fill(0);
  scratch.greenHistogram.fill(0);
  scratch.blueHistogram.fill(0);

  for (let index = 0; index < sampleCount; index += 1) {
    if (scratch.alpha[index] < 16) continue;
    scratch.redHistogram[scratch.red[index]] += 1;
    scratch.greenHistogram[scratch.green[index]] += 1;
    scratch.blueHistogram[scratch.blue[index]] += 1;
  }

  const medianRed = histogramMedian(scratch.redHistogram, visibleCount);
  const medianGreen = histogramMedian(scratch.greenHistogram, visibleCount);
  const medianBlue = histogramMedian(scratch.blueHistogram, visibleCount);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < sampleCount; index += 1) {
    if (scratch.alpha[index] < 16) continue;
    const redDelta = scratch.red[index] - medianRed;
    const greenDelta = scratch.green[index] - medianGreen;
    const blueDelta = scratch.blue[index] - medianBlue;
    const distance =
      redDelta * redDelta * 0.299 +
      greenDelta * greenDelta * 0.587 +
      blueDelta * blueDelta * 0.114;

    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }

  return [
    scratch.red[bestIndex],
    scratch.green[bestIndex],
    scratch.blue[bestIndex],
  ] as const;
}

/**
 * Collapses a generated model raster onto the exact logical grid.
 *
 * Each logical cell uses an inset 7x7 sample at most. The channel medians are
 * used to select an actual generated sample (a medoid), avoiding both isolated
 * model noise and synthetic colors. Alpha always comes from the current edit;
 * transparent current pixels are canonicalized to transparent black.
 */
export function collapseMagicFixResult(
  generated: RgbaImageData,
  current: RgbaImageData,
  transform: MagicFixTransform,
  options: CollapseMagicFixOptions = {},
): RgbaImageData {
  assertImage(generated, "Generated image");
  assertImage(current, "Current edit");
  assertTransform(transform);

  if (
    current.width !== transform.logicalWidth ||
    current.height !== transform.logicalHeight
  ) {
    throw new RangeError(
      "The current edit dimensions do not match the Magic Fix transform.",
    );
  }

  const palette = options.palette
    ? buildPalette(current, options.palette)
    : null;
  const paletteCache = palette
    ? new Int16Array(QUANTIZED_COLOR_COUNT)
    : null;
  paletteCache?.fill(-1);
  const flattenedBackground = options.flattenedBackground;
  if (flattenedBackground) {
    flattenedBackground.forEach((channel, index) =>
      assertByte(channel, `Flattened background channel ${index + 1}`),
    );
  }
  const output = new Uint8ClampedArray(
    transform.logicalWidth * transform.logicalHeight * 4,
  );
  const scratch: SampleScratch = {
    red: new Uint8Array(MAX_SAMPLES_PER_CELL),
    green: new Uint8Array(MAX_SAMPLES_PER_CELL),
    blue: new Uint8Array(MAX_SAMPLES_PER_CELL),
    alpha: new Uint8Array(MAX_SAMPLES_PER_CELL),
    redHistogram: new Uint16Array(256),
    greenHistogram: new Uint16Array(256),
    blueHistogram: new Uint16Array(256),
  };
  const generatedScaleX = generated.width / transform.modelWidth;
  const generatedScaleY = generated.height / transform.modelHeight;

  for (let y = 0; y < transform.logicalHeight; y += 1) {
    const top =
      (transform.contentY +
        (y * transform.contentHeight) / transform.logicalHeight) *
      generatedScaleY;
    const bottom =
      (transform.contentY +
        ((y + 1) * transform.contentHeight) / transform.logicalHeight) *
      generatedScaleY;

    for (let x = 0; x < transform.logicalWidth; x += 1) {
      const outputOffset = (y * transform.logicalWidth + x) * 4;
      const lockedAlpha = current.data[outputOffset + 3];

      if (lockedAlpha === 0) {
        output[outputOffset] = 0;
        output[outputOffset + 1] = 0;
        output[outputOffset + 2] = 0;
        output[outputOffset + 3] = 0;
        continue;
      }

      const left =
        (transform.contentX +
          (x * transform.contentWidth) / transform.logicalWidth) *
        generatedScaleX;
      const right =
        (transform.contentX +
          ((x + 1) * transform.contentWidth) / transform.logicalWidth) *
        generatedScaleX;
      const representative = robustRepresentative(
        generated,
        left,
        top,
        right,
        bottom,
        [
          current.data[outputOffset],
          current.data[outputOffset + 1],
          current.data[outputOffset + 2],
        ],
        scratch,
      );
      const straightRepresentative = flattenedBackground
        ? restoreStraightAlphaColor(
            representative,
            lockedAlpha,
            flattenedBackground,
          )
        : representative;
      const color = palette
        ? mapToPalette(
            straightRepresentative[0],
            straightRepresentative[1],
            straightRepresentative[2],
            palette,
            paletteCache!,
          )
        : straightRepresentative;

      output[outputOffset] = color[0];
      output[outputOffset + 1] = color[1];
      output[outputOffset + 2] = color[2];
      output[outputOffset + 3] = lockedAlpha;
    }
  }

  return {
    width: transform.logicalWidth,
    height: transform.logicalHeight,
    data: output,
  };
}
