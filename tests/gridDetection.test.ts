import { describe, expect, it } from "vitest";
import {
  alignPixelGridPhaseData,
  analyzePixelGridData,
  buildCellRanges,
  detectPixelGridData,
  getPixelGridDimensions,
  suggestPixelGridData,
  type PixelBuffer,
} from "../src/lib/gridDetection";

type GridFixtureOptions = {
  width: number;
  height: number;
  pitch: number;
  pitchY?: number;
  offsetX?: number;
  offsetY?: number;
  sprite?: { left: number; top: number; columns: number; rows: number };
  transparentBackground?: boolean;
  seed?: number;
};

function hashCell(x: number, y: number, seed: number) {
  let value = (x * 0x1f123bb5) ^ (y * 0x5f356495) ^ seed;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function cellColor(x: number, y: number, seed: number) {
  const hash = hashCell(x, y, seed);
  return [
    24 + (hash & 0xb7),
    24 + ((hash >>> 8) & 0xb7),
    24 + ((hash >>> 16) & 0xb7),
    255,
  ] as const;
}

function createGridFixture({
  width,
  height,
  pitch,
  pitchY,
  offsetX = 0,
  offsetY = 0,
  sprite,
  transparentBackground = false,
  seed = 0x51f15e,
}: GridFixtureOptions): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  const verticalPitch = pitchY ?? pitch;
  const spriteLeft = sprite?.left ?? 0;
  const spriteTop = sprite?.top ?? 0;
  const spriteRight = sprite
    ? sprite.left + sprite.columns * pitch
    : width;
  const spriteBottom = sprite
    ? sprite.top + sprite.rows * verticalPitch
    : height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const inSprite =
        x >= spriteLeft &&
        x < spriteRight &&
        y >= spriteTop &&
        y < spriteBottom;

      if (!inSprite) {
        const channel = transparentBackground ? 0 : 255;
        data[index] = channel;
        data[index + 1] = channel;
        data[index + 2] = channel;
        data[index + 3] = transparentBackground ? 0 : 255;
        continue;
      }

      const cellX = Math.floor((x - offsetX) / pitch);
      const cellY = Math.floor((y - offsetY) / verticalPitch);
      const [red, green, blue, alpha] = cellColor(cellX, cellY, seed);
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = alpha;
    }
  }

  return { width, height, data };
}

function createConflictingCanvasPhaseFixture(): PixelBuffer {
  const width = 250;
  const height = 250;
  const pitch = 8;
  const spriteLeft = 61;
  const spriteTop = 61;
  const spriteRight = spriteLeft + 16 * pitch;
  const spriteBottom = spriteTop + 16 * pitch;
  const image = createGridFixture({
    width,
    height,
    pitch,
    offsetX: spriteLeft,
    offsetY: spriteTop,
    sprite: {
      left: spriteLeft,
      top: spriteTop,
      columns: 16,
      rows: 16,
    },
  });

  // The pale checker is a plausible generated-image background with a phase
  // of zero. It must not replace the sprite's own phase of 61 % 8 = 5.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (
        x >= spriteLeft &&
        x < spriteRight &&
        y >= spriteTop &&
        y < spriteBottom
      ) {
        continue;
      }

      const index = (y * width + x) * 4;
      const checkerIsDark =
        (Math.floor(x / pitch) + Math.floor(y / pitch)) % 2 === 0;
      const channel = checkerIsDark ? 235 : 255;
      image.data[index] = channel;
      image.data[index + 1] = channel;
      image.data[index + 2] = channel;
      image.data[index + 3] = checkerIsDark ? 245 : 255;
    }
  }

  return image;
}

