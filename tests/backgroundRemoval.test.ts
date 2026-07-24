import { describe, expect, it } from "vitest";
import { removeEdgeConnectedBackground } from "../src/lib/backgroundRemoval";
import type { PixelBuffer } from "../src/lib/gridDetection";

type RgbaColor = readonly [number, number, number, number];

function image(
  width: number,
  height: number,
  color: RgbaColor,
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set(color, offset);
  }
  return { width, height, data };
}

function paint(
  target: PixelBuffer,
  left: number,
  top: number,
  width: number,
  height: number,
  color: RgbaColor,
) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      target.data.set(color, (y * target.width + x) * 4);
    }
  }
}

function colorAt(target: PixelBuffer, x: number, y: number) {
  const offset = (y * target.width + x) * 4;
  return [...target.data.slice(offset, offset + 4)];
}

describe("removeEdgeConnectedBackground", () => {
  it("removes a flat exterior while preserving enclosed matching colors", () => {
    const white: RgbaColor = [246, 244, 239, 255];
    const black: RgbaColor = [18, 20, 23, 255];
    const source = image(9, 9, white);

    paint(source, 2, 2, 5, 1, black);
    paint(source, 2, 6, 5, 1, black);
    paint(source, 2, 3, 1, 3, black);
    paint(source, 6, 3, 1, 3, black);

    const result = removeEdgeConnectedBackground(source);

    expect(result.image).toBe(source);
    expect(result).toMatchObject({
      detected: true,
      removedPixels: 56,
      noOpaquePixels: false,
    });
    expect(colorAt(source, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(colorAt(source, 2, 2)).toEqual(black);
    expect(colorAt(source, 4, 4)).toEqual(white);
  });

  it("does not treat an already-transparent sprite as its own background", () => {
    const transparent: RgbaColor = [0, 0, 0, 0];
    const green: RgbaColor = [52, 210, 104, 255];
    const source = image(9, 9, transparent);
    paint(source, 2, 4, 5, 1, green);
    paint(source, 4, 2, 1, 5, green);
    const before = [...source.data];

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    });
    expect([...source.data]).toEqual(before);
  });

  it("removes a compact multicolor checkerboard background", () => {
    const first: RgbaColor = [238, 238, 238, 255];
    const second: RgbaColor = [255, 255, 255, 255];
    const foreground: RgbaColor = [221, 42, 72, 255];
    const source = image(8, 8, first);

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        source.data.set(
          (x + y) % 2 === 0 ? first : second,
          (y * source.width + x) * 4,
        );
      }
    }
    paint(source, 3, 3, 2, 2, foreground);

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: true,
      removedPixels: 60,
      noOpaquePixels: false,
    });
    expect(colorAt(source, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(colorAt(source, 7, 7)).toEqual([0, 0, 0, 0]);
    expect(colorAt(source, 3, 3)).toEqual(foreground);
  });

  it("rejects a highly nonuniform border that could be artwork", () => {
    const source = image(9, 9, [38, 42, 51, 255]);
    const borderColors: RgbaColor[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
      [0, 255, 255, 255],
      [255, 0, 255, 255],
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ];
    let borderIndex = 0;

    for (let x = 0; x < source.width; x += 1) {
      source.data.set(
        borderColors[borderIndex++ % borderColors.length],
        x * 4,
      );
    }
    for (let y = 1; y < source.height; y += 1) {
      source.data.set(
        borderColors[borderIndex++ % borderColors.length],
        (y * source.width + source.width - 1) * 4,
      );
    }
    for (let x = source.width - 2; x >= 0; x -= 1) {
      source.data.set(
        borderColors[borderIndex++ % borderColors.length],
        ((source.height - 1) * source.width + x) * 4,
      );
    }
    for (let y = source.height - 2; y > 0; y -= 1) {
      source.data.set(
        borderColors[borderIndex++ % borderColors.length],
        y * source.width * 4,
      );
    }
    const before = [...source.data];

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    });
    expect([...source.data]).toEqual(before);
  });

  it("walks transparent padding to remove a frame-like inset background", () => {
    const transparent: RgbaColor = [0, 0, 0, 0];
    const white: RgbaColor = [250, 249, 246, 255];
    const red: RgbaColor = [194, 37, 45, 255];
    const source = image(11, 11, transparent);
    paint(source, 2, 2, 7, 7, white);
    paint(source, 4, 4, 3, 3, red);

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: true,
      removedPixels: 40,
      noOpaquePixels: false,
    });
    expect(colorAt(source, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(colorAt(source, 5, 5)).toEqual(red);
  });

  it("reports an empty transparent image without changing hidden RGB", () => {
    const source = image(4, 3, [17, 29, 43, 0]);
    const before = [...source.data];

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: true,
      removedPixels: 0,
      noOpaquePixels: true,
    });
    expect([...source.data]).toEqual(before);
  });

  it("rejects a solid opaque image instead of erasing every pixel", () => {
    const source = image(12, 10, [231, 228, 218, 255]);
    const before = [...source.data];

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    });
    expect([...source.data]).toEqual(before);
  });

  it("rejects a solid inset rectangle instead of returning an empty source", () => {
    const source = image(12, 12, [0, 0, 0, 0]);
    paint(source, 2, 2, 8, 8, [241, 238, 229, 255]);
    const before = [...source.data];

    const result = removeEdgeConnectedBackground(source);

    expect(result).toMatchObject({
      detected: false,
      removedPixels: 0,
      noOpaquePixels: false,
    });
    expect([...source.data]).toEqual(before);
  });
});
