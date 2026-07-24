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

  it("matches FFmpeg/libswscale whole-canvas point coordinates", () => {
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
      4, 24, 44, 255,
      8, 28, 48, 255,
    ]);
  });

  it("fits a transparent foreground without changing the logical canvas", () => {
    const source = rgbaBuffer(10, 10);
    source.data.fill(0);

    for (let y = 2; y < 8; y += 1) {
      for (let x = 2; x < 8; x += 1) {
        const offset = (y * source.width + x) * 4;
        source.data.set([x, y, x + y, 255], offset);
      }
    }

    const result = pixelizeBuffer(source, {
      pixelSize: 2,
      offsetX: 0,
      offsetY: 0,
      fitForeground: true,
    });

    expect([result.width, result.height]).toEqual([5, 5]);
    expect([...result.data.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([
      ...result.data.slice((1 * result.width + 1) * 4, (1 * result.width + 1) * 4 + 4),
    ]).toEqual([3, 3, 6, 255]);
    expect([
      ...result.data.slice((3 * result.width + 3) * 4, (3 * result.width + 3) * 4 + 4),
    ]).toEqual([7, 7, 14, 255]);
    expect([
      ...result.data.slice((4 * result.width + 4) * 4, (4 * result.width + 4) * 4 + 4),
    ]).toEqual([0, 0, 0, 0]);
  });

  it("removes isolated light-neutral fringe without deleting interior highlights", () => {
    const source = rgbaBuffer(10, 10);
    source.data.fill(0);

    for (let y = 2; y < 8; y += 1) {
      for (let x = 2; x < 8; x += 1) {
        source.data.set(
          [32, 34, 33, 255],
          (y * source.width + x) * 4,
        );
      }
    }
    source.data.set([224, 223, 225, 255], (5 * source.width + 7) * 4);
    source.data.set([230, 229, 231, 255], (5 * source.width + 5) * 4);

    const result = pixelizeBuffer(source, {
      pixelSize: 2,
      offsetX: 0,
      offsetY: 0,
      fitForeground: true,
    });
    const edgeOffset = (2 * result.width + 3) * 4;
    const interiorOffset = (2 * result.width + 2) * 4;

    expect([...result.data.slice(edgeOffset, edgeOffset + 4)]).toEqual([
      0, 0, 0, 0,
    ]);
    expect([
      ...result.data.slice(interiorOffset, interiorOffset + 4),
    ]).toEqual([230, 229, 231, 255]);
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

  it("keeps the selected grid dimensions and phase in smart mode", () => {
    const source = rgbaBuffer(10, 10, 80);

    const result = pixelizeBuffer(source, {
      pixelSize: 3,
      offsetX: 1,
      offsetY: 2,
      samplingMode: "smart",
    });

    expect(result.width).toBe(3);
    expect(result.height).toBe(3);
    expect(result.xRanges).toEqual([
      [1, 4],
      [4, 7],
      [7, 10],
    ]);
    expect(result.yRanges).toEqual([
      [2, 5],
      [5, 8],
      [8, 10],
    ]);
  });

  it("rejects a bright center outlier in smart mode", () => {
    const source = rgbaBuffer(8, 8);

    for (let y = 1; y < 7; y += 1) {
      for (let x = 1; x < 7; x += 1) {
        const offset = (y * source.width + x) * 4;
        const variation = (x + y) % 3;
        source.data.set(
          [120 + variation, 62 + variation, 31 + variation, 255],
          offset,
        );
      }
    }
    source.data.set([255, 250, 240, 255], (4 * source.width + 4) * 4);

    const result = pixelizeBuffer(source, {
      pixelSize: 8,
      offsetX: 0,
      offsetY: 0,
      samplingMode: "smart",
    });

    expect([...result.data]).toEqual([121, 63, 32, 255]);
  });

  it("binarizes alpha only when the source contains transparency", () => {
    const transparent = rgbaBuffer(4, 4, 40);
    for (let offset = 3; offset < transparent.data.length; offset += 4) {
      transparent.data[offset] = 100;
    }
    const transparentResult = pixelizeBuffer(transparent, {
      pixelSize: 2,
      offsetX: 0,
      offsetY: 0,
      samplingMode: "smart",
    });

    expect([...transparentResult.data]).toEqual(
      new Array(transparentResult.width * transparentResult.height * 4).fill(0),
    );

    const opaque = rgbaBuffer(4, 4, 40);
    const opaqueResult = pixelizeBuffer(opaque, {
      pixelSize: 2,
      offsetX: 0,
      offsetY: 0,
      samplingMode: "smart",
    });
    expect(opaqueResult.data[3]).toBe(255);
  });

});
