import type { PixelBuffer } from "./gridDetection";

type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

type WeightedRgbColor = RgbColor & {
  count: number;
  key: number;
};

export type BackgroundRemovalResult = {
  /**
   * The supplied image. Its pixel data is mutated in place when a removable
   * background is detected, which avoids cloning a potentially large RGBA
   * buffer in the image worker.
   */
  image: PixelBuffer;
  /**
   * True when the border/frontier colors formed a compact background model.
   * A true result can still remove zero pixels when the image is empty.
   */
  detected: boolean;
  removedPixels: number;
  noOpaquePixels: boolean;
};

const OPAQUE_ALPHA_THRESHOLD = 16;
const MAX_BACKGROUND_CLUSTERS = 4;
const MAX_MODEL_P95_DISTANCE = 12;
const MIN_CLUSTER_SHARE = 0.08;
const MAX_BORDER_SAMPLES = 65_536;

function weightedColorDistanceSquared(first: RgbColor, second: RgbColor) {
  const red = first.red - second.red;
  const green = first.green - second.green;
  const blue = first.blue - second.blue;
  return red * red * 0.299 + green * green * 0.587 + blue * blue * 0.114;
}

function fitBorderModel(samples: RgbColor[], clusterCount: number) {
  const histogram = new Map<number, WeightedRgbColor>();

  for (const sample of samples) {
    const key =
      (Math.round(sample.red) << 16) |
      (Math.round(sample.green) << 8) |
      Math.round(sample.blue);
    const color = histogram.get(key);

    if (color) {
      color.count += 1;
    } else {
      histogram.set(key, { ...sample, count: 1, key });
    }
  }

  const colors = [...histogram.values()].sort(
    (first, second) =>
      second.count - first.count || first.key - second.key,
  );
  if (colors.length < clusterCount || colors.length === 0) return null;

  const centers: RgbColor[] = [
    {
      red: colors[0].red,
      green: colors[0].green,
      blue: colors[0].blue,
    },
  ];

  while (centers.length < clusterCount) {
    let best = colors[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const color of colors) {
      const nearestDistance = Math.min(
        ...centers.map((center) =>
          weightedColorDistanceSquared(color, center),
        ),
      );
      const score = nearestDistance * color.count ** 0.2;
      if (score > bestScore) {
        best = color;
        bestScore = score;
      }
    }

    centers.push({
      red: best.red,
      green: best.green,
      blue: best.blue,
    });
  }

  const assignments = new Uint8Array(colors.length);
  const clusterWeights = new Float64Array(clusterCount);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const redTotals = new Float64Array(clusterCount);
    const greenTotals = new Float64Array(clusterCount);
    const blueTotals = new Float64Array(clusterCount);
    clusterWeights.fill(0);

    for (let colorIndex = 0; colorIndex < colors.length; colorIndex += 1) {
      const color = colors[colorIndex];
      let bestCluster = 0;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (
        let clusterIndex = 0;
        clusterIndex < centers.length;
        clusterIndex += 1
      ) {
        const distance = weightedColorDistanceSquared(
          color,
          centers[clusterIndex],
        );
        if (distance < bestDistance) {
          bestCluster = clusterIndex;
          bestDistance = distance;
        }
      }

      assignments[colorIndex] = bestCluster;
      clusterWeights[bestCluster] += color.count;
      redTotals[bestCluster] += color.red * color.count;
      greenTotals[bestCluster] += color.green * color.count;
      blueTotals[bestCluster] += color.blue * color.count;
    }

    for (
      let clusterIndex = 0;
      clusterIndex < centers.length;
      clusterIndex += 1
    ) {
      const weight = clusterWeights[clusterIndex];
      if (weight === 0) continue;
      centers[clusterIndex] = {
        red: redTotals[clusterIndex] / weight,
        green: greenTotals[clusterIndex] / weight,
        blue: blueTotals[clusterIndex] / weight,
      };
    }
  }

  const distances = samples
    .map((sample) =>
      Math.sqrt(
        Math.min(
          ...centers.map((center) =>
            weightedColorDistanceSquared(sample, center),
          ),
        ),
      ),
    )
    .sort((first, second) => first - second);
  const percentileIndex = Math.min(
    distances.length - 1,
    Math.floor(distances.length * 0.95),
  );
  const totalWeight = clusterWeights.reduce(
    (total, weight) => total + weight,
    0,
  );

  return {
    centers,
    p95: distances[percentileIndex] ?? Number.POSITIVE_INFINITY,
    clusterShares: [...clusterWeights].map(
      (weight) => weight / Math.max(1, totalWeight),
    ),
  };
}

