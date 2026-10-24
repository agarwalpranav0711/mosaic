import { CONFIG } from './config';
import { computeTileFixed, initGPUFixed } from './gpuTileFixed';
import type { MosaicConfig } from './config';
import { REGION_CATALOGUE, PLANET_MAX_ITER, PLANET_TILE_SIZE } from './nameEngine';
import type { NameRegion } from './nameEngine';
import { computeProbeMetrics } from './regionMetrics';
import { RELAXATION_STAGES, REGION_EDGE_MIN_PERCENT, isRegionPassing } from './regionGenerator';
import { renderTileToCanvas } from './renderer';

const Q24 = 1 << 24;
const TILE_SIZE = 128;
const COLUMNS = 20;
const CELL_SIZE = 128;

function safeStatus(text: string): void {
  try {
    document.querySelector<HTMLElement>('#evidence-status')!.textContent = text;
  } catch (error) {
    console.error('Evidence UI callback failed:', error);
  }
}

function safeReport(text: string): void {
  try {
    document.querySelector<HTMLElement>('#evidence-report')!.textContent = text;
  } catch (error) {
    console.error('Evidence report callback failed:', error);
  }
}

function planetConfig(region: NameRegion, tileSize: number): MosaicConfig {
  const scaleQ24 = Math.floor(region.widthQ24 / PLANET_TILE_SIZE);
  return {
    ...CONFIG,
    tileSize,
    gridW: 1,
    gridH: 1,
    maxIter: PLANET_MAX_ITER,
    centerX: region.centerXQ24 / Q24,
    centerY: region.centerYQ24 / Q24,
    viewWidth: scaleQ24 * tileSize / Q24,
  };
}

function firstPassingTier(interior: number, fast: number, distinct: number, edges: number, total: number): number {
  const metrics = {
    interiorPixels: interior,
    fastEscapePixels: fast,
    distinctIterations: distinct,
    edgePixels: edges,
    edgeDensityPercent: edges * 100 / total,
    totalPixels: total,
  };
  const tier = RELAXATION_STAGES.findIndex((stage) => isRegionPassing(metrics, stage));
  if (tier < 0) throw new Error('Catalogue region failed every relaxation tier.');
  return tier + 1;
}

async function save(kind: string, content: string): Promise<void> {
  const response = await fetch('/__catalogue-evidence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, content }),
  });
  if (!response.ok) throw new Error(`Could not save ${kind} evidence (HTTP ${response.status}): ${await response.text()}`);
}

function makeContactSheet(tiles: HTMLCanvasElement[], indices: number[]): HTMLCanvasElement {
  const rows = Math.ceil(indices.length / COLUMNS);
  const sheet = document.createElement('canvas');
  sheet.width = COLUMNS * CELL_SIZE;
  sheet.height = rows * CELL_SIZE;
  const context = sheet.getContext('2d');
  if (!context) throw new Error('Could not create contact sheet canvas.');
  context.fillStyle = '#090d13';
  context.fillRect(0, 0, sheet.width, sheet.height);
  indices.forEach((index, position) => {
    const x = (position % COLUMNS) * CELL_SIZE;
    const y = Math.floor(position / COLUMNS) * CELL_SIZE;
    context.drawImage(tiles[index], x, y, CELL_SIZE, CELL_SIZE);
    context.font = 'bold 16px sans-serif';
    context.lineWidth = 3;
    context.strokeStyle = '#000';
    context.fillStyle = '#fff';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.strokeText(String(index), x + 4, y + 3);
    context.fillText(String(index), x + 4, y + 3);
  });
  return sheet;
}

function canvasPngBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('Canvas did not produce a PNG data URL.');
  return dataUrl.slice(separator + 1);
}

