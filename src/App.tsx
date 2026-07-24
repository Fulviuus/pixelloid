import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  Check,
  Download,
  ImagePlus,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";
import pixelloidWordmark from "./assets/pixelloid-wordmark-dark.png";
import { PixelEditor } from "./components/PixelEditor";
import { PixelMark } from "./components/PixelMark";
import {
  getImageWorkerClient,
  isAbortError,
  resetImageWorkerClient,
  shouldFallbackFromImageWorker,
} from "./lib/imageWorkerClient";
import {
  analyzePixelGrid,
  getPixelGridDimensions,
  pixelizeImage,
  PixelizeResult,
  type PixelGridSuggestion,
} from "./lib/pixelize";
import { extractImagePalette } from "./lib/palette";
import "./App.css";

type SourceImage = {
  file: File;
  processingFile: File;
  image: HTMLImageElement;
  url: string;
  width: number;
  height: number;
};

type DetectedGridSetting = {
  pixelSize: number;
  offsetX: number;
  offsetY: number;
  confidence: number;
};

type SuggestionDecision = "available" | "accepted" | "rejected";

const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
];
const ACCEPTED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "bmp",
]);
const MAX_SOURCE_PIXELS = 40_000_000;
const MIN_USABLE_DETECTION_CONFIDENCE = 20;
const GRID_VALUE_PRECISION = 1000;
const GRID_VALUE_EPSILON = 1 / GRID_VALUE_PRECISION;

function fileExtension(file: File) {
  return file.name.split(".").pop()?.toLowerCase() ?? "";
}

function isAcceptedImageFile(file: File) {
  if (ACCEPTED_IMAGE_TYPES.includes(file.type)) return true;
  return (
    (file.type === "" || file.type === "application/octet-stream") &&
    ACCEPTED_IMAGE_EXTENSIONS.has(fileExtension(file))
  );
}

function isGifFile(file: File) {
  return file.type === "image/gif" || fileExtension(file) === "gif";
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function htmlCanvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The GIF frame could not be frozen."));
    }, "image/png");
  });
}

async function freezeGifFrame(
  file: File,
  image: HTMLImageElement,
  isCurrent: () => boolean,
) {
  let blob: Blob | null = null;

  if (
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function"
  ) {
    let bitmap: ImageBitmap | null = null;

    try {
      bitmap = await createImageBitmap(file);
      if (!isCurrent()) {
        throw new DOMException("GIF import was cancelled.", "AbortError");
      }
      if (
        bitmap.width === image.naturalWidth &&
        bitmap.height === image.naturalHeight
      ) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(bitmap, 0, 0);
          blob = await canvas.convertToBlob({ type: "image/png" });
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Older WebKit builds can decode GIF in <img> but not createImageBitmap.
      // The canvas fallback below still freezes one deterministic edit frame.
    } finally {
      bitmap?.close();
    }
  }

  if (!blob) {
    if (!isCurrent()) {
      throw new DOMException("GIF import was cancelled.", "AbortError");
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available on this system.");
    context.drawImage(image, 0, 0);
    blob = await htmlCanvasToPng(canvas);
  }

  const frozenName = file.name.replace(/\.gif$/i, "-frame.png");
  return new File([blob], frozenName, {
    type: "image/png",
    lastModified: file.lastModified,
  });
}

function formatPixelSize(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "");
}

function roundGridValue(value: number) {
  return Math.round(value * GRID_VALUE_PRECISION) / GRID_VALUE_PRECISION;
}

function maximumPixelSize(width: number, height: number) {
  return Math.max(1, Math.floor(Math.min(width, height) / 2));
}

