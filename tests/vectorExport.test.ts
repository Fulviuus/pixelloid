import { describe, expect, it } from "vitest";
import { pixelBufferToSvg } from "../src/lib/vectorExport";

describe("pixelBufferToSvg", () => {
  it("exports merged paths without embedding a raster image", () => {
    const data = new Uint8ClampedArray([
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 0, 0, 255,
    ]);

    const svg = pixelBufferToSvg({ width: 2, height: 2, data }, "Red & square");

    expect(svg).toContain('viewBox="0 0 2 2"');
    expect(svg).toContain("<title>Red &amp; square</title>");
    expect(svg).toContain('<path fill="#ff0000" d="M0 0h2v2h-2Z"/>');
    expect(svg).not.toContain("<image");
  });

  it("omits transparent pixels and preserves partial opacity", () => {
    const data = new Uint8ClampedArray([
      9, 8, 7, 0,
      10, 20, 30, 128,
    ]);

    const svg = pixelBufferToSvg({ width: 2, height: 1, data });

    expect(svg).not.toContain("#090807");
    expect(svg).toContain('fill="#0a141e" fill-opacity="0.502"');
    expect(svg).toContain('d="M1 0h1v1h-1Z"');
  });

  it("keeps disconnected rectangles of one color in one path", () => {
    const data = new Uint8ClampedArray([
      1, 2, 3, 255,
      0, 0, 0, 0,
      1, 2, 3, 255,
    ]);

    const svg = pixelBufferToSvg({ width: 3, height: 1, data });

    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('d="M0 0h1v1h-1ZM2 0h1v1h-1Z"');
  });
});
