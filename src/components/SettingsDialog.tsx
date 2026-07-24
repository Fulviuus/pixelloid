import { Moon, Settings, Sun, X } from "lucide-react";
import { useEffect, useRef } from "react";

export type AppTheme = "dark" | "light";
export type SmartPaletteMode = "off" | "64" | "32";

export type SettingsDialogProps = {
  theme: AppTheme;
  chromaKey: string;
  smartPalette: SmartPaletteMode;
  onThemeChange: (theme: AppTheme) => void;
  onChromaKeyChange: (color: string) => void;
  onSmartPaletteChange: (mode: SmartPaletteMode) => void;
  onClose: () => void;
};

export function SettingsDialog({
  theme,
  chromaKey,
  smartPalette,
  onThemeChange,
  onChromaKeyChange,
  onSmartPaletteChange,
  onClose,
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();

    return () => previousFocus?.focus();
  }, []);

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="settings-header">
          <div className="settings-heading">
            <span className="settings-mark" aria-hidden="true">
              <Settings size={17} />
            </span>
            <div>
              <p>APPLICATION</p>
              <h2 id="settings-title">Settings</h2>
            </div>
          </div>
          <button
            className="settings-close"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-row">
            <div className="settings-copy">
              <strong>THEME</strong>
              <span>Choose the application interface appearance.</span>
            </div>
            <div
              className="settings-segmented"
              role="group"
              aria-label="Application theme"
            >
              <button
                type="button"
                aria-pressed={theme === "dark"}
                onClick={() => onThemeChange("dark")}
              >
                <Moon aria-hidden="true" size={15} />
                DARK
              </button>
              <button
                type="button"
                aria-pressed={theme === "light"}
                onClick={() => onThemeChange("light")}
              >
                <Sun aria-hidden="true" size={15} />
                LIGHT
              </button>
            </div>
          </section>

          <section className="settings-row">
            <div className="settings-copy">
              <strong>CHROMA KEY</strong>
              <span>Display color used behind transparent pixels.</span>
            </div>
            <label className="settings-color">
              <span
                aria-hidden="true"
                style={{ backgroundColor: chromaKey }}
              />
              <input
                aria-label="Chroma key color"
                type="color"
                value={chromaKey}
                onChange={(event) => onChromaKeyChange(event.target.value)}
              />
              <output>{chromaKey.toUpperCase()}</output>
            </label>
          </section>

          <section className="settings-row">
            <div className="settings-copy">
              <strong>SMART PALETTE</strong>
              <span>
                Optionally reduce colors after sampling. No dithering or
                pre-processing.
              </span>
            </div>
            <div
              className="settings-segmented"
              role="group"
              aria-label="Smart palette reduction"
            >
              {(["off", "64", "32"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={smartPalette === mode}
                  onClick={() => onSmartPaletteChange(mode)}
                >
                  {mode === "off" ? "OFF" : mode}
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="settings-footer">
          <span>CHANGES SAVE AUTOMATICALLY</span>
          <button type="button" onClick={onClose}>
            DONE
          </button>
        </footer>
      </div>
    </div>
  );
}
