import { CONFIG, SITE_URL } from './config';
import { makeDiveKeyframes } from './dive';
import type { DiveKeyframe } from './dive';
import { fnv1a32, u16LittleEndian } from './fnv';
import { computeTileFixedAdaptive, initGPUFixed } from './gpuTileFixed';
import type { AdaptiveFixedTileResult, GPUFixedContext } from './gpuTileFixed';
import { createPlanet, normalizeName, PLANET_MAX_ITER, PLANET_TILE_SIZE } from './nameEngine';
import type { PlanetParameters } from './nameEngine';
import { PALETTES } from './palette';
import type { PaletteName } from './palette';
import { renderTileToCanvas } from './renderer';
import type { MosaicConfig } from './config';

const Q24 = 1 << 24;
const DIVE_DURATION_MS = 5400;
const GATHER_MIN_MS = 1200;
const KEYFRAME_TIMEOUT_MS = 8000;
const FRAME_GPU_TIMEOUT_MS = 60000;
const PALETTES_BY_INDEX: PaletteName[] = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];
const $ = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required dive page element #${id} is missing.`);
  return element as T;
};

interface PreparedFrame {
  keyframe: DiveKeyframe;
  tile: AdaptiveFixedTileResult;
  canvas: HTMLCanvasElement;
  hash: string;
}

interface DiveDebugReport {
  normalizedName: string;
  planetId: string;
  finalPlanetHash: string;
  paletteIndex: number;
  keyframeComputeMs: number;
  calibrationMs?: number;
  frameTimeMedianMs: number | null;
  frameTimeP95Ms: number | null;
  reducedMotion: boolean;
  stageLog: DiveStageLog[];
  keyframes: Array<DiveKeyframe & { fnv1a: string; chunked: boolean; estimatedMs: number }>;
}

interface DiveStageLog {
  stage: string;
  timestamp: string;
  elapsedMs: number;
  [key: string]: string | number | boolean;
}

let fixed: GPUFixedContext | undefined;
let calibrationMs: number | undefined;
let runSequence = 0;
let runStartedAt = 0;
let diveStageLog: DiveStageLog[] = [];
let diveActive = false;
let injectedTimeoutUsed = false;
let injectedDeviceLossUsed = false;
let injectedDeviceLossPending = false;
let audioContext: AudioContext | undefined;
let audioEnabled = false;
let audioOscillator: OscillatorNode | undefined;
let audioGain: GainNode | undefined;
let lastPlanet: { name: string; parameters: PlanetParameters; tile: AdaptiveFixedTileResult; hash: string; canvas: HTMLCanvasElement } | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameSamples: number[] = [];
let flightCanvas: HTMLCanvasElement;
let flightContext: CanvasRenderingContext2D;

let ambientCanvas: HTMLCanvasElement;
let ambientContext: CanvasRenderingContext2D;
let ambientSatellites: HTMLElement;
let ambientActive = true;
let ambientRafId = 0;
let ambientDrawSamples: number[] = [];
let ambientKeyframes: Array<{ canvas: HTMLCanvasElement; scale_q24: number; centerX: number; centerY: number }> = [];
let ambientStarted = 0;

export interface SamplePlanetInfo {
  name: string;
  planetId: string;
  paletteIndex: number;
  canvas: HTMLCanvasElement;
}
let samplePlanetsCache: SamplePlanetInfo[] = [];

let previewTimer: number | undefined;
let previewCounter = 0;
let livePreviewEnabled = true;
let previewTimings: number[] = [];
let consecutiveSlowPreviews = 0;
let cachedPreviewPlanet: { name: string; parameters: PlanetParameters } | undefined;

let gpuOperationQueue: Promise<unknown> = Promise.resolve();
export async function withGPULock<T>(op: () => Promise<T>): Promise<T> {
  const result = gpuOperationQueue.then(op, op);
  gpuOperationQueue = result.catch(() => {});
  return result;
}

function setStatus(message: string): void {
  $('status-message').textContent = message;
}

function recordStage(stage: string, details: Record<string, string | number | boolean> = {}): void {
  const entry: DiveStageLog = {
    stage,
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - runStartedAt),
    ...details,
  };
  diveStageLog.push(entry);
  $('app').dataset.diveDebug = JSON.stringify({ stageLog: diveStageLog });
  console.info('[mosaic-dive-stage]', entry);
}

function assertStartButtonHitTest(): void {
  const button = $<HTMLButtonElement>('start-button');
  const bounds = button.getBoundingClientRect();
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const target = document.elementFromPoint(centerX, centerY);
  const passed = target === button;
  $('app').dataset.startButtonHitTest = JSON.stringify({
    passed,
    target: target?.id || target?.tagName || 'none',
    x: Math.round(centerX),
    y: Math.round(centerY),
  });
  if (!passed) {
    throw new Error(`Start button hit-test failed at (${Math.round(centerX)}, ${Math.round(centerY)}): elementFromPoint returned <${target?.tagName?.toLowerCase()} id="${target?.id}"> instead of <button id="start-button">. Check overlap and pointer-events.`);
  }
}

function selectScene(scene: 'entry' | 'gathering' | 'flight' | 'landing' | 'error'): void {
  const scenes: Record<string, HTMLElement> = {
    entry: $('entry'),
    gathering: $('gathering'),
    flight: flightCanvas,
    landing: $('landing'),
    error: $('error-state'),
  };
  for (const [name, element] of Object.entries(scenes)) {
    const active = name === scene;
    element.style.display = active ? (name === 'flight' ? 'block' : 'flex') : 'none';
    if (name !== 'flight') element.setAttribute('aria-hidden', String(!active));
  }
  if (scene === 'flight') {
    flightCanvas.style.opacity = '1';
    stopAmbientWorld();
    if (ambientCanvas) ambientCanvas.style.display = 'none';
    if (ambientSatellites) ambientSatellites.style.display = 'none';
    $<HTMLCanvasElement>('preview-planet').style.display = 'none';
  } else if (scene === 'landing' || scene === 'error') {
    stopAmbientWorld();
    if (ambientCanvas) ambientCanvas.style.display = 'none';
    if (ambientSatellites) ambientSatellites.style.display = 'none';
    $<HTMLCanvasElement>('preview-planet').style.display = 'none';
  } else if (scene === 'gathering') {
    if (ambientCanvas) ambientCanvas.style.opacity = '0';
    if (ambientSatellites) ambientSatellites.style.opacity = '0';
    $<HTMLCanvasElement>('preview-planet').classList.remove('visible');
  } else if (scene === 'entry') {
    if (ambientCanvas) {
      ambientCanvas.style.display = 'block';
      ambientCanvas.style.opacity = '0.38';
    }
    if (ambientSatellites) {
      ambientSatellites.style.display = 'block';
      ambientSatellites.style.opacity = '1';
    }
    $<HTMLCanvasElement>('preview-planet').style.display = 'block';
    startAmbientLoop();
  }
  $('point').style.display = scene === 'entry' || scene === 'gathering' ? 'block' : 'none';
  $('sound-toggle').style.display = scene === 'landing' || scene === 'error' ? 'none' : 'block';
  if (scene === 'landing') {
    requestAnimationFrame(() => $('landing').classList.add('visible'));
  } else {
    $('landing').classList.remove('visible');
  }
}

