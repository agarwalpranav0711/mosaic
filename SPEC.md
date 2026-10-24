# Mosaic fixed-point specification

## Frozen Q8.24 rule

**FROZEN:** Signed Q8.24 products truncate toward zero after shifting the unsigned product magnitude right by 24 bits, then reapply the product sign.

Q8.24 stores signed fixed-point values in 32 bits with 24 fractional bits and 8 integer/sign bits; the scale is `2^24` units per one. BigInt division in the CPU reference truncates toward zero, and the WGSL multiply shifts the unsigned magnitude before restoring its sign. For the negative product `(-1 * 1) / 2^24`, truncation gives `0`, while arithmetic-shift floor gives `-1`; the runtime GPU probe confirms GPU and BigInt CPU results match.

The fixed-point canonical iteration output is the sequence of per-pixel iteration counts. Changes to display, auxiliary output buffers, and dispatch chunking must not alter it. Reference default hashes:

- B2 (42,16), tileSize 128, maxIter 500: `985dade1`
- C2 (49,41), tileSize 128, maxIter 500: `329ac730`
- D2 (49,22), tileSize 128, maxIter 500: `a63eed4d`

## Name-to-planet engine

**DRAFT — ENGINE_VERSION 1; not frozen.** The frozen source catalogue is `src/regions.json`, SHA-256 `793adc48b7b93dc7226395233d2fc7a2140afa331cfcb07f705db9dec22d8238`.

The v1 mapping normalizes a name with Unicode NFKC, trims it, collapses whitespace, lowercases it, and hashes `mosaic-v1:` plus that value with SHA-256. The first little-endian u32 selects `regionIndex` modulo 300; the next two little-endian u32 values independently select integer center offsets in `[-floor(widthQ24/4), +floor(widthQ24/4)]`; the fourth selects `paletteIndex` modulo 4. Planet width remains the catalogue `widthQ24`, `scale_q24 = floor(widthQ24/512)`, tile size is 512, and maxIter is 2000.

Candidate zero uses the name digest. Rehash counters 1 through 64 hash `mosaic-v1:<normalized-name>:<counter>` and repeat the same integer mapping. A 64x64 Q8.24 probe passes when it has at least 90 distinct iteration values, fewer than 50% of pixels escape before iteration 10, and fewer than 60% are interior. If no candidate passes, choose the candidate with the greatest distinct-iteration count; ties keep the lowest counter and the returned result records `fallbackUsed: true`. `planetId` is the first eight lowercase hex characters of SHA-256 over the JSON serialization of the output parameters other than `planetId` and `fallbackUsed`.
