import type {
  PixelGridDetection,
  PixelGridSettings,
  PixelGridSuggestion,
  PixelBuffer,
} from "./gridDetection";
import type { CellRange } from "./pixelizeCore";
import type {
  ReconstructionCrop,
  ReconstructionPaletteColor,
} from "./cellReconstruction";

export type SourceDimensions = {
  expectedWidth: number;
  expectedHeight: number;
};

export type AnalyzeImageOptions = SourceDimensions & {
  maximumColors?: number;
};

export type AnalyzeImageResult = {
  sourceWidth: number;
  sourceHeight: number;
  detection: PixelGridDetection;
  suggestion: PixelGridSuggestion | null;
  palette: string[];
};

export type PixelizeImageResult = {
  blob: Blob;
  width: number;
  height: number;
  xRanges: CellRange[];
  yRanges: CellRange[];
};

export type ReconstructImageOptions = SourceDimensions & {
  current: PixelBuffer;
  xRanges: CellRange[];
  yRanges: CellRange[];
  crop: ReconstructionCrop;
  protectedMask?: Uint8Array;
  palette?: ReconstructionPaletteColor[];
};

export type ReconstructImageResult = PixelBuffer & {
  changedPixels: number;
};

export type ImageWorkerErrorCode =
  | "DECODE_FAILED"
  | "DIMENSIONS_MISMATCH"
  | "WORKER_UNSUPPORTED"
  | "PROCESSING_FAILED";

export type AnalyzeImageRequest = {
  id: number;
  operation: "analyze";
  file: File;
  options: AnalyzeImageOptions;
};

export type PixelizeImageRequest = {
  id: number;
  operation: "pixelize";
  file: File;
  settings: PixelGridSettings;
  dimensions: SourceDimensions;
};

export type ReconstructImageRequest = {
  id: number;
  operation: "reconstruct";
  file: File;
  options: ReconstructImageOptions;
};

export type ImageWorkerRequest =
  | AnalyzeImageRequest
  | PixelizeImageRequest
  | ReconstructImageRequest;

export type ImageWorkerRequestPayload =
  | Omit<AnalyzeImageRequest, "id">
  | Omit<PixelizeImageRequest, "id">
  | Omit<ReconstructImageRequest, "id">;

export type ImageWorkerSuccess =
  | {
      id: number;
      operation: "analyze";
      ok: true;
      result: AnalyzeImageResult;
    }
  | {
      id: number;
      operation: "pixelize";
      ok: true;
      result: PixelizeImageResult;
    }
  | {
      id: number;
      operation: "reconstruct";
      ok: true;
      result: ReconstructImageResult;
    };

export type ImageWorkerFailure = {
  id: number;
  operation: ImageWorkerRequest["operation"];
  ok: false;
  error: {
    code: ImageWorkerErrorCode;
    message: string;
    stack?: string;
  };
};

export type ImageWorkerResponse = ImageWorkerSuccess | ImageWorkerFailure;
