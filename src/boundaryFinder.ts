/**
 * Boundary Tile Finder for Mosaic (Part 1.5).
 * Cheaply scans the tile grid to locate tiles with high variance / rich boundaries,
 * avoiding flat interior or exterior tiles.
 */

import { getScale } from './config';
import type { MosaicConfig } from './config';

export interface BoundaryCandidate {
  tx: number;
  ty: number;
  sampleMin: number;
  sampleMax: number;
  spread: number;
  distinctSamples: number;
  score: number;
}

export interface TileStats {
  min: number;
  max: number;
  distinctCount: number;
  mean: number;
  variance: number;
}

/**
 * Fast CPU single-pixel Mandelbrot evaluator used for grid scanning.
 */
export function evalMandelPoint(cr: number, ci: number, maxIter: number): number {
  let zr = 0.0;
  let zi = 0.0;
  let i = 0;
  while (i < maxIter) {
    const zr2 = zr * zr;
    const zi2 = zi * zi;
    if (zr2 + zi2 > 4.0) break;
    zi = 2.0 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
    i++;
  }
  return i;
}

/**
 * Cheaply scan all gridW x gridH tiles on the CPU.
 * Uses 9 sample points per tile (3x3 grid) to detect high variance / boundary tiles.
 *
 * @param cfg Tile and grid configuration
 * @param maxScanIter Iteration limit for scanning (capped for speed, default 500)
 */
export function scanGridForBoundaryTiles(
  cfg: MosaicConfig,
  count: number = 20,
  maxScanIter: number = 500,
): { candidates: BoundaryCandidate[]; scanTimeMs: number; totalScanned: number } {
  const t0 = performance.now();
  const scale = getScale(cfg);
  const halfW = cfg.gridW * cfg.tileSize * 0.5;
  const halfH = cfg.gridH * cfg.tileSize * 0.5;
  const iterLimit = Math.min(cfg.maxIter, maxScanIter);

  const fractions = [0.2, 0.5, 0.8];
  const allCandidates: BoundaryCandidate[] = [];

  for (let ty = 0; ty < cfg.gridH; ty++) {
    for (let tx = 0; tx < cfg.gridW; tx++) {
      const samples: number[] = [];
      for (const fy of fractions) {
        for (const fx of fractions) {
          const px = Math.floor(cfg.tileSize * fx);
          const py = Math.floor(cfg.tileSize * fy);
          const cr = cfg.centerX + (tx * cfg.tileSize + px - halfW) * scale;
          const ci = cfg.centerY + (ty * cfg.tileSize + py - halfH) * scale;
          samples.push(evalMandelPoint(cr, ci, iterLimit));
        }
      }

      const min = Math.min(...samples);
      const max = Math.max(...samples);
      const set = new Set(samples);

      // Tile has boundary features if samples differ
      if (set.size > 1) {
        const spread = max - min;
        const score = set.size * 1000 + spread;
        allCandidates.push({
          tx,
          ty,
          sampleMin: min,
          sampleMax: max,
          spread,
          distinctSamples: set.size,
          score,
        });
      }
    }
  }

  // Sort descending by score (most distinct samples & highest spread first)
  allCandidates.sort((a, b) => b.score - a.score);

  // Pick diverse tiles so they aren't clustered in one spot
  const selected: BoundaryCandidate[] = [];
  for (const c of allCandidates) {
    if (selected.length >= count) break;
    // Keep at least 2 tiles separation if we have plenty of candidates
    const tooClose = selected.some(
      (s) => Math.abs(s.tx - c.tx) <= 1 && Math.abs(s.ty - c.ty) <= 1,
    );
    if (!tooClose || allCandidates.length - selected.length <= count) {
      selected.push(c);
    }
  }

  // If spatial filtering left us with fewer than count, fill up with remaining top candidates
  if (selected.length < count) {
    for (const c of allCandidates) {
      if (selected.length >= count) break;
      if (!selected.includes(c)) selected.push(c);
    }
  }

  const scanTimeMs = performance.now() - t0;
  return { candidates: selected, scanTimeMs, totalScanned: cfg.gridW * cfg.gridH };
}

/**
 * Pick 3 diverse boundary tiles (e.g. from cardioid boundary, bulb valley, and outer antenna).
 */
export function select3DiverseBoundaryTiles(candidates: BoundaryCandidate[]): BoundaryCandidate[] {
  if (candidates.length < 3) return candidates;

  const b1 = candidates[0];
  // Find b2 well-separated from b1
  let b2 = candidates.find((c) => Math.hypot(c.tx - b1.tx, c.ty - b1.ty) >= 10);
  if (!b2) b2 = candidates[Math.floor(candidates.length / 3)];

  // Find b3 well-separated from both b1 and b2
  let b3 = candidates.find(
    (c) =>
      Math.hypot(c.tx - b1.tx, c.ty - b1.ty) >= 8 &&
      Math.hypot(c.tx - b2!.tx, c.ty - b2!.ty) >= 8,
  );
  if (!b3) b3 = candidates[Math.floor((candidates.length * 2) / 3)];

  return [b1, b2, b3];
}

/**
 * Compute exhaustive statistics on a tile's iteration data.
 * Used for verifying that boundary tiles are truly non-flat.
 */
export function computeTileStats(data: Uint32Array): TileStats {
  const N = data.length;
  let min = data[0];
  let max = data[0];
  let sum = 0;
  let sumSq = 0;
  const set = new Set<number>();

  for (let i = 0; i < N; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    set.add(v);
  }

  const mean = sum / N;
  const variance = sumSq / N - mean * mean;

  return {
    min,
    max,
    distinctCount: set.size,
    mean,
    variance,
  };
}
