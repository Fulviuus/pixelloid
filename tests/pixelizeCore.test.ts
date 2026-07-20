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

  it("uses the robust upper median of the reusable 7x7 sample", () => {
    const source = rgbaBuffer(7, 7);

    // Twenty-five dark samples and twenty-four bright outliers make the upper
    // median exactly 40; an average would instead be badly skewed.
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
    });

    expect([...result.data]).toEqual([40, 41, 42, 200]);
  });
});