function prepareDetectedGrid(
  detection: {
    pixelSize: number;
    offsetX: number;
    offsetY: number;
    confidence: number;
  },
  width: number,
  height: number,
): {
  active: Omit<DetectedGridSetting, "confidence"> & {
    confidence: number | null;
  };
  detected: DetectedGridSetting | null;
} {
  const valuesAreFinite =
    Number.isFinite(detection.pixelSize) &&
    Number.isFinite(detection.offsetX) &&
    Number.isFinite(detection.offsetY) &&
    Number.isFinite(detection.confidence);

  if (
    !valuesAreFinite ||
    detection.pixelSize < 1 ||
    detection.confidence < MIN_USABLE_DETECTION_CONFIDENCE
  ) {
    return {
      active: { pixelSize: 1, offsetX: 0, offsetY: 0, confidence: null },
      detected: null,
    };
  }

  const maximum = maximumPixelSize(width, height);
  const pixelSize = roundGridValue(
    Math.max(1, Math.min(maximum, detection.pixelSize)),
  );

  // A clamped pitch no longer describes the phase that the detector scored.
  // Keep the value inside the UI's safe range, but do not present it as a
  // restorable detection with potentially invalid offsets.
  if (Math.abs(pixelSize - detection.pixelSize) > GRID_VALUE_EPSILON) {
    return {
      active: { pixelSize, offsetX: 0, offsetY: 0, confidence: null },
      detected: null,
    };
  }

  const detected = {
    pixelSize,
    offsetX: roundGridValue(detection.offsetX),
    offsetY: roundGridValue(detection.offsetY),
    confidence: Math.round(Math.max(0, Math.min(100, detection.confidence))),
  };

  return { active: detected, detected };
}

