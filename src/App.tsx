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
import { PixelEditor } from "./components/PixelEditor";
import { PixelMark } from "./components/PixelMark";
import {
  detectPixelGrid,
  getPixelGridDimensions,
  pixelizeImage,
  PixelizeResult,
} from "./lib/pixelize";
import { extractImagePalette } from "./lib/palette";
import "./App.css";

type SourceImage = {
  file: File;
  image: HTMLImageElement;
  url: string;
  width: number;
  height: number;
};

const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
];
const MAX_SOURCE_PIXELS = 40_000_000;

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function formatPixelSize(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "");
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadGenerationRef = useRef(0);
  const conversionGenerationRef = useRef(0);
  const sourceRef = useRef<SourceImage | null>(null);
  const resultRef = useRef<PixelizeResult | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [result, setResult] = useState<PixelizeResult | null>(null);
  const [pixelSize, setPixelSize] = useState(8);
  const [gridOffset, setGridOffset] = useState({ x: 0, y: 0 });
  const [confidence, setConfidence] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [sourcePalette, setSourcePalette] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const outputSize = useMemo(() => {
    if (!source) return null;

    return getPixelGridDimensions(source.width, source.height, {
      pixelSize,
      offsetX: gridOffset.x,
      offsetY: gridOffset.y,
    });
  }, [gridOffset, pixelSize, source]);

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
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    };
  }, []);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (isEditorOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handlePixelize();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  async function loadFile(file: File) {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPG, WebP, or BMP image.");
      return;
    }

    const generation = ++loadGenerationRef.current;
    conversionGenerationRef.current += 1;
    setError(null);
    setIsAnalyzing(true);
    setIsProcessing(false);
    setIsEditorOpen(false);
    setSourcePalette([]);
    replaceResult(null);
    await nextFrame();

    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.src = url;

    try {
      await image.decode();

      if (generation !== loadGenerationRef.current) {
        URL.revokeObjectURL(url);
        return;
      }

      if (image.naturalWidth * image.naturalHeight > MAX_SOURCE_PIXELS) {
        throw new Error("image-too-large");
      }

      const loaded: SourceImage = {
        file,
        image,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      const detection = detectPixelGrid(image);
      const palette = extractImagePalette(image);

      if (generation !== loadGenerationRef.current) {
        URL.revokeObjectURL(url);
        return;
      }

      replaceSource(loaded);
      setPixelSize(detection.pixelSize);
      setGridOffset({ x: detection.offsetX, y: detection.offsetY });
      setConfidence(detection.confidence);
      setSourcePalette(palette);
    } catch (caughtError) {
      URL.revokeObjectURL(url);

      if (generation === loadGenerationRef.current) {
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

  function updatePixelSize(nextSize: number) {
    if (!source) return;
    const maximum = Math.max(
      1,
      Math.floor(Math.min(source.width, source.height) / 2),
    );
    const clampedSize =
      Math.round(
        Math.max(1, Math.min(maximum, nextSize)) * 1000,
      ) / 1000;

    if (
      clampedSize === pixelSize &&
      gridOffset.x === 0 &&
      gridOffset.y === 0
    ) {
      return;
    }

    conversionGenerationRef.current += 1;
    setIsProcessing(false);
    setPixelSize(clampedSize);
    setGridOffset({ x: 0, y: 0 });
    setConfidence(null);
    setIsEditorOpen(false);
    replaceResult(null);
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

    try {
      const nextResult = await pixelizeImage(source.image, settings);

      if (
        generation !== conversionGenerationRef.current ||
        sourceRef.current !== sourceAtStart
      ) {
        URL.revokeObjectURL(nextResult.url);
        return;
      }

      replaceResult(nextResult);
      setIsEditorOpen(false);
    } catch {
      if (generation === conversionGenerationRef.current) {
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
    replaceSource(null);
    replaceResult(null);
    setPixelSize(8);
    setGridOffset({ x: 0, y: 0 });
    setConfidence(null);
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#" aria-label="Pixelloid home">
          <span className="brand-mark">
            <PixelMark size={25} />
          </span>
          <span>PIXELLOID</span>
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
          <p className="eyebrow">
            <span>01</span>
            TRUE PIXEL CONVERTER
          </p>
          <h1>
            Turn almost-pixels
            <br />
            into <em>actual pixels.</em>
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
                  <span className="file-hint">PNG · JPG · WEBP · BMP</span>
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
              <div className="result-grid" />
              {result ? (
                <>
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
          <section className="detection-bar" aria-label="Grid detection settings">
            <div className="detection-heading">
              <span className="scan-icon">
                <ScanSearch size={17} />
              </span>
              <div>
                <span>DETECTED GRID</span>
                <strong>
                  {confidence === null
                    ? "MANUAL ADJUSTMENT"
                    : `${confidence}% CONFIDENCE`}
                </strong>
              </div>
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
                  onClick={() =>
                    updatePixelSize(Math.max(1, Math.ceil(pixelSize) - 1))
                  }
                >
                  <Minus size={13} />
                </button>
                <strong>{formatPixelSize(pixelSize)} PX</strong>
                <button
                  aria-label="Increase source pixel size"
                  disabled={isAnalyzing || isProcessing}
                  type="button"
                  onClick={() => updatePixelSize(Math.floor(pixelSize) + 1)}
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

            <p className="detection-note">
              Not quite right? Adjust the source pixel size.
            </p>
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
    </div>
  );
}

export default App;