function configFor(keyframe: DiveKeyframe): MosaicConfig {
  return {
    ...CONFIG,
    tileSize: PLANET_TILE_SIZE,
    gridW: 1,
    gridH: 1,
    maxIter: keyframe.maxIter,
    centerX: keyframe.centerXQ24 / Q24,
    centerY: keyframe.centerYQ24 / Q24,
    viewWidth: keyframe.scaleQ24 * PLANET_TILE_SIZE / Q24,
  };
}

function resizeFlightCanvas(): void {
  if (!flightCanvas || !flightContext) return;
  const bounds = $('app').getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  flightCanvas.width = Math.round(bounds.width * dpr);
  flightCanvas.height = Math.round(bounds.height * dpr);
  flightContext.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function currentMedianAndP95(samples: number[]): { median: number | null; p95: number | null } {
  if (samples.length === 0) return { median: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { median, p95 };
}

function smoothStep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function drawKeyframe(frame: PreparedFrame, currentWidthQ24: number, currentXQ24: number, currentYQ24: number, side: number, alpha: number): void {
  const sourceWidthQ24 = frame.keyframe.scaleQ24 * PLANET_TILE_SIZE;
  const scale = sourceWidthQ24 / currentWidthQ24;
  const centerX = window.innerWidth / 2 + (frame.keyframe.centerXQ24 - currentXQ24) / currentWidthQ24 * side;
  const centerY = window.innerHeight / 2 + (frame.keyframe.centerYQ24 - currentYQ24) / currentWidthQ24 * side;
  const displaySize = side * scale;
  flightContext.globalAlpha = alpha;
  flightContext.drawImage(frame.canvas, centerX - displaySize / 2, centerY - displaySize / 2, displaySize, displaySize);
}

let maskCanvas: HTMLCanvasElement | undefined;
let maskContext: CanvasRenderingContext2D | undefined;

function drawFeatheredIncomingKeyframe(
  frame: PreparedFrame,
  currentWidthQ24: number,
  currentXQ24: number,
  currentYQ24: number,
  side: number,
  alpha: number,
): void {
  const sourceWidthQ24 = frame.keyframe.scaleQ24 * PLANET_TILE_SIZE;
  const scale = sourceWidthQ24 / currentWidthQ24;
  const centerX = window.innerWidth / 2 + (frame.keyframe.centerXQ24 - currentXQ24) / currentWidthQ24 * side;
  const centerY = window.innerHeight / 2 + (frame.keyframe.centerYQ24 - currentYQ24) / currentWidthQ24 * side;
  const displaySize = Math.round(side * scale);
  if (displaySize <= 0) return;

  const targetDim = Math.min(2048, Math.max(displaySize, 512));
  if (!maskCanvas || maskCanvas.width !== targetDim || maskCanvas.height !== targetDim) {
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = targetDim;
    maskCanvas.height = targetDim;
    maskContext = maskCanvas.getContext('2d') ?? undefined;
  }
  const mCtx = maskContext;
  if (!mCtx) return;

  mCtx.clearRect(0, 0, targetDim, targetDim);
  mCtx.globalCompositeOperation = 'source-over';
  mCtx.drawImage(frame.canvas, 0, 0, targetDim, targetDim);

  // Smooth radial alpha mask matched to incoming content area
  // Outer rectangular perimeter feathers cleanly to 0 alpha so no hard edge ever shows
  mCtx.globalCompositeOperation = 'destination-in';
  const radGrad = mCtx.createRadialGradient(
    targetDim / 2, targetDim / 2, targetDim * 0.28,
    targetDim / 2, targetDim / 2, targetDim * 0.48,
  );
  radGrad.addColorStop(0, 'rgba(0,0,0,1)');
  radGrad.addColorStop(0.70, 'rgba(0,0,0,1)');
  radGrad.addColorStop(1, 'rgba(0,0,0,0)');
  mCtx.fillStyle = radGrad;
  mCtx.fillRect(0, 0, targetDim, targetDim);

  flightContext.globalAlpha = alpha;
  flightContext.drawImage(
    maskCanvas,
    0, 0, targetDim, targetDim,
    centerX - displaySize / 2, centerY - displaySize / 2, displaySize, displaySize,
  );
}

export function getBrightestAccent(paletteIndex: number): string {
  const paletteName = PALETTES_BY_INDEX[paletteIndex];
  if (!paletteName) throw new Error(`Unknown planet palette index: ${paletteIndex}`);
  const chromaticStops = PALETTES[paletteName].filter((stop) => Math.max(stop.r, stop.g, stop.b) - Math.min(stop.r, stop.g, stop.b) > 24);
  const brightest = chromaticStops.reduce((best, stop) => (
    stop.r * 0.2126 + stop.g * 0.7152 + stop.b * 0.0722
      > best.r * 0.2126 + best.g * 0.7152 + best.b * 0.0722
      ? stop
      : best
  ));
  return `#${[brightest.r, brightest.g, brightest.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

export async function previewPaletteIndex(name: string): Promise<number> {
  const normalized = normalizeName(name);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mosaic-v1:${normalized}`));
  const bytes = new Uint8Array(digest);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true) % 4;
}

function setPlanetAccent(paletteIndex: number): void {
  const accent = getBrightestAccent(paletteIndex);
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-glow', `${accent}55`);
  $('point').style.backgroundColor = accent;
  $('point').style.boxShadow = `0 0 10px 3px ${accent}66`;
}

