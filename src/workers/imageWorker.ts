import {
  alignPixelGridPhaseData,
  analyzePixelGridData,
  buildCellRanges,
  type PixelBuffer,
} from "../lib/gridDetection";
import {
  type ImageWorkerErrorCode,
  type ImageWorkerRequest,
  type ImageWorkerResponse,
  type SourceDimensions,
} from "../lib/imageWorkerProtocol";
import { extractPaletteFromImageData } from "../lib/palette";
import { pixelizeBuffer } from "../lib/pixelizeCore";
import { removeEdgeConnectedBackground } from "../lib/backgroundRemoval";

const MAX_DETECTION_DIMENSION = 2048;
const MAX_PALETTE_DIMENSION = 256;
const DEFAULT_MAXIMUM_COLORS = 24;

type WorkerScope = {
  onmessage: ((event: MessageEvent<ImageWorkerRequest>) => void) | null;
  postMessage(message: ImageWorkerResponse): void;
};

class ImageProcessingError extends Error {
  readonly code: ImageWorkerErrorCode;

  constructor(code: ImageWorkerErrorCode, message: string) {
    super(message);
    this.name = "ImageProcessingError";
    this.code = code;
  }
}

function getContext(canvas: OffscreenCanvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new ImageProcessingError(
      "WORKER_UNSUPPORTED",
      "Offscreen canvas rendering is not available in this webview.",
    );
  }
  return context;
}

