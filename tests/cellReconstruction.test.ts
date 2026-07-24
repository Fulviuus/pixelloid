import { describe, expect, it } from "vitest";
import {
  MAX_RECONSTRUCTION_CELLS,
  reconstructSourceCells,
  type RgbaColor,
} from "../src/lib/cellReconstruction";
import type { PixelBuffer } from "../src/lib/gridDetection";

function image(
  width: number,
  height: number,
  color: RgbaColor = [0, 0, 0, 255],
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

describe("reconstructSourceCells", () => {
  it("discards a one-pixel fringe in favor of the coherent cell core", () => {
    const fringe: RgbaColor = [241, 33, 199, 255];
    const core: RgbaColor = [22, 48, 71, 255];
    const source = image(7, 7, fringe);
    paint(source, 1, 1, 5, 5, core);

    const result = reconstructSourceCells(source, [[0, 7]], [[0, 7]]);

    expect([...result.data]).toEqual(core);
    expect(result.decisions[0].sourceColor).toEqual(core);
  });

  it("keeps a coherent centered minority detail", () => {
    const background: RgbaColor = [222, 218, 204, 255];
    const detail: RgbaColor = [28, 35, 44, 255];
    const source = image(7, 7, background);
    paint(source, 2, 2, 3, 3, detail);

    const result = reconstructSourceCells(source, [[0, 7]], [[0, 7]]);
    const current = image(1, 1, [1, 2, 3, 255]);
    const resultWithCurrent = reconstructSourceCells(
      source,
      [[0, 7]],
      [[0, 7]],
      { current },
    );

    expect([...result.data]).toEqual(detail);
    expect(result.decisions[0].reason).toBe("centered-local-detail");
    expect([...resultWithCurrent.data]).toEqual(detail);
    expect(resultWithCurrent.decisions[0].reason).toBe(
      "centered-local-detail",
    );
  });

  it("always represents a local decision with an actual source sample", () => {
    const colors: RgbaColor[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [250, 240, 10, 255],
    ];
    const source = image(4, 4);
    for (let pixel = 0; pixel < 16; pixel += 1) {
      source.data.set(colors[pixel % colors.length], pixel * 4);
    }

    const result = reconstructSourceCells(source, [[0, 4]], [[0, 4]]);
    const sourceSamples = new Set(
      Array.from({ length: 16 }, (_, pixel) =>
        [...source.data.slice(pixel * 4, pixel * 4 + 4)].join(","),
      ),
    );

    expect(sourceSamples.has([...result.data].join(","))).toBe(true);
    expect(sourceSamples.has(result.decisions[0].sourceColor!.join(","))).toBe(
      true,
    );
  });

  it("chooses RGBA modes coherently instead of combining color and alpha", () => {
    const hiddenTransparent: RgbaColor = [9, 230, 173, 0];
    const opaqueDetail: RgbaColor = [190, 42, 33, 255];
    const source = image(7, 7, hiddenTransparent);
    paint(source, 2, 2, 3, 3, opaqueDetail);

    const result = reconstructSourceCells(source, [[0, 7]], [[0, 7]]);
    const localSamples = new Set([
      hiddenTransparent.join(","),
      opaqueDetail.join(","),
    ]);

    expect(localSamples.has([...result.data].join(","))).toBe(true);
    expect([0, 255]).toContain(result.data[3]);
  });

  it("preserves hidden RGB and reports no repair beneath zero current alpha", () => {
    const source = image(3, 3, [0, 0, 0, 0]);
    paint(source, 1, 1, 1, 1, [255, 0, 0, 255]);
    const current = image(1, 1, [7, 8, 9, 0]);

    const result = reconstructSourceCells(source, [[0, 3]], [[0, 3]], {
      current,
    });

    expect([...result.data]).toEqual([7, 8, 9, 0]);
    expect(result.decisions[0].reason).toBe("kept-current-transparent");
  });

  it("uses only a local candidate when weak-boundary neighbor evidence resolves a tie", () => {
    const red: RgbaColor = [220, 35, 42, 255];
    const blue: RgbaColor = [28, 57, 220, 255];
    const source = image(8, 4, red);
    // The second cell is an even, spatially ambiguous split. Its entire shared
    // boundary is red, and red remains a candidate inside the cell.
    paint(source, 5, 0, 3, 2, blue);
    paint(source, 7, 2, 1, 1, blue);
    paint(source, 5, 3, 1, 1, blue);

    const result = reconstructSourceCells(
      source,
      [
        [0, 4],
        [4, 8],
      ],
      [[0, 4]],
    );

    expect(colorAt(result, 0, 0)).toEqual(red);
    expect(colorAt(result, 1, 0)).toEqual(red);
    expect(result.decisions[1].refinedByNeighbors).toBe(true);
    expect(result.decisions[1].reason).toBe("neighbor-consensus");
  });

  it("does not smooth an ambiguous cell across a strongly contrasting boundary", () => {
    const red: RgbaColor = [220, 35, 42, 255];
    const blue: RgbaColor = [28, 57, 220, 255];
    const source = image(10, 4, red);
    // Blue touches the shared boundary, so the neighboring red cell must not
    // override the target's locally selected blue candidate.
    paint(source, 4, 0, 4, 4, blue);

    const result = reconstructSourceCells(
      source,
      [
        [0, 4],
        [4, 10],
      ],
      [[0, 4]],
    );

    expect(colorAt(result, 1, 0)).toEqual(blue);
    expect(result.decisions[1].refinedByNeighbors).toBe(false);
  });

  it("locks current alpha, protected RGBA, crop alignment, and optional palette mapping", () => {
    const source = image(6, 2, [180, 20, 20, 255]);
    paint(source, 4, 0, 2, 2, [20, 40, 190, 255]);
    const current = image(2, 1, [1, 2, 3, 91]);
    current.data.set([7, 8, 9, 133], 4);
    const protectedMask = new Uint8Array([0, 1]);

    const result = reconstructSourceCells(
      source,
      [
        [0, 2],
        [2, 4],
        [4, 6],
      ],
      [[0, 2]],
      {
        crop: { x: 1, y: 0, width: 2, height: 1 },
        current,
        protectedMask,
        palette: ["#ff0000", "#0000ff"],
      },
    );

    expect(colorAt(result, 0, 0)).toEqual([255, 0, 0, 91]);
    expect(colorAt(result, 1, 0)).toEqual([7, 8, 9, 133]);
    expect(result.decisions[1]).toMatchObject({
      sourceColor: null,
      confidence: 1,
      reason: "protected",
    });
  });

  it("keeps current RGB when local ambiguity remains unresolved", () => {
    const first: RgbaColor = [32, 48, 190, 255];
    const second: RgbaColor = [206, 52, 36, 255];
    const source = image(4, 4, first);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if ((x + y) % 2 === 0) {
          source.data.set(second, (y * source.width + x) * 4);
        }
      }
    }
    const current = image(1, 1, [71, 83, 97, 121]);

    const result = reconstructSourceCells(source, [[0, 4]], [[0, 4]], {
      current,
      palette: ["#000000"],
    });

    expect([...result.data]).toEqual([71, 83, 97, 121]);
    expect(result.decisions[0].reason).toBe("kept-current-ambiguous");
  });

  it("can omit per-cell diagnostics for memory-bounded production use", () => {
    const source = image(4, 4, [18, 36, 54, 255]);
    const result = reconstructSourceCells(source, [[0, 4]], [[0, 4]], {
      includeDecisions: false,
    });

    expect([...result.data]).toEqual([18, 36, 54, 255]);
    expect(result.decisions).toEqual([]);
  });

  it("rejects logical images beyond the bounded restoration limit", () => {
    const width = 501;
    const height = 500;
    const source = image(width, height);
    const xRanges = Array.from(
      { length: width },
      (_, x) => [x, x + 1] as const,
    );
    const yRanges = Array.from(
      { length: height },
      (_, y) => [y, y + 1] as const,
    );

    expect(width * height).toBeGreaterThan(MAX_RECONSTRUCTION_CELLS);
    expect(() => reconstructSourceCells(source, xRanges, yRanges)).toThrow(
      "250,000",
    );
  });

  it("is byte-for-byte and decision-for-decision deterministic", () => {
    const source = image(12, 8);
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        source.data.set(
          [
            (x * 47 + y * 13) % 256,
            (x * 19 + y * 71) % 256,
            (x * 89 + y * 7) % 256,
            (x + y) % 3 === 0 ? 128 : 255,
          ],
          (y * source.width + x) * 4,
        );
      }
    }
    const xRanges = [
      [0, 4],
      [4, 8],
      [8, 12],
    ] as const;
    const yRanges = [
      [0, 4],
      [4, 8],
    ] as const;

    const first = reconstructSourceCells(source, xRanges, yRanges);
    const second = reconstructSourceCells(source, xRanges, yRanges);

    expect([...second.data]).toEqual([...first.data]);
    expect(second.decisions).toEqual(first.decisions);
  });
});