function createGradientFixture(
  width: number,
  height: number,
  kind: "diagonal" | "radial",
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const maximumRadius = Math.hypot(centerX, centerY);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const amount =
        kind === "diagonal"
          ? (x + y) / (width + height - 2)
          : Math.hypot(x - centerX, y - centerY) / maximumRadius;
      data[index] = Math.round(20 + amount * 210);
      data[index + 1] = Math.round(35 + amount * 170);
      data[index + 2] = Math.round(80 + amount * 130);
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function createStripeFixture(width: number, height: number, pitch: number) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const light = Math.floor(x / pitch) % 2 === 0;
      const channel = light ? 225 : 35;
      data[index] = channel;
      data[index + 1] = light ? 210 : 55;
      data[index + 2] = light ? 185 : 75;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

/**
 * Every cell is still independently observable, but every second boundary is
 * deliberately stronger. Real sprites commonly have subtle shading between
 * adjacent source pixels and a high-contrast outline every few pixels; that
 * must not make an integer harmonic become the reported source-pixel size.
 */
function createUnevenBoundaryGridFixture(
  width: number,
  height: number,
  pitch: number,
) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.floor(x / pitch);
      const cellY = Math.floor(y / pitch);
      const groupIsLight =
        (Math.floor(cellX / 2) + Math.floor(cellY / 2)) % 2 === 1;
      const withinGroup = (cellX % 2) + (cellY % 2);
      const channel = groupIsLight
        ? 230 - withinGroup * 24
        : 20 + withinGroup * 24;
      const index = (y * width + x) * 4;

      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function createSmoothPeriodicFixture(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const channel = Math.round(
        128 + 100 * Math.sin(x * 0.23) * Math.sin(y * 0.23),
      );
      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

/** A continuous tone with subtle 8x8 codec-style block offsets, not pixels. */
function createCodecBlockingFixture(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const blockX = Math.floor(x / 8);
      const blockY = Math.floor(y / 8);
      const blockBias = ((blockX * 37 + blockY * 61) % 17) - 8;
      const channel = Math.round(
        30 +
          (180 * (x + y)) / Math.max(1, width + height - 2) +
          blockBias * 0.5,
      );
      const index = (y * width + x) * 4;
      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function createBlurredGridFixture(
  width: number,
  height: number,
  pitch: number,
  radius = 2,
) {
  const source = createGridFixture({ width, height, pitch });
  const data = new Uint8ClampedArray(source.data.length);
  const diameter = radius * 2 + 1;
  const sampleCount = diameter * diameter;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
          const sample = (sampleY * width + sampleX) * 4;
          red += source.data[sample];
          green += source.data[sample + 1];
          blue += source.data[sample + 2];
        }
      }

      data[target] = Math.round(red / sampleCount);
      data[target + 1] = Math.round(green / sampleCount);
      data[target + 2] = Math.round(blue / sampleCount);
      data[target + 3] = 255;
    }
  }

  return { width, height, data };
}