function resizeAmbientCanvas(): void {
  if (!ambientCanvas || !ambientContext) return;
  const bounds = $('app').getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ambientCanvas.width = Math.round(bounds.width * dpr);
  ambientCanvas.height = Math.round(bounds.height * dpr);
  ambientContext.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export async function initAmbientWorld(gpuCtx: GPUFixedContext): Promise<void> {
  ambientCanvas = $<HTMLCanvasElement>('ambient-canvas');
  const ctx = ambientCanvas.getContext('2d');
  if (!ctx) return;
  ambientContext = ctx;
  ambientSatellites = $('ambient-satellites');
  resizeAmbientCanvas();

  const specs = [
    { centerX: -0.7436438870371587, centerY: 0.13182590420531197, scale_q24: 65536, maxIter: 350, pal: 0 },
    { centerX: -0.7436438870371587, centerY: 0.13182590420531197, scale_q24: 16384, maxIter: 500, pal: 1 },
    { centerX: -0.7436438870371587, centerY: 0.13182590420531197, scale_q24: 4096, maxIter: 650, pal: 2 },
    { centerX: -0.7436438870371587, centerY: 0.13182590420531197, scale_q24: 1024, maxIter: 800, pal: 3 },
  ];

  ambientKeyframes = [];
  for (const s of specs) {
    const cfg: MosaicConfig = {
      ...CONFIG,
      tileSize: 256,
      gridW: 1,
      gridH: 1,
      centerX: s.centerX,
      centerY: s.centerY,
      viewWidth: s.scale_q24 * 256 / Q24,
      maxIter: s.maxIter,
    };
    const tile = await withGPULock(() => computeTileFixedAdaptive(gpuCtx, 0, 0, cfg, 0));
    const canvas = renderTileToCanvas(tile.iter, tile.z2, 256, s.maxIter, {
      paletteName: PALETTES_BY_INDEX[s.pal],
      mappingMode: 'log',
      cycleSpeed: 1,
      edgeGlowIntensity: 0.8,
      planetMode: false,
      outputSize: 256,
    });
    ambientKeyframes.push({ canvas, scale_q24: s.scale_q24, centerX: s.centerX, centerY: s.centerY });
  }

  ambientStarted = performance.now();
  startAmbientLoop();
}

function startAmbientLoop(): void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    drawAmbientFrame(0);
    return;
  }
  ambientActive = true;
  cancelAnimationFrame(ambientRafId);

  const loop = (now: number) => {
    if (!ambientActive) return;
    if (document.hidden) {
      ambientRafId = requestAnimationFrame(loop);
      return;
    }
    const cycleMs = 24000;
    const raw = ((now - ambientStarted) % cycleMs) / cycleMs;
    drawAmbientFrame(raw);
    ambientRafId = requestAnimationFrame(loop);
  };
  ambientRafId = requestAnimationFrame(loop);
}

function stopAmbientWorld(): void {
  ambientActive = false;
  cancelAnimationFrame(ambientRafId);
}

function drawAmbientFrame(raw: number): void {
  if (!ambientCanvas || !ambientContext || ambientKeyframes.length === 0) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const side = Math.max(w, h);

  const t0 = performance.now();
  ambientContext.clearRect(0, 0, w, h);

  const pos = raw * (ambientKeyframes.length - 1);
  const idx = Math.min(Math.max(0, ambientKeyframes.length - 2), Math.floor(pos));
  const local = smoothStep(pos - idx);
  const from = ambientKeyframes[idx];
  const to = ambientKeyframes[Math.min(idx + 1, ambientKeyframes.length - 1)];
  if (!from || !to) return;

  const zoomFactor = 1 + local * 1.8;
  const dw = side * zoomFactor;
  const dh = side * zoomFactor;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;

  ambientContext.globalAlpha = 1 - local * 0.4;
  ambientContext.drawImage(from.canvas, dx, dy, dw, dh);
  if (local > 0.05) {
    ambientContext.globalAlpha = local;
    ambientContext.drawImage(to.canvas, dx, dy, dw, dh);
  }

  const rad = ambientContext.createRadialGradient(
    w / 2, h / 2, Math.min(w, h) * 0.16,
    w / 2, h / 2, Math.max(w, h) * 0.72,
  );
  rad.addColorStop(0, 'rgba(0, 0, 0, 0.90)');
  rad.addColorStop(0.48, 'rgba(0, 0, 0, 0.68)');
  rad.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  ambientContext.globalAlpha = 1;
  ambientContext.fillStyle = rad;
  ambientContext.fillRect(0, 0, w, h);

  const elapsed = performance.now() - t0;
  ambientDrawSamples.push(elapsed);
  if (ambientDrawSamples.length > 250) ambientDrawSamples.shift();
}

export async function initSamplePlanets(gpuCtx: GPUFixedContext): Promise<void> {
  const names = ['Priya', 'Rahul', 'Aman', 'Neha', 'Kuber', 'Artemis', 'Zenith'];
  const tracks = [
    { y: '6%', dur: '46s', delay: '-6s', scale: '0.65', scaleVal: 0.65, opacity: '0.65' },
    { y: '15%', dur: '54s', delay: '-18s', scale: '0.50', scaleVal: 0.50, opacity: '0.55' },
    { y: '9%', dur: '42s', delay: '-28s', scale: '0.70', scaleVal: 0.70, opacity: '0.70' },
    { y: '17%', dur: '50s', delay: '-38s', scale: '0.55', scaleVal: 0.55, opacity: '0.60' },
    { y: '80%', dur: '44s', delay: '-8s', scale: '0.75', scaleVal: 0.75, opacity: '0.70' },
    { y: '87%', dur: '48s', delay: '-22s', scale: '0.50', scaleVal: 0.50, opacity: '0.55' },
    { y: '82%', dur: '56s', delay: '-35s', scale: '0.60', scaleVal: 0.60, opacity: '0.65' },
  ];

  samplePlanetsCache = [];
  ambientSatellites.replaceChildren();

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const track = tracks[i];
    const planet = await createPlanet(name, async (x, y, scale, maxIter) => {
      const cfg: MosaicConfig = {
        ...CONFIG,
        tileSize: 64,
        gridW: 1,
        gridH: 1,
        centerX: x / Q24,
        centerY: y / Q24,
        viewWidth: scale * 64 / Q24,
        maxIter,
      };
      const res = await withGPULock(() => computeTileFixedAdaptive(gpuCtx, 0, 0, cfg, 0));
      return res.iter;
    });

    const tileCfg: MosaicConfig = {
      ...CONFIG,
      tileSize: 256,
      gridW: 1,
      gridH: 1,
      centerX: planet.centerXQ24 / Q24,
      centerY: planet.centerYQ24 / Q24,
      viewWidth: planet.scale_q24 * 256 / Q24,
      maxIter: Math.min(800, planet.maxIter),
    };
    const tile = await withGPULock(() => computeTileFixedAdaptive(gpuCtx, 0, 0, tileCfg, 0));
    const canvas = renderTileToCanvas(tile.iter, tile.z2, 256, tileCfg.maxIter, renderOptions(planet.paletteIndex, 128, true));

    samplePlanetsCache.push({ name, planetId: planet.planetId, paletteIndex: planet.paletteIndex, canvas });

    const item = document.createElement('div');
    item.className = 'drift-satellite';
    item.style.setProperty('--drift-y', track.y);
    item.style.setProperty('--drift-dur', track.dur);
    item.style.setProperty('--drift-delay', track.delay);
    item.style.setProperty('--drift-scale', track.scale);
    item.style.setProperty('--drift-opacity', track.opacity);
    item.dataset.samplePlanet = name;

    const pCanvas = document.createElement('canvas');
    pCanvas.className = 'drift-planet';
    pCanvas.width = 128;
    pCanvas.height = 128;
    const dim = Math.round(128 * track.scaleVal);
    pCanvas.style.width = `${dim}px`;
    pCanvas.style.height = `${dim}px`;
    const cCtx = pCanvas.getContext('2d');
    if (cCtx) cCtx.drawImage(canvas, 0, 0);

    const label = document.createElement('span');
    label.className = 'drift-name';
    label.textContent = name;

    item.append(pCanvas, label);
    ambientSatellites.append(item);
  }
}

function clearPreview(): void {
  $<HTMLCanvasElement>('preview-planet').classList.remove('visible');
  $('point').style.opacity = '1';
  document.documentElement.style.setProperty('--accent', '#c9c9c9');
  document.documentElement.style.setProperty('--accent-glow', 'rgba(200, 200, 200, 0.25)');
  cachedPreviewPlanet = undefined;
}