async function runEvidence(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('#run-evidence')!;
  button.disabled = true;
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter is unavailable.');
  const device = await adapter.requestDevice();
  const fixed = await initGPUFixed(device, 8);
  const tiers: Record<string, number> = {};
  const interior: Record<string, number> = {};
  const areas = new Map<string, Record<string, number>>();
  const tierCounts = [0, 0, 0, 0];
  const thumbnails: HTMLCanvasElement[] = [];
  try {
    for (let index = 0; index < REGION_CATALOGUE.length; index++) {
      const region = REGION_CATALOGUE[index];
      const probe = await computeTileFixed(fixed, 0, 0, { ...planetConfig(region, 64), workgroupSize: fixed.workgroupSize });
      const metrics = computeProbeMetrics(probe.iter, PLANET_MAX_ITER);
      const tier = firstPassingTier(
        metrics.interiorPixels,
        metrics.fastEscapePixels,
        metrics.distinctIterations,
        metrics.edgePixels,
        metrics.totalPixels,
      );
      tiers[String(index)] = tier;
      tierCounts[tier - 1]++;
      const areaCounts = areas.get(region.area) ?? { '1': 0, '2': 0, '3': 0, '4': 0 };
      areaCounts[String(tier)]++;
      areas.set(region.area, areaCounts);

      const tile = await computeTileFixed(fixed, 0, 0, { ...planetConfig(region, TILE_SIZE), workgroupSize: fixed.workgroupSize });
      let black = 0;
      for (const value of tile.iter) if (value >= PLANET_MAX_ITER) black++;
      interior[String(index)] = black / tile.iter.length;
      thumbnails.push(renderTileToCanvas(tile.iter, tile.z2, TILE_SIZE, PLANET_MAX_ITER, {
        paletteName: 'Ember',
        mappingMode: 'log',
        cycleSpeed: 1,
        edgeGlowIntensity: 0.8,
        planetMode: true,
        outputSize: CELL_SIZE,
      }));
      if ((index + 1) % 10 === 0) safeStatus(`Probed and rendered ${index + 1}/${REGION_CATALOGUE.length} regions; tier ${tierCounts.join('/')}.`);
    }
    const tier4Indices = Object.keys(tiers).map(Number).filter((index) => tiers[String(index)] === 4);
    const tierCountsByArea = Object.fromEntries([...areas.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const tierDocument = {
      catalogueSha256: '793adc48b7b93dc7226395233d2fc7a2140afa331cfcb07f705db9dec22d8238',
      probe: { tileSize: 64, maxIter: PLANET_MAX_ITER, edgeDensityMinPercent: REGION_EDGE_MIN_PERCENT },
      tierCounts: { '1': tierCounts[0], '2': tierCounts[1], '3': tierCounts[2], '4': tierCounts[3] },
      tierCountsByArea,
      tiers,
    };
    await save('tiers', JSON.stringify(tierDocument));
    await save('interior', JSON.stringify({
      catalogueSha256: tierDocument.catalogueSha256,
      tileSize: TILE_SIZE,
      maxIter: PLANET_MAX_ITER,
      blackInteriorFractions: interior,
    }));
    const allSheet = makeContactSheet(thumbnails, Array.from({ length: REGION_CATALOGUE.length }, (_, index) => index));
    await save('contact', canvasPngBase64(allSheet));
    const tier4Sheet = makeContactSheet(thumbnails, tier4Indices);
    await save('tier4', canvasPngBase64(tier4Sheet));
    safeReport(JSON.stringify({
      tierCounts: tierDocument.tierCounts,
      tierCountsByArea,
      tier4Count: tier4Indices.length,
      contactSheet: `screens/contact-sheet.png (${allSheet.width}x${allSheet.height})`,
      tier4Sheet: `screens/tier-4-contact-sheet.png (${tier4Sheet.width}x${tier4Sheet.height})`,
      blackInteriorFractionByIndex: interior,
    }, null, 2));
    safeStatus(`Evidence saved. ${REGION_CATALOGUE.length} regions; tier counts ${tierCounts.join('/')}; tier 4 ${tier4Indices.length}.`);
  } finally {
    device.destroy();
    button.disabled = false;
  }
}

document.querySelector<HTMLButtonElement>('#run-evidence')!.addEventListener('click', () => {
  void runEvidence().catch((error: unknown) => safeStatus(error instanceof Error ? error.message : String(error)));
});
