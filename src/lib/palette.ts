type ColorBucket = {
  count: number;
  red: number;
  green: number;
  blue: number;
};

type PaletteCandidate = {
  count: number;
  red: number;
  green: number;
  blue: number;
  luminance: number;
  chroma: number;
};

const PALETTE_ANALYSIS_SIZE = 256;
const MAX_CANDIDATES = 256;

function toHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function colorDistance(
  first: PaletteCandidate,
  second: PaletteCandidate,
) {
  const red = first.red - second.red;
  const green = first.green - second.green;
  const blue = first.blue - second.blue;
  return Math.sqrt(red * red + green * green + blue * blue);
}

/**
 * Builds a compact, diverse palette from representative colors in the source.
 * Colors are quantized only for grouping; each swatch uses the source pixels'
 * average color within its bucket.
 */
export function extractImagePalette(
  image: HTMLImageElement,
  maximumColors = 24,
) {
  const scale = Math.min(
    1,
    PALETTE_ANALYSIS_SIZE /
      Math.max(image.naturalWidth, image.naturalHeight),
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) return ["#000000", "#ffffff"];

  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const buckets = new Map<number, ColorBucket>();

  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 32) continue;

    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.count += 1;
      bucket.red += red;
      bucket.green += green;
      bucket.blue += blue;
    } else {
      buckets.set(key, {
        count: 1,
        red,
        green,
        blue,
      });
    }
  }

  const candidates = [...buckets.values()]
    .map((bucket): PaletteCandidate => {
      const red = bucket.red / bucket.count;
      const green = bucket.green / bucket.count;
      const blue = bucket.blue / bucket.count;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);

      return {
        count: bucket.count,
        red,
        green,
        blue,
        luminance: (red + green + blue) / 3,
        chroma: maximum - minimum,
      };
    })
    .sort((first, second) => second.count - first.count)
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) return ["#000000", "#ffffff"];

  const selected: PaletteCandidate[] = [candidates[0]];
  const selectedSet = new Set([candidates[0]]);

  while (
    selected.length < Math.max(1, maximumColors) &&
    selected.length < candidates.length
  ) {
    let best: PaletteCandidate | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const lightNeutralCount = selected.filter(
      (color) => color.luminance > 220 && color.chroma < 22,
    ).length;

    for (const candidate of candidates) {
      if (selectedSet.has(candidate)) continue;
      if (
        lightNeutralCount >= 2 &&
        candidate.luminance > 220 &&
        candidate.chroma < 22
      ) {
        continue;
      }

      const minimumDistance = Math.min(
        ...selected.map((color) => colorDistance(candidate, color)),
      );
      if (minimumDistance < 16) continue;

      const diversity = Math.min(1, minimumDistance / 180);
      const frequency = Math.log2(candidate.count + 1);
      const score = frequency * (0.35 + diversity * 0.65);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (!best) break;
    selected.push(best);
    selectedSet.add(best);
  }

  return selected.map((color) => toHex(color.red, color.green, color.blue));
}