function triggerGuard(reason: string): void {
  livePreviewEnabled = false;
  clearPreview();
  setStatus('Live preview paused to keep typing smooth.');
  $('app').dataset.previewGuardTriggered = JSON.stringify({ reason, timings: previewTimings });
  console.warn('[mosaic-preview-guard]', reason);
}

export async function runLivePreview(name: string): Promise<PlanetParameters | undefined> {
  if (!livePreviewEnabled) return undefined;
  await ensureGPU();
  if (!fixed) return undefined;

  const runId = ++previewCounter;
  const t0 = performance.now();

  let normalized: string;
  try {
    normalized = normalizeName(name);
  } catch {
    clearPreview();
    return undefined;
  }

  const isSlowFault = typeof window !== 'undefined' && window.location.search.includes('preview-perf=slow');
  if (isSlowFault) {
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }

  let planet: PlanetParameters;
  try {
    planet = await createPlanet(normalized, async (x, y, scale, maxIter) => {
      if (!fixed || runId !== previewCounter) throw new Error('Preview cancelled');
      const cfg: MosaicConfig = {
        ...CONFIG,
        tileSize: 64,
        gridW: 1,
        gridH: 1,
        centerX: x / Q24,
        centerY: y / Q24,
        viewWidth: scale * 64 / Q24,
        maxIter,
      };
      const res = await withGPULock(() => computeTileFixedAdaptive(fixed!, 0, 0, cfg, 0));
      return res.iter;
    });
  } catch (err) {
    console.error('runLivePreview error:', err);
    return undefined;
  }

  if (runId !== previewCounter || !fixed) return undefined;

  const previewCfg: MosaicConfig = {
    ...CONFIG,
    tileSize: 192,
    gridW: 1,
    gridH: 1,
    centerX: planet.centerXQ24 / Q24,
    centerY: planet.centerYQ24 / Q24,
    viewWidth: planet.scale_q24 * 192 / Q24,
    maxIter: Math.min(800, planet.maxIter),
  };

  const tile = await withGPULock(() => computeTileFixedAdaptive(fixed!, 0, 0, previewCfg, 0));
  if (runId !== previewCounter) return undefined;

  const canvas = renderTileToCanvas(tile.iter, tile.z2, 192, previewCfg.maxIter, renderOptions(planet.paletteIndex, 192, true));

  const previewCanvas = $<HTMLCanvasElement>('preview-planet');
  const pCtx = previewCanvas.getContext('2d');
  if (pCtx) {
    pCtx.clearRect(0, 0, 192, 192);
    pCtx.drawImage(canvas, 0, 0);
  }

  const accent = getBrightestAccent(planet.paletteIndex);
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-glow', `${accent}55`);

  previewCanvas.classList.add('visible');
  $('point').style.opacity = '0';

  cachedPreviewPlanet = { name: normalized, parameters: planet };

  const elapsed = performance.now() - t0 + (isSlowFault ? 450 : 0);
  previewTimings.push(elapsed);

  if (previewTimings.length === 1 && elapsed > 400) {
    triggerGuard(`Preview compute ${Math.round(elapsed)} ms exceeded 400 ms on first probe.`);
  } else if (elapsed > 600) {
    consecutiveSlowPreviews++;
    if (consecutiveSlowPreviews >= 2) {
      triggerGuard(`Two consecutive previews exceeded 600 ms (${Math.round(elapsed)} ms).`);
    }
  } else {
    consecutiveSlowPreviews = 0;
  }

  return planet;
}

function renderOptions(paletteIndex: number, outputSize: number, planetMode: boolean, name?: string, hash?: string) {
  const paletteName = PALETTES_BY_INDEX[paletteIndex];
  if (!paletteName) throw new Error(`Unknown planet palette index: ${paletteIndex}`);
  const options = {
    paletteName,
    mappingMode: 'log' as const,
    cycleSpeed: 1,
    edgeGlowIntensity: 0.8,
    planetMode,
    outputSize,
    ...(name && hash ? { caption: { name, hash8: hash } } : {}),
  };
  return options;
}

function makeParticleName(name: string): void {
  const parent = $('gathering-particles');
  parent.replaceChildren();
  const characters = Array.from(name);
  const total = characters.length;
  characters.forEach((character, index) => {
    const point = document.createElement('span');
    point.className = 'letter-particle';
    point.textContent = character === ' ' ? '\u00a0' : character;
    const fromX = (index - (total - 1) / 2) * 20;
    point.style.setProperty('--from-x', `${fromX}px`);
    point.style.setProperty('--from-y', '0px');
    // Drift straight into central light (#point) located at (50%, 26%)
    // Since #gathering-particles is at (50%, 48%), target Y is -22svh
    point.style.setProperty('--to-x', `${-fromX}px`);
    point.style.setProperty('--to-y', '-22svh');
    point.style.setProperty('--delay', `${Math.min(index * 24, 400)}ms`);
    parent.append(point);
  });
}

function beginSwell(): void {
  if (!audioEnabled) return;
  try {
    const context = audioContext ?? new AudioContext();
    audioContext = context;
    void context.resume().then(() => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(58, now);
      oscillator.frequency.exponentialRampToValueAtTime(42, now + 2.7);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.018, now + 1.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 5.1);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 5.2);
      audioOscillator = oscillator;
      audioGain = gain;
    }).catch((error: unknown) => {
      setStatus(`Sound could not start: ${error instanceof Error ? error.message : String(error)}.`);
      audioEnabled = false;
      updateSoundButton();
    });
  } catch (error) {
    setStatus(`Sound is unavailable: ${error instanceof Error ? error.message : String(error)}.`);
    audioEnabled = false;
    updateSoundButton();
  }
}

function stopSwell(): void {
  if (!audioContext || !audioGain || !audioOscillator) return;
  try {
    audioGain.gain.cancelScheduledValues(audioContext.currentTime);
    audioGain.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.08);
    audioOscillator.stop(audioContext.currentTime + 0.5);
  } catch (error) {
    console.error('Could not stop dive sound cleanly:', error);
  }
  audioOscillator = undefined;
  audioGain = undefined;
}

function updateSoundButton(): void {
  const button = $<HTMLButtonElement>('sound-toggle');
  button.textContent = audioEnabled ? 'Sound on' : 'Sound off';
  button.setAttribute('aria-pressed', String(audioEnabled));
  button.setAttribute('aria-label', audioEnabled ? 'Turn sound off' : 'Turn sound on');
}

let adapterVendor = 'unknown';
let adapterArch = 'unknown';

function showWebGPUFailure(msg: string): void {
  diveActive = false;
  const overlay = $('webgpu-failure');
  overlay.style.display = 'flex';
  const p = overlay.querySelector('p');
  if (p) p.textContent = msg;
}

