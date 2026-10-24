import type { NameRegion, ProbeMetrics } from './nameEngine';

export const REGION_SCAN_SEED = 0x4d4f5341;
export const REGION_SCAN_WIDTH = 512;
export const REGION_PROBE_ITERATIONS = 2000;
export const REGION_TIME_BUDGET_MS = 10 * 60 * 1000;
export const REGION_EDGE_MIN_PERCENT = 5;
const Q24 = 1 << 24;

export interface BoundarySeed {
  centerXQ24: number;
  centerYQ24: number;
  area: string;
}

export interface ScanFunnel {
  generated: number;
  rejectedOverlap: number;
  failedInterior: number;
  failedFastEscape: number;
  failedDistinct: number;
  failedEdges: number;
  accepted: number;
}

export interface ScanState {
  candidateIndex: number;
  stage: number;
  accepted: NameRegion[];
  funnel: ScanFunnel;
  stageFunnels: ScanFunnel[];
  stageRecovered: number[];
  stageRecheck: ScanFunnel[];
  probed: Array<{ candidate: NameRegion; metrics: ProbeMetrics }>;
}

export interface ScanSettings {
  distinctMin: number;
  fastEscapeMaxPercent: number;
  interiorMaxPercent: number;
}

export const RELAXATION_STAGES: readonly ScanSettings[] = [
  { distinctMin: 120, fastEscapeMaxPercent: 50, interiorMaxPercent: 60 },
  { distinctMin: 90, fastEscapeMaxPercent: 50, interiorMaxPercent: 60 },
  { distinctMin: 90, fastEscapeMaxPercent: 60, interiorMaxPercent: 60 },
  { distinctMin: 90, fastEscapeMaxPercent: 60, interiorMaxPercent: 70 },
];

const LOG_WIDTHS_Q24 = (() => {
  const widths: number[] = [];
  let width = Math.ceil(0.01 * Q24);
  const maxWidth = Math.floor(0.2 * Q24);
  const ratioQ24 = 17177669;
  while (width < maxWidth) {
    widths.push(width);
    width = Math.floor((width * ratioQ24) / Q24);
  }
  widths.push(maxWidth);
  return widths;
})();

export function extractBoundarySeeds(
  iterations: Uint32Array,
  width: number,
  height: number,
  leftQ24: number,
  topQ24: number,
  xStepQ24: number,
  yStepQ24: number,
  maxIter: number,
): BoundarySeed[] {
  if (iterations.length !== width * height) throw new Error('Coarse scan buffer dimensions do not match.');
  const seeds: BoundarySeed[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const value = iterations[index];
      const neighbors = [iterations[index - 1], iterations[index + 1], iterations[index - width], iterations[index + width]];
      if (!neighbors.some((neighbor) => ((value >= maxIter) !== (neighbor >= maxIter)) || Math.abs(value - neighbor) > 8)) continue;
      const centerXQ24 = leftQ24 + x * xStepQ24;
      const centerYQ24 = topQ24 + y * yStepQ24;
      seeds.push({ centerXQ24, centerYQ24, area: classifyArea(centerXQ24, centerYQ24) });
    }
  }
  return seeds;
}

function classifyArea(x: number, y: number): string {
  if (x < Math.round(-1.55 * Q24)) return 'minibrots';
  if (y > Math.round(0.42 * Q24)) return 'spirals';
  if (y < Math.round(-0.42 * Q24)) return 'filaments';
  return 'seahorse';
}

function randomWord(value: number): number {
  let x = value >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

export function regionCandidateAt(seeds: BoundarySeed[], index: number, seed = REGION_SCAN_SEED): NameRegion {
  if (seeds.length === 0) throw new Error('Coarse GPU scan found no boundary pixels.');
  const base = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  const seedIndex = randomWord(base) % seeds.length;
  const widthIndex = randomWord(base ^ 0xa5a5a5a5) % LOG_WIDTHS_Q24.length;
  const point = seeds[seedIndex];
  return {
    centerXQ24: point.centerXQ24,
    centerYQ24: point.centerYQ24,
    widthQ24: LOG_WIDTHS_Q24[widthIndex],
    area: point.area,
  };
}

export function overlapsRegion(candidate: NameRegion, existing: NameRegion[]): boolean {
  return existing.some((region) => {
    const dx = BigInt(candidate.centerXQ24 - region.centerXQ24);
    const dy = BigInt(candidate.centerYQ24 - region.centerYQ24);
    const largerWidth = BigInt(Math.max(candidate.widthQ24, region.widthQ24));
    return 100n * (dx * dx + dy * dy) < 49n * largerWidth * largerWidth;
  });
}

export function isRegionPassing(metrics: ProbeMetrics, stage: ScanSettings): boolean {
  return metrics.interiorPixels * 100 < metrics.totalPixels * stage.interiorMaxPercent
    && metrics.fastEscapePixels * 100 < metrics.totalPixels * stage.fastEscapeMaxPercent
    && metrics.distinctIterations >= stage.distinctMin
    && metrics.edgePixels * 100 >= metrics.totalPixels * REGION_EDGE_MIN_PERCENT;
}

export function updateFunnel(funnel: ScanFunnel, metrics: ProbeMetrics, settings: ScanSettings): boolean {
  if (metrics.interiorPixels * 100 >= metrics.totalPixels * settings.interiorMaxPercent) {
    funnel.failedInterior++;
    return false;
  }
  if (metrics.fastEscapePixels * 100 >= metrics.totalPixels * settings.fastEscapeMaxPercent) {
    funnel.failedFastEscape++;
    return false;
  }
  if (metrics.distinctIterations < settings.distinctMin) {
    funnel.failedDistinct++;
    return false;
  }
  if (metrics.edgePixels * 100 < metrics.totalPixels * REGION_EDGE_MIN_PERCENT) {
    funnel.failedEdges++;
    return false;
  }
  return true;
}

export function emptyFunnel(): ScanFunnel {
  return { generated: 0, rejectedOverlap: 0, failedInterior: 0, failedFastEscape: 0, failedDistinct: 0, failedEdges: 0, accepted: 0 };
}

export function initialScanState(): ScanState {
  return {
    candidateIndex: 0,
    stage: 0,
    accepted: [],
    funnel: emptyFunnel(),
    stageFunnels: [],
    stageRecovered: Array(RELAXATION_STAGES.length).fill(0),
    stageRecheck: Array.from({ length: RELAXATION_STAGES.length }, emptyFunnel),
    probed: [],
  };
}

export function minimumCenterDistanceRatio(regions: NameRegion[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const dx = regions[i].centerXQ24 - regions[j].centerXQ24;
      const dy = regions[i].centerYQ24 - regions[j].centerYQ24;
      minimum = Math.min(minimum, Math.sqrt(dx * dx + dy * dy) / Math.max(regions[i].widthQ24, regions[j].widthQ24));
    }
  }
  return minimum;
}

export function q24ToNumber(value: number): number {
  return value / Q24;
}
