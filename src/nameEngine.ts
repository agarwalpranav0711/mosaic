import type { MosaicConfig } from './config';
import { computeTileCPUFixed } from './cpuFixed';
import type { FixedTileResult } from './cpuFixed';
import regions from './regions.json';
import type { ProbeMetrics } from './regionMetrics';
import { computeProbeMetrics } from './regionMetrics';

export { computeProbeMetrics };
export type { ProbeMetrics };

export const ENGINE_VERSION = 1;
export const ENGINE_STATUS = 'DRAFT';
export const REGION_CATALOGUE_SHA256 = '793adc48b7b93dc7226395233d2fc7a2140afa331cfcb07f705db9dec22d8238';
export const PLANET_TILE_SIZE = 512;
export const PLANET_MAX_ITER = 2000;
const Q24_ONE = 1 << 24;
const PROBE_SIZE = 64;
const MAX_REHASH_COUNTER = 64;

export interface NameRegion {
  centerXQ24: number;
  centerYQ24: number;
  widthQ24: number;
  area: string;
}

export interface PlanetParameters {
  regionIndex: number;
  centerXQ24: number;
  centerYQ24: number;
  widthQ24: number;
  scale_q24: number;
  maxIter: number;
  counter: number;
  paletteIndex: number;
  planetId: string;
  fallbackUsed: boolean;
}

export type RegionProbe = (
  centerXQ24: number,
  centerYQ24: number,
  scaleQ24: number,
  maxIter: number,
) => Promise<Uint32Array>;

export const REGION_CATALOGUE = regions as NameRegion[];

export function normalizeName(name: string): string {
  const normalized = name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!normalized) throw new Error('Name must not be empty after normalization.');
  if ([...normalized].length > 40) throw new Error('Name must be 40 characters or fewer after normalization.');
  return normalized;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export async function hashName(name: string): Promise<string> {
  return sha256Hex(`mosaic-v1:${normalizeName(name)}`);
}

export function isInterestingPlanet(metrics: ProbeMetrics): boolean {
  return metrics.distinctIterations >= 90
    && metrics.fastEscapePixels * 2 < metrics.totalPixels
    && metrics.interiorPixels * 5 < metrics.totalPixels * 3;
}

function mapCandidate(hash: string, counter: number): Omit<PlanetParameters, 'planetId' | 'fallbackUsed'> {
  const bytes = Uint8Array.from(hash.match(/../gu)!, (part) => Number.parseInt(part, 16));
  const regionIndex = readU32(bytes, 0) % REGION_CATALOGUE.length;
  const region = REGION_CATALOGUE[regionIndex];
  const quarterWidth = Math.floor(region.widthQ24 / 4);
  const offsetRange = quarterWidth * 2 + 1;
  const centerXQ24 = region.centerXQ24 - quarterWidth + (readU32(bytes, 4) % offsetRange);
  const centerYQ24 = region.centerYQ24 - quarterWidth + (readU32(bytes, 8) % offsetRange);
  const scaleQ24 = Math.floor(region.widthQ24 / PLANET_TILE_SIZE);
  if (scaleQ24 < 256) throw new Error(`Region ${regionIndex} violates the frozen minimum scale_q24.`);
  return {
    regionIndex,
    centerXQ24,
    centerYQ24,
    widthQ24: region.widthQ24,
    scale_q24: scaleQ24,
    maxIter: PLANET_MAX_ITER,
    counter,
    paletteIndex: readU32(bytes, 12) % 4,
  };
}

function probeConfig(centerXQ24: number, centerYQ24: number, scaleQ24: number, maxIter: number): MosaicConfig {
  return {
    tileSize: PROBE_SIZE,
    gridW: 1,
    gridH: 1,
    maxIter,
    centerX: centerXQ24 / Q24_ONE,
    centerY: centerYQ24 / Q24_ONE,
    viewWidth: scaleQ24 * PROBE_SIZE / Q24_ONE,
    workgroupSize: 8,
    tolerance: { minExactMatchPct: 100 },
  };
}

async function makePlanet(
  candidate: Omit<PlanetParameters, 'planetId' | 'fallbackUsed'>,
  fallbackUsed: boolean,
): Promise<PlanetParameters> {
  const parameters = {
    regionIndex: candidate.regionIndex,
    centerXQ24: candidate.centerXQ24,
    centerYQ24: candidate.centerYQ24,
    widthQ24: candidate.widthQ24,
    scale_q24: candidate.scale_q24,
    maxIter: candidate.maxIter,
    counter: candidate.counter,
    paletteIndex: candidate.paletteIndex,
  };
  const planetId = (await sha256Hex(JSON.stringify(parameters))).slice(0, 8);
  return { ...parameters, planetId, fallbackUsed };
}

export async function createPlanet(
  name: string,
  probe: RegionProbe = async (x, y, scale, maxIter) => (
    computeTileCPUFixed(0, 0, probeConfig(x, y, scale, maxIter)).iter
  ),
): Promise<PlanetParameters> {
  const normalized = normalizeName(name);
  if (REGION_CATALOGUE.length !== 300) throw new Error(`Expected 300 curated regions, found ${REGION_CATALOGUE.length}.`);

  let best: { candidate: Omit<PlanetParameters, 'planetId' | 'fallbackUsed'>; distinctIterations: number } | undefined;
  for (let counter = 0; counter <= MAX_REHASH_COUNTER; counter++) {
    const hash = counter === 0
      ? await hashName(normalized)
      : await sha256Hex(`mosaic-v1:${normalized}:${counter}`);
    const candidate = mapCandidate(hash, counter);
    const pixels = await probe(candidate.centerXQ24, candidate.centerYQ24, candidate.scale_q24, candidate.maxIter);
    const metrics = computeProbeMetrics(pixels, candidate.maxIter);
    if (!best || metrics.distinctIterations > best.distinctIterations) {
      best = { candidate, distinctIterations: metrics.distinctIterations };
    }
    if (isInterestingPlanet(metrics)) return makePlanet(candidate, false);
  }

  if (!best) throw new Error('Name-to-planet generation produced no candidates.');
  return makePlanet(best.candidate, true);
}

export function computeProbeCPU(centerXQ24: number, centerYQ24: number, scaleQ24: number): FixedTileResult {
  return computeTileCPUFixed(0, 0, probeConfig(centerXQ24, centerYQ24, scaleQ24, PLANET_MAX_ITER));
}

export function normalizeNameUtf8Length(name: string): number {
  return new TextEncoder().encode(normalizeName(name)).length;
}