async function ensureGPU(): Promise<void> {
  if (fixed) return;
  const isNoGpuFault = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('nogpu') === '1';
  if (!navigator.gpu || isNoGpuFault) {
    showWebGPUFailure('This needs WebGPU. Try a recent Chrome or Edge, or Safari 26 or newer.');
    return;
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    adapter = null;
  }
  if (!adapter) {
    showWebGPUFailure('This needs WebGPU. Try a recent Chrome or Edge, or Safari 26 or newer.');
    return;
  }
  try {
    const info = (adapter as unknown as { info?: { vendor?: string; architecture?: string } }).info;
    if (info) {
      adapterVendor = info.vendor || 'unknown';
      adapterArch = info.architecture || 'unknown';
    }
  } catch {}
  const device = await adapter.requestDevice();
  const context = await initGPUFixed(device, 8);
  fixed = context;
  void device.lost.then((info) => {
    if (fixed?.device !== device) return;
    fixed = undefined;
    const injectedLoss = injectedDeviceLossPending;
    injectedDeviceLossPending = false;
    if (info.reason !== 'destroyed' || injectedLoss) {
      recordStage('GPU device lost', { reason: info.reason || 'unknown', injected: injectedLoss });
      runSequence++;
      stopSwell();
      showWebGPUFailure('The GPU device stopped during the session. Refresh to restart WebGPU.');
    }
  }).catch((error: unknown) => {
    console.error('GPU device-loss notification failed:', error);
  });
}

function showError(message: string): void {
  diveActive = false;
  $('error-message').textContent = message;
  selectScene('error');
}

let baselineOverheadMs: number | undefined;
let aluRatePerPixelIter: number | undefined;

async function calibrateGPU(ctx: GPUFixedContext): Promise<void> {
  const tOverhead0 = performance.now();
  await withGPULock(() => computeTileFixedAdaptive(ctx, 42, 16, { ...CONFIG, maxIter: 1 }, 0));
  baselineOverheadMs = performance.now() - tOverhead0;

  const tCalib0 = performance.now();
  await withGPULock(() => computeTileFixedAdaptive(ctx, 42, 16, CONFIG, 0));
  const totalCalibMs = performance.now() - tCalib0;

  const aluCalibMs = Math.max(0.01, totalCalibMs - baselineOverheadMs);
  const calibPixelIters = CONFIG.tileSize * CONFIG.tileSize * CONFIG.maxIter;
  aluRatePerPixelIter = aluCalibMs / calibPixelIters;
  calibrationMs = totalCalibMs;
}

async function calibratedTile(keyframe: DiveKeyframe): Promise<AdaptiveFixedTileResult> {
  if (!fixed) throw new Error('The WebGPU device is not ready. Restart the dive.');
  const cfg = configFor(keyframe);
  if (aluRatePerPixelIter === undefined) {
    await calibrateGPU(fixed);
  }
  const pixelIters = cfg.tileSize ** 2 * cfg.maxIter;
  const estimate = (baselineOverheadMs ?? 2) + (aluRatePerPixelIter ?? 0.000001) * pixelIters;
  const context = fixed;
  let timeout = 0;
  try {
    return await Promise.race([
      withGPULock(() => computeTileFixedAdaptive(context, 0, 0, cfg, estimate, 100, 32)),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          if (fixed?.device === context.device) fixed = undefined;
          reject(new Error('A 512×512 keyframe did not finish within 60 seconds. Restart the dive or use a faster WebGPU device.'));
        }, FRAME_GPU_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function makePlanetPortrait(tile: AdaptiveFixedTileResult, parameters: PlanetParameters): HTMLCanvasElement {
  return renderTileToCanvas(tile.iter, tile.z2, PLANET_TILE_SIZE, PLANET_MAX_ITER, renderOptions(
    parameters.paletteIndex,
    1024,
    true,
  ));
}

function createDebugReport(
  name: string,
  parameters: PlanetParameters,
  frames: PreparedFrame[],
  totalMs: number,
  samples: number[],
  reducedMotion: boolean,
): DiveDebugReport {
  const timing = currentMedianAndP95(samples);
  return {
    normalizedName: name,
    planetId: parameters.planetId,
    finalPlanetHash: frames.at(-1)?.hash ?? '',
    paletteIndex: parameters.paletteIndex,
    keyframeComputeMs: totalMs,
    calibrationMs,
    frameTimeMedianMs: timing.median,
    frameTimeP95Ms: timing.p95,
    reducedMotion,
    stageLog: [...diveStageLog],
    keyframes: frames.map(({ keyframe, hash, tile }) => ({
      ...keyframe,
      fnv1a: hash,
      chunked: tile.chunked,
      estimatedMs: tile.estimatedMs,
    })),
  };
}

async function computeFrames(
  parameters: PlanetParameters,
  keyframes: DiveKeyframe[],
  runId: number,
  gatherStarted: number,
  isCancelled: () => boolean,
): Promise<PreparedFrame[]> {
  const frames: PreparedFrame[] = [];
  const paletteName = PALETTES_BY_INDEX[parameters.paletteIndex];
  if (!paletteName) throw new Error(`Unknown planet palette index: ${parameters.paletteIndex}`);
  for (const keyframe of keyframes) {
    if (isCancelled() || runId !== runSequence) throw new Error('This dive was cancelled because keyframe preparation timed out or the GPU device changed.');
    if (!fixed) throw new Error('The WebGPU device was lost. Restart the dive to try again.');
    $('gathering-message').textContent = `Finding your planet. ${frames.length + 1} of ${keyframes.length}`;
    const keyframeStarted = performance.now();
    if (new URLSearchParams(window.location.search).get('fault') === 'keyframe-timeout' && !injectedTimeoutUsed) {
      injectedTimeoutUsed = true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, KEYFRAME_TIMEOUT_MS + 250));
    }
    if (isCancelled()) throw new Error('Keyframe preparation exceeded 8 seconds. Retry the dive; use a faster WebGPU device if it happens again.');
    const tile = await calibratedTile(keyframe);
    if (isCancelled() || runId !== runSequence) throw new Error('This dive was cancelled because keyframe preparation timed out or the GPU device changed.');
    const hash = fnv1a32(u16LittleEndian(tile.iter));
    const canvas = renderTileToCanvas(tile.iter, tile.z2, PLANET_TILE_SIZE, keyframe.maxIter, {
      paletteName,
      mappingMode: 'log',
      cycleSpeed: 1,
      edgeGlowIntensity: 0.8,
      planetMode: false,
      outputSize: PLANET_TILE_SIZE,
    });
    frames.push({ keyframe, tile, canvas, hash });
    recordStage(`keyframe ${keyframe.index} computed`, {
      hash,
      computeMs: Math.round(performance.now() - keyframeStarted),
      keyframeIndex: keyframe.index,
      totalKeyframes: keyframes.length,
    });
    $('app').dataset.gatherElapsed = String(Math.round(performance.now() - gatherStarted));
  }
  recordStage('keyframes ready', { count: frames.length });
  return frames;
}

let lastPreparedFrames: PreparedFrame[] | undefined;

export function renderFlightFrame(
  frames: PreparedFrame[],
  raw: number,
  side: number,
  landingPlanet?: { canvas: HTMLCanvasElement },
): void {
  const progress = smoothStep(Math.max(0, Math.min(1, raw)));
  const position = progress * (frames.length - 1);
  const index = Math.min(frames.length - 2, Math.floor(position));
  const local = position >= frames.length - 1 ? 1 : smoothStep(position - index);
  const from = frames[index];
  const to = frames[Math.min(index + 1, frames.length - 1)];
  const fromWidth = from.keyframe.scaleQ24 * PLANET_TILE_SIZE;
  const toWidth = to.keyframe.scaleQ24 * PLANET_TILE_SIZE;
  const currentWidth = fromWidth * (toWidth / fromWidth) ** local;
  const currentX = Math.round(from.keyframe.centerXQ24 + (to.keyframe.centerXQ24 - from.keyframe.centerXQ24) * local);
  const currentY = Math.round(from.keyframe.centerYQ24 + (to.keyframe.centerYQ24 - from.keyframe.centerYQ24) * local);

  flightContext.globalAlpha = 1;
  flightContext.fillStyle = '#000000';
  flightContext.fillRect(0, 0, window.innerWidth, window.innerHeight);
  drawKeyframe(from, currentWidth, currentX, currentY, side, 1 - local);
  if (local > 0) drawFeatheredIncomingKeyframe(to, currentWidth, currentX, currentY, side, local);

  if (landingPlanet && progress > 0.94) {
    const fade = smoothStep((progress - 0.94) / 0.06);
    flightContext.globalAlpha = fade;
    const portraitSide = Math.min(window.innerWidth * 0.92, window.innerHeight * 0.52, 640);
    flightContext.drawImage(landingPlanet.canvas, (window.innerWidth - portraitSide) / 2, (window.innerHeight - portraitSide) / 2, portraitSide, portraitSide);
  }
  flightContext.globalAlpha = 1;
}

function animateDive(frames: PreparedFrame[], runId: number): Promise<number[]> {
  lastPreparedFrames = frames;
  return new Promise((resolve, reject) => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    frameSamples = [];
    if (reduceMotion) {
      resolve(frameSamples);
      return;
    }
    beginSwell();
    resizeFlightCanvas();
    const started = performance.now();
    const side = Math.max(window.innerWidth, window.innerHeight);

    // Draw first frame immediately so canvas is never blank or waiting for rAF
    renderFlightFrame(frames, 0, side, lastPlanet);
    if (!flightCanvas.dataset.firstFrameDrawn) {
      flightCanvas.dataset.firstFrameDrawn = 'true';
      recordStage('first frame drawn');
    }

    let isCompleted = false;
    let rafId = 0;
    let fallbackTimer = 0;

    const finish = () => {
      if (isCompleted) return;
      isCompleted = true;
      cancelAnimationFrame(rafId);
      clearTimeout(fallbackTimer);
      stopSwell();
      resolve(frameSamples);
    };

    // State machine advances by timestamp so hidden/background tabs never get stuck
    fallbackTimer = window.setTimeout(() => {
      finish();
    }, DIVE_DURATION_MS + 250);

    const draw = (now: number) => {
      if (isCompleted) return;
      if (runId !== runSequence || !fixed) {
        clearTimeout(fallbackTimer);
        cancelAnimationFrame(rafId);
        reject(new Error('The GPU device was lost during the dive. Restart the dive to try again.'));
        return;
      }
      const raw = Math.min(1, (now - started) / DIVE_DURATION_MS);

      // Measure exact draw execution time around draw calls (D2)
      const tDraw0 = performance.now();
      renderFlightFrame(frames, raw, side, lastPlanet);
      const tDrawElapsed = performance.now() - tDraw0;
      frameSamples.push(tDrawElapsed);

      if (new URLSearchParams(window.location.search).get('fault') === 'device-lost' && !injectedDeviceLossUsed) {
        injectedDeviceLossUsed = true;
        injectedDeviceLossPending = true;
        recordStage('injected device loss');
        fixed.device.destroy();
      }

      if (raw >= 1) {
        finish();
      } else {
        rafId = requestAnimationFrame(draw);
      }
    };

    rafId = requestAnimationFrame(draw);
  });
}

