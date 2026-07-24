type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export default function init(
  moduleOrPath?: InitInput | Promise<InitInput>,
): Promise<WebAssembly.Exports>;

export function crop_offset(
  rgba: Uint8Array,
  width: number,
  height: number,
  scale: number,
): Uint32Array;

export function detect_tiled(
  rgba: Uint8Array,
  width: number,
  height: number,
): number;

export function downscale_rgba_packed(
  rgba: Uint8Array,
  width: number,
  height: number,
  scale: number,
  method: number,
  domThreshold: number,
  alignGrid: number,
): Uint8Array;

export function morph_cleanup_packed(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array;

export function quantize_packed(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxColors: number,
  fixedPalette: Uint8Array,
): Uint8Array;