function prepareGridSuggestion(
  suggestion: PixelGridSuggestion | null,
  width: number,
  height: number,
) {
  if (
    !suggestion ||
    !Number.isFinite(suggestion.pixelSize) ||
    !Number.isFinite(suggestion.confidence) ||
    !Array.isArray(suggestion.alternatives)
  ) {
    return null;
  }

  const maximum = maximumPixelSize(width, height);
  const pixelSize = roundGridValue(suggestion.pixelSize);

  // Suggestions are optional escape hatches, so reject malformed or clamped
  // values instead of silently changing what the detector proposed.
  if (
    pixelSize <= 1 + GRID_VALUE_EPSILON ||
    pixelSize > maximum ||
    Math.abs(pixelSize - suggestion.pixelSize) > GRID_VALUE_EPSILON
  ) {
    return null;
  }

  return {
    pixelSize,
    confidence: Math.round(Math.max(0, Math.min(100, suggestion.confidence))),
    alternatives: suggestion.alternatives
      .filter((candidate: number) => Number.isFinite(candidate))
      .map(roundGridValue)
      .filter(
        (candidate) =>
          candidate > 1 + GRID_VALUE_EPSILON && candidate <= maximum,
      ),
  } satisfies PixelGridSuggestion;
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadGenerationRef = useRef(0);
  const conversionGenerationRef = useRef(0);
  const workerFallbackFileRef = useRef<File | null>(null);
  const sourceRef = useRef<SourceImage | null>(null);
  const resultRef = useRef<PixelizeResult | null>(null);
  const suggestionPrimaryActionRef = useRef<HTMLButtonElement | null>(null);
  const suggestionFollowupActionRef = useRef<HTMLButtonElement | null>(null);
  const suggestionFocusRequestRef = useRef(false);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [result, setResult] = useState<PixelizeResult | null>(null);
  const [pixelSize, setPixelSize] = useState(8);
  const [gridOffset, setGridOffset] = useState({ x: 0, y: 0 });
  const [confidence, setConfidence] = useState<number | null>(null);
  const [detectedGrid, setDetectedGrid] =
    useState<DetectedGridSetting | null>(null);
  const [gridSuggestion, setGridSuggestion] =
    useState<PixelGridSuggestion | null>(null);
  const [suggestionDecision, setSuggestionDecision] =
    useState<SuggestionDecision | null>(null);
  const [acceptedSuggestionPixelSize, setAcceptedSuggestionPixelSize] =
    useState<number | null>(null);
  const [strictDetectionFailed, setStrictDetectionFailed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [sourcePalette, setSourcePalette] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const shortcutHandlerRef = useRef<(event: globalThis.KeyboardEvent) => void>(
    () => undefined,
  );

  shortcutHandlerRef.current = (event) => {
    if (isEditorOpen) return;

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handlePixelize();
    }
  };

  const outputSize = useMemo(() => {
    if (!source) return null;

    return getPixelGridDimensions(source.width, source.height, {
      pixelSize,
      offsetX: gridOffset.x,
      offsetY: gridOffset.y,
    });
  }, [gridOffset, pixelSize, source]);

  const suggestionCandidates = useMemo(() => {
    if (!source || !gridSuggestion) return [];

    const pitches = [
      gridSuggestion.pixelSize,
      ...gridSuggestion.alternatives,
    ].filter(
      (candidate, index, values) =>
        values.findIndex(
          (value) => Math.abs(value - candidate) < GRID_VALUE_EPSILON,
        ) === index,
    );

    return pitches.slice(0, 3).map((candidate) => {
      const dimensions = getPixelGridDimensions(source.width, source.height, {
        pixelSize: candidate,
        offsetX: 0,
        offsetY: 0,
      });

      return {
        pixelSize: candidate,
        width: dimensions.width,
        height: dimensions.height,
      };
    });
  }, [gridSuggestion, source]);
  const suggestionOutputSize = suggestionCandidates[0] ?? null;

  function replaceSource(nextSource: SourceImage | null) {
    const previous = sourceRef.current;
    sourceRef.current = nextSource;
    setSource(nextSource);

    if (previous && previous.url !== nextSource?.url) {
      URL.revokeObjectURL(previous.url);
    }
  }

  function replaceResult(nextResult: PixelizeResult | null) {
    const previous = resultRef.current;
    resultRef.current = nextResult;
    setResult(nextResult);

    if (previous && previous.url !== nextResult?.url) {
      URL.revokeObjectURL(previous.url);
    }
  }

  useEffect(() => {
    return () => {
      loadGenerationRef.current += 1;
      conversionGenerationRef.current += 1;
      resetImageWorkerClient("Pixelloid was closed.");
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    };
  }, []);

  useEffect(() => {
    function preventWindowFileDrop(event: globalThis.DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;

      event.preventDefault();
      if (event.type === "drop") setIsDragging(false);
    }

    window.addEventListener("dragover", preventWindowFileDrop);
    window.addEventListener("drop", preventWindowFileDrop);

    return () => {
      window.removeEventListener("dragover", preventWindowFileDrop);
      window.removeEventListener("drop", preventWindowFileDrop);
    };
  }, []);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      shortcutHandlerRef.current(event);
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!suggestionFocusRequestRef.current) return;
    suggestionFocusRequestRef.current = false;

    const nextTarget =
      suggestionDecision === "available"
        ? suggestionPrimaryActionRef.current
        : suggestionFollowupActionRef.current;
    nextTarget?.focus();
  }, [suggestionDecision]);

  async function loadFile(file: File) {
    if (!isAcceptedImageFile(file)) {
      setError("Choose a PNG, JPG, WebP, GIF, AVIF, or BMP image.");
      return;
    }

    const generation = ++loadGenerationRef.current;
    conversionGenerationRef.current += 1;
    resetImageWorkerClient("A newer image was selected.");
    workerFallbackFileRef.current = null;
    suggestionFocusRequestRef.current = false;
    setError(null);
    setIsAnalyzing(true);
    setIsProcessing(false);
    setIsEditorOpen(false);
    setSourcePalette([]);
    replaceResult(null);
    await nextFrame();

    if (generation !== loadGenerationRef.current) return;

    const originalUrl = URL.createObjectURL(file);
    let activeUrl = originalUrl;
    let processingFile = file;
    let image = new Image();
    image.decoding = "async";
    image.src = originalUrl;

    function revokePendingSourceUrls() {
      URL.revokeObjectURL(activeUrl);
      if (activeUrl !== originalUrl) URL.revokeObjectURL(originalUrl);
    }

    try {
      await image.decode();

      if (generation !== loadGenerationRef.current) {
        revokePendingSourceUrls();
        return;
      }

      if (image.naturalWidth * image.naturalHeight > MAX_SOURCE_PIXELS) {
        throw new Error("image-too-large");
      }

      if (isGifFile(file)) {
        processingFile = await freezeGifFrame(
          file,
          image,
          () => generation === loadGenerationRef.current,
        );

        if (generation !== loadGenerationRef.current) {
          revokePendingSourceUrls();
          return;
        }

        const frozenUrl = URL.createObjectURL(processingFile);
        activeUrl = frozenUrl;
        const frozenImage = new Image();
        frozenImage.decoding = "async";
        frozenImage.src = frozenUrl;
        await frozenImage.decode();

        if (generation !== loadGenerationRef.current) {
          revokePendingSourceUrls();
          return;
        }

        URL.revokeObjectURL(originalUrl);
        image = frozenImage;
      }

      const loaded: SourceImage = {
        file,
        processingFile,
        image,
        url: activeUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      let detection: ReturnType<typeof analyzePixelGrid>["detection"];
      let suggestion: PixelGridSuggestion | null;
      let palette: string[];
      const worker = getImageWorkerClient();

      if (worker) {
        try {
          const analysis = await worker.analyze(processingFile, {
            expectedWidth: loaded.width,
            expectedHeight: loaded.height,
            maximumColors: 24,
          });
          detection = analysis.detection;
          suggestion = analysis.suggestion;
          palette = analysis.palette;
        } catch (workerError) {
          if (
            isAbortError(workerError) ||
            !shouldFallbackFromImageWorker(workerError)
          ) {
            throw workerError;
          }

          workerFallbackFileRef.current = processingFile;
          const analysis = analyzePixelGrid(image);
          detection = analysis.detection;
          suggestion = analysis.suggestion;
          palette = extractImagePalette(image);
        }
      } else {
        const analysis = analyzePixelGrid(image);
        detection = analysis.detection;
        suggestion = analysis.suggestion;
        palette = extractImagePalette(image);
      }
      const preparedGrid = prepareDetectedGrid(
        detection,
        loaded.width,
        loaded.height,
      );
      const preparedSuggestion =
        preparedGrid.detected === null
          ? prepareGridSuggestion(suggestion, loaded.width, loaded.height)
          : null;

      if (generation !== loadGenerationRef.current) {
        revokePendingSourceUrls();
        return;
      }

      replaceSource(loaded);
      setPixelSize(preparedGrid.active.pixelSize);
      setGridOffset({
        x: preparedGrid.active.offsetX,
        y: preparedGrid.active.offsetY,
      });
      setConfidence(preparedGrid.active.confidence);
      setDetectedGrid(preparedGrid.detected);
      setGridSuggestion(preparedSuggestion);
      setSuggestionDecision(preparedSuggestion ? "available" : null);
      setAcceptedSuggestionPixelSize(null);
      setStrictDetectionFailed(preparedGrid.detected === null);
      setSourcePalette(palette);
    } catch (caughtError) {
      revokePendingSourceUrls();

      if (
        generation === loadGenerationRef.current &&
        !isAbortError(caughtError)
      ) {
        setError(
          caughtError instanceof Error &&
            caughtError.message === "image-too-large"
            ? "That image is too large. Choose an image under 40 megapixels."
            : "That image could not be read. Try exporting it again.",
        );
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setIsAnalyzing(false);
      }
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) void loadFile(file);
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  }

  function openPicker() {
    fileInputRef.current?.click();
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  }

  function updatePixelSize(
    nextSize: number,
    options: { forceManual?: boolean } = {},
  ) {
    if (!source) return;
    const maximum = maximumPixelSize(source.width, source.height);
    const clampedSize = roundGridValue(
      Math.max(1, Math.min(maximum, nextSize)),
    );
    const restoresDetection =
      !options.forceManual &&
      detectedGrid !== null &&
      Math.abs(clampedSize - detectedGrid.pixelSize) < GRID_VALUE_EPSILON;
    const nextOffset = restoresDetection
      ? { x: detectedGrid.offsetX, y: detectedGrid.offsetY }
      : { x: 0, y: 0 };
    const nextConfidence = restoresDetection
      ? detectedGrid.confidence
      : null;

    if (
      clampedSize === pixelSize &&
      gridOffset.x === nextOffset.x &&
      gridOffset.y === nextOffset.y &&
      confidence === nextConfidence
    ) {
      return;
    }

    conversionGenerationRef.current += 1;
    resetImageWorkerClient("Pixel-grid settings changed.");
    setIsProcessing(false);
    setPixelSize(clampedSize);
    setGridOffset(nextOffset);
    setConfidence(nextConfidence);
    setSuggestionDecision((current) =>
      current === null ? null : "available",
    );
    setAcceptedSuggestionPixelSize(null);
    setIsEditorOpen(false);
    replaceResult(null);
  }

  function stepPixelSize(direction: -1 | 1) {
    const integerTarget =
      direction === -1
        ? Math.max(1, Math.ceil(pixelSize) - 1)
        : Math.floor(pixelSize) + 1;
    let target = integerTarget;

    if (detectedGrid) {
      const detectedSize = detectedGrid.pixelSize;
      const crossesDetection =
        direction === -1
          ? pixelSize > detectedSize + GRID_VALUE_EPSILON &&
            integerTarget <= detectedSize + GRID_VALUE_EPSILON
          : pixelSize < detectedSize - GRID_VALUE_EPSILON &&
            integerTarget >= detectedSize - GRID_VALUE_EPSILON;

      if (crossesDetection) target = detectedSize;
    }

    updatePixelSize(target);
  }

  function acceptGridSuggestion(candidatePixelSize: number) {
    const candidate = suggestionCandidates.find(
      ({ pixelSize: availablePixelSize }) =>
        Math.abs(availablePixelSize - candidatePixelSize) <
        GRID_VALUE_EPSILON,
    );
    if (!candidate) return;

    suggestionFocusRequestRef.current = true;
    updatePixelSize(candidate.pixelSize, { forceManual: true });
    setAcceptedSuggestionPixelSize(candidate.pixelSize);
    setSuggestionDecision("accepted");
  }

  function rejectGridSuggestion() {
    if (!gridSuggestion) return;
    suggestionFocusRequestRef.current = true;
    updatePixelSize(1);
    setAcceptedSuggestionPixelSize(null);
    setSuggestionDecision("rejected");
  }

  function restoreGridSuggestion() {
    if (!gridSuggestion) return;
    suggestionFocusRequestRef.current = true;
    setAcceptedSuggestionPixelSize(null);
    setSuggestionDecision("available");
  }

  async function handlePixelize() {
    if (!source || isProcessing || isAnalyzing) return;

    const generation = ++conversionGenerationRef.current;
    const sourceAtStart = source;
    const settings = {
      pixelSize,
      offsetX: gridOffset.x,
      offsetY: gridOffset.y,
    };
    setError(null);
    setIsProcessing(true);
    await nextFrame();

    if (
      generation !== conversionGenerationRef.current ||
      sourceRef.current !== sourceAtStart
    ) {
      return;
    }

    try {
      let nextResult: PixelizeResult;
      const worker =
        workerFallbackFileRef.current === source.processingFile
          ? null
          : getImageWorkerClient();

      if (worker) {
        try {
          const generated = await worker.pixelize(
            source.processingFile,
            settings,
            {
              expectedWidth: source.width,
              expectedHeight: source.height,
            },
          );

          // Worker blobs do not own a URL yet. Check staleness first so an
          // obsolete conversion can be garbage-collected without cleanup.
          if (
            generation !== conversionGenerationRef.current ||
            sourceRef.current !== sourceAtStart
          ) {
            return;
          }

          nextResult = {
            blob: generated.blob,
            url: URL.createObjectURL(generated.blob),
            width: generated.width,
            height: generated.height,
            sourceGrid: {
              xRanges: generated.xRanges,
              yRanges: generated.yRanges,
            },
          };
        } catch (workerError) {
          if (
            isAbortError(workerError) ||
            !shouldFallbackFromImageWorker(workerError)
          ) {
            throw workerError;
          }

          workerFallbackFileRef.current = source.processingFile;
          nextResult = await pixelizeImage(source.image, settings);
        }
      } else {
        nextResult = await pixelizeImage(source.image, settings);
      }

      if (
        generation !== conversionGenerationRef.current ||
        sourceRef.current !== sourceAtStart
      ) {
        URL.revokeObjectURL(nextResult.url);
        return;
      }

      replaceResult(nextResult);
      setIsEditorOpen(false);
    } catch (caughtError) {
      if (
        generation === conversionGenerationRef.current &&
        !isAbortError(caughtError)
      ) {
        setError(
          "The image could not be pixelized. Try a smaller source image.",
        );
      }
    } finally {
      if (generation === conversionGenerationRef.current) {
        setIsProcessing(false);
      }
    }
  }

  function reset() {
    loadGenerationRef.current += 1;
    conversionGenerationRef.current += 1;
    resetImageWorkerClient("The workspace was reset.");
    workerFallbackFileRef.current = null;
    replaceSource(null);
    replaceResult(null);
    setPixelSize(8);
    setGridOffset({ x: 0, y: 0 });
    setConfidence(null);
    setDetectedGrid(null);
    setGridSuggestion(null);
    setSuggestionDecision(null);
    setAcceptedSuggestionPixelSize(null);
    suggestionFocusRequestRef.current = false;
    setStrictDetectionFailed(false);
    setIsAnalyzing(false);
    setIsProcessing(false);
    setIsDragging(false);
    setIsEditorOpen(false);
    setSourcePalette([]);
    setError(null);
  }

  const downloadName = source
    ? `${source.file.name.replace(/\.[^.]+$/, "")}-pixel-perfect.png`
    : "pixel-perfect.png";
  const isUsingDetectedGrid =
    detectedGrid !== null &&
    Math.abs(pixelSize - detectedGrid.pixelSize) < GRID_VALUE_EPSILON &&
    Math.abs(gridOffset.x - detectedGrid.offsetX) < GRID_VALUE_EPSILON &&
    Math.abs(gridOffset.y - detectedGrid.offsetY) < GRID_VALUE_EPSILON;
  const isSafeFallbackSetting =
    strictDetectionFailed &&
    confidence === null &&
    Math.abs(pixelSize - 1) < GRID_VALUE_EPSILON &&
    Math.abs(gridOffset.x) < GRID_VALUE_EPSILON &&
    Math.abs(gridOffset.y) < GRID_VALUE_EPSILON;
  const detectionStatus =
    confidence !== null
      ? `${confidence}% CONFIDENCE`
      : isSafeFallbackSetting
        ? "NO SINGLE GRID FOUND"
        : "MANUAL ADJUSTMENT";

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#" aria-label="Pixelloid home">
          <span className="brand-wordmark">
            <img
              alt=""
              aria-hidden="true"
              src={pixelloidWordmark}
            />
          </span>
          <span className="version-badge">ALPHA</span>
        </a>

        <p className="header-tagline">
          <span className="status-dot" />
          PIXEL ART, ACTUALLY.
        </p>

        <button className="icon-button" type="button" onClick={reset}>
          <RotateCcw size={15} strokeWidth={2.2} />
          NEW
        </button>
      </header>

      <main className="workspace">
        <section className="intro">
          <p className="eyebrow">TRUE PIXEL CONVERTER</p>
          <h1>
            Turn almost-pixels into <em>actual pixels.</em>
          </h1>
          <p className="intro-copy">
            Detect the hidden grid in AI-generated pixel art, then rebuild it
            at its true native resolution.
          </p>
        </section>

        <section className="converter" aria-label="Pixel art converter">
          <article className="image-panel source-panel">
            <div className="panel-header">
              <div>
                <span className="panel-number">01</span>
                <span className="panel-label">SOURCE</span>
              </div>
              {source && (
                <button
                  className="text-button"
                  type="button"
                  onClick={openPicker}
                >
                  {isAnalyzing ? "ANALYZING…" : "REPLACE"}
                </button>
              )}
            </div>

            <div
              className={`image-stage dropzone ${
                isDragging ? "is-dragging" : ""
              } ${source ? "has-image" : ""}`}
              role={!source ? "button" : undefined}
              tabIndex={!source ? 0 : undefined}
              aria-disabled={!source && isAnalyzing ? true : undefined}
              onClick={!source && !isAnalyzing ? openPicker : undefined}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsDragging(false);
                }
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              onKeyDown={
                !source && !isAnalyzing ? handleDropzoneKeyDown : undefined
              }
            >
              {source ? (
                <>
                  <div className="checkerboard" />
                  <img
                    alt={`Source: ${source.file.name}`}
                    className="preview-image source-image"
                    src={source.url}
                  />
                  <div className="image-corner image-corner-tl" />
                  <div className="image-corner image-corner-tr" />
                  <div className="image-corner image-corner-bl" />
                  <div className="image-corner image-corner-br" />
                </>
              ) : (
                <div className="empty-state">
                  <div className="upload-glyph">
                    {isAnalyzing ? (
                      <ScanSearch size={30} strokeWidth={1.7} />
                    ) : (
                      <ImagePlus size={30} strokeWidth={1.7} />
                    )}
                    <span className="glyph-pixel pixel-one" />
                    <span className="glyph-pixel pixel-two" />
                  </div>
                  <h2>{isAnalyzing ? "READING PIXELS…" : "IMPORT IMAGE"}</h2>
                  <p>Drop your pseudo-pixel art here</p>
                  <span className="file-hint">
                    PNG · JPG · WEBP · GIF · AVIF · BMP
                  </span>
                  <span className="frame-hint">GIF IMPORTS ONE FRAME</span>
                  <span
                    aria-hidden="true"
                    className={`secondary-button ${
                      isAnalyzing ? "is-disabled" : ""
                    }`}
                  >
                    <Upload size={15} />
                    CHOOSE FILE
                  </span>
                </div>
              )}
            </div>

            <div className="panel-footer">
              {source ? (
                <>
                  <div className="file-meta">
                    <strong>{source.file.name}</strong>
                    <span>
                      {source.width} × {source.height} PX
                    </span>
                  </div>
                  <span className="ready-badge">
                    <Check size={12} strokeWidth={3} />
                    READY
                  </span>
                </>
              ) : (
                <span>YOUR ORIGINAL</span>
              )}
            </div>
          </article>

          <div className="action-column">
            <div className="direction-line">
              <span />
              <ArrowRight size={16} />
            </div>

            <button
              className="pixelize-button"
              type="button"
              disabled={!source || isProcessing || isAnalyzing}
              onClick={handlePixelize}
            >
              <span className="button-icon">
                <WandSparkles size={18} strokeWidth={2.3} />
              </span>
              <span>
                <small>{isProcessing ? "BUILDING" : "MAKE IT"}</small>
                {isProcessing ? "PIXELIZING…" : "PIXELLIZE"}
              </span>
            </button>

            <span className="shortcut-hint">⌘ ENTER</span>
          </div>

          <article className={`image-panel result-panel ${result ? "done" : ""}`}>
            <div className="panel-header">
              <div>
                <span className="panel-number">02</span>
                <span className="panel-label">PIXEL PERFECT</span>
              </div>
              {result && (
                <span className="result-ready">
                  <Sparkles size={13} />
                  TRUE 1:1
                </span>
              )}
            </div>

            <div className={`image-stage result-stage ${result ? "has-image" : ""}`}>
              {result ? (
                <>
                  <div className="checkerboard" aria-hidden="true" />
                  <img
                    alt="Pixel-perfect result"
                    className="preview-image result-image"
                    src={result.url}
                  />
                  <button
                    aria-haspopup="dialog"
                    className="edit-result-button"
                    type="button"
                    onClick={() => setIsEditorOpen(true)}
                  >
                    <Pencil size={13} strokeWidth={2.3} />
                    EDIT PIXELS
                  </button>
                </>
              ) : (
                <>
                  <div className="result-grid" aria-hidden="true" />
                  <div className="empty-state result-empty">
                    <div className="result-glyph">
                      <PixelMark size={42} />
                      <Sparkles
                        className="result-sparkle"
                        size={17}
                        strokeWidth={1.8}
                      />
                    </div>
                    <h2>TRUE PIXELS LAND HERE</h2>
                    <p>Import an image, then hit pixellize.</p>
                  </div>
                </>
              )}
            </div>

            <div className="panel-footer">
              {result ? (
                <>
                  <div className="file-meta">
                    <strong>TRUE RESOLUTION</strong>
                    <span>
                      {result.width} × {result.height} PX
                    </span>
                  </div>
                  <a
                    className="download-button"
                    download={downloadName}
                    href={result.url}
                  >
                    <Download size={14} strokeWidth={2.4} />
                    DOWNLOAD PNG
                  </a>
                </>
              ) : (
                <span>YOUR RESULT</span>
              )}
            </div>
          </article>
        </section>

        {source && outputSize && (
          <section className="detection-bar" aria-label="Grid analysis settings">
            <div className="detection-heading">
              <span className="scan-icon">
                <ScanSearch size={17} />
              </span>
              <div>
                <span>GRID ANALYSIS</span>
                <strong
                  aria-live="polite"
                  className={isSafeFallbackSetting ? "no-grid-status" : undefined}
                >
                  {detectionStatus}
                </strong>
              </div>
              {detectedGrid && !isUsingDetectedGrid && (
                <button
                  aria-label="Restore original grid analysis settings"
                  className="restore-detection-button"
                  disabled={isAnalyzing || isProcessing}
                  title={`Restore analyzed ${formatPixelSize(detectedGrid.pixelSize)} px grid and offsets`}
                  type="button"
                  onClick={() => updatePixelSize(detectedGrid.pixelSize)}
                >
                  <RotateCcw size={12} strokeWidth={2.2} />
                </button>
              )}
            </div>

            <div className="metric">
              <span>ORIGINAL</span>
              <strong>
                {source.width} × {source.height}
              </strong>
            </div>

            <ArrowRight className="metric-arrow" size={15} />

            <div className="metric block-size-metric">
              <span>SOURCE PIXEL</span>
              <div className="stepper">
                <button
                  aria-label="Decrease source pixel size"
                  disabled={isAnalyzing || isProcessing}
                  type="button"
                  onClick={() => stepPixelSize(-1)}
                >
                  <Minus size={13} />
                </button>
                <strong>{formatPixelSize(pixelSize)} PX</strong>
                <button
                  aria-label="Increase source pixel size"
                  disabled={isAnalyzing || isProcessing}
                  type="button"
                  onClick={() => stepPixelSize(1)}
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>

            <ArrowRight className="metric-arrow" size={15} />

            <div className="metric output-metric">
              <span>TRUE OUTPUT</span>
              <strong>
                {outputSize.width} × {outputSize.height}
              </strong>
            </div>

            {strictDetectionFailed &&
            gridSuggestion &&
            suggestionOutputSize ? (
              <div
                aria-label="Advisory texture estimate"
                className="grid-suggestion"
                role="group"
              >
                <span className="grid-suggestion-kicker">
                  TEXTURE ESTIMATE · ADVISORY
                </span>
                <div className="grid-suggestion-controls">
                  {suggestionDecision === "accepted" ? (
                    <>
                      <span className="grid-suggestion-status" role="status">
                        {formatPixelSize(
                          acceptedSuggestionPixelSize ?? pixelSize,
                        )}{" "}
                        PX · MANUAL
                        <small>
                          {outputSize.width} × {outputSize.height} OUTPUT
                        </small>
                      </span>
                      <button
                        ref={suggestionFollowupActionRef}
                        className="grid-suggestion-secondary"
                        disabled={isAnalyzing || isProcessing}
                        type="button"
                        onClick={rejectGridSuggestion}
                      >
                        BACK TO 1 PX
                      </button>
                    </>
                  ) : suggestionDecision === "rejected" ? (
                    <>
                      <span className="grid-suggestion-status" role="status">
                        STAYING AT 1 PX
                        <small>SUGGESTION DISMISSED</small>
                      </span>
                      <button
                        ref={suggestionFollowupActionRef}
                        className="grid-suggestion-secondary"
                        disabled={isAnalyzing || isProcessing}
                        type="button"
                        onClick={restoreGridSuggestion}
                      >
                        RESTORE OPTION
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        ref={suggestionPrimaryActionRef}
                        aria-label={`Try primary ${formatPixelSize(suggestionOutputSize.pixelSize)} pixel source size; output ${suggestionOutputSize.width} by ${suggestionOutputSize.height} pixels`}
                        className="grid-suggestion-accept"
                        disabled={isAnalyzing || isProcessing}
                        type="button"
                        onClick={() =>
                          acceptGridSuggestion(suggestionOutputSize.pixelSize)
                        }
                      >
                        TRY {formatPixelSize(suggestionOutputSize.pixelSize)} PX
                        <small>
                          {suggestionOutputSize.width} ×{" "}
                          {suggestionOutputSize.height} OUTPUT
                        </small>
                      </button>
                      {suggestionCandidates.slice(1).map((candidate) => (
                        <button
                          key={candidate.pixelSize}
                          aria-label={`Try alternative ${formatPixelSize(candidate.pixelSize)} pixel source size; output ${candidate.width} by ${candidate.height} pixels`}
                          className="grid-suggestion-alternative"
                          disabled={isAnalyzing || isProcessing}
                          type="button"
                          onClick={() =>
                            acceptGridSuggestion(candidate.pixelSize)
                          }
                        >
                          TRY {formatPixelSize(candidate.pixelSize)} PX
                          <small>
                            ALT · {candidate.width} × {candidate.height}
                          </small>
                        </button>
                      ))}
                      <button
                        aria-label="Reject suggestion and keep the safe 1 pixel setting"
                        className="grid-suggestion-secondary"
                        disabled={isAnalyzing || isProcessing}
                        type="button"
                        onClick={rejectGridSuggestion}
                      >
                        KEEP 1 PX
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <p className="detection-note">
                {strictDetectionFailed
                  ? "No reliable single grid. Staying at a safe 1:1 source size."
                  : "Not quite right? Adjust the source pixel size."}
              </p>
            )}
          </section>
        )}

        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </main>

      <footer className="app-footer">
        <span>LOCAL-ONLY PROCESSING</span>
        <span className="footer-rule" />
        <span>NO IMAGE UPLOADS</span>
        <span className="footer-signature">MADE FOR SHARP EDGES</span>
      </footer>

      <input
        ref={fileInputRef}
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        hidden
        type="file"
        onChange={handleFileInput}
      />

      {result && source && isEditorOpen && (
        <PixelEditor
          palette={sourcePalette}
          result={result}
          sourceFile={source.processingFile}
          sourceHeight={source.height}
          sourceUrl={source.url}
          sourceWidth={source.width}
          onApply={(nextResult) => {
            replaceResult(nextResult);
            setIsEditorOpen(false);
          }}
          onCancel={() => setIsEditorOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
