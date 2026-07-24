import { invoke } from "@tauri-apps/api/core";

export type MagicFixProviderStatus = {
  available: boolean;
  platformSupported: boolean;
  uvPath: string | null;
  modelCached: boolean;
  pixelArtAdapterCached: boolean;
  message: string;
};

export type MagicFixRunRequest = {
  jobId: string;
  currentPngBase64: string;
  originalPngBase64: string;
  width: number;
  height: number;
  prompt: string;
};

export type MagicFixRunResponse = {
  outputPngBase64: string;
  elapsedMs: number;
};

export function magicFixErrorMessage(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

export async function getMagicFixStatus() {
  if (!isTauriRuntime()) {
    return {
      available: false,
      platformSupported: false,
      uvPath: null,
      modelCached: false,
      pixelArtAdapterCached: false,
      message: "Magic Fix is available in the Pixelloid desktop app.",
    } satisfies MagicFixProviderStatus;
  }

  return invoke<MagicFixProviderStatus>("magic_fix_status");
}

export function runMagicFix(request: MagicFixRunRequest) {
  return invoke<MagicFixRunResponse>("magic_fix_run", { request });
}

export async function cancelMagicFix(jobId: string) {
  if (!isTauriRuntime()) return false;

  return invoke<boolean>("magic_fix_cancel", {
    request: { jobId },
  });
}
