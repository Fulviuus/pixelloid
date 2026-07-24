import type { PixelBuffer } from "./gridDetection";

type PixelRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ActiveRectangle = PixelRectangle & {
  colorKey: number;
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colorKey(data: Uint8ClampedArray, offset: number) {
  return (
    data[offset] * 0x1000000 +
    data[offset + 1] * 0x10000 +
    data[offset + 2] * 0x100 +
    data[offset + 3]
  );
}

function keyToColor(key: number) {
  const red = Math.floor(key / 0x1000000) & 0xff;
  const green = Math.floor(key / 0x10000) & 0xff;
  const blue = Math.floor(key / 0x100) & 0xff;
  const alpha = key & 0xff;

  return {
    fill: `#${red.toString(16).padStart(2, "0")}${green
      .toString(16)
      .padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`,
    alpha,
  };
}

function collectRectangles(source: PixelBuffer) {
  const rectangles = new Map<number, PixelRectangle[]>();
  let active = new Map<string, ActiveRectangle>();

  const finish = (rectangle: ActiveRectangle) => {
    const colorRectangles = rectangles.get(rectangle.colorKey) ?? [];
    colorRectangles.push({
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
    });
    rectangles.set(rectangle.colorKey, colorRectangles);
  };

  for (let y = 0; y < source.height; y += 1) {
    const next = new Map<string, ActiveRectangle>();
    let x = 0;

    while (x < source.width) {
      const offset = (y * source.width + x) * 4;
      if (source.data[offset + 3] === 0) {
        x += 1;
        continue;
      }

      const runColor = colorKey(source.data, offset);
      const runStart = x;
      x += 1;
      while (x < source.width) {
        const nextOffset = (y * source.width + x) * 4;
        if (
          source.data[nextOffset + 3] === 0 ||
          colorKey(source.data, nextOffset) !== runColor
        ) {
          break;
        }
        x += 1;
      }

      const width = x - runStart;
      const runKey = `${runColor}:${runStart}:${width}`;
      const previous = active.get(runKey);
      next.set(
        runKey,
        previous
          ? { ...previous, height: previous.height + 1 }
          : {
              colorKey: runColor,
              x: runStart,
              y,
              width,
              height: 1,
            },
      );
    }

    for (const [runKey, rectangle] of active) {
      if (!next.has(runKey)) finish(rectangle);
    }
    active = next;
  }

  for (const rectangle of active.values()) finish(rectangle);
  return rectangles;
}

/**
 * Convert true-resolution pixels into real SVG paths. Consecutive equal-color
 * pixels are merged into rectangles, then rectangles of one color share a
 * single path. No raster image is embedded and no colors are approximated.
 */
export function pixelBufferToSvg(
  source: PixelBuffer,
  title = "Pixelloid vector export",
) {
  if (source.width < 1 || source.height < 1) {
    throw new RangeError("The vector source has invalid dimensions.");
  }
  if (source.data.length < source.width * source.height * 4) {
    throw new RangeError("The vector source pixel buffer is incomplete.");
  }

  const paths = [...collectRectangles(source)]
    .map(([key, rectangles]) => {
      const color = keyToColor(key);
      const path = rectangles
        .map(
          ({ x, y, width, height }) =>
            `M${x} ${y}h${width}v${height}h-${width}Z`,
        )
        .join("");
      const opacity =
        color.alpha < 255
          ? ` fill-opacity="${(color.alpha / 255).toFixed(3)}"`
          : "";
      return `  <path fill="${color.fill}"${opacity} d="${path}"/>`;
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}" viewBox="0 0 ${source.width} ${source.height}" shape-rendering="crispEdges">`,
    `  <title>${escapeXml(title)}</title>`,
    paths,
    "</svg>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function decodeBlob(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable for vector export.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export async function pixelBlobToSvg(blob: Blob, title?: string) {
  return pixelBufferToSvg(await decodeBlob(blob), title);
}
