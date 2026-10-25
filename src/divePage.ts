import { CONFIG } from './config';
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
  $('point').style.backgroundColor = accent;
  $('point').style.boxShadow = `0 0 10px 3px ${accent}66`;
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
    // Drift straight into the central light (#point) located at (50%, 32%)
    // Since #gathering-particles is at (50%, 48%), target Y is -16svh
    point.style.setProperty('--to-x', `${-fromX}px`);
    point.style.setProperty('--to-y', '-16svh');
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

async function ensureGPU(): Promise<void> {
  if (fixed) return;
  if (!navigator.gpu) {
    throw new Error('This browser does not expose WebGPU. Open this page in a current WebGPU-enabled browser.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available. Try a browser or device with WebGPU enabled.');
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
      if (diveActive) showError('The GPU device stopped during the dive. Select Retry this dive to rebuild the renderer and run it again.');
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
  await computeTileFixedAdaptive(ctx, 42, 16, { ...CONFIG, maxIter: 1 }, 0);
  baselineOverheadMs = performance.now() - tOverhead0;

  const tCalib0 = performance.now();
  await computeTileFixedAdaptive(ctx, 42, 16, CONFIG, 0);
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
      computeTileFixedAdaptive(context, 0, 0, cfg, estimate, 100, 32),
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
  $('landing-name').textContent = name;
  lastPlanet = { name, parameters, tile, hash, canvas: portrait };
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
    const parameters = await createPlanet(normalizedName, async (x, y, scale, maxIter) => {
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
      const probe = await computeTileFixedAdaptive(fixed, 0, 0, config, 0);
      return probe.iter;
    });
    if (thisRun !== runSequence) return;
    recordStage('engine result ready', { planetId: parameters.planetId, regionIndex: parameters.regionIndex });
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

function tryAnotherName(): void {
  runSequence++;
  stopSwell();
  lastPlanet = undefined;
  $<HTMLInputElement>('planet-name').value = '';
  $('name-display').textContent = '';
  document.documentElement.style.setProperty('--accent', '#c9c9c9');
  $('point').style.backgroundColor = '#c9c9c9';
  $('point').style.boxShadow = '0 0 8px 2px rgba(255, 255, 255, .3)';
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
  resizeObserver = new ResizeObserver(resizeFlightCanvas);
  resizeObserver.observe($('app'));
  window.addEventListener('pagehide', () => {
    runSequence++;
    stopSwell();
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
  $<HTMLInputElement>('planet-name').addEventListener('input', (event) => {
    const val = (event.currentTarget as HTMLInputElement).value;
    $('name-display').textContent = val;
    setStatus('');
    $('name-control').classList.remove('invalid');
    assertStartButtonHitTest();

    // Option (b): Keep preview neutral while typing; change light colour at dive start
    document.documentElement.style.setProperty('--accent', '#c9c9c9');
    $('point').style.backgroundColor = '#c9c9c9';
    $('point').style.boxShadow = '0 0 8px 2px rgba(255, 255, 255, .3)';
  });
  $<HTMLButtonElement>('save-button').addEventListener('click', savePlanet);
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
