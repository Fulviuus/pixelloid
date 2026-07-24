import {
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  Cpu,
  HardDriveDownload,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";

export type MagicFixPhase =
  | "checking"
  | "ready"
  | "preparing"
  | "running"
  | "cancelling"
  | "preview"
  | "error";

export type MagicFixRuntimeStatus = {
  available: boolean;
  modelCached: boolean;
  pixelArtAdapterCached: boolean;
  message: string;
};

export type MagicFixDialogProps = {
  phase: MagicFixPhase;
  runtime: MagicFixRuntimeStatus | null;
  current: ImageData;
  candidate: ImageData | null;
  stage: string | null;
  error: string | null;
  onRun: (lockPalette: boolean) => void;
  onCancelRun: () => void;
  onAccept: () => void;
  onClose: () => void;
};

function drawPreview(
  canvas: HTMLCanvasElement | null,
  image: ImageData | null,
) {
  if (!canvas || !image) return;

  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.putImageData(image, 0, 0);
}

export function MagicFixDialog({
  phase,
  runtime,
  current,
  candidate,
  stage,
  error,
  onRun,
  onCancelRun,
  onAccept,
  onClose,
}: MagicFixDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const currentCanvasRef = useRef<HTMLCanvasElement>(null);
  const candidateCanvasRef = useRef<HTMLCanvasElement>(null);
  const [lockPalette, setLockPalette] = useState(false);
  const isBusy =
    phase === "preparing" ||
    phase === "running" ||
    phase === "cancelling";

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.focus();
    }
  }, [phase]);

  useEffect(() => {
    drawPreview(currentCanvasRef.current, current);
  }, [current, phase]);

  useEffect(() => {
    drawPreview(candidateCanvasRef.current, candidate);
  }, [candidate, phase]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();

    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key !== "Escape") return;
    event.preventDefault();
    if (phase === "cancelling") return;
    if (isBusy) {
      onCancelRun();
    } else {
      onClose();
    }
  }

  return (
    <div
      className="magic-fix-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !isBusy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="magic-fix-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="magic-fix-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="magic-fix-header">
          <div className="magic-fix-heading">
            <span className="magic-fix-mark" aria-hidden="true">
              <Sparkles size={17} />
            </span>
            <div>
              <p>LOCAL AI · KLEIN 4B + PIXEL ART LORA</p>
              <h3 id="magic-fix-title">Magic Fix</h3>
            </div>
          </div>
          <span className="magic-fix-local-badge">
            <span aria-hidden="true" />
            LOCAL ONLY
          </span>
          <button
            className="magic-fix-close"
            type="button"
            aria-label="Close Magic Fix"
            onClick={onClose}
            disabled={isBusy}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        {phase === "preview" && candidate ? (
          <>
            <div className="magic-fix-comparison">
              <figure>
                <figcaption>CURRENT EDIT</figcaption>
                <div className="magic-fix-preview-frame">
                  <canvas
                    ref={currentCanvasRef}
                    aria-label="Current pixel edit"
                  />
                </div>
              </figure>
              <figure className="is-magic">
                <figcaption>
                  <Sparkles aria-hidden="true" size={13} />
                  MAGIC FIX
                </figcaption>
                <div className="magic-fix-preview-frame">
                  <canvas
                    ref={candidateCanvasRef}
                    aria-label="Magic Fix preview"
                  />
                </div>
              </figure>
            </div>

            <p className="magic-fix-preview-note">
              The AI result has been collapsed back to{" "}
              {candidate.width} × {candidate.height} true pixels. Nothing has
              changed until you apply it.
            </p>

            <footer className="magic-fix-actions">
              <button
                className="magic-fix-secondary"
                type="button"
                onClick={onClose}
              >
                DISCARD
              </button>
              <button
                className="magic-fix-secondary"
                type="button"
                onClick={() => onRun(lockPalette)}
              >
                <RotateCcw aria-hidden="true" size={15} />
                TRY AGAIN
              </button>
              <button
                className="magic-fix-primary"
                type="button"
                onClick={onAccept}
              >
                <Check aria-hidden="true" size={16} />
                APPLY MAGIC FIX
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="magic-fix-body">
              {phase === "checking" ? (
                <div className="magic-fix-status-card is-running" role="status">
                  <LoaderCircle
                    className="magic-fix-spinner"
                    aria-hidden="true"
                    size={21}
                  />
                  <div>
                    <strong>CHECKING LOCAL RUNTIME</strong>
                    <span>Looking for the Apple Silicon model runner…</span>
                  </div>
                </div>
              ) : isBusy ? (
                <div className="magic-fix-running" role="status">
                  <div className="magic-fix-orbit" aria-hidden="true">
                    <Sparkles size={24} />
                  </div>
                  <p>
                    {phase === "cancelling"
                      ? "STOPPING MAGIC FIX"
                      : stage ?? "RUNNING PIXEL ART MODEL"}
                  </p>
                  <span>
                    {runtime?.modelCached &&
                    runtime.pixelArtAdapterCached
                      ? "The model and pixel-art adapter are working locally. Larger images take longer."
                      : "First run: downloading and loading the local model files. This can take several minutes."}
                  </span>
                </div>
              ) : (
                <>
                  <p className="magic-fix-intro">
                    FLUX compares your true-pixel edit with the original while
                    a dedicated pixel-art adapter keeps the reconstruction
                    crisp. Pixelloid then forces the result back onto the exact
                    same pixel grid.
                  </p>

                  <div
                    className={`magic-fix-status-card ${
                      runtime?.available ? "is-ready" : "is-error"
                    }`}
                  >
                    <Cpu aria-hidden="true" size={21} />
                    <div>
                      <strong>
                        {runtime?.available
                          ? runtime.modelCached &&
                            runtime.pixelArtAdapterCached
                            ? "PIXEL ART MODEL READY"
                            : "PIXEL ART MODEL AVAILABLE"
                          : "LOCAL RUNTIME UNAVAILABLE"}
                      </strong>
                      <span>{runtime?.message ?? "Runtime check failed."}</span>
                    </div>
                  </div>

                  {runtime?.available &&
                    (!runtime.modelCached ||
                      !runtime.pixelArtAdapterCached) && (
                    <div className="magic-fix-download-note">
                      <HardDriveDownload aria-hidden="true" size={19} />
                      <div>
                        <strong>ONE-TIME LOCAL DOWNLOAD</strong>
                        <span>
                          {!runtime.modelCached
                            ? "The first run downloads approximately 16.5 GB for FLUX.2 Klein and its pixel-art adapter."
                            : "The first styled run downloads the approximately 325 MB pixel-art adapter."}{" "}
                          It is cached locally for later fixes.
                        </span>
                      </div>
                    </div>
                  )}

                  <label className="magic-fix-option">
                    <input
                      type="checkbox"
                      checked={lockPalette}
                      onChange={(event) =>
                        setLockPalette(event.currentTarget.checked)
                      }
                      disabled={!runtime?.available}
                    />
                    <span aria-hidden="true" />
                    <div>
                      <strong>LOCK TO CURRENT PALETTE</strong>
                      <small>
                        Prevent new colors. Useful for strict palettes, but can
                        remove subtle shading recovered from the original.
                      </small>
                    </div>
                  </label>

                  {phase === "error" && error && (
                    <p className="magic-fix-error" role="alert">
                      {error}
                    </p>
                  )}
                </>
              )}
            </div>

            <footer className="magic-fix-actions">
              {isBusy ? (
                <button
                  className="magic-fix-secondary"
                  type="button"
                  onClick={onCancelRun}
                  disabled={phase === "cancelling"}
                >
                  <X aria-hidden="true" size={15} />
                  {phase === "cancelling" ? "STOPPING…" : "CANCEL"}
                </button>
              ) : (
                <>
                  <button
                    className="magic-fix-secondary"
                    type="button"
                    onClick={onClose}
                  >
                    CANCEL
                  </button>
                  <button
                    className="magic-fix-primary"
                    type="button"
                    onClick={() => onRun(lockPalette)}
                    disabled={!runtime?.available || phase === "checking"}
                  >
                    <Sparkles aria-hidden="true" size={16} />
                    {phase === "error" ? "TRY AGAIN" : "RUN MAGIC FIX"}
                  </button>
                </>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
