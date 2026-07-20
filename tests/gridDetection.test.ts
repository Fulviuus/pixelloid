import { describe, expect, it } from "vitest";
import {
  buildCellRanges,
  detectPixelGridData,
  getPixelGridDimensions,
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
});