function showPlanet(
  name: string,
  parameters: PlanetParameters,
  tile: AdaptiveFixedTileResult,
  hash: string,
  portrait: HTMLCanvasElement,
): void {
  const visibleCanvas = $<HTMLCanvasElement>('planet-portrait');
  visibleCanvas.width = 1024;
  visibleCanvas.height = 1024;
  const context = visibleCanvas.getContext('2d');
  if (!context) throw new Error('Could not create a 2D canvas for the final planet.');
  context.clearRect(0, 0, 1024, 1024);
  context.drawImage(portrait, 0, 0, 1024, 1024);
  visibleCanvas.setAttribute('aria-label', `Planet ${name}`);
  lastPlanet = { name, parameters, tile, hash, canvas: portrait };

  // Debug fingerprint (?debug=1 only)
  const isDebug = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
  const debugEl = $('debug-fingerprint');
  if (isDebug) {
    debugEl.style.display = 'flex';
    const text = `planetId: ${parameters.planetId} | counter: ${parameters.counter} | paletteIndex: ${parameters.paletteIndex} (${PALETTES_BY_INDEX[parameters.paletteIndex]}) | hash: 0x${hash} | adapter: ${adapterVendor}/${adapterArch}`;
    $('debug-text').textContent = text;
    const copyBtn = $<HTMLButtonElement>('debug-copy-btn');
    copyBtn.onclick = () => {
      void navigator.clipboard?.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      });
    };
  } else {
    debugEl.style.display = 'none';
  }

  selectScene('landing');
  diveActive = false;
  recordStage('landing visible', { hash });
}