function rasterize(bitmap: ImageBitmap, maximumDimension: number) {
  const scale = Math.min(
    1,
    maximumDimension / Math.max(bitmap.width, bitmap.height),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = getContext(canvas);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function validateDimensions(
  bitmap: ImageBitmap,
  dimensions: SourceDimensions,
) {
  if (
    bitmap.width !== dimensions.expectedWidth ||
    bitmap.height !== dimensions.expectedHeight
  ) {
    throw new ImageProcessingError(
      "DIMENSIONS_MISMATCH",
      `The worker decoded ${bitmap.width} x ${bitmap.height}, but the browser ` +
        `preview decoded ${dimensions.expectedWidth} x ${dimensions.expectedHeight}.`,
    );
  }
}

async function decodeFile(file: File) {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    throw new ImageProcessingError(
      "WORKER_UNSUPPORTED",
      "Worker image decoding is not available in this webview.",
    );
  }

  try {
    return await createImageBitmap(file);
  } catch {
    throw new ImageProcessingError(
      "DECODE_FAILED",
      "The worker could not decode this image.",
    );
  }
}

async function analyze(request: Extract<ImageWorkerRequest, { operation: "analyze" }>) {
  const bitmap = await decodeFile(request.file);

  try {
    validateDimensions(bitmap, request.options);
    const analysisPixels = rasterize(bitmap, MAX_DETECTION_DIMENSION);
    const palettePixels = rasterize(bitmap, MAX_PALETTE_DIMENSION);
    const gridAnalysis = analyzePixelGridData(
      analysisPixels,
      bitmap.width,
      bitmap.height,
    );
    const phaseAlignments = (request.options.phasePixelSizes ?? [])
      .slice(0, 3)
      .map((pixelSize) =>
        alignPixelGridPhaseData(
          analysisPixels,
          pixelSize,
          bitmap.width,
          bitmap.height,
        ),
      )
      .filter((alignment) => alignment !== null);

    return {
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      detection: gridAnalysis.detection,
      suggestion: gridAnalysis.suggestion,
      phaseAlignments,
      palette: extractPaletteFromImageData(
        palettePixels,
        request.options.maximumColors ?? DEFAULT_MAXIMUM_COLORS,
      ),
    };
  } finally {
    bitmap.close();
  }
}

async function pixelize(
  request: Extract<ImageWorkerRequest, { operation: "pixelize" }>,
) {
  const bitmap = await decodeFile(request.file);
  let bitmapIsOpen = true;

  try {
    if (typeof OffscreenCanvas.prototype.convertToBlob !== "function") {
      throw new ImageProcessingError(
        "WORKER_UNSUPPORTED",
        "Worker PNG encoding is not available in this webview.",
      );
    }

    validateDimensions(bitmap, request.dimensions);
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const sourceContext = getContext(sourceCanvas);
    sourceContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    bitmapIsOpen = false;

    const isIdentity =
      Math.abs(request.settings.pixelSize - 1) < 1e-6 &&
      Math.abs(request.settings.offsetX) < 1e-6 &&
      Math.abs(request.settings.offsetY) < 1e-6;

    if (isIdentity) {
      const xRanges = buildCellRanges(sourceWidth, 1, 0);
      const yRanges = buildCellRanges(sourceHeight, 1, 0);
      const blob = await sourceCanvas.convertToBlob({ type: "image/png" });

      return {
        blob,
        width: sourceWidth,
        height: sourceHeight,
        xRanges,
        yRanges,
      };
    }

    const sourcePixels = sourceContext.getImageData(
      0,
      0,
      sourceWidth,
      sourceHeight,
    ) as PixelBuffer;
    // ImageData now owns the pixels needed by the sampler. Release the large
    // source canvas before allocating the output backing store.
    sourceCanvas.width = 1;
    sourceCanvas.height = 1;
    const result = pixelizeBuffer(sourcePixels, request.settings);
    const outputCanvas = new OffscreenCanvas(result.width, result.height);
    const outputContext = getContext(outputCanvas);
    outputContext.putImageData(
      new ImageData(result.data, result.width, result.height),
      0,
      0,
    );
    const blob = await outputCanvas.convertToBlob({ type: "image/png" });

    return {
      blob,
      width: result.width,
      height: result.height,
      xRanges: result.xRanges,
      yRanges: result.yRanges,
    };
  } finally {
    if (bitmapIsOpen) bitmap.close();
  }
}

async function removeBackground(
  request: Extract<ImageWorkerRequest, { operation: "removeBackground" }>,
) {
  const bitmap = await decodeFile(request.file);
  let bitmapIsOpen = true;

  try {
    if (typeof OffscreenCanvas.prototype.convertToBlob !== "function") {
      throw new ImageProcessingError(
        "WORKER_UNSUPPORTED",
        "Worker PNG encoding is not available in this webview.",
      );
    }

    validateDimensions(bitmap, request.dimensions);
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const context = getContext(canvas);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    bitmapIsOpen = false;

    const source = context.getImageData(0, 0, width, height) as PixelBuffer;
    const removal = removeEdgeConnectedBackground(source);

    if (removal.removedPixels > 0) {
      context.putImageData(
        new ImageData(removal.image.data, width, height),
        0,
        0,
      );
    }

    const blob =
      removal.removedPixels > 0
        ? await canvas.convertToBlob({ type: "image/png" })
        : null;
    return {
      blob,
      width,
      height,
      detected: removal.detected,
      removedPixels: removal.removedPixels,
      noOpaquePixels: removal.noOpaquePixels,
    };
  } finally {
    if (bitmapIsOpen) bitmap.close();
  }
}

function serializeError(error: unknown) {
  if (error instanceof ImageProcessingError) {
    return {
      code: error.code,
      message: error.message,
      stack: error.stack,
    };
  }

  const normalized =
    error instanceof Error
      ? error
      : new Error("The worker could not process this image.");
  return {
    code: "PROCESSING_FAILED" as const,
    message: normalized.message,
    stack: normalized.stack,
  };
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const request = event.data;

  void (async () => {
    try {
      if (request.operation === "analyze") {
        const result = await analyze(request);
        workerScope.postMessage({
          id: request.id,
          operation: request.operation,
          ok: true,
          result,
        });
      } else if (request.operation === "pixelize") {
        const result = await pixelize(request);
        workerScope.postMessage({
          id: request.id,
          operation: request.operation,
          ok: true,
          result,
        });
      } else {
        const result = await removeBackground(request);
        workerScope.postMessage({
          id: request.id,
          operation: request.operation,
          ok: true,
          result,
        });
      }
    } catch (error) {
      workerScope.postMessage({
        id: request.id,
        operation: request.operation,
        ok: false,
        error: serializeError(error),
      });
    }
  })();
};
