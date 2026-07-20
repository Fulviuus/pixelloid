import {
  CSSProperties,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Crop,
  Eraser,
  Eye,
  ImageOff,
  PaintBucket,
  Pencil,
  Pipette,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PixelizeResult } from "../lib/pixelize";

type EditorTool = "pencil" | "fill" | "eyedropper" | "eraser" | "crop";

type PixelPoint = {
  x: number;
  y: number;
};

type CropSelection = PixelPoint & {
  width: number;
  height: number;
};

type CanvasSize = {
  width: number;
  height: number;
};

type ResultCrop = NonNullable<PixelizeResult["crop"]>;
type SourceGridMapping = NonNullable<PixelizeResult["sourceGrid"]>;

type CanvasSnapshot = {
  image: ImageData;
  size: CanvasSize;
  crop: ResultCrop;
};

export type PixelEditorProps = {
  result: PixelizeResult;
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  palette: string[];
  onCancel: () => void;
  onApply: (next: PixelizeResult) => void;
};

const ZOOM_LEVELS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;
const WHEEL_ZOOM_THRESHOLD = 40;
const MAX_BULK_EDIT_PIXELS = 4_000_000;
const MAX_ORIGINAL_OVERLAY_PIXELS = 4_000_000;
const MAX_ORIGINAL_OVERLAY_DIMENSION = 16_384;

type ActivePointerInteraction =
  | { kind: "crop" }
  | {
      kind: "draw";
      tool: "pencil" | "eraser";
      color: string;
    };

type ZoomAnchor = {
  frameX: number;
  frameY: number;
  viewportX: number;
  viewportY: number;
};

function cropFromPoints(start: PixelPoint, end: PixelPoint): CropSelection {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x) + 1,
    height: Math.abs(end.y - start.y) + 1,
  };
}

function normalizeHexColor(color: string) {
  const trimmed = color.trim().toLowerCase();

  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (!/^#[0-9a-f]{3}$/.test(trimmed)) return null;

  return `#${trimmed
    .slice(1)
    .split("")
    .map((character) => character.repeat(2))
    .join("")}`;
}

function colorToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgba(color: string) {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    255,
  ] as const;
}

function floodFill(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  point: PixelPoint,
  color: string,
) {
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  const startPixel = point.y * width + point.x;
  const startOffset = startPixel * 4;
  const target = [
    pixels[startOffset],
    pixels[startOffset + 1],
    pixels[startOffset + 2],
    pixels[startOffset + 3],
  ] as const;
  const replacement = hexToRgba(color);

  if (target.every((channel, index) => channel === replacement[index])) {
    return 0;
  }

  const queue = new Uint32Array(width * height);
  let head = 0;
  let tail = 0;

  function matches(pixelIndex: number) {
    const offset = pixelIndex * 4;
    return (
      pixels[offset] === target[0] &&
      pixels[offset + 1] === target[1] &&
      pixels[offset + 2] === target[2] &&
      pixels[offset + 3] === target[3]
    );
  }

  function paintAndQueue(pixelIndex: number) {
    if (!matches(pixelIndex)) return;

    const offset = pixelIndex * 4;
    pixels[offset] = replacement[0];
    pixels[offset + 1] = replacement[1];
    pixels[offset + 2] = replacement[2];
    pixels[offset + 3] = replacement[3];
    queue[tail] = pixelIndex;
    tail += 1;
  }

  paintAndQueue(startPixel);

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    if (x > 0) paintAndQueue(pixelIndex - 1);
    if (x + 1 < width) paintAndQueue(pixelIndex + 1);
    if (y > 0) paintAndQueue(pixelIndex - width);
    if (y + 1 < height) paintAndQueue(pixelIndex + width);
  }

  context.putImageData(image, 0, 0);
  return tail;
}

type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

type WeightedRgbColor = RgbColor & {
  count: number;
  key: number;
};

