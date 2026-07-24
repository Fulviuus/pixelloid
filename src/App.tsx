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
  ImageOff,
  ImagePlus,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  ScanSearch,
  Settings,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";
import pixelloidWordmark from "./assets/pixelloid-wordmark-dark.png";
import pixelloidWordmarkLight from "./assets/pixelloid-wordmark.png";
import { PixelEditor } from "./components/PixelEditor";
import { PixelMark } from "./components/PixelMark";
import {
  SettingsDialog,
  type AppTheme,
  type SmartPaletteMode,
} from "./components/SettingsDialog";
import {
  getImageWorkerClient,
  isAbortError,
  resetImageWorkerClient,
  shouldFallbackFromImageWorker,
} from "./lib/imageWorkerClient";
import {
  alignPixelGridPhases,
  analyzePixelGrid,
  getPixelGridDimensions,
  pixelizeImage,
  PixelizeResult,
  type PixelGridPhaseAlignment,
  type PixelGridSuggestion,
  type PixelSamplingMode,
} from "./lib/pixelize";
import {
  getPixelGridAmbiguity,
  type PixelGridAmbiguity,
  type PixelGridCandidate,
} from "./lib/gridAmbiguity";
import { extractImagePalette } from "./lib/palette";
import { removeEdgeConnectedBackground } from "./lib/backgroundRemoval";
import { pixelBlobToSvg } from "./lib/vectorExport";
import "./App.css";

