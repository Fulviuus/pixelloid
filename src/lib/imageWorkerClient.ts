import type { PixelGridSettings } from "./gridDetection";
import type {
  AnalyzeImageOptions,
  AnalyzeImageResult,
  ImageWorkerErrorCode,
  ImageWorkerRequest,
  ImageWorkerRequestPayload,
  ImageWorkerResponse,
  PixelizeImageResult,
  SourceDimensions,
} from "./imageWorkerProtocol";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

export class WorkerUnavailableError extends Error {
  constructor(message = "Background image processing is unavailable.") {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

export class WorkerTaskError extends Error {
  readonly code: ImageWorkerErrorCode;
  readonly workerStack?: string;

  constructor(
    code: ImageWorkerErrorCode,
    message: string,
    workerStack?: string,
  ) {
    super(message);
    this.name = "WorkerTaskError";
    this.code = code;
    this.workerStack = workerStack;
  }
}

function createAbortError(message: string) {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

export function shouldFallbackFromImageWorker(error: unknown) {
  return (
    error instanceof WorkerUnavailableError ||
    (error instanceof WorkerTaskError &&
      (error.code === "WORKER_UNSUPPORTED" ||
        error.code === "DECODE_FAILED" ||
        error.code === "DIMENSIONS_MISMATCH"))
  );
}

export type ImageWorkerSupport = {
  supported: boolean;
  reason?: string;
};

let constructionFailure: string | null = null;

export function getImageWorkerSupport(): ImageWorkerSupport {
  if (constructionFailure) {
    return { supported: false, reason: constructionFailure };
  }

  if (typeof Worker === "undefined") {
    return { supported: false, reason: "Web workers are unavailable." };
  }
  if (typeof OffscreenCanvas === "undefined") {
    return { supported: false, reason: "Offscreen canvas is unavailable." };
  }
  if (typeof createImageBitmap !== "function") {
    return { supported: false, reason: "Worker image decoding is unavailable." };
  }

  return { supported: true };
}

export class ImageWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;

  constructor() {
    const support = getImageWorkerSupport();
    if (!support.supported) {
      throw new WorkerUnavailableError(support.reason);
    }

    try {
      this.worker = new Worker(new URL("../workers/imageWorker.ts", import.meta.url), {
        type: "module",
        name: "pixelloid-image-processing",
      });
    } catch (error) {
      throw new WorkerUnavailableError(
        error instanceof Error
          ? `The image worker could not start: ${error.message}`
          : "The image worker could not start.",
      );
    }

    this.worker.onmessage = (event: MessageEvent<ImageWorkerResponse>) => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.failUnexpectedly(
        new WorkerUnavailableError(
          event.message || "The image worker stopped unexpectedly.",
        ),
      );
    };
    this.worker.onmessageerror = () => {
      this.failUnexpectedly(
        new WorkerUnavailableError("The image worker returned unreadable data."),
      );
    };
  }

  get available() {
    return !this.closed;
  }

  analyze(file: File, options: AnalyzeImageOptions) {
    return this.request<AnalyzeImageResult>({
      operation: "analyze",
      file,
      options,
    });
  }

  pixelize(
    file: File,
    settings: PixelGridSettings,
    dimensions: SourceDimensions,
  ) {
    return this.request<PixelizeImageResult>({
      operation: "pixelize",
      file,
      settings,
      dimensions,
    });
  }

  /** Terminate active work and synchronously reject every pending request. */
  reset(message = "Image processing was cancelled.") {
    this.terminate(message);
  }

  terminate(message = "Image processing was cancelled.") {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.rejectAll(createAbortError(message));
  }

  private request<Result>(payload: ImageWorkerRequestPayload) {
    if (this.closed) {
      return Promise.reject<Result>(
        new WorkerUnavailableError("This image worker has been terminated."),
      );
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request = { id, ...payload } as ImageWorkerRequest;

    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(
          new WorkerUnavailableError(
            error instanceof Error
              ? `The worker request could not be sent: ${error.message}`
              : "The worker request could not be sent.",
          ),
        );
      }
    });
  }

  private handleResponse(response: ImageWorkerResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    pending.reject(
      new WorkerTaskError(
        response.error.code,
        response.error.message,
        response.error.stack,
      ),
    );
  }

  private failUnexpectedly(error: WorkerUnavailableError) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.rejectAll(error);
  }

  private rejectAll(error: unknown) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let singleton: ImageWorkerClient | null = null;

/** Returns null when the current webview cannot support the worker pipeline. */
export function getImageWorkerClient() {
  if (singleton?.available) return singleton;
  if (!getImageWorkerSupport().supported) return null;

  try {
    singleton = new ImageWorkerClient();
    return singleton;
  } catch (error) {
    constructionFailure =
      error instanceof Error ? error.message : "The image worker could not start.";
    singleton = null;
    return null;
  }
}

/**
 * Cancel all active work. The next getter call creates a fresh worker, so an
 * obsolete large conversion cannot delay a newly imported image.
 */
export function resetImageWorkerClient(
  message = "Image processing was cancelled.",
) {
  singleton?.reset(message);
  singleton = null;
  constructionFailure = null;
}