function weightedColorDistanceSquared(
  first: RgbColor,
  second: RgbColor,
) {
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

function removeEdgeConnectedBackground(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  const borderPixels: number[] = [];
  let visiblePixels = 0;

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    if (pixels[pixelIndex * 4 + 3] >= 16) {
      visiblePixels += 1;
    }
  }

  if (visiblePixels === 0) {
    return { detected: true, removedPixels: 0, noOpaquePixels: true };
  }

  for (let x = 0; x < width; x += 1) {
    borderPixels.push(x, (height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    borderPixels.push(y * width, y * width + width - 1);
  }
  const hasVisibleBorder = borderPixels.some(
    (pixelIndex) => pixels[pixelIndex * 4 + 3] >= 16,
  );

  // Walk through transparent padding and model the first visible frontier.
  // This handles an inset opaque backdrop without mistaking the empty outer
  // ring for proof that no background remains.
  const transparentVisited = new Uint8Array(width * height);
  const frontierSeen = new Uint8Array(width * height);
  const transparentQueue = new Uint32Array(width * height);
  const frontierPixels: number[] = [];
  const samples: RgbColor[] = [];
  let transparentHead = 0;
  let transparentTail = 0;

  function visitExterior(pixelIndex: number) {
    const offset = pixelIndex * 4;

    if (pixels[offset + 3] < 16) {
      if (transparentVisited[pixelIndex]) return;
      transparentVisited[pixelIndex] = 1;
      transparentQueue[transparentTail] = pixelIndex;
      transparentTail += 1;
      return;
    }

    if (frontierSeen[pixelIndex]) return;
    frontierSeen[pixelIndex] = 1;
    frontierPixels.push(pixelIndex);
    samples.push({
      red: pixels[offset],
      green: pixels[offset + 1],
      blue: pixels[offset + 2],
    });
  }

  for (const pixelIndex of borderPixels) visitExterior(pixelIndex);

  while (transparentHead < transparentTail) {
    const pixelIndex = transparentQueue[transparentHead];
    transparentHead += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    if (x > 0) visitExterior(pixelIndex - 1);
    if (x + 1 < width) visitExterior(pixelIndex + 1);
    if (y > 0) visitExterior(pixelIndex - width);
    if (y + 1 < height) visitExterior(pixelIndex + width);
  }

  if (samples.length === 0) {
    return { detected: false, removedPixels: 0, noOpaquePixels: false };
  }

  if (!hasVisibleBorder) {
    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;

    for (const pixelIndex of frontierPixels) {
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }

    const spanX = Math.max(1, right - left + 1);
    const spanY = Math.max(1, bottom - top + 1);
    let horizontalEdges = 0;
    let verticalEdges = 0;

    for (const pixelIndex of frontierPixels) {
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (y === top || y === bottom) horizontalEdges += 1;
      if (x === left || x === right) verticalEdges += 1;
    }

    // A transparent canvas around a sprite is already background-free. Only
    // learn an inset background when the opaque frontier resembles a frame;
    // otherwise a uniform sprite outline could be erased by mistake.
    const frameCoverage = Math.min(
      horizontalEdges / (spanX * 2),
      verticalEdges / (spanY * 2),
    );
    const interiorCoverage = visiblePixels / (spanX * spanY);
    if (frameCoverage < 0.45 || interiorCoverage < 0.65) {
      return { detected: false, removedPixels: 0, noOpaquePixels: false };
    }
  }

  let model: ReturnType<typeof fitBorderModel> = null;

  for (let clusterCount = 1; clusterCount <= 4; clusterCount += 1) {
    const candidate = fitBorderModel(samples, clusterCount);
    if (!candidate) break;

    const usefulClusters =
      clusterCount === 1 ||
      candidate.clusterShares.every((share) => share >= 0.08);
    if (candidate.p95 <= 12 && usefulClusters) {
      model = candidate;
      break;
    }
  }

  if (!model) {
    return { detected: false, removedPixels: 0, noOpaquePixels: false };
  }

  const tolerance = Math.max(10, Math.min(24, model.p95 + 6));
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0;
  let tail = 0;
  let removedPixels = 0;

  function matchesBackground(pixelIndex: number) {
    const offset = pixelIndex * 4;
    if (pixels[offset + 3] < 16) return true;

    const color = {
      red: pixels[offset],
      green: pixels[offset + 1],
      blue: pixels[offset + 2],
    };
    return model!.centers.some(
      (center) =>
        Math.sqrt(weightedColorDistanceSquared(color, center)) <= tolerance,
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

  for (let pixelIndex = 0; pixelIndex < visited.length; pixelIndex += 1) {
    if (!visited[pixelIndex]) continue;
    const offset = pixelIndex * 4;
    if (pixels[offset + 3] > 0) removedPixels += 1;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = 0;
  }

  if (removedPixels > 0) context.putImageData(image, 0, 0);
  return { detected: true, removedPixels, noOpaquePixels: false };
}

function initialZoom(width: number, height: number) {
  const target = Math.max(1, Math.floor(520 / Math.max(width, height)));
  let selected: number = ZOOM_LEVELS[0];

  for (const level of ZOOM_LEVELS) {
    if (level > target) break;
    selected = level;
  }

  return selected;
}

function evenlyDividedRanges(length: number, count: number) {
  return Array.from({ length: count }, (_, index): [number, number] => [
    (index * length) / count,
    ((index + 1) * length) / count,
  ]);
}

function currentSourceRanges(
  mapping: SourceGridMapping | undefined,
  crop: ResultCrop,
  size: CanvasSize,
  sourceWidth: number,
  sourceHeight: number,
) {
  const fallbackX = evenlyDividedRanges(sourceWidth, crop.baseWidth);
  const fallbackY = evenlyDividedRanges(sourceHeight, crop.baseHeight);
  const fullX =
    mapping && mapping.xRanges.length >= crop.baseWidth
      ? mapping.xRanges
      : fallbackX;
  const fullY =
    mapping && mapping.yRanges.length >= crop.baseHeight
      ? mapping.yRanges
      : fallbackY;

  return {
    x: fullX.slice(crop.x, crop.x + size.width),
    y: fullY.slice(crop.y, crop.y + size.height),
  };
}

function renderOriginalOverlay(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  xRanges: Array<[number, number]>,
  yRanges: Array<[number, number]>,
  zoom: number,
) {
  if (xRanges.length === 0 || yRanges.length === 0) return;

  const renderScale = Math.max(
    Number.EPSILON,
    Math.min(
      zoom,
      Math.sqrt(
        MAX_ORIGINAL_OVERLAY_PIXELS /
          Math.max(1, xRanges.length * yRanges.length),
      ),
      MAX_ORIGINAL_OVERLAY_DIMENSION / xRanges.length,
      MAX_ORIGINAL_OVERLAY_DIMENSION / yRanges.length,
    ),
  );
  const targetWidth = Math.max(1, Math.floor(xRanges.length * renderScale));
  const targetHeight = Math.max(1, Math.floor(yRanges.length * renderScale));
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, targetWidth, targetHeight);
  context.imageSmoothingEnabled = false;

  const sourceLeft = xRanges[0][0];
  const sourceRight = xRanges[xRanges.length - 1][1];
  const sourceTop = yRanges[0][0];
  const sourceBottom = yRanges[yRanges.length - 1][1];
  const sourceSpanX = Math.max(1, sourceRight - sourceLeft);
  const sourceSpanY = Math.max(1, sourceBottom - sourceTop);
  const horizontalFirstPixels = targetWidth * sourceSpanY;
  const verticalFirstPixels = sourceSpanX * targetHeight;

  if (horizontalFirstPixels <= verticalFirstPixels) {
    const intermediate = document.createElement("canvas");
    intermediate.width = targetWidth;
    intermediate.height = Math.ceil(sourceSpanY);
    const intermediateContext = intermediate.getContext("2d");
    if (!intermediateContext) return;
    intermediateContext.imageSmoothingEnabled = false;

    for (let x = 0; x < xRanges.length; x += 1) {
      const [left, right] = xRanges[x];
      const destinationLeft = (x * targetWidth) / xRanges.length;
      const destinationRight = ((x + 1) * targetWidth) / xRanges.length;
      intermediateContext.drawImage(
        image,
        left,
        sourceTop,
        Math.max(1, right - left),
        sourceSpanY,
        destinationLeft,
        0,
        destinationRight - destinationLeft,
        intermediate.height,
      );
    }

    for (let y = 0; y < yRanges.length; y += 1) {
      const [top, bottom] = yRanges[y];
      const destinationTop = (y * targetHeight) / yRanges.length;
      const destinationBottom = ((y + 1) * targetHeight) / yRanges.length;
      const mappedTop =
        ((top - sourceTop) / sourceSpanY) * intermediate.height;
      const mappedHeight =
        ((bottom - top) / sourceSpanY) * intermediate.height;
      context.drawImage(
        intermediate,
        0,
        mappedTop,
        targetWidth,
        Math.max(1, mappedHeight),
        0,
        destinationTop,
        targetWidth,
        destinationBottom - destinationTop,
      );
    }
    return;
  }

  const intermediate = document.createElement("canvas");
  intermediate.width = Math.ceil(sourceSpanX);
  intermediate.height = targetHeight;
  const intermediateContext = intermediate.getContext("2d");
  if (!intermediateContext) return;
  intermediateContext.imageSmoothingEnabled = false;

  for (let y = 0; y < yRanges.length; y += 1) {
    const [top, bottom] = yRanges[y];
    const destinationTop = (y * targetHeight) / yRanges.length;
    const destinationBottom = ((y + 1) * targetHeight) / yRanges.length;
    intermediateContext.drawImage(
      image,
      sourceLeft,
      top,
      sourceSpanX,
      Math.max(1, bottom - top),
      0,
      destinationTop,
      intermediate.width,
      destinationBottom - destinationTop,
    );
  }

  for (let x = 0; x < xRanges.length; x += 1) {
    const [left, right] = xRanges[x];
    const destinationLeft = (x * targetWidth) / xRanges.length;
    const destinationRight = ((x + 1) * targetWidth) / xRanges.length;
    const mappedLeft =
      ((left - sourceLeft) / sourceSpanX) * intermediate.width;
    const mappedWidth =
      ((right - left) / sourceSpanX) * intermediate.width;
    context.drawImage(
      intermediate,
      mappedLeft,
      0,
      Math.max(1, mappedWidth),
      targetHeight,
      destinationLeft,
      0,
      destinationRight - destinationLeft,
      targetHeight,
    );
  }
}

function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("png-export-failed"));
      }
    }, "image/png");
  });
}