async function startDive(event?: Event): Promise<void> {
  event?.preventDefault();
  assertStartButtonHitTest();
  const input = $<HTMLInputElement>('planet-name');
  let normalizedName: string;
  try {
    normalizedName = normalizeName(input.value);
  } catch (error) {
    setStatus(error instanceof Error && /empty/u.test(error.message)
      ? 'Enter a name to start the dive.'
      : 'Use a name with 40 characters or fewer, then try again.');
    input.focus();
    $('name-control').classList.remove('invalid');
    void $('name-control').offsetWidth;
    $('name-control').classList.add('invalid');
    return;
  }
  const displayName = input.value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

  // S2: Update address bar with history.replaceState
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('n', normalizedName);
    window.history.replaceState(null, '', url.toString());
  } catch {}

  const thisRun = ++runSequence;
  diveActive = true;
  runStartedAt = performance.now();
  diveStageLog = [];
  $('app').removeAttribute('data-dive-debug');
  $('flight').removeAttribute('data-first-frame-drawn');
  recordStage('dive started');
  const gatherStarted = performance.now();
  const minGathering = new Promise<void>((resolve) => window.setTimeout(resolve, GATHER_MIN_MS));
  let longGatherTimer = 0;
  $('start-button').setAttribute('disabled', 'true');
  setStatus('');
  $('name-control').classList.remove('invalid');
  makeParticleName(displayName);
  selectScene('gathering');
  longGatherTimer = window.setTimeout(() => {
    if (thisRun === runSequence) $('gathering-message').textContent = 'Your view is coming into focus.';
  }, 3000);

  try {
    await ensureGPU();
    let parameters: PlanetParameters;
    if (cachedPreviewPlanet && cachedPreviewPlanet.name === normalizedName) {
      parameters = cachedPreviewPlanet.parameters;
      recordStage('engine result reused from preview', { planetId: parameters.planetId, regionIndex: parameters.regionIndex });
    } else {
      parameters = await createPlanet(normalizedName, async (x, y, scale, maxIter) => {
        if (!fixed || thisRun !== runSequence) throw new Error('The GPU device was lost. Restart the dive to try again.');
        const config: MosaicConfig = {
          ...CONFIG,
          tileSize: 64,
          gridW: 1,
          gridH: 1,
          centerX: x / Q24,
          centerY: y / Q24,
          viewWidth: scale * 64 / Q24,
          maxIter,
        };
        const probe = await withGPULock(() => computeTileFixedAdaptive(fixed!, 0, 0, config, 0));
        return probe.iter;
      });
      if (thisRun !== runSequence) return;
      recordStage('engine result ready', { planetId: parameters.planetId, regionIndex: parameters.regionIndex });
    }
    setPlanetAccent(parameters.paletteIndex);
    const keyframes = makeDiveKeyframes(parameters);
    const keyframesStarted = performance.now();
    let preparationCancelled = false;
    let keyframeTimeout = 0;
    const frames = await Promise.race([
      computeFrames(parameters, keyframes, thisRun, gatherStarted, () => preparationCancelled),
      new Promise<never>((_, reject) => {
        keyframeTimeout = window.setTimeout(() => {
          preparationCancelled = true;
          fixed = undefined;
          calibrationMs = undefined;
          recordStage('keyframe preparation timed out', { timeoutMs: KEYFRAME_TIMEOUT_MS });
          reject(new Error('Keyframes were not ready within 8 seconds. Retry the dive; use a faster WebGPU device if it happens again.'));
        }, KEYFRAME_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(keyframeTimeout));
    const keyframeComputeMs = performance.now() - keyframesStarted;
    const finalFrame = frames.at(-1);
    if (!finalFrame) throw new Error('No dive keyframes were generated.');
    const finalHash = finalFrame.hash;
    const portrait = makePlanetPortrait(finalFrame.tile, parameters);
    lastPlanet = { name: displayName, parameters, tile: finalFrame.tile, hash: finalHash, canvas: portrait };

    await minGathering;
    if (thisRun !== runSequence || !fixed) return;
    clearTimeout(longGatherTimer);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      selectScene('landing');
      showPlanet(displayName, parameters, finalFrame.tile, finalHash, portrait);
      const report = createDebugReport(normalizedName, parameters, frames, keyframeComputeMs, [], true);
      $('app').dataset.diveDebug = JSON.stringify(report);
      console.info('[mosaic-dive-debug]', report);
      return;
    }

    selectScene('flight');
    recordStage('flight visible');
    const samples = await animateDive(frames, thisRun);
    if (thisRun !== runSequence || !fixed) return;
    showPlanet(displayName, parameters, finalFrame.tile, finalHash, portrait);
    const report = createDebugReport(normalizedName, parameters, frames, keyframeComputeMs, samples, false);
    $('app').dataset.diveDebug = JSON.stringify(report);
    console.info('[mosaic-dive-debug]', report);
  } catch (error) {
    if (thisRun !== runSequence) return;
    stopSwell();
    const message = error instanceof Error ? error.message : String(error);
    showError(message.includes('scale_q24')
      ? `${message} Choose another name to try a different planet.`
      : message);
  } finally {
    clearTimeout(longGatherTimer);
    if (thisRun === runSequence) $('start-button').removeAttribute('disabled');
  }
}

function savePlanet(): void {
  if (!lastPlanet) {
    setStatus('Create a planet before saving it.');
    return;
  }
  const canvas = renderTileToCanvas(
    lastPlanet.tile.iter,
    lastPlanet.tile.z2,
    PLANET_TILE_SIZE,
    PLANET_MAX_ITER,
    renderOptions(lastPlanet.parameters.paletteIndex, 1024, true, lastPlanet.name, lastPlanet.hash),
  );
  canvas.toBlob((blob) => {
    if (!blob) {
      showError('The PNG could not be created. Try saving the planet again.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mosaic-planet-${lastPlanet?.parameters.planetId}-${lastPlanet?.hash}.png`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

export async function buildShareCard(
  name: string,
  parameters: PlanetParameters,
  tile: AdaptiveFixedTileResult,
): Promise<HTMLCanvasElement> {
  const card = document.createElement('canvas');
  card.width = 1080;
  card.height = 1350;
  const ctx = card.getContext('2d');
  if (!ctx) throw new Error('Could not create share card context');

  // Pure black background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1080, 1350);

  // Render planet portrait at 1024x1024
  const planetCanvas = renderTileToCanvas(
    tile.iter,
    tile.z2,
    PLANET_TILE_SIZE,
    parameters.maxIter,
    renderOptions(parameters.paletteIndex, 1024, true),
  );

  // Draw planet in upper center area
  ctx.drawImage(planetCanvas, 28, 80, 1024, 1024);

  // Typography - System fonts only
  const accent = getBrightestAccent(parameters.paletteIndex);

  // Name (large)
  const fontSize = name.length > 28 ? 38 : name.length > 16 ? 48 : 58;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = '#f2f2f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 540, 1155);

  // Planet ID (small)
  ctx.font = '500 24px system-ui, -apple-system, monospace';
  ctx.fillStyle = accent;
  ctx.fillText(`PLANET ${parameters.planetId.toUpperCase()}`, 540, 1220);

  // Site URL (one subtle line)
  ctx.font = '400 20px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#72747d';
  ctx.fillText(SITE_URL, 540, 1275);

  return card;
}

async function sharePlanet(): Promise<void> {
  if (!lastPlanet) return;
  const card = await buildShareCard(lastPlanet.name, lastPlanet.parameters, lastPlanet.tile);
  const blob = await new Promise<Blob | null>((resolve) => card.toBlob(resolve, 'image/png'));
  if (!blob) return;

  const fileName = `${lastPlanet.name.toLowerCase().replace(/[^a-z0-9_-]/gu, '_') || 'planet'}-card.png`;
  const file = new File([blob], fileName, { type: 'image/png' });

  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: `${lastPlanet.name}'s Planet`,
        text: `See ${lastPlanet.name}'s planet in the Mandelbrot set: ${SITE_URL}/?n=${encodeURIComponent(lastPlanet.name)}`,
        files: [file],
      });
      return;
    } catch {
      // User cancelled or share error; fall through to direct download
    }
  }

  // Fallback direct download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function tryAnotherName(): void {
  runSequence++;
  stopSwell();
  lastPlanet = undefined;
  $<HTMLInputElement>('planet-name').value = '';
  $('name-display').textContent = '';
  $<HTMLButtonElement>('start-button').textContent = 'Fall into your planet';
  clearPreview();
  $('app').removeAttribute('data-dive-debug');
  const url = new URL(window.location.href);
  url.searchParams.delete('n');
  url.searchParams.delete('v');
  history.replaceState(null, '', url);
  setStatus('');
  selectScene('entry');
  $<HTMLInputElement>('planet-name').focus();
}

async function restart(): Promise<void> {
  $('restart-button').setAttribute('disabled', 'true');
  runSequence++;
  try {
    stopSwell();
    if (!fixed) {
      calibrationMs = undefined;
      baselineOverheadMs = undefined;
      aluRatePerPixelIter = undefined;
    }
    await ensureGPU();
    selectScene('entry');
    setStatus('Retrying with the same name.');
    await startDive();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
  } finally {
    $('restart-button').removeAttribute('disabled');
  }
}

async function initialize(): Promise<void> {
  flightCanvas = $<HTMLCanvasElement>('flight');
  const context = flightCanvas.getContext('2d');
  if (!context) throw new Error('This browser cannot create the canvas used for the dive.');
  flightContext = context;
  resizeFlightCanvas();

  ambientCanvas = $<HTMLCanvasElement>('ambient-canvas');
  ambientSatellites = $('ambient-satellites');
  resizeAmbientCanvas();

  resizeObserver = new ResizeObserver(() => {
    resizeFlightCanvas();
    resizeAmbientCanvas();
  });
  resizeObserver.observe($('app'));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAmbientWorld();
    } else if (!diveActive) {
      startAmbientLoop();
    }
  });

  window.addEventListener('pagehide', () => {
    runSequence++;
    stopSwell();
    stopAmbientWorld();
    fixed?.device.destroy();
    resizeObserver?.disconnect();
    void audioContext?.close();
  }, { once: true });

  $<HTMLFormElement>('entry').addEventListener('submit', (event) => {
    void startDive(event).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  });
  $('name-control').addEventListener('click', () => {
    const input = $<HTMLInputElement>('planet-name');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  let initialQueryName = '';
  try {
    const rawQuery = new URLSearchParams(window.location.search).get('n');
    if (rawQuery) {
      try {
        initialQueryName = decodeURIComponent(rawQuery);
      } catch {
        initialQueryName = rawQuery;
      }
      try {
        normalizeName(initialQueryName);
        const input = $<HTMLInputElement>('planet-name');
        input.value = initialQueryName;
        $('name-display').textContent = initialQueryName;
        const startBtn = $<HTMLButtonElement>('start-button');
        startBtn.textContent = `See ${initialQueryName}'s planet`;
        void ensureGPU().then(() => {
          void runLivePreview(initialQueryName);
        });
      } catch {
        // Invalid query name; leave blank
      }
    }
  } catch {}

  $<HTMLInputElement>('planet-name').addEventListener('input', (event) => {
    const val = (event.currentTarget as HTMLInputElement).value;
    $('name-display').textContent = val;
    setStatus('');
    $('name-control').classList.remove('invalid');
    assertStartButtonHitTest();

    if (!initialQueryName || val !== initialQueryName) {
      $<HTMLButtonElement>('start-button').textContent = 'Fall into your planet';
    }

    clearTimeout(previewTimer);
    if (!val.trim()) {
      clearPreview();
      return;
    }

    if (!livePreviewEnabled) return;

    previewTimer = window.setTimeout(() => {
      void runLivePreview(val);
    }, 350);
  });
  $<HTMLButtonElement>('save-button').addEventListener('click', savePlanet);
  $<HTMLButtonElement>('share-button').addEventListener('click', () => { void sharePlanet(); });
  $<HTMLButtonElement>('again-button').addEventListener('click', tryAnotherName);
  $<HTMLButtonElement>('restart-button').addEventListener('click', () => { void restart(); });
  $<HTMLButtonElement>('sound-toggle').addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    updateSoundButton();
    if (!audioEnabled) stopSwell();
    else if (audioContext?.state === 'suspended') {
      void audioContext.resume().catch((error: unknown) => {
        setStatus(`Sound could not start: ${error instanceof Error ? error.message : String(error)}.`);
      });
    }
  });
  updateSoundButton();
  selectScene('entry');
  setStatus('');
  assertStartButtonHitTest();

  void ensureGPU().then(async () => {
    if (fixed) {
      await initAmbientWorld(fixed);
      await initSamplePlanets(fixed);
    }
  }).catch((err: unknown) => {
    console.warn('WebGPU init deferred for ambient world:', err);
  });

  (window as unknown as { __mosaicHomeTest?: unknown }).__mosaicHomeTest = {
    getAmbientStats: () => {
      const { median, p95 } = currentMedianAndP95(ambientDrawSamples);
      return {
        drawTimeMedianMs: median,
        drawTimeP95Ms: p95,
        sampleCount: ambientDrawSamples.length,
        isActive: ambientActive,
      };
    },
    getSamplePlanets: () => samplePlanetsCache.map((p) => ({
      name: p.name,
      planetId: p.planetId,
      paletteIndex: p.paletteIndex,
    })),
    getPreviewPlanet: () => cachedPreviewPlanet,
    isLivePreviewEnabled: () => livePreviewEnabled,
    getPreviewTimings: () => [...previewTimings],
    triggerPreviewManually: async (name: string) => {
      await runLivePreview(name);
      return cachedPreviewPlanet;
    },
    computeFinalPlanet: async (name: string) => {
      await ensureGPU();
      if (!fixed) throw new Error('No fixed GPU');
      return createPlanet(normalizeName(name), async (x, y, scale, maxIter) => {
        const config: MosaicConfig = {
          ...CONFIG,
          tileSize: 64,
          gridW: 1,
          gridH: 1,
          centerX: x / Q24,
          centerY: y / Q24,
          viewWidth: scale * 64 / Q24,
          maxIter,
        };
        const probe = await withGPULock(() => computeTileFixedAdaptive(fixed!, 0, 0, config, 0));
        return probe.iter;
      });
    },
    buildShareCardForTest: async (name: string) => {
      const p = await (window as unknown as { __mosaicHomeTest: { computeFinalPlanet: (n: string) => Promise<PlanetParameters> } }).__mosaicHomeTest.computeFinalPlanet(name);
      const keyframes = makeDiveKeyframes(p);
      const finalKf = keyframes[keyframes.length - 1];
      const tile = await calibratedTile(finalKf);
      return await buildShareCard(name, p, tile);
    },
  };

  (window as unknown as { __mosaicDiveTest?: unknown }).__mosaicDiveTest = {
    renderFrameAt: (raw: number) => {
      if (!lastPreparedFrames) throw new Error('No prepared frames available');
      const side = Math.max(window.innerWidth, window.innerHeight);
      renderFlightFrame(lastPreparedFrames, raw, side, lastPlanet);
    },
    getPreparedFrames: () => lastPreparedFrames,
    getLastPlanet: () => lastPlanet,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
  });
}