/**
 * Removes only pixels that both match a compact edge-color model and are
 * four-way connected to the exterior. Enclosed regions of the same color are
 * preserved.
 *
 * Transparent padding is traversed to inspect the first opaque frontier. An
 * inset background is accepted only when that frontier resembles a filled
 * rectangular frame; this keeps an already-transparent sprite from being
 * mistaken for its own background.
 *
 * The input RGBA data is mutated in place only after a model is accepted.
 */
export function removeEdgeConnectedBackground(
  source: PixelBuffer,
): BackgroundRemovalResult {
  const { data: pixels, width, height } = source;
  const pixelCount = width * height;
  let visiblePixels = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (pixels[pixelIndex * 4 + 3] >= OPAQUE_ALPHA_THRESHOLD) {
      visiblePixels += 1;
    }
  }

  if (visiblePixels === 0) {
    return {
      image: source,
      detected: true,
      removedPixels: 0,
      noOpaquePixels: true,
    };
  }

  const borderPixels: number[] = [];
  for (let x = 0; x < width; x += 1) {
    borderPixels.push(x, (height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    borderPixels.push(y * width, y * width + width - 1);
  }

  const hasVisibleBorder = borderPixels.some(
    (pixelIndex) =>
      pixels[pixelIndex * 4 + 3] >= OPAQUE_ALPHA_THRESHOLD,
  );

  // These buffers are reused for the removal flood once frontier discovery is
  // complete, limiting peak auxiliary storage to six bytes per source pixel.
  const visited = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  const frontierSeen = new Uint8Array(pixelCount);
  const samples: RgbColor[] = [];
  let head = 0;
  let tail = 0;
  let frontierCount = 0;
  let sampleRandomState = 0x9e3779b9;
  let frontierLeft = width;
  let frontierRight = -1;
  let frontierTop = height;
  let frontierBottom = -1;

  function visitExterior(pixelIndex: number) {
    const offset = pixelIndex * 4;

    if (pixels[offset + 3] < OPAQUE_ALPHA_THRESHOLD) {
      if (visited[pixelIndex]) return;
      visited[pixelIndex] = 1;
      queue[tail] = pixelIndex;
      tail += 1;
      return;
    }

    if (frontierSeen[pixelIndex]) return;
    frontierSeen[pixelIndex] = 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    frontierLeft = Math.min(frontierLeft, x);
    frontierRight = Math.max(frontierRight, x);
    frontierTop = Math.min(frontierTop, y);
    frontierBottom = Math.max(frontierBottom, y);
    frontierCount += 1;

    if (samples.length < MAX_BORDER_SAMPLES) {
      samples.push({
        red: pixels[offset],
        green: pixels[offset + 1],
        blue: pixels[offset + 2],
      });
      return;
    }

    // Keep a deterministic reservoir rather than retaining an object for every
    // opaque frontier pixel in pathological transparent/opaque stripe inputs.
    sampleRandomState =
      (Math.imul(sampleRandomState, 1_664_525) + 1_013_904_223) >>> 0;
    const replacementIndex = Math.floor(
      (sampleRandomState / 0x1_0000_0000) * frontierCount,
    );
    if (replacementIndex < MAX_BORDER_SAMPLES) {
      samples[replacementIndex] = {
        red: pixels[offset],
        green: pixels[offset + 1],
        blue: pixels[offset + 2],
      };
    }
  }

  for (const pixelIndex of borderPixels) visitExterior(pixelIndex);

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    if (x > 0) visitExterior(pixelIndex - 1);
    if (x + 1 < width) visitExterior(pixelIndex + 1);
    if (y > 0) visitExterior(pixelIndex - width);
    if (y + 1 < height) visitExterior(pixelIndex + width);
  }

  if (samples.length === 0) {
    return {
      image: source,
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    };
  }

  if (!hasVisibleBorder) {
    const spanX = Math.max(1, frontierRight - frontierLeft + 1);
    const spanY = Math.max(1, frontierBottom - frontierTop + 1);
    let horizontalEdges = 0;
    let verticalEdges = 0;

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (!frontierSeen[pixelIndex]) continue;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (y === frontierTop || y === frontierBottom) horizontalEdges += 1;
      if (x === frontierLeft || x === frontierRight) verticalEdges += 1;
    }

    const frameCoverage = Math.min(
      horizontalEdges / (spanX * 2),
      verticalEdges / (spanY * 2),
    );
    const interiorCoverage = visiblePixels / (spanX * spanY);

    if (frameCoverage < 0.45 || interiorCoverage < 0.65) {
      return {
        image: source,
        detected: false,
        removedPixels: 0,
        noOpaquePixels: false,
      };
    }
  }

  let model: ReturnType<typeof fitBorderModel> = null;

  for (
    let clusterCount = 1;
    clusterCount <= MAX_BACKGROUND_CLUSTERS;
    clusterCount += 1
  ) {
    const candidate = fitBorderModel(samples, clusterCount);
    if (!candidate) break;

    const usefulClusters =
      clusterCount === 1 ||
      candidate.clusterShares.every(
        (share) => share >= MIN_CLUSTER_SHARE,
      );
    if (candidate.p95 <= MAX_MODEL_P95_DISTANCE && usefulClusters) {
      model = candidate;
      break;
    }
  }

  if (!model) {
    return {
      image: source,
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    };
  }

  const tolerance = Math.max(10, Math.min(24, model.p95 + 6));

  // Reuse the transparent-padding traversal buffers for the actual flood.
  visited.fill(0);
  head = 0;
  tail = 0;
  let removedPixels = 0;
  let removedVisiblePixels = 0;

  function matchesBackground(pixelIndex: number) {
    const offset = pixelIndex * 4;
    if (pixels[offset + 3] < OPAQUE_ALPHA_THRESHOLD) return true;

    const color = {
      red: pixels[offset],
      green: pixels[offset + 1],
      blue: pixels[offset + 2],
    };
    return model!.centers.some(
      (center) =>
        Math.sqrt(weightedColorDistanceSquared(color, center)) <=
        tolerance,
    );
  }

  function enqueue(pixelIndex: number) {
    if (visited[pixelIndex] || !matchesBackground(pixelIndex)) return;
    visited[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  }

  for (const pixelIndex of borderPixels) enqueue(pixelIndex);

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (!visited[pixelIndex]) continue;
    const alpha = pixels[pixelIndex * 4 + 3];
    if (alpha > 0) removedPixels += 1;
    if (alpha >= OPAQUE_ALPHA_THRESHOLD) removedVisiblePixels += 1;
  }

  // A compact border is not enough to prove that any foreground exists. Fail
  // safely for solid images and inset solid rectangles instead of returning a
  // completely empty source.
  if (removedVisiblePixels >= visiblePixels) {
    return {
      image: source,
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    };
  }

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (!visited[pixelIndex]) continue;
    const offset = pixelIndex * 4;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = 0;
  }

  return {
    image: source,
    detected: true,
    removedPixels,
    noOpaquePixels: false,
  };
}
