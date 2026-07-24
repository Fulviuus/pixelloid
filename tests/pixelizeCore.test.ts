import { describe, expect, it } from "vitest";
import { pixelizeBuffer } from "../src/lib/pixelizeCore";

function rgbaBuffer(width: number, height: number, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = fill;
    data[offset + 1] = fill;
    data[offset + 2] = fill;
    data[offset + 3] = 255;
  }

  return { width, height, data };
}

describe("pixelizeBuffer", () => {
  it("uses the source pixels unchanged for an exact 1:1 grid", () => {
    const source = rgbaBuffer(2, 2);
    source.data.set([
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 11, 12,
      13, 14, 15, 16,
    ]);

    const result = pixelizeBuffer(source, {
      pixelSize: 1,
      offsetX: 0,
      offsetY: 0,
    });

    expect(result.passthrough).toBe(true);
    expect(result.data).toBe(source.data);
    expect(result.xRanges).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(result.yRanges).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("returns exact source ranges for fractional edge fragments", () => {
    const result = pixelizeBuffer(rgbaBuffer(10, 6, 80), {
      pixelSize: 4,
      offsetX: 2,
      offsetY: 0,
      samplingMode: "medoid",
    });

    expect(result.xRanges).toEqual([
      [0, 2],
      [2, 6],
      [6, 10],
    ]);
    expect(result.yRanges).toEqual([
      [0, 4],
      [4, 6],
    ]);
    expect([result.width, result.height]).toEqual([3, 2]);
  });

  it("uses the exact center source pixel by default", () => {
    const source = rgbaBuffer(4, 4, 20);
    const centerOffset = (2 * source.width + 2) * 4;
    source.data.set([91, 37, 12, 177], centerOffset);

    const result = pixelizeBuffer(source, {
      pixelSize: 4,
      offsetX: 0,
      offsetY: 0,
    });

    expect([...result.data]).toEqual([91, 37, 12, 177]);
  });

  it("keeps the detected pitch instead of stretching it to the output size", () => {
    const source = rgbaBuffer(10, 1);
    for (let x = 0; x < source.width; x += 1) {
      const offset = x * 4;
      source.data[offset] = x;
      source.data[offset + 1] = x + 20;
      source.data[offset + 2] = x + 40;
    }

    const result = pixelizeBuffer(source, {
      pixelSize: 4,
      offsetX: 0,
      offsetY: 0,
    });

    expect(result.width).toBe(3);
    expect(result.xRanges).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect([...result.data]).toEqual([
      2, 22, 42, 255,
      6, 26, 46, 255,
      9, 29, 49, 255,
    ]);
  });

  it("matches conventional whole-canvas nearest-neighbor coordinates", () => {
    const source = rgbaBuffer(10, 1);
    for (let x = 0; x < source.width; x += 1) {
      const offset = x * 4;
      source.data.set([x, x + 20, x + 40, 255], offset);
    }

    const result = pixelizeBuffer(source, {
      pixelSize: 4,
      offsetX: 2,
      offsetY: 0,
      fitToCanvas: true,
    });

    expect(result.xRanges).toEqual([
      [0, 3],
      [3, 6],
      [6, 10],
    ]);
    expect([...result.data]).toEqual([
      1, 21, 41, 255,
      5, 25, 45, 255,
      8, 28, 48, 255,
    ]);
  });

  it("uses a robust observed-source medoid when requested", () => {
    const source = rgbaBuffer(7, 7);

    // Twenty-five dark samples and twenty-four bright outliers make the dark
    // source pixel the medoid; an average would instead be badly skewed.
    for (let pixel = 0; pixel < 49; pixel += 1) {
      const offset = pixel * 4;
      const value = pixel < 25 ? 40 : 240;
      source.data[offset] = value;
      source.data[offset + 1] = value + 1;
      source.data[offset + 2] = value + 2;
      source.data[offset + 3] = pixel < 25 ? 200 : 255;
    }

    const result = pixelizeBuffer(source, {
      pixelSize: 7,
      offsetX: 0,
      offsetY: 0,
      samplingMode: "medoid",
    });

    expect([...result.data]).toEqual([40, 41, 42, 200]);
  });

  it("never synthesizes a color from independent channels in medoid mode", () => {
    const source = rgbaBuffer(3, 1);
    source.data.set([
      0, 255, 255, 255,
      255, 0, 255, 255,
      255, 255, 0, 255,
    ]);

    const result = pixelizeBuffer(source, {
      pixelSize: 3,
      offsetX: 0,
      offsetY: 0,
      samplingMode: "medoid",
    });

    // Independent channel medians would invent white (255, 255, 255).
    expect([...result.data]).toEqual([0, 255, 255, 255]);
  });
});
