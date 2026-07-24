import {
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";

export type MagicFixPhase = "ready" | "running" | "preview" | "error";

export type MagicFixDialogProps = {
  phase: MagicFixPhase;
  current: ImageData;
  candidate: ImageData | null;
  summary: string | null;
  error: string | null;
  onRun: (lockPalette: boolean) => void;
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
  current,
  candidate,
  summary,
  error,
  onRun,
  onAccept,
  onClose,
}: MagicFixDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const currentCanvasRef = useRef<HTMLCanvasElement>(null);
  const candidateCanvasRef = useRef<HTMLCanvasElement>(null);
  const [lockPalette, setLockPalette] = useState(false);
  const isBusy = phase === "running";

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

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="magic-fix-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
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
              <p>DETERMINISTIC · SOURCE-GRID RESTORATION</p>
              <h3 id="magic-fix-title">Magic Fix</h3>
            </div>
          </div>
          <span className="magic-fix-local-badge">
            <span aria-hidden="true" />
            LOCAL · NO AI
          </span>
          <button
            className="magic-fix-close"
            type="button"
            aria-label="Close Magic Fix"
            onClick={onClose}
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
                  RESTORED
                </figcaption>
                <div className="magic-fix-preview-frame">
                  <canvas
                    ref={candidateCanvasRef}
                    aria-label="Deterministic Magic Fix preview"
                  />
                </div>
              </figure>
            </div>

            <p className="magic-fix-preview-note">
              {summary ??
                `Source colors were resolved directly onto the existing ${candidate.width} × ${candidate.height} grid.`}{" "}
              Nothing changes until you apply the result.
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
              {isBusy ? (
                <div className="magic-fix-running" role="status">
                  <LoaderCircle
                    className="magic-fix-spinner"
                    aria-hidden="true"
                    size={24}
                  />
                  <p>ANALYZING SOURCE CELLS</p>
                  <span>
                    Separating coherent source colors from interpolation,
                    halos and isolated noise.
                  </span>
                </div>
              ) : (
                <>
                  <p className="magic-fix-intro">
                    Magic Fix examines every original source cell, weighs its
                    clean interior more heavily than its edges, and keeps the
                    strongest coherent color. Ambiguous cells remain unchanged.
                  </p>

                  <div className="magic-fix-status-card is-ready">
                    <Sparkles aria-hidden="true" size={21} />
                    <div>
                      <strong>READY · NO MODEL REQUIRED</strong>
                      <span>
                        The reconstruction is deterministic, offline and runs
                        directly on the source image.
                      </span>
                    </div>
                  </div>

                  <label className="magic-fix-option">
                    <input
                      type="checkbox"
                      checked={lockPalette}
                      onChange={(event) =>
                        setLockPalette(event.currentTarget.checked)
                      }
                    />
                    <span aria-hidden="true" />
                    <div>
                      <strong>LOCK TO CURRENT PALETTE</strong>
                      <small>
                        Map recovered colors to the editor palette instead of
                        introducing source variations.
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
                disabled={isBusy}
              >
                <Sparkles aria-hidden="true" size={16} />
                {phase === "error" ? "TRY AGAIN" : "ANALYZE SOURCE"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
