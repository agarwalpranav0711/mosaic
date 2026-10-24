# Mosaic fixed-point specification

## Frozen Q8.24 arithmetic rule

**Frozen:** each signed Q8.24 product is computed as the unsigned product's magnitude shifted right by 24 bits, then the sign is reapplied; this is truncation toward zero, not arithmetic-shift floor.

For example, `(-1 * 1) / 2^24` truncates toward zero to `0`, while an arithmetic signed shift `(-1) >> 24` is `-1`. The BigInt CPU reference uses BigInt division, which truncates toward zero. The WGSL `mul_q24` computes the unsigned magnitude and reapplies the sign, matching that rule.

The fixed-point canonical iteration output is the sequence of per-pixel iteration counts. Changes to display, auxiliary output buffers, and dispatch chunking must not alter it. Reference default hashes:

- B2 (42,16), tileSize 128, maxIter 500: `985dade1`
- C2 (49,41), tileSize 128, maxIter 500: `329ac730`
- D2 (49,22), tileSize 128, maxIter 500: `a63eed4d`
