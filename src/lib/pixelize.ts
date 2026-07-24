import {
  alignPixelGridPhaseData,
  analyzePixelGridData,
  buildCellRanges,
  detectPixelGridData,
  getPixelGridDimensions,
  suggestPixelGridData,
  type PixelGridDetection,
  type PixelGridPhaseAlignment,
  type PixelGridSettings,
  type PixelGridSuggestion,
} from "./gridDetection";
import { pixelizeBuffer } from "./pixelizeCore";

export type {
  PixelGridDetection,
  PixelGridPhaseAlignment,
  PixelGridSettings,
  PixelGridSuggestion,
  PixelSamplingMode,
} from "./gridDetection";
export {
  alignPixelGridPhaseData,
  analyzePixelGridData,
  buildCellRanges,
  detectPixelGridData,
  getPixelGridDimensions,
  suggestPixelGridData,
};

export type SourceGridMapping = {
  xRanges: Array<[number, number]>;
  yRanges: Array<[number, number]>;
};

export type PixelizeResult = {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  sourceGrid?: SourceGridMapping;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    baseWidth: number;
    baseHeight: number;
  };
};

const MAX_ANALYSIS_DIMENSION = 2048;

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function rasterizeGridAnalysis(image: CanvasImageSource) {
  const isImageElement =
    typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement;
  const sourceWidth = isImageElement
    ? image.naturalWidth
    : (image as HTMLCanvasElement).width;
  const sourceHeight = isImageElement
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
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);

  return {
    image: context.getImageData(0, 0, width, height),
    sourceWidth,
    sourceHeight,
  };
}

/**
 * Rasterize a browser image into a bounded analysis buffer, then delegate to
 * the deterministic detector. A 2048px ceiling retains 3px grids that the old
 * 1024px pass collapsed into their 2x harmonic.
 */
export function detectPixelGrid(image: CanvasImageSource): PixelGridDetection {
  const analysis = rasterizeGridAnalysis(image);
  return detectPixelGridData(
    analysis.image,
    analysis.sourceWidth,
    analysis.sourceHeight,
  );
}

/**
 * Main-thread compatibility path for webviews without the image worker.
 * Suggestions are advisory and are produced only after strict detection fails.
 */
export function analyzePixelGrid(image: CanvasImageSource): {
  detection: PixelGridDetection;
  suggestion: PixelGridSuggestion | null;
} {
  const analysis = rasterizeGridAnalysis(image);
  return analyzePixelGridData(
    analysis.image,
    analysis.sourceWidth,
    analysis.sourceHeight,
  );
}

export function alignPixelGridPhases(
  image: CanvasImageSource,
  pixelSizes: number[],
): PixelGridPhaseAlignment[] {
  if (pixelSizes.length === 0) return [];
  const analysis = rasterizeGridAnalysis(image);

  return pixelSizes
    .slice(0, 3)
    .map((pixelSize) =>
      alignPixelGridPhaseData(
        analysis.image,
        pixelSize,
        analysis.sourceWidth,
        analysis.sourceHeight,
      ),
    )
    .filter(
      (alignment): alignment is PixelGridPhaseAlignment =>
        alignment !== null,
    );
}

/** Rebuild the image with one output pixel per inferred source block. */
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
  const sourceCanvas = createCanvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!sourceContext) {
    throw new Error("Canvas is not available on this system.");
  }

  sourceContext.drawImage(image, 0, 0);

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
      sourceGrid: { xRanges, yRanges },
    };
  }

  const sourcePixels = sourceContext.getImageData(
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  const generated = pixelizeBuffer(sourcePixels, settings);
  const outputCanvas = createCanvas(generated.width, generated.height);
  const outputContext = outputCanvas.getContext("2d");

  if (!outputContext) {
    throw new Error("Canvas is not available on this system.");
  }

  outputContext.putImageData(
    new ImageData(generated.data, generated.width, generated.height),
    0,
    0,
  );

  const blob = await new Promise<Blob>((resolve, reject) => {
    outputCanvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("The PNG could not be created."));
    }, "image/png");
  });

  return {
    blob,
    url: URL.createObjectURL(blob),
    width: generated.width,
    height: generated.height,
    sourceGrid: {
      xRanges: generated.xRanges,
      yRanges: generated.yRanges,
    },
  };
}