export function PixelEditor({
  result,
  sourceUrl,
  sourceWidth,
  sourceHeight,
  palette,
  onCancel,
  onApply,
}: PixelEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const originalOverlayRef = useRef<HTMLCanvasElement>(null);
  const originalImageRef = useRef<HTMLImageElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const activePointerRef = useRef<number | null>(null);
  const activeInteractionRef = useRef<ActivePointerInteraction | null>(null);
  const lastPointRef = useRef<PixelPoint | null>(null);
  const cropStartRef = useRef<PixelPoint | null>(null);
  const pendingCanvasImageRef = useRef<ImageData | null>(null);
  const bulkUndoRef = useRef<CanvasSnapshot | null>(null);
  const pendingZoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const wheelDeltaRef = useRef(0);
  const normalizedPalette = useMemo(
    () =>
      Array.from(
        new Set(
          palette
            .map(normalizeHexColor)
            .filter((color): color is string => color !== null),
        ),
      ),
    [palette],
  );
  const [tool, setTool] = useState<EditorTool>("pencil");
  const [selectedColor, setSelectedColor] = useState(
    () => normalizedPalette[0] ?? "#000000",
  );
  const [zoom, setZoom] = useState<number>(() =>
    initialZoom(result.width, result.height),
  );
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(() => ({
    width: result.width,
    height: result.height,
  }));
  const [resultCrop, setResultCrop] = useState<ResultCrop>(
    () =>
      result.crop ?? {
        x: 0,
        y: 0,
        width: result.width,
        height: result.height,
        baseWidth: result.width,
        baseHeight: result.height,
      },
  );
  const [cropSelection, setCropSelection] = useState<CropSelection | null>(
    null,
  );
  const [isReady, setIsReady] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [originalImageRevision, setOriginalImageRevision] = useState(0);
  const [canUndoBulkEdit, setCanUndoBulkEdit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isColorTool = tool === "pencil" || tool === "fill";
  const canvasDisplayWidth = canvasSize.width * zoom;
  const canvasDisplayHeight = canvasSize.height * zoom;
  const editorStatus =
    tool === "crop"
      ? cropSelection
        ? `CROP ${cropSelection.width} × ${cropSelection.height} AT ${cropSelection.x}, ${cropSelection.y} · ENTER TO APPLY`
        : "DRAG ON THE IMAGE TO SELECT A CROP"
      : notice;

  const canvasStyle = {
    "--pixel-editor-canvas-width": `${canvasDisplayWidth}px`,
    "--pixel-editor-canvas-height": `${canvasDisplayHeight}px`,
    "--pixel-editor-grid-size-x": `${zoom}px`,
    "--pixel-editor-grid-size-y": `${zoom}px`,
    "--pixel-editor-grid-opacity":
      !showOriginal && zoom >= 4 ? "0.55" : "0",
  } as CSSProperties;
  const cropSelectionStyle = cropSelection
    ? ({
        left: `${(cropSelection.x / canvasSize.width) * 100}%`,
        top: `${(cropSelection.y / canvasSize.height) * 100}%`,
        width: `${(cropSelection.width / canvasSize.width) * 100}%`,
        height: `${(cropSelection.height / canvasSize.height) * 100}%`,
      } as CSSProperties)
    : undefined;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    let isCurrent = true;
    const image = new Image();
    originalImageRef.current = null;

    image.onload = () => {
      if (!isCurrent) return;
      originalImageRef.current = image;
      setOriginalImageRevision((revision) => revision + 1);
    };
    image.src = sourceUrl;

    return () => {
      isCurrent = false;
      image.onload = null;
      if (originalImageRef.current === image) {
        originalImageRef.current = null;
      }
    };
  }, [sourceUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isCurrent = true;
    const imageUrl = URL.createObjectURL(result.blob);
    const image = new Image();
    setIsReady(false);
    setError(null);
    setNotice(null);
    bulkUndoRef.current = null;
    setCanUndoBulkEdit(false);

    image.onload = () => {
      if (!isCurrent) return;

      const context = canvas.getContext("2d");
      if (!context) {
        setError("The pixel editor could not start.");
        return;
      }

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setIsReady(true);
    };
    image.onerror = () => {
      if (isCurrent) {
        setError("The converted image could not be loaded.");
      }
    };
    image.src = imageUrl;

    return () => {
      isCurrent = false;
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(imageUrl);
    };
  }, [result]);

  useLayoutEffect(() => {
    const pendingImage = pendingCanvasImageRef.current;
    const canvas = canvasRef.current;
    if (!pendingImage || !canvas) return;

    const context = canvas.getContext("2d");
    if (!context) {
      setError("The resized image could not be restored.");
      return;
    }

    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.putImageData(pendingImage, 0, 0);
    pendingCanvasImageRef.current = null;
  }, [canvasSize.height, canvasSize.width]);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const scroller = canvasScrollRef.current;
    const frame = canvasFrameRef.current;
    if (!anchor || !scroller || !frame) return;

    const scrollerBounds = scroller.getBoundingClientRect();
    const frameBounds = frame.getBoundingClientRect();
    const nextViewportX =
      frameBounds.left -
      scrollerBounds.left +
      frameBounds.width * anchor.frameX;
    const nextViewportY =
      frameBounds.top -
      scrollerBounds.top +
      frameBounds.height * anchor.frameY;

    scroller.scrollLeft += nextViewportX - anchor.viewportX;
    scroller.scrollTop += nextViewportY - anchor.viewportY;
    pendingZoomAnchorRef.current = null;
  }, [canvasDisplayHeight, canvasDisplayWidth]);

  useLayoutEffect(() => {
    const overlay = originalOverlayRef.current;
    const original = originalImageRef.current;
    if (!showOriginal || !overlay || !original) return;

    const ranges = currentSourceRanges(
      result.sourceGrid,
      resultCrop,
      canvasSize,
      sourceWidth,
      sourceHeight,
    );
    renderOriginalOverlay(overlay, original, ranges.x, ranges.y, zoom);
  }, [
    canvasSize,
    originalImageRevision,
    result.sourceGrid,
    resultCrop,
    showOriginal,
    sourceHeight,
    sourceWidth,
    zoom,
  ]);

  useEffect(() => {
    const scroller = canvasScrollRef.current;
    if (!scroller) return;

    const onWheel = (event: WheelEvent) => handleCanvasWheel(event);
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [isApplying, isReady, zoom]);

  function getCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;

    return {
      x: Math.max(
        0,
        Math.min(
          canvas.width - 1,
          Math.floor(((event.clientX - bounds.left) / bounds.width) * canvas.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          canvas.height - 1,
          Math.floor(
            ((event.clientY - bounds.top) / bounds.height) * canvas.height,
          ),
        ),
      ),
    };
  }

  function drawPixel(
    point: PixelPoint,
    drawingTool: "pencil" | "eraser",
    color: string,
  ) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    if (drawingTool === "eraser") {
      context.clearRect(point.x, point.y, 1, 1);
      return;
    }

    context.fillStyle = color;
    context.fillRect(point.x, point.y, 1, 1);
  }

  function drawLine(
    from: PixelPoint,
    to: PixelPoint,
    drawingTool: "pencil" | "eraser",
    color: string,
  ) {
    let x = from.x;
    let y = from.y;
    const stepX = from.x < to.x ? 1 : -1;
    const stepY = from.y < to.y ? 1 : -1;
    const deltaX = Math.abs(to.x - from.x);
    const deltaY = -Math.abs(to.y - from.y);
    let lineError = deltaX + deltaY;

    while (true) {
      drawPixel({ x, y }, drawingTool, color);
      if (x === to.x && y === to.y) break;

      const doubledError = lineError * 2;
      if (doubledError >= deltaY) {
        lineError += deltaY;
        x += stepX;
      }
      if (doubledError <= deltaX) {
        lineError += deltaX;
        y += stepY;
      }
    }
  }

  function pickColor(point: PixelPoint) {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;

    const pixel = context.getImageData(point.x, point.y, 1, 1).data;
    if (pixel[3] === 0) {
      setTool("eraser");
      setCropSelection(null);
      return;
    }
    setSelectedColor(colorToHex(pixel[0], pixel[1], pixel[2]));
    setTool("pencil");
    setCropSelection(null);
  }

  function chooseColor(color: string) {
    cancelActivePointerInteraction();
    setSelectedColor(color);
    setTool((currentTool) =>
      currentTool === "fill" ? "fill" : "pencil",
    );
    setCropSelection(null);
  }

  function selectTool(nextTool: EditorTool) {
    cancelActivePointerInteraction();
    setTool(nextTool);
    if (nextTool !== "crop") {
      setCropSelection(null);
      cropStartRef.current = null;
    }
    if (nextTool === "crop") setNotice(null);
  }

  function cancelActivePointerInteraction() {
    const canvas = canvasRef.current;
    const pointerId = activePointerRef.current;

    if (canvas && pointerId !== null && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    activePointerRef.current = null;
    activeInteractionRef.current = null;
    lastPointRef.current = null;
    cropStartRef.current = null;
  }

  function clearBulkUndo() {
    bulkUndoRef.current = null;
    setCanUndoBulkEdit(false);
  }

  function storeBulkUndo(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
  ) {
    bulkUndoRef.current = {
      image: context.getImageData(0, 0, canvas.width, canvas.height),
      size: { width: canvas.width, height: canvas.height },
      crop: { ...resultCrop },
    };
    setCanUndoBulkEdit(true);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!isReady || isApplying || !event.isPrimary || event.button !== 0) {
      return;
    }

    const point = getCanvasPoint(event);
    if (!point) return;

    event.preventDefault();

    if (tool === "eyedropper") {
      pickColor(point);
      return;
    }

    if (tool === "crop") {
      cropStartRef.current = point;
      activePointerRef.current = event.pointerId;
      activeInteractionRef.current = { kind: "crop" };
      lastPointRef.current = point;
      setCropSelection(cropFromPoints(point, point));
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "fill") {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (canvas && context) {
        if (canvas.width * canvas.height > MAX_BULK_EDIT_PIXELS) {
          setNotice("FILL IS LIMITED TO 4 MEGAPIXELS");
          return;
        }

        const previousImage = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const filledPixels = floodFill(
          context,
          canvas.width,
          canvas.height,
          point,
          selectedColor,
        );
        if (filledPixels > 0) {
          bulkUndoRef.current = {
            image: previousImage,
            size: { width: canvas.width, height: canvas.height },
            crop: { ...resultCrop },
          };
          setCanUndoBulkEdit(true);
        }
        setNotice(
          filledPixels > 0
            ? `FILLED ${filledPixels.toLocaleString()} PIXELS`
            : "AREA ALREADY USES THAT COLOR",
        );
      }
      return;
    }

    clearBulkUndo();
    setNotice(null);
    activePointerRef.current = event.pointerId;
    const drawingTool = tool === "eraser" ? "eraser" : "pencil";
    activeInteractionRef.current = {
      kind: "draw",
      tool: drawingTool,
      color: selectedColor,
    };
    lastPointRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawPixel(point, drawingTool, selectedColor);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (
      activePointerRef.current !== event.pointerId ||
      !lastPointRef.current
    ) {
      return;
    }

    const point = getCanvasPoint(event);
    if (!point) return;

    event.preventDefault();

    const interaction = activeInteractionRef.current;
    if (!interaction) return;

    if (interaction.kind === "crop") {
      if (!cropStartRef.current) return;
      setCropSelection(cropFromPoints(cropStartRef.current, point));
      lastPointRef.current = point;
      return;
    }

    drawLine(
      lastPointRef.current,
      point,
      interaction.tool,
      interaction.color,
    );
    lastPointRef.current = point;
  }

  function finishPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (activePointerRef.current !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerRef.current = null;
    activeInteractionRef.current = null;
    lastPointRef.current = null;
    cropStartRef.current = null;
  }

  function rememberZoomAnchor(clientX?: number, clientY?: number) {
    const scroller = canvasScrollRef.current;
    const frame = canvasFrameRef.current;
    if (!scroller || !frame) return;

    const scrollerBounds = scroller.getBoundingClientRect();
    const frameBounds = frame.getBoundingClientRect();
    const anchorClientX =
      clientX ?? scrollerBounds.left + scroller.clientWidth / 2;
    const anchorClientY =
      clientY ?? scrollerBounds.top + scroller.clientHeight / 2;

    pendingZoomAnchorRef.current = {
      frameX: Math.max(
        0,
        Math.min(1, (anchorClientX - frameBounds.left) / frameBounds.width),
      ),
      frameY: Math.max(
        0,
        Math.min(1, (anchorClientY - frameBounds.top) / frameBounds.height),
      ),
      viewportX: anchorClientX - scrollerBounds.left,
      viewportY: anchorClientY - scrollerBounds.top,
    };
  }

  function getNextZoom(
    currentZoom: number,
    levels: readonly number[],
    direction: -1 | 1,
  ) {
    if (direction > 0) {
      return (
        levels.find((level) => level > currentZoom + Number.EPSILON) ??
        levels[levels.length - 1]
      );
    }

    return (
      [...levels]
        .reverse()
        .find((level) => level < currentZoom - Number.EPSILON) ?? levels[0]
    );
  }

  function changeZoom(
    direction: -1 | 1,
    clientX?: number,
    clientY?: number,
  ) {
    const nextZoom = getNextZoom(zoom, ZOOM_LEVELS, direction);
    if (nextZoom === zoom) return;

    rememberZoomAnchor(clientX, clientY);
    setZoom(nextZoom);
  }

  function handleCanvasWheel(event: WheelEvent) {
    event.preventDefault();
    if (!isReady || isApplying) return;

    const scroller = canvasScrollRef.current;
    if (!scroller) return;
    const deltaMultiplier =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? scroller.clientHeight
          : 1;
    wheelDeltaRef.current += event.deltaY * deltaMultiplier;

    if (Math.abs(wheelDeltaRef.current) < WHEEL_ZOOM_THRESHOLD) return;

    const direction: -1 | 1 = wheelDeltaRef.current < 0 ? 1 : -1;
    wheelDeltaRef.current = 0;
    changeZoom(direction, event.clientX, event.clientY);
  }

  function toggleOriginal() {
    wheelDeltaRef.current = 0;
    setShowOriginal((visible) => !visible);
  }

  function hideOriginal() {
    if (!showOriginal) return;
    setShowOriginal(false);
  }

  function centerNextCanvasLayout() {
    const scroller = canvasScrollRef.current;
    if (!scroller) return;

    pendingZoomAnchorRef.current = {
      frameX: 0.5,
      frameY: 0.5,
      viewportX: scroller.clientWidth / 2,
      viewportY: scroller.clientHeight / 2,
    };
  }

  function handleApplyCrop() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (
      !canvas ||
      !context ||
      !cropSelection ||
      !isReady ||
      isApplying
    ) {
      return;
    }

    const selection = {
      x: Math.max(0, Math.min(canvas.width - 1, cropSelection.x)),
      y: Math.max(0, Math.min(canvas.height - 1, cropSelection.y)),
      width: Math.max(
        1,
        Math.min(cropSelection.width, canvas.width - Math.max(0, cropSelection.x)),
      ),
      height: Math.max(
        1,
        Math.min(
          cropSelection.height,
          canvas.height - Math.max(0, cropSelection.y),
        ),
      ),
    };

    if (
      selection.x === 0 &&
      selection.y === 0 &&
      selection.width === canvas.width &&
      selection.height === canvas.height
    ) {
      setCropSelection(null);
      setTool("pencil");
      setNotice("CROP MATCHES THE CURRENT CANVAS");
      return;
    }

    if (selection.width * selection.height > MAX_BULK_EDIT_PIXELS) {
      setNotice("CROP SELECTION IS LIMITED TO 4 MEGAPIXELS");
      return;
    }

    const croppedImage = context.getImageData(
      selection.x,
      selection.y,
      selection.width,
      selection.height,
    );
    const canSnapshotSource =
      canvas.width * canvas.height <= MAX_BULK_EDIT_PIXELS;
    if (canSnapshotSource) {
      storeBulkUndo(context, canvas);
    } else {
      clearBulkUndo();
    }
    pendingCanvasImageRef.current = croppedImage;
    centerNextCanvasLayout();
    setCanvasSize({
      width: selection.width,
      height: selection.height,
    });
    setResultCrop((currentCrop) => ({
      x: currentCrop.x + selection.x,
      y: currentCrop.y + selection.y,
      width: selection.width,
      height: selection.height,
      baseWidth: currentCrop.baseWidth,
      baseHeight: currentCrop.baseHeight,
    }));
    setCropSelection(null);
    cropStartRef.current = null;
    activePointerRef.current = null;
    lastPointRef.current = null;
    setTool("pencil");
    setNotice(
      `CROPPED TO ${selection.width} × ${selection.height} PIXELS${
        canSnapshotSource ? "" : " · UNDO UNAVAILABLE FOR LARGE SOURCE"
      }`,
    );
  }

  async function handleApply() {
    const canvas = canvasRef.current;
    if (!canvas || !isReady || isApplying) return;

    setIsApplying(true);
    setError(null);
    let nextUrl: string | null = null;

    try {
      const blob = await canvasToPng(canvas);
      nextUrl = URL.createObjectURL(blob);
      const nextResult: PixelizeResult = {
        blob,
        url: nextUrl,
        width: canvas.width,
        height: canvas.height,
        crop: resultCrop,
        sourceGrid: result.sourceGrid,
      };
      onApply(nextResult);
      setIsApplying(false);
    } catch {
      if (nextUrl) URL.revokeObjectURL(nextUrl);
      setError("The edited image could not be exported.");
      setIsApplying(false);
    }
  }

  function handleRemoveBackground() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !isReady || isApplying) return;

    if (canvas.width * canvas.height > MAX_BULK_EDIT_PIXELS) {
      setNotice("BACKGROUND REMOVAL IS LIMITED TO 4 MEGAPIXELS");
      return;
    }

    const previousImage = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const removal = removeEdgeConnectedBackground(
      context,
      canvas.width,
      canvas.height,
    );

    if (removal.removedPixels > 0) {
      bulkUndoRef.current = {
        image: previousImage,
        size: { width: canvas.width, height: canvas.height },
        crop: { ...resultCrop },
      };
      setCanUndoBulkEdit(true);
      setNotice(
        `REMOVED ${removal.removedPixels.toLocaleString()} BACKGROUND PIXELS`,
      );
    } else {
      setNotice(
        removal.noOpaquePixels
          ? "NO OPAQUE BACKGROUND REMAINS"
          : removal.detected
            ? "NO MATCHING EDGE BACKGROUND FOUND"
            : "NO UNIFORM EDGE BACKGROUND FOUND",
      );
    }
    setCropSelection(null);
    hideOriginal();
  }

  function handleUndoBulkEdit() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const snapshot = bulkUndoRef.current;
    if (!canvas || !context || !snapshot || isApplying) return;

    if (
      canvas.width === snapshot.size.width &&
      canvas.height === snapshot.size.height
    ) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.putImageData(snapshot.image, 0, 0);
    } else {
      pendingCanvasImageRef.current = snapshot.image;
      centerNextCanvasLayout();
      setCanvasSize(snapshot.size);
    }

    setResultCrop(snapshot.crop);
    setCropSelection(null);
    setTool("pencil");
    clearBulkUndo();
    setNotice("LAST IMAGE ACTION UNDONE");
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !isApplying) {
      event.preventDefault();
      cancelActivePointerInteraction();
      if (cropSelection) {
        setCropSelection(null);
        return;
      }
      if (tool === "crop") {
        setTool("pencil");
        return;
      }
      onCancel();
      return;
    }

    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;

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

    if (
      event.target instanceof HTMLInputElement ||
      isApplying ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }

    if (
      event.key === "Enter" &&
      tool === "crop" &&
      cropSelection &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      handleApplyCrop();
    } else if (event.key.toLowerCase() === "p") {
      selectTool("pencil");
    } else if (event.key.toLowerCase() === "f") {
      selectTool("fill");
    } else if (event.key.toLowerCase() === "i") {
      selectTool("eyedropper");
    } else if (event.key.toLowerCase() === "e") {
      selectTool("eraser");
    } else if (event.key.toLowerCase() === "c") {
      selectTool("crop");
    } else if (event.key.toLowerCase() === "o" && !event.repeat) {
      event.preventDefault();
      toggleOriginal();
    } else if (event.key === "-" || event.key === "_") {
      changeZoom(-1);
    } else if (event.key === "+" || event.key === "=") {
      changeZoom(1);
    }
  }

  function handleBackdropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !isApplying) {
      onCancel();
    }
  }

  return (
    <div
      className="pixel-editor-backdrop"
      onPointerDown={handleBackdropPointerDown}
    >
      <div
        ref={dialogRef}
        className="pixel-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pixel-editor-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="pixel-editor-header">
          <div>
            <p className="pixel-editor-kicker">PIXEL EDITOR</p>
            <h2 id="pixel-editor-title">Fine-tune your pixels</h2>
          </div>
          <button
            className="pixel-editor-close"
            type="button"
            aria-label="Close pixel editor"
            onClick={onCancel}
            disabled={isApplying}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div
          className="pixel-editor-toolbar"
          role="toolbar"
          aria-label="Pixel editor controls"
        >
          <div
            className="pixel-editor-tool-group"
            role="group"
            aria-label="Drawing tools"
          >
            <button
              className="pixel-editor-tool"
              type="button"
              aria-label="Pencil"
              aria-keyshortcuts="P"
              aria-pressed={tool === "pencil"}
              onClick={() => selectTool("pencil")}
              disabled={!isReady || isApplying}
            >
              <Pencil aria-hidden="true" size={17} />
              <span>PENCIL</span>
            </button>
            <button
              className="pixel-editor-tool"
              type="button"
              aria-label="Fill"
              aria-keyshortcuts="F"
              aria-pressed={tool === "fill"}
              onClick={() => selectTool("fill")}
              disabled={!isReady || isApplying}
            >
              <PaintBucket aria-hidden="true" size={17} />
              <span>FILL</span>
            </button>
            <button
              className="pixel-editor-tool"
              type="button"
              aria-label="Eyedropper"
              aria-keyshortcuts="I"
              aria-pressed={tool === "eyedropper"}
              onClick={() => selectTool("eyedropper")}
              disabled={!isReady || isApplying}
            >
              <Pipette aria-hidden="true" size={17} />
              <span>PICK</span>
            </button>
            <button
              className="pixel-editor-tool"
              type="button"
              aria-label="Eraser"
              aria-keyshortcuts="E"
              aria-pressed={tool === "eraser"}
              onClick={() => selectTool("eraser")}
              disabled={!isReady || isApplying}
            >
              <Eraser aria-hidden="true" size={17} />
              <span>ERASE</span>
            </button>
            <button
              className="pixel-editor-tool"
              type="button"
              aria-label="Crop"
              aria-keyshortcuts="C"
              aria-pressed={tool === "crop"}
              onClick={() => selectTool("crop")}
              disabled={!isReady || isApplying}
            >
              <Crop aria-hidden="true" size={17} />
              <span>CROP</span>
            </button>
          </div>

          <div
            className="pixel-editor-reference-group"
            role="group"
            aria-label="Reference and image actions"
          >
            <button
              className="pixel-editor-reference-button"
              type="button"
              aria-label="Toggle original overlay"
              aria-keyshortcuts="O"
              aria-pressed={showOriginal}
              onClick={toggleOriginal}
              disabled={!isReady || isApplying}
            >
              <Eye aria-hidden="true" size={17} />
              <span>ORIGINAL</span>
              <kbd>O</kbd>
            </button>
            <button
              className="pixel-editor-background-button"
              type="button"
              aria-label="Remove edge-connected background"
              onClick={handleRemoveBackground}
              disabled={!isReady || isApplying}
            >
              <ImageOff aria-hidden="true" size={17} />
              <span>REMOVE BG</span>
            </button>
            <button
              className="pixel-editor-undo-button"
              type="button"
              aria-label="Undo last image action"
              onClick={handleUndoBulkEdit}
              disabled={!canUndoBulkEdit || isApplying}
            >
              <Undo2 aria-hidden="true" size={17} />
              <span>UNDO</span>
            </button>
          </div>

          <div
            className="pixel-editor-zoom-controls"
            role="group"
            aria-label="Canvas zoom"
          >
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => changeZoom(-1)}
              disabled={
                !isReady ||
                isApplying ||
                zoom === ZOOM_LEVELS[0]
              }
            >
              <ZoomOut aria-hidden="true" size={17} />
            </button>
            <output aria-live="polite">{zoom}×</output>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => changeZoom(1)}
              disabled={
                !isReady ||
                isApplying ||
                zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
              }
            >
              <ZoomIn aria-hidden="true" size={17} />
            </button>
          </div>
        </div>

        <div className="pixel-editor-workspace">
          <div
            ref={canvasScrollRef}
            className="pixel-editor-canvas-scroll"
          >
            <div className="pixel-editor-canvas-stage">
              <div
                ref={canvasFrameRef}
                className="pixel-editor-canvas-frame"
                style={canvasStyle}
              >
                <canvas
                  ref={canvasRef}
                  className="pixel-editor-canvas"
                  data-tool={tool}
                  width={canvasSize.width}
                  height={canvasSize.height}
                  aria-label="Editable pixel canvas"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishPointer}
                  onPointerCancel={finishPointer}
                />
                <canvas
                  aria-hidden="true"
                  className={`pixel-editor-original-overlay ${
                    showOriginal ? "is-visible" : ""
                  }`}
                  ref={originalOverlayRef}
                />
                {cropSelection && (
                  <div
                    className="pixel-editor-crop-selection"
                    style={cropSelectionStyle}
                    aria-hidden="true"
                  >
                    <span>
                      {cropSelection.width} × {cropSelection.height}
                    </span>
                  </div>
                )}
                {!isReady && !error && (
                  <p className="pixel-editor-loading" role="status">
                    Loading pixels…
                  </p>
                )}
              </div>
            </div>
          </div>

          <aside className="pixel-editor-palette" aria-label="Color palette">
            <div className="pixel-editor-palette-heading">
              <span>SOURCE PALETTE</span>
              <span>{normalizedPalette.length} COLORS</span>
            </div>

            <div className="pixel-editor-swatches">
              {normalizedPalette.map((color) => (
                <button
                  key={color}
                  className="pixel-editor-swatch"
                  type="button"
                  aria-label={`Use ${color}`}
                  aria-pressed={isColorTool && selectedColor === color}
                  onClick={() => chooseColor(color)}
                  disabled={!isReady || isApplying}
                >
                  <svg
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <rect width="20" height="20" fill={color} />
                  </svg>
                </button>
              ))}
            </div>

            <label className="pixel-editor-custom-color">
              <span>CUSTOM COLOR</span>
              <input
                type="color"
                value={selectedColor}
                aria-label="Choose a custom color"
                onChange={(event) => chooseColor(event.currentTarget.value)}
                disabled={!isReady || isApplying}
              />
              <output>{selectedColor.toUpperCase()}</output>
            </label>
          </aside>
        </div>

        {error && (
          <p className="pixel-editor-error" role="alert">
            {error}
          </p>
        )}

        <footer className="pixel-editor-footer">
          <div className="pixel-editor-footer-status">
            <span>
              {canvasSize.width} × {canvasSize.height} PX
            </span>
            {editorStatus && (
              <output aria-live="polite">{editorStatus}</output>
            )}
          </div>
          <div className="pixel-editor-actions">
            {tool === "crop" && cropSelection && (
              <>
                <button
                  className="pixel-editor-crop-clear"
                  type="button"
                  aria-label="Clear crop selection"
                  onClick={() => setCropSelection(null)}
                  disabled={isApplying}
                >
                  <X aria-hidden="true" size={15} />
                  CLEAR
                </button>
                <button
                  className="pixel-editor-crop-apply"
                  type="button"
                  aria-keyshortcuts="Enter"
                  onClick={handleApplyCrop}
                  disabled={isApplying}
                >
                  <Crop aria-hidden="true" size={15} />
                  CROP SELECTION
                </button>
              </>
            )}
            <button
              className="pixel-editor-cancel"
              type="button"
              onClick={onCancel}
              disabled={isApplying}
            >
              CANCEL
            </button>
            <button
              className="pixel-editor-apply"
              type="button"
              onClick={() => void handleApply()}
              disabled={!isReady || isApplying || cropSelection !== null}
              title={
                cropSelection
                  ? "Apply or clear the crop selection first"
                  : undefined
              }
            >
              <Check aria-hidden="true" size={17} />
              {isApplying ? "APPLYING…" : "APPLY CHANGES"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