type SourceImage = {
  file: File;
  originalProcessingFile: File;
  processingFile: File;
  image: HTMLImageElement;
  url: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
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
const MAX_BACKGROUND_REMOVAL_PIXELS = 2048 * 2048;
const MIN_USABLE_DETECTION_CONFIDENCE = 20;
const GRID_VALUE_PRECISION = 1000;
const GRID_VALUE_EPSILON = 1 / GRID_VALUE_PRECISION;
const THEME_STORAGE_KEY = "pixelloid.theme";
const CHROMA_KEY_STORAGE_KEY = "pixelloid.chroma-key";
const SMART_PALETTE_STORAGE_KEY = "pixelloid.smart-palette";
const DEFAULT_CHROMA_KEY = "#ff00ff";

function storedTheme(): AppTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

function storedChromaKey() {
  try {
    const stored = localStorage.getItem(CHROMA_KEY_STORAGE_KEY);
    return stored && /^#[0-9a-f]{6}$/i.test(stored)
      ? stored.toLowerCase()
      : DEFAULT_CHROMA_KEY;
  } catch {
    return DEFAULT_CHROMA_KEY;
  }
}

function storedSmartPalette(): SmartPaletteMode {
  try {
    const stored = localStorage.getItem(SMART_PALETTE_STORAGE_KEY);
    return stored === "32" || stored === "64" ? stored : "off";
  } catch {
    return "off";
  }
}

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

async function decodePreview(file: File) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;

  try {
    await image.decode();
    return { image, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function removeBackgroundOnMainThread(image: HTMLImageElement) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Canvas is not available on this system.");
  }

  context.drawImage(image, 0, 0);
  const removal = removeEdgeConnectedBackground(
    context.getImageData(0, 0, width, height),
  );

  if (removal.removedPixels > 0) {
    context.putImageData(
      new ImageData(removal.image.data, width, height),
      0,
      0,
    );
  }

  return {
    ...removal,
    blob:
      removal.removedPixels > 0 ? await htmlCanvasToPng(canvas) : null,
    width,
    height,
  };
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
  ambiguity: PixelGridAmbiguity | null;
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
      ambiguity: null,
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
      ambiguity: null,
    };
  }

  const detected = {
    pixelSize,
    offsetX: roundGridValue(detection.offsetX),
    offsetY: roundGridValue(detection.offsetY),
    confidence: Math.round(Math.max(0, Math.min(100, detection.confidence))),
  };
  const ambiguity = getPixelGridAmbiguity(detected, width, height);

  if (ambiguity) {
    const recommended = ambiguity.candidates[0];
    return {
      active: {
        pixelSize: recommended.pixelSize,
        offsetX: recommended.offsetX,
        offsetY: recommended.offsetY,
        confidence: null,
      },
      detected,
      ambiguity,
    };
  }

  return { active: detected, detected, ambiguity: null };
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
  const ambiguityPreviewGenerationRef = useRef(0);
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
  const [gridAmbiguity, setGridAmbiguity] =
    useState<PixelGridAmbiguity | null>(null);
  const [ambiguityPreviewUrls, setAmbiguityPreviewUrls] = useState<
    Partial<Record<PixelGridCandidate["kind"], string>>
  >({});
  const [ambiguityPreviewStatus, setAmbiguityPreviewStatus] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [suggestionDecision, setSuggestionDecision] =
    useState<SuggestionDecision | null>(null);
  const [acceptedSuggestionPixelSize, setAcceptedSuggestionPixelSize] =
    useState<number | null>(null);
  const [strictDetectionFailed, setStrictDetectionFailed] = useState(false);
  const [samplingMode, setSamplingMode] =
    useState<PixelSamplingMode>("medoid");
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExportingSvg, setIsExportingSvg] = useState(false);
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [sourcePalette, setSourcePalette] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>(storedTheme);
  const [chromaKey, setChromaKey] = useState(storedChromaKey);
  const [smartPalette, setSmartPalette] =
    useState<SmartPaletteMode>(storedSmartPalette);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const shortcutHandlerRef = useRef<(event: globalThis.KeyboardEvent) => void>(
    () => undefined,
  );

  shortcutHandlerRef.current = (event) => {
    if (isEditorOpen || isSettingsOpen) return;

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handlePixelize();
    }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--chroma-key", chromaKey);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      localStorage.setItem(CHROMA_KEY_STORAGE_KEY, chromaKey);
      localStorage.setItem(SMART_PALETTE_STORAGE_KEY, smartPalette);
    } catch {
      // The settings still apply for this session when storage is unavailable.
    }
  }, [chromaKey, smartPalette, theme]);

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
      ambiguityPreviewGenerationRef.current += 1;
      resetImageWorkerClient("Pixelloid was closed.");
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    };
  }, []);

  useEffect(() => {
    const generation = ++ambiguityPreviewGenerationRef.current;
    const createdUrls: string[] = [];
    setAmbiguityPreviewUrls({});

    if (!source || !gridAmbiguity) {
      setAmbiguityPreviewStatus("idle");
      return;
    }
    setAmbiguityPreviewStatus("loading");
    const previewSource = source;
    const previewAmbiguity = gridAmbiguity;

    async function buildPreviews() {
      const previews: Partial<
        Record<PixelGridCandidate["kind"], string>
      > = {};
      let worker =
        workerFallbackFileRef.current === previewSource.processingFile
          ? null
          : getImageWorkerClient();

      for (const candidate of previewAmbiguity.candidates) {
        const settings = {
          pixelSize: candidate.pixelSize,
          offsetX: candidate.offsetX,
          offsetY: candidate.offsetY,
          samplingMode,
          fitToCanvas:
            samplingMode === "nearest" &&
            !previewSource.backgroundRemoved,
          fitForeground:
            samplingMode === "nearest" &&
            previewSource.backgroundRemoved,
          maximumColors:
            samplingMode === "smart" && smartPalette !== "off"
              ? Number(smartPalette)
              : undefined,
        };
        let url: string;

        if (worker) {
          try {
            const generated = await worker.pixelize(
              previewSource.processingFile,
              settings,
              {
                expectedWidth: previewSource.width,
                expectedHeight: previewSource.height,
              },
            );
            url = URL.createObjectURL(generated.blob);
          } catch (workerError) {
            if (
              isAbortError(workerError) ||
              !shouldFallbackFromImageWorker(workerError)
            ) {
              throw workerError;
            }

            workerFallbackFileRef.current = previewSource.processingFile;
            worker = null;
            const generated = await pixelizeImage(
              previewSource.image,
              settings,
            );
            url = generated.url;
          }
        } else {
          const generated = await pixelizeImage(previewSource.image, settings);
          url = generated.url;
        }

        if (generation !== ambiguityPreviewGenerationRef.current) {
          URL.revokeObjectURL(url);
          return;
        }

        createdUrls.push(url);
        previews[candidate.kind] = url;
      }

      if (generation === ambiguityPreviewGenerationRef.current) {
        setAmbiguityPreviewUrls(previews);
        setAmbiguityPreviewStatus("ready");
      }
    }

    void buildPreviews().catch((previewError) => {
      createdUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
      if (
        generation === ambiguityPreviewGenerationRef.current &&
        !isAbortError(previewError)
      ) {
        setAmbiguityPreviewUrls({});
        setAmbiguityPreviewStatus("failed");
      }
    });

    return () => {
      if (generation === ambiguityPreviewGenerationRef.current) {
        ambiguityPreviewGenerationRef.current += 1;
      }
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [gridAmbiguity, samplingMode, smartPalette, source]);

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

  async function analyzePreparedSource(
    processingFile: File,
    image: HTMLImageElement,
    width: number,
    height: number,
    phasePixelSizes: number[] = [],
  ) {
    let detection: ReturnType<typeof analyzePixelGrid>["detection"];
    let suggestion: PixelGridSuggestion | null;
    let phaseAlignments: PixelGridPhaseAlignment[];
    let palette: string[];
    const worker =
      workerFallbackFileRef.current === processingFile
        ? null
        : getImageWorkerClient();

    if (worker) {
      try {
        const analysis = await worker.analyze(processingFile, {
          expectedWidth: width,
          expectedHeight: height,
          maximumColors: 24,
          phasePixelSizes,
        });
        detection = analysis.detection;
        suggestion = analysis.suggestion;
        phaseAlignments = analysis.phaseAlignments;
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
        phaseAlignments = alignPixelGridPhases(image, phasePixelSizes);
        palette = extractImagePalette(image);
      }
    } else {
      const analysis = analyzePixelGrid(image);
      detection = analysis.detection;
      suggestion = analysis.suggestion;
      phaseAlignments = alignPixelGridPhases(image, phasePixelSizes);
      palette = extractImagePalette(image);
    }

    const preparedGrid = prepareDetectedGrid(detection, width, height);
    const preparedSuggestion =
      preparedGrid.detected === null
        ? prepareGridSuggestion(suggestion, width, height)
        : null;

    return {
      palette,
      phaseAlignments,
      preparedGrid,
      preparedSuggestion,
    };
  }

  function commitAnalyzedSource(
    loaded: SourceImage,
    analysis: Awaited<ReturnType<typeof analyzePreparedSource>>,
    options: { preserveExistingGridWhenUndetected?: boolean } = {},
  ) {
    replaceSource(loaded);
    setSourcePalette(analysis.palette);

    const existingGridIsMeaningful =
      detectedGrid !== null ||
      confidence !== null ||
      pixelSize > 1 + GRID_VALUE_EPSILON ||
      Math.abs(gridOffset.x) >= GRID_VALUE_EPSILON ||
      Math.abs(gridOffset.y) >= GRID_VALUE_EPSILON;
    if (
      options.preserveExistingGridWhenUndetected &&
      analysis.preparedGrid.detected === null &&
      existingGridIsMeaningful
    ) {
      // Background removal does not move pixels, so the active geometry remains
      // a useful conversion setting. Do not keep the old detector metadata,
      // though: its confidence may have come from the background just removed.
      setConfidence(null);
      setDetectedGrid(null);
      const activeAlignment = analysis.phaseAlignments.find(
        (alignment) =>
          Math.abs(alignment.pixelSize - pixelSize) <
          GRID_VALUE_EPSILON,
      );
      if (activeAlignment) {
        setGridOffset((current) => ({
          x: activeAlignment.offsetX ?? current.x,
          y: activeAlignment.offsetY ?? current.y,
        }));
      }
      setGridAmbiguity((current) => {
        if (!current) return current;
        if (analysis.phaseAlignments.length === 0) {
          return { ...current, confidence: null };
        }

        const candidates = current.candidates.map((candidate) => {
          const alignment = analysis.phaseAlignments.find(
            (item) =>
              Math.abs(item.pixelSize - candidate.pixelSize) <
              GRID_VALUE_EPSILON,
          );
          if (!alignment) return candidate;
          const offsetX = alignment.offsetX ?? candidate.offsetX;
          const offsetY = alignment.offsetY ?? candidate.offsetY;
          const dimensions = getPixelGridDimensions(
            loaded.width,
            loaded.height,
            {
              pixelSize: candidate.pixelSize,
              offsetX,
              offsetY,
            },
          );

          return {
            ...candidate,
            offsetX,
            offsetY,
            width: dimensions.width,
            height: dimensions.height,
          };
        }) as PixelGridAmbiguity["candidates"];

        return { confidence: null, candidates };
      });
      setGridSuggestion(analysis.preparedSuggestion);
      setSuggestionDecision(
        analysis.preparedSuggestion ? "available" : null,
      );
      setAcceptedSuggestionPixelSize(null);
      setStrictDetectionFailed(true);
      return;
    }

    setPixelSize(analysis.preparedGrid.active.pixelSize);
    setGridOffset({
      x: analysis.preparedGrid.active.offsetX,
      y: analysis.preparedGrid.active.offsetY,
    });
    setConfidence(analysis.preparedGrid.active.confidence);
    setDetectedGrid(analysis.preparedGrid.detected);
    setGridAmbiguity(analysis.preparedGrid.ambiguity);
    setGridSuggestion(analysis.preparedSuggestion);
    setSuggestionDecision(
      analysis.preparedSuggestion ? "available" : null,
    );
    setAcceptedSuggestionPixelSize(null);
    setStrictDetectionFailed(analysis.preparedGrid.detected === null);
  }

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
    setIsRemovingBackground(false);
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
        originalProcessingFile: processingFile,
        processingFile,
        image,
        url: activeUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
        backgroundRemoved: false,
      };
      const analysis = await analyzePreparedSource(
        processingFile,
        image,
        loaded.width,
        loaded.height,
      );

      if (generation !== loadGenerationRef.current) {
        revokePendingSourceUrls();
        return;
      }

      commitAnalyzedSource(loaded, analysis);
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
    options: {
      forceManual?: boolean;
      offset?: { x: number; y: number };
    } = {},
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
    const nextOffset =
      options.offset ??
      (restoresDetection
        ? { x: detectedGrid.offsetX, y: detectedGrid.offsetY }
        : { x: 0, y: 0 });
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

  function selectAmbiguousGrid(candidate: PixelGridCandidate) {
    updatePixelSize(candidate.pixelSize, {
      forceManual: candidate.kind !== "detected",
      offset: { x: candidate.offsetX, y: candidate.offsetY },
    });
  }

  function updateSamplingMode(nextMode: PixelSamplingMode) {
    if (nextMode === samplingMode) return;

    conversionGenerationRef.current += 1;
    resetImageWorkerClient("Pixel sampling changed.");
    setIsProcessing(false);
    setSamplingMode(nextMode);
    setIsEditorOpen(false);
    replaceResult(null);
  }

  async function handleToggleBackgroundRemoval() {
    if (!source || isAnalyzing || isProcessing) return;
    if (
      !source.backgroundRemoved &&
      source.width * source.height > MAX_BACKGROUND_REMOVAL_PIXELS
    ) {
      setError(
        "Background removal supports source images up to 4.2 megapixels.",
      );
      return;
    }

    const sourceAtStart = source;
    const generation = ++loadGenerationRef.current;
    conversionGenerationRef.current += 1;
    resetImageWorkerClient("The source image is being updated.");
    workerFallbackFileRef.current = null;
    suggestionFocusRequestRef.current = false;
    setError(null);
    setIsAnalyzing(true);
    setIsRemovingBackground(true);
    setIsProcessing(false);
    setIsEditorOpen(false);
    await nextFrame();

    if (
      generation !== loadGenerationRef.current ||
      sourceRef.current !== sourceAtStart
    ) {
      return;
    }

    let pendingUrl: string | null = null;

    try {
      let nextProcessingFile = sourceAtStart.originalProcessingFile;
      const restoring = sourceAtStart.backgroundRemoved;

      if (!restoring) {
        let removal: {
          blob: Blob | null;
          width: number;
          height: number;
          detected: boolean;
          removedPixels: number;
          noOpaquePixels: boolean;
        };
        const worker = getImageWorkerClient();

        if (worker) {
          try {
            removal = await worker.removeBackground(
              sourceAtStart.processingFile,
              {
                expectedWidth: sourceAtStart.width,
                expectedHeight: sourceAtStart.height,
              },
            );
          } catch (workerError) {
            if (
              isAbortError(workerError) ||
              !shouldFallbackFromImageWorker(workerError)
            ) {
              throw workerError;
            }

            removal = await removeBackgroundOnMainThread(sourceAtStart.image);
          }
        } else {
          removal = await removeBackgroundOnMainThread(sourceAtStart.image);
        }

        if (
          generation !== loadGenerationRef.current ||
          sourceRef.current !== sourceAtStart
        ) {
          return;
        }

        if (removal.removedPixels === 0) {
          setError(
            removal.noOpaquePixels
              ? "The source is already fully transparent."
              : removal.detected
                ? "No matching edge-connected background was found."
                : "No safe, uniform edge background was found. The source was left unchanged.",
          );
          return;
        }
        if (!removal.blob) {
          throw new Error("The cleaned source image could not be encoded.");
        }

        const cleanedName = `${sourceAtStart.file.name.replace(
          /\.[^.]+$/,
          "",
        )}-background-removed.png`;
        nextProcessingFile = new File([removal.blob], cleanedName, {
          type: "image/png",
          lastModified: sourceAtStart.file.lastModified,
        });
      }

      const decoded = await decodePreview(nextProcessingFile);
      pendingUrl = decoded.url;

      if (
        generation !== loadGenerationRef.current ||
        sourceRef.current !== sourceAtStart
      ) {
        return;
      }

      const analysis = await analyzePreparedSource(
        nextProcessingFile,
        decoded.image,
        sourceAtStart.width,
        sourceAtStart.height,
        restoring
          ? []
          : [
              pixelSize,
              ...(gridAmbiguity?.candidates.map(
                (candidate) => candidate.pixelSize,
              ) ?? []),
            ].filter(
              (candidate, index, candidates) =>
                candidates.findIndex(
                  (value) =>
                    Math.abs(value - candidate) < GRID_VALUE_EPSILON,
                ) === index,
            ),
      );

      if (
        generation !== loadGenerationRef.current ||
        sourceRef.current !== sourceAtStart
      ) {
        return;
      }

      commitAnalyzedSource(
        {
          ...sourceAtStart,
          processingFile: nextProcessingFile,
          image: decoded.image,
          url: decoded.url,
          backgroundRemoved: !restoring,
        },
        analysis,
        { preserveExistingGridWhenUndetected: true },
      );
      pendingUrl = null;
      replaceResult(null);
    } catch (caughtError) {
      if (
        generation === loadGenerationRef.current &&
        !isAbortError(caughtError)
      ) {
        setError(
          "The background could not be updated. Try a smaller PNG or WebP image.",
        );
      }
    } finally {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      if (generation === loadGenerationRef.current) {
        setIsAnalyzing(false);
        setIsRemovingBackground(false);
      }
    }
  }

  async function handlePixelize() {
    if (!source || isProcessing || isAnalyzing) return;

    const generation = ++conversionGenerationRef.current;
    const sourceAtStart = source;
    const settings = {
      pixelSize,
      offsetX: gridOffset.x,
      offsetY: gridOffset.y,
      samplingMode,
      // Preserve the logical canvas, but fit a removed foreground on its own
      // nearest-neighbor lattice so transparent padding cannot shift it.
      fitToCanvas:
        samplingMode === "nearest" && !sourceAtStart.backgroundRemoved,
      fitForeground:
        samplingMode === "nearest" && sourceAtStart.backgroundRemoved,
      maximumColors:
        samplingMode === "smart" && smartPalette !== "off"
          ? Number(smartPalette)
          : undefined,
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

  async function handleVectorExport() {
    if (!result || !source || isExportingSvg) return;

    const resultAtStart = result;
    setError(null);
    setIsExportingSvg(true);

    try {
      const svg = await pixelBlobToSvg(
        resultAtStart.blob,
        `${source.file.name.replace(/\.[^.]+$/, "")} — Pixelloid`,
      );
      if (resultRef.current !== resultAtStart) return;

      const url = URL.createObjectURL(
        new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${source.file.name.replace(
        /\.[^.]+$/,
        "",
      )}-pixel-perfect.svg`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError("The SVG could not be created from the current result.");
    } finally {
      setIsExportingSvg(false);
    }
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
    gridAmbiguity
      ? gridAmbiguity.confidence === null
        ? "PRESERVED · COMPARE GRIDS"
        : `${gridAmbiguity.confidence}% · COMPARE GRIDS`
      : confidence !== null
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
              src={
                theme === "light"
                  ? pixelloidWordmarkLight
                  : pixelloidWordmark
              }
            />
          </span>
          <span className="version-badge">ALPHA</span>
        </a>

        <p className="header-tagline">
          <span className="status-dot" />
          PIXEL ART, ACTUALLY.
        </p>

        <button
          className="icon-button"
          type="button"
          aria-label="Open settings"
          onClick={() => setIsSettingsOpen(true)}
        >
          <Settings size={15} strokeWidth={2.2} />
          <span>SETTINGS</span>
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
                <div className="source-header-actions">
                  <button
                    aria-label={
                      source.backgroundRemoved
                        ? "Restore original source background"
                        : "Remove edge-connected source background before pixelization"
                    }
                    aria-pressed={source.backgroundRemoved}
                    className="source-background-button"
                    disabled={isAnalyzing || isProcessing}
                    type="button"
                    onClick={handleToggleBackgroundRemoval}
                  >
                    {source.backgroundRemoved ? (
                      <RotateCcw aria-hidden="true" size={11} />
                    ) : (
                      <ImageOff aria-hidden="true" size={11} />
                    )}
                    {isRemovingBackground
                      ? source.backgroundRemoved
                        ? "RESTORING…"
                        : "REMOVING…"
                      : source.backgroundRemoved
                        ? "RESTORE BG"
                        : "REMOVE BG"}
                  </button>
                  <button
                    className="text-button"
                    disabled={isAnalyzing || isProcessing}
                    type="button"
                    onClick={openPicker}
                  >
                    REPLACE
                  </button>
                </div>
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
                  <span className="ready-badge" aria-live="polite">
                    <Check size={12} strokeWidth={3} />
                    {isRemovingBackground
                      ? "UPDATING"
                      : source.backgroundRemoved
                        ? "BG REMOVED"
                        : "READY"}
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
                  <div className="download-actions">
                    <a
                      className="download-button"
                      download={downloadName}
                      href={result.url}
                    >
                      <Download size={14} strokeWidth={2.4} />
                      DOWNLOAD PNG
                    </a>
                    <button
                      className="download-button"
                      disabled={isExportingSvg}
                      type="button"
                      onClick={() => void handleVectorExport()}
                    >
                      <Download size={14} strokeWidth={2.4} />
                      {isExportingSvg ? "BUILDING SVG…" : "DOWNLOAD SVG"}
                    </button>
                  </div>
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

            <div className="metric sampling-metric">
              <span>COLOR SAMPLE</span>
              <div
                aria-label="Pixel color sampling method"
                className="sampling-toggle"
                role="group"
              >
                <button
                  aria-pressed={samplingMode === "nearest"}
                  disabled={isAnalyzing || isProcessing}
                  title="Use the exact source pixel at the center of each detected cell"
                  type="button"
                  onClick={() => updateSamplingMode("nearest")}
                >
                  NEAREST
                </button>
                <button
                  aria-pressed={samplingMode === "medoid"}
                  disabled={isAnalyzing || isProcessing}
                  title="Use a robust representative color that actually exists in the source"
                  type="button"
                  onClick={() => updateSamplingMode("medoid")}
                >
                  MEDOID
                </button>
                <button
                  aria-pressed={samplingMode === "smart"}
                  disabled={isAnalyzing || isProcessing}
                  title="Compare nearest, medoid, and dominant source colors per cell and keep the closest reconstruction"
                  type="button"
                  onClick={() => updateSamplingMode("smart")}
                >
                  SMART
                </button>
              </div>
            </div>

            {gridAmbiguity ? (
              <div
                aria-label="Ambiguous grid comparison"
                className="grid-ambiguity"
                role="group"
              >
                <span className="grid-suggestion-kicker">
                  LOW CONFIDENCE · COMPARE BOTH
                </span>
                <div className="grid-ambiguity-options">
                  {gridAmbiguity.candidates.map((candidate, index) => {
                    const isSelected =
                      Math.abs(pixelSize - candidate.pixelSize) <
                        GRID_VALUE_EPSILON &&
                      Math.abs(gridOffset.x - candidate.offsetX) <
                        GRID_VALUE_EPSILON &&
                      Math.abs(gridOffset.y - candidate.offsetY) <
                        GRID_VALUE_EPSILON;
                    const previewUrl =
                      ambiguityPreviewUrls[candidate.kind];

                    return (
                      <button
                        key={candidate.kind}
                        aria-label={`${index === 0 ? "Recommended" : "Detected"} grid: ${candidate.width} by ${candidate.height} output at ${formatPixelSize(candidate.pixelSize)} source pixels`}
                        aria-pressed={isSelected}
                        className="grid-ambiguity-option"
                        disabled={isAnalyzing || isProcessing}
                        type="button"
                        onClick={() => selectAmbiguousGrid(candidate)}
                      >
                        <span
                          aria-hidden="true"
                          className="grid-ambiguity-preview"
                        >
                          {previewUrl ? (
                            <img alt="" src={previewUrl} />
                          ) : ambiguityPreviewStatus === "loading" ? (
                            <span className="grid-preview-loading" />
                          ) : (
                            <ImageOff
                              className="grid-preview-unavailable"
                              size={13}
                            />
                          )}
                        </span>
                        <span className="grid-ambiguity-copy">
                          <strong>
                            {candidate.width} × {candidate.height}
                          </strong>
                          <small>
                            {formatPixelSize(candidate.pixelSize)} PX ·{" "}
                            {index === 0 ? "RECOMMENDED" : "DETECTED"}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : strictDetectionFailed &&
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

      {isSettingsOpen && (
        <SettingsDialog
          theme={theme}
          chromaKey={chromaKey}
          smartPalette={smartPalette}
          onThemeChange={setTheme}
          onChromaKeyChange={(color) => setChromaKey(color.toLowerCase())}
          onSmartPaletteChange={setSmartPalette}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
