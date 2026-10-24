/**
 * Comparison helpers for matching GPU vs CPU tile outputs.
 */

export interface CompareResult {
  totalPixels: number;
  exactMatches: number;
  exactMatchPct: number;
  maxAbsDiff: number;
  mismatchCount: number;
  /** First N mismatches: [x, y, gpuVal, cpuVal] */
  firstMismatches: Array<[number, number, number, number]>;
}

/**
 * Compare two Uint32Arrays of iteration counts element-by-element.
 * @param gpu  GPU output (tileSize*tileSize u32s, row-major)
 * @param cpu  CPU output (same layout)
 * @param tileSize pixels per side
 * @param maxMismatchReport how many mismatches to include in the report
 */
export function compareTiles(
  gpu: Uint32Array,
  cpu: Uint32Array,
  tileSize: number,
  maxMismatchReport = 5,
): CompareResult {
  const totalPixels = tileSize * tileSize;
  let exactMatches = 0;
  let maxAbsDiff = 0;
  let mismatchCount = 0;
  const firstMismatches: Array<[number, number, number, number]> = [];

  for (let i = 0; i < totalPixels; i++) {
    const g = gpu[i];
    const c = cpu[i];
    if (g === c) {
      exactMatches++;
    } else {
      mismatchCount++;
      const diff = Math.abs(g - c);
      if (diff > maxAbsDiff) maxAbsDiff = diff;
      if (firstMismatches.length < maxMismatchReport) {
        const x = i % tileSize;
        const y = Math.floor(i / tileSize);
        firstMismatches.push([x, y, g, c]);
      }
    }
  }

  return {
    totalPixels,
    exactMatches,
    exactMatchPct: (exactMatches / totalPixels) * 100,
    maxAbsDiff,
    mismatchCount,
    firstMismatches,
  };
}

/**
 * Convert Uint32Array iteration data to u16 bytes.
 * Throws a clear error if any value exceeds 65535 (no silent clamping).
 */
export function tileToU16Bytes(data: Uint32Array): Uint8Array {
  const u16 = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (val > 65535) {
      throw new Error(`Iteration count exceeds u16 limit (65535): received ${val} at index ${i}`);
    }
    u16[i] = val;
  }
  return new Uint8Array(u16.buffer);
}
