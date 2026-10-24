import { CONFIG } from './config';
import { computeTileCPUFixedSubBlock } from './cpuFixed';
import { fnv1a32, u16LittleEndian } from './fnv';
import { computeTileFixed, computeTileFixedAdaptive, initGPUFixed } from './gpuTileFixed';
import type { GPUFixedContext } from './gpuTileFixed';
import { createPlanet, ENGINE_STATUS, ENGINE_VERSION, PLANET_MAX_ITER, PLANET_TILE_SIZE, REGION_CATALOGUE_SHA256 } from './nameEngine';
import type { PlanetParameters } from './nameEngine';
import { renderTileToCanvas } from './renderer';
import type { MosaicConfig } from './config';
import type { PaletteName } from './palette';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const Q24 = 1 << 24;
const PALETTES: PaletteName[] = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];
const REAL_NAMES = ['Priya', 'Rahul', 'Aman', 'Neha', 'Kuber'] as const;
const REFERENCE_HASHES: Record<(typeof REAL_NAMES)[number], { planetId: string; tileHash: string }> = {
  Priya: { planetId: '81357026', tileHash: '9a90facd' },
  Rahul: { planetId: '184b2ca5', tileHash: '1c470754' },
  Aman: { planetId: 'e57d2897', tileHash: '7d0ece54' },
  Neha: { planetId: 'ed0aa39e', tileHash: '48050231' },
  Kuber: { planetId: '81e905b5', tileHash: '3fca3290' },
};
const nameHashes = new Map<string, { parameters: PlanetParameters; tileHash: string }>();
let fixed: GPUFixedContext | undefined;
let calibrationMs = 0;
let copySummary = '';

function status(text: string): void {
  try {
    $('planet-status').textContent = text;
  } catch (error) {
    console.error('Planet page status update failed:', error);
  }
}

function configFor(centerXQ24: number, centerYQ24: number, scaleQ24: number, tileSize: number, maxIter: number): MosaicConfig {
  return {
    ...CONFIG,
    tileSize,
    gridW: 1,
    gridH: 1,
    maxIter,
    centerX: centerXQ24 / Q24,
    centerY: centerYQ24 / Q24,
    viewWidth: scaleQ24 * tileSize / Q24,
  };
}

async function gpuProbe(centerXQ24: number, centerYQ24: number, scaleQ24: number, maxIter: number): Promise<Uint32Array> {
  if (!fixed) throw new Error('WebGPU fixed-point pipeline is not initialized.');
  return (await computeTileFixed(fixed, 0, 0, configFor(centerXQ24, centerYQ24, scaleQ24, 64, maxIter))).iter;
}

async function createAndRender(name: string, updateUrl: boolean): Promise<{ parameters: PlanetParameters; tileHash: string; chunked: boolean; elapsedMs: number }> {
  if (!fixed) throw new Error('WebGPU fixed-point pipeline is not initialized.');
  const parameters = await createPlanet(name, gpuProbe);
  const cfg = configFor(parameters.centerXQ24, parameters.centerYQ24, parameters.scale_q24, PLANET_TILE_SIZE, PLANET_MAX_ITER);
  if (calibrationMs === 0) {
    const started = performance.now();
    await computeTileFixed(fixed, 42, 16, CONFIG);
    calibrationMs = performance.now() - started;
  }
  const estimate = calibrationMs * cfg.tileSize ** 2 * cfg.maxIter / (CONFIG.tileSize ** 2 * CONFIG.maxIter);
  const started = performance.now();
  const tile = await computeTileFixedAdaptive(fixed, 0, 0, cfg, estimate);
  const elapsedMs = performance.now() - started;
  const tileHash = fnv1a32(u16LittleEndian(tile.iter));
  $('planet-image').replaceChildren(renderTileToCanvas(tile.iter, tile.z2, PLANET_TILE_SIZE, PLANET_MAX_ITER, {
    paletteName: PALETTES[parameters.paletteIndex],
    mappingMode: 'log',
    cycleSpeed: 1,
    edgeGlowIntensity: 0.8,
    planetMode: true,
    outputSize: 512,
  }));
  let interior = 0;
  for (const value of tile.iter) if (value >= PLANET_MAX_ITER) interior++;
  const report = {
    ...parameters,
    fixedTileHash: tileHash,
    blackInteriorFraction: interior / tile.iter.length,
    palette: PALETTES[parameters.paletteIndex],
    chunked: tile.chunked,
    estimatedDispatchMs: tile.estimatedMs,
    gpuTimeMs: elapsedMs,
  };
  $('planet-output').textContent = JSON.stringify(report, null, 2);
  status(`Planet ${parameters.planetId}; FNV-1a ${tileHash}; ${elapsedMs.toFixed(1)} ms GPU tile${tile.chunked ? ' (chunked)' : ''}${parameters.fallbackUsed ? '; fallback candidate used' : ''}.`);
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('n', name);
    url.searchParams.set('v', String(ENGINE_VERSION));
    history.replaceState(null, '', url);
  }
  nameHashes.set(name.toLowerCase(), { parameters, tileHash });
  updateCopySummary();
  return { parameters, tileHash, chunked: tile.chunked, elapsedMs };
}

function updateCopySummary(): void {
  const lines = [
    `Engine: ${ENGINE_STATUS} v${ENGINE_VERSION}`,
    `Catalogue SHA-256: ${REGION_CATALOGUE_SHA256}`,
  ];
  for (const name of REAL_NAMES) {
    const result = nameHashes.get(name.toLowerCase());
    const reference = REFERENCE_HASHES[name];
    const observed = result ? `; this device ${result.parameters.planetId} ${result.tileHash}` : '';
    lines.push(`${name}: expected ${reference.planetId} ${reference.tileHash}${observed}`);
  }
  copySummary = `${lines.join('\n')}\n`;
  $<HTMLButtonElement>('copy-summary').disabled = false;
}