function createStructuredMonochromeGridFixture(
  width: number,
  height: number,
  pitch: number,
) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.floor(x / pitch);
      const cellY = Math.floor(y / pitch);
      const channel = 20 + ((cellX * 7 + cellY * 31) % 220);
      const index = (y * width + x) * 4;
      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function createStructuredSpriteFixture({
  width,
  height,
  pitch,
  left,
  top,
  cells,
  transparent,
}: {
  width: number;
  height: number;
  pitch: number;
  left: number;
  top: number;
  cells: number;
  transparent: boolean;
}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const right = left + cells * pitch;
  const bottom = top + cells * pitch;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (x < left || x >= right || y < top || y >= bottom) {
        data[index] = transparent ? 0 : 255;
        data[index + 1] = transparent ? 0 : 255;
        data[index + 2] = transparent ? 0 : 255;
        data[index + 3] = transparent ? 0 : 255;
        continue;
      }

      const cellX = Math.floor((x - left) / pitch);
      const cellY = Math.floor((y - top) / pitch);
      const channel = 20 + ((cellX * 7 + cellY * 31) % 220);
      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function createAlternatingBoundaryFixture(
  width: number,
  height: number,
  pitch: number,
  weakDelta: number,
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const cellY = Math.floor(y / pitch) % 4;

    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const cellX = Math.floor(x / pitch) % 4;
      // Every other boundary changes only blue. The alternating boundary also
      // changes a high-weight channel, creating an exact 2x harmonic that is
      // much stronger without erasing the true intervening grid boundary.
      data[index] = cellX >= 2 ? 255 : 0;
      data[index + 1] = cellY >= 2 ? 255 : 0;
      data[index + 2] = ((cellX % 2) + (cellY % 2)) * weakDelta;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

/**
 * A locally warped, lightly textured 4px grid. It retains the short plateaus
 * and staircase gaps of generated pseudo-pixel art while deliberately losing
 * the globally repeatable phase required by the strict detector.
 */
function createPseudoPixelFixture(
  width = 512,
  height = 512,
  pitch = 4,
  translationX = 0,
  translationY = 0,
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  const artWidth = Math.min(Math.round(width * 0.375), width);
  const artHeight = Math.min(Math.round(height * 0.25), height);
  const artLeft = Math.min(
    Math.round((width * 91) / 512) + translationX,
    Math.max(0, width - artWidth),
  );
  const artTop = Math.min(
    Math.round((height * 73) / 512) + translationY,
    Math.max(0, height - artHeight),
  );
  const pseudoHash = (x: number, y: number) => {
    let value = (x * 0x1f123bb5) ^ (y * 0x5f356495) ^ 0xabc123;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return (value ^ (value >>> 16)) >>> 0;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const localX = x - artLeft;
      const localY = y - artTop;

      if (
        localX < 0 ||
        localX >= artWidth ||
        localY < 0 ||
        localY >= artHeight
      ) {
        data[index] = 220;
        data[index + 1] = 220;
        data[index + 2] = 220;
        data[index + 3] = 255;
        continue;
      }

      const shiftX =
        (pseudoHash(Math.floor(localX / 32), Math.floor(localY / 12)) % 3) -
        1;
      const shiftY =
        (pseudoHash(Math.floor(localX / 12), Math.floor(localY / 32)) % 3) -
        1;
      const cellX = Math.floor((localX + shiftX) / pitch);
      const cellY = Math.floor((localY + shiftY) / pitch);
      const hash = pseudoHash(cellX, cellY);
      const texture = (pseudoHash(localX, localY) % 3) - 1;

      data[index] = 32 + (hash & 0x9f) + texture;
      data[index + 1] = 32 + ((hash >>> 8) & 0x9f) + texture;
      data[index + 2] = 32 + ((hash >>> 16) & 0x9f) + texture;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function changeCanvasSize(image: PixelBuffer, edgeChange: number): PixelBuffer {
  const width = image.width + edgeChange;
  const height = image.height + edgeChange;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < data.length; index += 4) {
    data[index] = 220;
    data[index + 1] = 220;
    data[index + 2] = 220;
    data[index + 3] = 255;
  }

  const copiedWidth = Math.min(width, image.width);
  const copiedHeight = Math.min(height, image.height);
  for (let row = 0; row < copiedHeight; row += 1) {
    const sourceStart = row * image.width * 4;
    data.set(
      image.data.subarray(sourceStart, sourceStart + copiedWidth * 4),
      row * width * 4,
    );
  }

  return { width, height, data };
}

function createPhotoLikeFixture(width: number, height: number): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const grain = (hashCell(x, y, 0x735a2d) % 31) - 15;
      const wave =
        Math.sin(x * 0.071 + y * 0.023) * 28 +
        Math.cos(y * 0.057 - x * 0.019) * 22;

      data[index] = Math.max(0, Math.min(255, 118 + wave + grain));
      data[index + 1] = Math.max(
        0,
        Math.min(255, 102 + wave * 0.7 - grain),
      );
      data[index + 2] = Math.max(
        0,
        Math.min(255, 136 - wave * 0.45 + grain * 0.6),
      );
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () =>
    ((state =
      (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) /
      0x1_0000_0000);
}

function createDrawingCanvas(width = 512, height = 512): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 250;
    data[index + 1] = 250;
    data[index + 2] = 250;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

function drawRectangle(
  image: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(image.width - 1, Math.floor(x1));
  const bottom = Math.min(image.height - 1, Math.floor(y1));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = (y * image.width + x) * 4;
      image.data[index] = 20;
      image.data[index + 1] = 20;
      image.data[index + 2] = 20;
    }
  }
}

function createRandomLineArt(seed = 47) {
  const image = createDrawingCanvas();
  const random = seededRandom(seed);

  for (let index = 0; index < 70; index += 1) {
    const x = 5 + Math.floor(random() * 475);
    const y = 5 + Math.floor(random() * 475);
    const length = 20 + Math.floor(random() * 100);
    if (index % 2 === 1) {
      drawRectangle(image, x, y, x + length, y + 3);
    } else {
      drawRectangle(image, x, y, x + 3, y + length);
    }
  }

  return image;
}

function createIrregularBars(seed = 47) {
  const image = createDrawingCanvas();
  const random = seededRandom(seed);
  const sizes = [2, 4, 6];

  for (let y = 0; y < image.height; y += 13) {
    for (let x = 0; x < image.width; x += 11) {
      if (random() >= 0.45) continue;
      const width = sizes[Math.floor(random() * sizes.length)];
      const height = sizes[Math.floor(random() * sizes.length)];
      drawRectangle(image, x, y, x + width, y + height);
    }
  }

  return image;
}

function createDenseMonospaceText() {
  const image = createDrawingCanvas();
  const random = seededRandom(47);

  // Deterministic 5x7 bitmap glyphs reproduce the dense, axis-aligned stroke
  // topology of a 14–16px monospace text page without relying on host fonts.
  for (let top = 4; top + 14 < image.height; top += 19) {
    for (let left = 4; left + 10 < image.width; left += 10) {
      const glyph = Math.floor(random() * 0x7fffffff);
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          const bit = (glyph >>> ((row * 5 + column) % 30)) & 1;
          if (bit === 0) continue;
          drawRectangle(
            image,
            left + column * 2,
            top + row * 2,
            left + column * 2 + 1,
            top + row * 2 + 1,
          );
        }
      }
    }
  }

  return image;
}

