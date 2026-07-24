import { describe, expect, it } from "vitest";
import {
  collapseMagicFixResult,
  prepareMagicFixEdit,
  prepareMagicFixOriginalReference,
  type RgbaImageData,
} from "../src/features/magic-fix";

function image(
  width: number,
  height: number,
  pixels: Array<readonly [number, number, number, number]>,
): RgbaImageData {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < width * height; index += 1) {
    data.set(pixels[index] ?? [0, 0, 0, 0], index * 4);
  }

  return { width, height, data };
}

function solid(
  width: number,
  height: number,
  color: readonly [number, number, number, number],
) {
  return image(
    width,
    height,
    Array.from({ length: width * height }, () => color),
  );
}

function pixelAt(source: RgbaImageData, x: number, y: number) {
  const offset = (y * source.width + x) * 4;
  return [...source.data.slice(offset, offset + 4)];
}

describe("prepareMagicFixEdit", () => {
  it("nearest-neighbour upscales and centers the edit in a model canvas", () => {
    const current = image(2, 1, [
      [255, 0, 0, 255],
      [0, 0, 255, 128],
    ]);

    const prepared = prepareMagicFixEdit(current, {
      width: 8,
      height: 8,
      dimensionMultiple: 4,
    });

    expect(prepared.transform).toMatchObject({
      logicalWidth: 2,
      logicalHeight: 1,
      modelWidth: 8,
      modelHeight: 8,
      contentX: 0,
      contentY: 2,
      contentWidth: 8,
      contentHeight: 4,
      scaleX: 4,
      scaleY: 4,
    });
    expect(pixelAt(prepared.image, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(prepared.image, 0, 2)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(prepared.image, 3, 5)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(prepared.image, 4, 2)).toEqual([0, 0, 255, 128]);
    expect(pixelAt(prepared.image, 7, 5)).toEqual([0, 0, 255, 128]);
    expect(pixelAt(prepared.image, 2, 7)).toEqual([0, 0, 0, 0]);
  });

  it("enforces the provider dimension multiple and prevents implicit shrinkage", () => {
    expect(() =>
      prepareMagicFixEdit(solid(2, 2, [0, 0, 0, 255]), {
        width: 7,
        height: 8,
        dimensionMultiple: 4,
      }),
    ).toThrow(/multiples of 4/);

    expect(() =>
      prepareMagicFixEdit(solid(9, 2, [0, 0, 0, 255]), {
        width: 8,
        height: 8,
      }),
    ).toThrow(/smaller than the logical edit/);
  });
});

describe("prepareMagicFixOriginalReference", () => {
  it("aligns variable source grid ranges and an editor crop to logical cells", () => {
    const original = image(
      8,
      1,
      Array.from(
        { length: 8 },
        (_, red) => [red, 0, 0, 255] as const,
      ),
    );
    const current = solid(2, 1, [0, 0, 0, 255]);
    const { transform } = prepareMagicFixEdit(current, {
      width: 8,
      height: 4,
    });
    const aligned = prepareMagicFixOriginalReference(original, transform, {
      sourceGrid: {
        xRanges: [
          [0, 2],
          [2, 5],
          [5, 8],
        ],
        yRanges: [[0, 1]],
      },
      resultCrop: {
        x: 1,
        y: 0,
        width: 2,
        height: 1,
        baseWidth: 3,
        baseHeight: 1,
      },
    });

    expect(
      Array.from({ length: 8 }, (_, x) => pixelAt(aligned, x, 0)[0]),
    ).toEqual([2, 3, 3, 4, 5, 6, 6, 7]);
  });

  it("falls back to evenly divided source ranges when grid metadata is absent", () => {
    const original = image(4, 1, [
      [10, 0, 0, 255],
      [20, 0, 0, 255],
      [30, 0, 0, 255],
      [40, 0, 0, 255],
    ]);
    const { transform } = prepareMagicFixEdit(
      solid(2, 1, [0, 0, 0, 255]),
      { width: 4, height: 2 },
    );
    const aligned = prepareMagicFixOriginalReference(original, transform);

    expect(
      Array.from({ length: 4 }, (_, x) => pixelAt(aligned, x, 0)[0]),
    ).toEqual([10, 20, 30, 40]);
  });
});

describe("collapseMagicFixResult", () => {
  it("uses a robust generated medoid and locks the current alpha value", () => {
    const generated = solid(7, 7, [240, 241, 242, 255]);

    for (let pixel = 0; pixel < 25; pixel += 1) {
      generated.data.set([40, 41, 42, 255], pixel * 4);
    }

    const current = solid(1, 1, [4, 5, 6, 137]);
    const { transform } = prepareMagicFixEdit(current, {
      width: 7,
      height: 7,
    });
    const result = collapseMagicFixResult(
      generated,
      current,
      transform,
    );

    expect([...result.data]).toEqual([40, 41, 42, 137]);
  });

  it("preserves the exact alpha mask and ignores generated transparency", () => {
    const current = image(2, 1, [
      [90, 80, 70, 0],
      [12, 34, 56, 128],
    ]);
    const { transform } = prepareMagicFixEdit(current, {
      width: 8,
      height: 4,
    });
    const generated = image(
      8,
      4,
      Array.from({ length: 32 }, (_, index) =>
        index % 2 === 0
          ? ([250, 10, 10, 0] as const)
          : ([10, 240, 10, 0] as const),
      ),
    );
    const result = collapseMagicFixResult(
      generated,
      current,
      transform,
    );

    expect(pixelAt(result, 0, 0)).toEqual([0, 0, 0, 0]);
    // With no visible generated sample, the current color is the safe fallback.
    expect(pixelAt(result, 1, 0)).toEqual([12, 34, 56, 128]);
  });

  it("undoes model-input flattening before restoring semi-transparent alpha", () => {
    const current = solid(1, 1, [255, 0, 0, 128]);
    const { transform } = prepareMagicFixEdit(current, {
      width: 4,
      height: 4,
    });
    const generated = solid(4, 4, [191, 63, 63, 255]);
    const result = collapseMagicFixResult(
      generated,
      current,
      transform,
      { flattenedBackground: [127, 127, 127] },
    );

    expect([...result.data]).toEqual([255, 0, 0, 128]);
  });

  it("optionally maps generated colors to custom and current colors", () => {
    const current = image(2, 1, [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const { transform } = prepareMagicFixEdit(current, {
      width: 8,
      height: 4,
    });
    const generated = image(
      8,
      4,
      Array.from({ length: 32 }, (_, index) =>
        index % 8 < 4
          ? ([245, 8, 8, 255] as const)
          : ([5, 245, 5, 255] as const),
      ),
    );
    const result = collapseMagicFixResult(
      generated,
      current,
      transform,
      {
        palette: {
          colors: ["#00ff00"],
          includeCurrentColors: true,
        },
      },
    );

    expect(pixelAt(result, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(result, 1, 0)).toEqual([0, 255, 0, 255]);
  });

  it("normalizes a generated raster whose dimensions differ from the model canvas", () => {
    const current = solid(1, 1, [0, 0, 0, 255]);
    const { transform } = prepareMagicFixEdit(current, {
      width: 8,
      height: 8,
    });
    const generated = solid(4, 4, [22, 44, 66, 255]);
    const result = collapseMagicFixResult(
      generated,
      current,
      transform,
    );

    expect([...result.data]).toEqual([22, 44, 66, 255]);
  });
});
