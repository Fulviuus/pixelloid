const PNG_SIGNATURE = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
]);

function writeUint32(value: number) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Uint8Array) {
  const type = new TextEncoder().encode(name);
  const body = new Uint8Array(type.length + data.length);
  body.set(type);
  body.set(data, type.length);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(writeUint32(data.length), 0);
  chunk.set(body, 4);
  chunk.set(writeUint32(crc32(body)), 8 + data.length);
  return chunk;
}

function adler32(data: Uint8Array) {
  let first = 1;
  let second = 0;
  for (const byte of data) {
    first = (first + byte) % 65521;
    second = (second + first) % 65521;
  }
  return ((second << 16) | first) >>> 0;
}

function storeDeflate(data: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const output = new Uint8Array(2 + data.length + blocks * 5 + 4);
  output.set([0x78, 0x01], 0);
  let sourceOffset = 0;
  let outputOffset = 2;

  for (let block = 0; block < blocks; block += 1) {
    const length = Math.min(65535, data.length - sourceOffset);
    const isFinal = block === blocks - 1;
    output[outputOffset] = isFinal ? 1 : 0;
    output[outputOffset + 1] = length & 0xff;
    output[outputOffset + 2] = (length >>> 8) & 0xff;
    output[outputOffset + 3] = (~length) & 0xff;
    output[outputOffset + 4] = ((~length) >>> 8) & 0xff;
    output.set(data.subarray(sourceOffset, sourceOffset + length), outputOffset + 5);
    sourceOffset += length;
    outputOffset += length + 5;
  }

  output.set(writeUint32(adler32(data)), outputOffset);
  return output;
}

function packedBitDepth(colorCount: number) {
  if (colorCount <= 2) return 1;
  if (colorCount <= 4) return 2;
  if (colorCount <= 16) return 4;
  return 8;
}

/**
 * Encode RGBA pixels as a real indexed PNG when they use at most 256 colors.
 * Returns null when a palette representation is not possible.
 */
export function encodeIndexedPng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (
    width < 1 ||
    height < 1 ||
    rgba.length < width * height * 4
  ) {
    return null;
  }

  const palette: number[][] = [];
  const paletteIndex = new Map<number, number>();
  const indices = new Uint8Array(width * height);

  for (let pixel = 0; pixel < indices.length; pixel += 1) {
    const offset = pixel * 4;
    const key =
      rgba[offset] |
      (rgba[offset + 1] << 8) |
      (rgba[offset + 2] << 16) |
      (rgba[offset + 3] << 24);
    let index = paletteIndex.get(key);
    if (index === undefined) {
      if (palette.length === 256) return null;
      index = palette.length;
      paletteIndex.set(key, index);
      palette.push([
        rgba[offset],
        rgba[offset + 1],
        rgba[offset + 2],
        rgba[offset + 3],
      ]);
    }
    indices[pixel] = index;
  }

  const bitDepth = packedBitDepth(palette.length);
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const scanlines = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    for (let x = 0; x < width; x += 1) {
      const index = indices[y * width + x];
      if (bitDepth === 8) {
        scanlines[rowStart + 1 + x] = index;
      } else {
        const bit = x * bitDepth;
        scanlines[rowStart + 1 + (bit >>> 3)] |=
          index << (8 - bitDepth - (bit & 7));
      }
    }
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(writeUint32(width), 0);
  ihdr.set(writeUint32(height), 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 3;
  const plte = new Uint8Array(palette.length * 3);
  const transparency = new Uint8Array(palette.length);
  palette.forEach((color, index) => {
    plte.set(color.slice(0, 3), index * 3);
    transparency[index] = color[3];
  });

  return new Blob(
    [
      PNG_SIGNATURE,
      pngChunk("IHDR", ihdr),
      pngChunk("PLTE", plte),
      pngChunk("tRNS", transparency),
      pngChunk("IDAT", storeDeflate(scanlines)),
      pngChunk("IEND", new Uint8Array()),
    ],
    { type: "image/png" },
  );
}