function expectPitch(
  image: PixelBuffer,
  expected: number,
  tolerance = 0.16,
  sourceWidth = image.width,
  sourceHeight = image.height,
) {
  const detection = detectPixelGridData(image, sourceWidth, sourceHeight);
  expect(Math.abs(detection.pixelSize - expected)).toBeLessThanOrEqual(
    tolerance,
  );
  expect(detection.confidence).toBeGreaterThan(20);
  return detection;
}

describe("pixel-grid detector regressions", () => {
  it("keeps an 8px shifted sprite grid on a white 250px canvas", () => {
    const image = createGridFixture({
      width: 250,
      height: 250,
      pitch: 8,
      offsetX: 61,
      offsetY: 61,
      sprite: { left: 61, top: 61, columns: 16, rows: 16 },
    });
    const detection = expectPitch(image, 8, 0.08);

    expect(detection.offsetX).toBeCloseTo(5, 0);
    expect(detection.offsetY).toBeCloseTo(5, 0);
  });

  it("keeps foreground phase when a pale canvas checker has another phase", () => {
    const detection = expectPitch(
      createConflictingCanvasPhaseFixture(),
      8,
      0.08,
    );

    expect(detection.offsetX).toBeCloseTo(5, 0);
    expect(detection.offsetY).toBeCloseTo(5, 0);
  });

  it("realigns a known pitch to transparent foreground after cleanup", () => {
    const image = createGridFixture({
      width: 250,
      height: 250,
      pitch: 8,
      offsetX: 61,
      offsetY: 61,
      sprite: { left: 61, top: 61, columns: 16, rows: 16 },
      transparentBackground: true,
    });

    expect(alignPixelGridPhaseData(image, 8)).toMatchObject({
      pixelSize: 8,
      offsetX: 5,
      offsetY: 5,
    });
  });

  it("balances an irregular transparent foreground across logical samples", () => {
    const image = {
      width: 60,
      height: 75,
      data: new Uint8ClampedArray(60 * 75 * 4),
    };

    for (let y = 8; y <= 61; y += 1) {
      for (let x = 12; x <= 34; x += 1) {
        const offset = (y * image.width + x) * 4;
        image.data.set([220, 140, 40, 255], offset);
      }
    }

    expect(alignPixelGridPhaseData(image, 15)).toEqual({
      pixelSize: 15,
      offsetX: 8,
      offsetY: 4,
    });
  });

  it("refines a full-bleed 1000/96 fractional pitch", () => {
    const pitch = 1000 / 96;
    const detection = expectPitch(
      createGridFixture({ width: 1000, height: 1000, pitch }),
      pitch,
      0.06,
    );
    expect(
      getPixelGridDimensions(1000, 1000, {
        pixelSize: detection.pixelSize,
        offsetX: detection.offsetX,
        offsetY: detection.offsetY,
      }),
    ).toEqual({ width: 96, height: 96 });

    const xRanges = buildCellRanges(
      1000,
      detection.pixelSize,
      detection.offsetX,
    );
    expect(detection.offsetX).toBe(0);
    expect(xRanges[0][0]).toBe(0);
    expect(xRanges.at(-1)?.[1]).toBe(1000);
  });

  it("refines a fractional grid on a transparent canvas", () => {
    const pitch = 500 / 48;
    const detection = expectPitch(
      createGridFixture({
        width: 640,
        height: 640,
        pitch,
        offsetX: 37,
        offsetY: 47,
        sprite: { left: 37, top: 47, columns: 48, rows: 48 },
        transparentBackground: true,
      }),
      pitch,
      0.08,
    );
    expect(detection.offsetX).toBeCloseTo(37 % pitch, 0);
    expect(detection.offsetY).toBeCloseTo(47 % pitch, 0);
  });

  it("searches the full cell-count uncertainty window", () => {
    const pitch = 1200 / 113;
    expectPitch(
      createGridFixture({ width: 1200, height: 1200, pitch }),
      pitch,
      0.06,
    );
  });

  it("selects the 12.5px fundamental instead of its exact 25px harmonic", () => {
    expectPitch(
      createGridFixture({ width: 500, height: 500, pitch: 12.5 }),
      12.5,
      0.06,
    );
  });

  it("keeps the fundamental when alternate boundaries are lower contrast", () => {
    expectPitch(createUnevenBoundaryGridFixture(512, 512, 8), 8, 0.08);
  });

  it.each([
    { pitch: 12.5, size: 256 },
    { pitch: 20, size: 400 },
  ])(
    "does not select a divisor for $pitch px structured monochrome cells",
    ({ pitch, size }) => {
      expectPitch(
        createStructuredMonochromeGridFixture(size, size, pitch),
        pitch,
        0.08,
      );
    },
  );

  it.each([
    {
      label: "white",
      width: 400,
      height: 400,
      pitch: 12.5,
      left: 57,
      top: 43,
      cells: 20,
      transparent: false,
    },
    {
      label: "transparent",
      width: 400,
      height: 400,
      pitch: 12.5,
      left: 57,
      top: 43,
      cells: 20,
      transparent: true,
    },
    {
      label: "transparent 20px",
      width: 640,
      height: 640,
      pitch: 20,
      left: 53,
      top: 47,
      cells: 20,
      transparent: true,
    },
  ])(
    "does not select a divisor for a $label structured sprite",
    (fixture) => {
      expectPitch(
        createStructuredSpriteFixture(fixture),
        fixture.pitch,
        0.1,
      );
    },
  );

  it("keeps a zero grid phase when analysis pixels are half source scale", () => {
    const detection = expectPitch(
      createGridFixture({ width: 1024, height: 1024, pitch: 10 }),
      20,
      0.05,
      2048,
      2048,
    );

    expect(detection.offsetX).toBe(0);
    expect(detection.offsetY).toBe(0);
  });

  it.each([2000, 4096])(
    "returns exactly 1px after failed detection at %ipx source size",
    (sourceSize) => {
      const analysis = createGradientFixture(512, 512, "diagonal");
      const detection = detectPixelGridData(
        analysis,
        sourceSize,
        sourceSize,
      );
      expect(detection).toEqual({
        pixelSize: 1,
        confidence: 0,
        offsetX: 0,
        offsetY: 0,
      });
    },
  );

  it("retains a 3px grid at 2048px instead of locking to 6px", () => {
    expectPitch(
      createGridFixture({ width: 2048, height: 2048, pitch: 3 }),
      3,
      0.05,
    );
  });

  it("does not halve a supported fractional grid just above 3px", () => {
    expectPitch(
      createGridFixture({ width: 512, height: 512, pitch: 3.01 }),
      3.01,
      0.05,
    );
  });

  it.each([1.75, 2.05])(
    "fails safely when a %spx analysis grid is below reliable resolution",
    (pitch) => {
      expect(
        detectPixelGridData(
          createGridFixture({ width: 512, height: 512, pitch }),
        ),
      ).toEqual({
        pixelSize: 1,
        confidence: 0,
        offsetX: 0,
        offsetY: 0,
      });
    },
  );

  it.each([3.05, 3.33])(
    "refines a supported fractional grid near the analysis limit (%spx)",
    (pitch) => {
      expectPitch(
        createGridFixture({ width: 512, height: 512, pitch }),
        pitch,
        0.05,
      );
    },
  );

  it("preserves an exact 20px grid at 2000px", () => {
    expectPitch(
      createGridFixture({ width: 2000, height: 2000, pitch: 20 }),
      20,
      0.05,
    );
  });

  it.each([
    { analysisSize: 2048, sourceSize: 4096, analysisPitch: 10 },
    { analysisSize: 1024, sourceSize: 4096, analysisPitch: 5 },
  ])(
    "keeps phase zero after $analysisSize px analysis is mapped to a $sourceSize px source",
    ({ analysisSize, sourceSize, analysisPitch }) => {
      const detection = expectPitch(
        createGridFixture({
          width: analysisSize,
          height: analysisSize,
          pitch: analysisPitch,
        }),
        20,
        0.05,
        sourceSize,
        sourceSize,
      );

      expect(detection.offsetX).toBe(0);
      expect(detection.offsetY).toBe(0);
    },
  );

  it.each([
    { pitch: 8, weakDelta: 48, size: 512 },
    { pitch: 12.5, weakDelta: 96, size: 500 },
  ])(
    "keeps the $pitch px fundamental when alternating boundaries differ by $weakDelta",
    ({ pitch, weakDelta, size }) => {
      const detection = expectPitch(
        createAlternatingBoundaryFixture(size, size, pitch, weakDelta),
        pitch,
        0.08,
      );

      expect(detection.confidence).toBeLessThan(100);
    },
  );

  it.each(["diagonal", "radial"] as const)(
    "rejects a smooth %s gradient",
    (kind) => {
      const detection = detectPixelGridData(
        createGradientFixture(512, 512, kind),
      );
      expect(detection.pixelSize).toBe(1);
      expect(detection.confidence).toBe(0);
    },
  );

  it("rejects a smooth periodic two-axis gradient", () => {
    const detection = detectPixelGridData(
      createSmoothPeriodicFixture(256, 256),
    );
    expect(detection.pixelSize).toBe(1);
    expect(detection.confidence).toBe(0);
  });

  it("rejects codec blocking on an otherwise continuous gradient", () => {
    const detection = detectPixelGridData(createCodecBlockingFixture(256, 256));
    expect(detection.pixelSize).toBe(1);
    expect(detection.confidence).toBe(0);
  });

  it.each([
    { pitch: 8, size: 256 },
    { pitch: 12.5, size: 400 },
    { pitch: 20, size: 400 },
  ])(
    "retains a $pitch px grid through a five-pixel antialias transition",
    ({ pitch, size }) => {
      expectPitch(createBlurredGridFixture(size, size, pitch), pitch, 0.1);
    },
  );

  it("rejects one-axis stripes", () => {
    const detection = detectPixelGridData(createStripeFixture(512, 512, 8));
    expect(detection.pixelSize).toBe(1);
    expect(detection.confidence).toBe(0);
  });

  it("uses per-axis evidence for a 1024x64 banner", () => {
    expectPitch(
      createGridFixture({ width: 1024, height: 64, pitch: 20 }),
      20,
      0.08,
    );
  });

  it("preserves square source pixels in a downscaled odd-height banner", () => {
    const sourceWidth = 4096;
    const sourceHeight = 65;
    const analysisWidth = 2048;
    const analysisHeight = 33;
    const sourcePitch = 20;
    const detection = expectPitch(
      createGridFixture({
        width: analysisWidth,
        height: analysisHeight,
        pitch: sourcePitch * (analysisWidth / sourceWidth),
        pitchY: sourcePitch * (analysisHeight / sourceHeight),
      }),
      sourcePitch,
      0.08,
      sourceWidth,
      sourceHeight,
    );

    expect(
      getPixelGridDimensions(sourceWidth, sourceHeight, detection),
    ).toEqual({ width: 205, height: 3 });
  });

  it("preserves the 1254-to-80 grid used by the real source fixture", () => {
    const pitch = 1254 / 80;
    const detection = expectPitch(
      createGridFixture({ width: 1254, height: 1254, pitch }),
      pitch,
      0.06,
    );
    expect(
      getPixelGridDimensions(1254, 1254, {
        pixelSize: detection.pixelSize,
        offsetX: detection.offsetX,
        offsetY: detection.offsetY,
      }),
    ).toEqual({ width: 80, height: 80 });
  });

  it("keeps the secondary suggestion advisory when strict detection succeeds", () => {
    const image = createGridFixture({ width: 512, height: 512, pitch: 8 });

    expect(suggestPixelGridData(image)).toBeNull();
    expect(analyzePixelGridData(image)).toEqual({
      detection: detectPixelGridData(image),
      suggestion: null,
    });
  });

  it.each([3, 4, 5, 6, 7, 8])(
    "suggests a low-confidence %ipx edit for locally warped pseudo-pixels",
    (pitch) => {
      const image = createPseudoPixelFixture(512, 512, pitch);

      expect(detectPixelGridData(image)).toEqual({
        pixelSize: 1,
        confidence: 0,
        offsetX: 0,
        offsetY: 0,
      });
      const suggestion = suggestPixelGridData(image);
      expect(suggestion?.pixelSize).toBe(pitch);
      expect(suggestion?.confidence).toBeGreaterThan(0);
      expect(suggestion?.confidence).toBeLessThanOrEqual(35);
    },
  );

  it("combines strict failure and advisory analysis without changing either result", () => {
    const image = createPseudoPixelFixture();

    expect(analyzePixelGridData(image)).toEqual({
      detection: {
        pixelSize: 1,
        confidence: 0,
        offsetX: 0,
        offsetY: 0,
      },
      suggestion: suggestPixelGridData(image),
    });
  });

  it.each([-3, -1, 0, 1, 3])(
    "keeps the 4px suggestion after a %ipx source-edge change",
    (edgeChange) => {
      const image = createPseudoPixelFixture();
      const suggestion = suggestPixelGridData(
        image,
        image.width + edgeChange,
        image.height + edgeChange,
      );

      expect(suggestion?.pixelSize).toBe(4);
    },
  );

  it("phase-balances high-resolution translation, crop, and padding samples", () => {
    const base = createPseudoPixelFixture(1600, 1600, 4);
    const variants = [
      createPseudoPixelFixture(1600, 1600, 4, 3, 3),
      changeCanvasSize(base, -3),
      changeCanvasSize(base, 3),
    ];

    for (const image of variants) {
      expect(suggestPixelGridData(image)?.pixelSize).toBe(4);
    }
  });

  it.each([
    {
      label: "diagonal gradient",
      image: createGradientFixture(512, 512, "diagonal"),
    },
    {
      label: "radial gradient",
      image: createGradientFixture(512, 512, "radial"),
    },
    {
      label: "smooth periodic tone",
      image: createSmoothPeriodicFixture(512, 512),
    },
    {
      label: "codec seams",
      image: createCodecBlockingFixture(512, 512),
    },
    {
      label: "one-axis stripes",
      image: createStripeFixture(512, 512, 4),
    },
    {
      label: "photo-like texture",
      image: createPhotoLikeFixture(512, 512),
    },
  ])("returns no advisory suggestion for $label", ({ image }) => {
    expect(suggestPixelGridData(image)).toBeNull();
  });

  it("withholds advisory guesses for compressed photo thumbnails", () => {
    expect(
      suggestPixelGridData(createPhotoLikeFixture(356, 356)),
    ).toBeNull();
  });

  it.each([
    { label: "dense monospace text", image: createDenseMonospaceText() },
    { label: "irregular 2D bars", image: createIrregularBars() },
    { label: "axis-aligned floorplan lines", image: createRandomLineArt() },
  ])("rejects structured non-pixel-art: $label", ({ image }) => {
    expect(detectPixelGridData(image)).toEqual({
      pixelSize: 1,
      confidence: 0,
      offsetX: 0,
      offsetY: 0,
    });
    expect(suggestPixelGridData(image)).toBeNull();
  });
});
