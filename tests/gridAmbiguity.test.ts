import { describe, expect, it } from "vitest";
import { getPixelGridAmbiguity } from "../src/lib/gridAmbiguity";

describe("getPixelGridAmbiguity", () => {
  it("offers the information-preserving 84px grid beside the weak 80px grid", () => {
    const ambiguity = getPixelGridAmbiguity(
      {
        pixelSize: 15.667,
        confidence: 20,
        offsetX: 0,
        offsetY: 0,
      },
      1254,
      1254,
    );

    expect(ambiguity).toEqual({
      confidence: 20,
      candidates: [
        {
          pixelSize: 15,
          offsetX: 12,
          offsetY: 12,
          width: 84,
          height: 84,
          kind: "integer",
        },
        {
          pixelSize: 15.667,
          offsetX: 0,
          offsetY: 0,
          width: 80,
          height: 80,
          kind: "detected",
        },
      ],
    });
  });

  it("centers the integer lattice instead of copying fractional phase", () => {
    const ambiguity = getPixelGridAmbiguity(
      {
        pixelSize: 15.667,
        confidence: 22,
        offsetX: 5,
        offsetY: 3,
      },
      1254,
      1254,
    );

    expect(
      ambiguity?.candidates.map(({ offsetX, offsetY }) => [
        offsetX,
        offsetY,
      ]),
    ).toEqual([
      [12, 12],
      [5, 3],
    ]);
  });

  it("does not second-guess an integer or high-confidence detection", () => {
    expect(
      getPixelGridAmbiguity(
        { pixelSize: 15, confidence: 20, offsetX: 0, offsetY: 0 },
        1254,
        1254,
      ),
    ).toBeNull();
    expect(
      getPixelGridAmbiguity(
        { pixelSize: 15.667, confidence: 70, offsetX: 0, offsetY: 0 },
        1254,
        1254,
      ),
    ).toBeNull();
  });
});
