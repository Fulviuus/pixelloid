import type {
  PixelGridDetection,
  PixelGridSettings,
} from "./gridDetection";
import type { CellRange } from "./pixelizeCore";

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
  palette: string[];
};

export type PixelizeImageResult = {
  blob: Blob;
  width: number;
  height: number;
  xRanges: CellRange[];
  yRanges: CellRange[];
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

export type ImageWorkerRequest = AnalyzeImageRequest | PixelizeImageRequest;

export type ImageWorkerRequestPayload =
  | Omit<AnalyzeImageRequest, "id">
  | Omit<PixelizeImageRequest, "id">;

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
