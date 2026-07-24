export {
  collapseMagicFixResult,
  prepareMagicFixEdit,
  prepareMagicFixOriginalReference,
} from "./imagePipeline";

export {
  cancelMagicFix,
  getMagicFixStatus,
  magicFixErrorMessage,
  runMagicFix,
} from "./client";

export type {
  CollapseMagicFixOptions,
  MagicFixModelCanvas,
  MagicFixPaletteColor,
  MagicFixPaletteOptions,
  MagicFixTransform,
  PreparedMagicFixImage,
  PrepareOriginalReferenceOptions,
  RgbaImageData,
} from "./imagePipeline";

export type {
  MagicFixProviderStatus,
  MagicFixRunRequest,
  MagicFixRunResponse,
} from "./client";