async function verifyCpuBlocks(name: string, parameters: PlanetParameters): Promise<string> {
  if (!fixed) throw new Error('WebGPU fixed-point pipeline is not initialized.');
  const cfg = configFor(parameters.centerXQ24, parameters.centerYQ24, parameters.scale_q24, PLANET_TILE_SIZE, PLANET_MAX_ITER);
  const gpu = await computeTileFixed(fixed, 0, 0, cfg);
  const offsets = [[0, 0], [224, 224]] as const;
  for (const [x, y] of offsets) {
    const cpu = computeTileCPUFixedSubBlock(0, 0, cfg, x, y, 64, 64);
    for (let row = 0; row < 64; row++) {
      for (let column = 0; column < 64; column++) {
        const gpuIndex = (y + row) * PLANET_TILE_SIZE + x + column;
        const cpuIndex = row * 64 + column;
        if (gpu.iter[gpuIndex] !== cpu.iter[cpuIndex] || gpu.z2[gpuIndex] !== cpu.z2[cpuIndex]) {
          throw new Error(`${name} GPU/CPU mismatch at tile pixel (${x + column},${y + row}).`);
        }
      }
    }
  }
  return `${name}: iteration and |z|^2 exact on top-left and center 64x64 blocks (8,192 pixels).`;
}

function makeGeneratedName(index: number): string {
  const numeric = `${index.toString(36)}-${(index * 7919).toString(10)}`;
  switch (index % 4) {
    case 0: return `Name ${numeric}`;
    case 1: return `प्रिया ${numeric}`;
    case 2: return `ليلى ${numeric}`;
    default: return `美咲 ${numeric}`;
  }
}

async function runTenThousand(): Promise<void> {
  const start = performance.now();
  const planetIds = new Set<string>();
  const regions = new Set<number>();
  let rehashed = 0;
  let collisions = 0;
  let maxCounter = 0;
  for (let index = 0; index < 10000; index++) {
    const planet = await createPlanet(makeGeneratedName(index), gpuProbe);
    if (planet.counter > 0) rehashed++;
    maxCounter = Math.max(maxCounter, planet.counter);
    if (planetIds.has(planet.planetId)) collisions++;
    planetIds.add(planet.planetId);
    regions.add(planet.regionIndex);
    if ((index + 1) % 250 === 0) {
      status(`Generated names ${index + 1}/10000; rehashed ${rehashed}; max counter ${maxCounter}.`);
      $('validation-output').textContent = `Working on GPU probes; elapsed ${(performance.now() - start).toFixed(0)} ms.`;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const elapsedMs = performance.now() - start;
  const report = {
    generatedNames: 10000,
    rehashFraction: rehashed / 10000,
    rehashedNames: rehashed,
    maxCounter,
    distinctPlanetIds: planetIds.size,
    collisions,
    distinctRegions: regions.size,
    timePerNameMs: elapsedMs / 10000,
    totalTimeMs: elapsedMs,
  };
  $('validation-output').textContent = JSON.stringify(report, null, 2);
  status(`10,000-name GPU-probe run complete in ${(elapsedMs / 1000).toFixed(1)} seconds.`);
}

async function initialize(): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const device = await adapter.requestDevice();
  fixed = await initGPUFixed(device, 8);
  window.addEventListener('pagehide', () => device.destroy(), { once: true });
  status(`Ready — ${ENGINE_STATUS} v${ENGINE_VERSION}; catalogue ${REGION_CATALOGUE_SHA256}.`);
  const params = new URLSearchParams(location.search);
  if (params.get('v') === String(ENGINE_VERSION) && params.has('n')) {
    const name = params.get('n') ?? '';
    $<HTMLInputElement>('planet-name').value = name;
    await createAndRender(name, false);
  }
}

$<HTMLButtonElement>('create-planet').addEventListener('click', () => {
  void createAndRender($<HTMLInputElement>('planet-name').value, true)
    .catch((error: unknown) => status(error instanceof Error ? error.message : String(error)));
});
$<HTMLButtonElement>('copy-summary').addEventListener('click', () => {
  void navigator.clipboard.writeText(copySummary)
    .catch((error: unknown) => status(`Copy failed: ${error instanceof Error ? error.message : String(error)}`));
});
$<HTMLButtonElement>('run-named').addEventListener('click', () => {
  void (async () => {
    const reports: string[] = [];
    for (const name of REAL_NAMES) {
      const result = await createAndRender(name, false);
      reports.push(`${name}: ${JSON.stringify({ ...result.parameters, fixedTileHash: result.tileHash, gpuTimeMs: result.elapsedMs })}`);
      if (name === 'Priya' || name === 'Rahul') reports.push(await verifyCpuBlocks(name, result.parameters));
    }
    $('validation-output').textContent = reports.join('\n');
  })().catch((error: unknown) => status(error instanceof Error ? error.message : String(error)));
});
$<HTMLButtonElement>('run-many').addEventListener('click', () => {
  void runTenThousand().catch((error: unknown) => {
    $('validation-output').textContent = error instanceof Error ? error.stack ?? error.message : String(error);
    status('10,000-name run failed.');
  });
});
void initialize().catch((error: unknown) => status(error instanceof Error ? error.message : String(error)));
