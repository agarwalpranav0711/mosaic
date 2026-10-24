import { computeTileFixed, initGPUFixed } from './gpuTileFixed';
import { computeTileCPUFixed } from './cpuFixed';
import {
  emptyFunnel,
  extractBoundarySeeds,
  initialScanState,
  REGION_PROBE_ITERATIONS,
  REGION_SCAN_SEED,
  REGION_TIME_BUDGET_MS,
  regionCandidateAt,
  minimumCenterDistanceRatio,
  overlapsRegion,
  RELAXATION_STAGES,
  updateFunnel,
} from './regionGenerator';
import type { BoundarySeed, ScanFunnel, ScanState } from './regionGenerator';
import { computeProbeMetrics } from './regionMetrics';
import type { NameRegion } from './nameEngine';

const Q24 = 1 << 24;
const COARSE_SIZE = 512;
const COARSE_ITERATIONS = 500;
const COARSE_LEFT_Q24 = Math.round(-2.1 * Q24);
const COARSE_TOP_Q24 = Math.round(-1.2 * Q24);
const COARSE_X_STEP_Q24 = Math.round(2.7 * Q24 / COARSE_SIZE);
const COARSE_Y_STEP_Q24 = Math.round(2.4 * Q24 / COARSE_SIZE);
const STAGE_CANDIDATE_LIMIT = 2000;
const CANDIDATE_LIMIT = 50000;
const PROGRESS_DB = 'mosaic-region-scan-v5';
const PROGRESS_STORE = 'scan-state';

interface CoarseContext {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  uniform: GPUBuffer;
  output: GPUBuffer;
  readback: GPUBuffer;
  bindGroup: GPUBindGroup;
}

let coarseContext: CoarseContext | undefined;
let fixedContext: Awaited<ReturnType<typeof initGPUFixed>> | undefined;
let device: GPUDevice | undefined;
let unloadRegistered = false;
let finalRegions: NameRegion[] | undefined;
let scanRunning = false;

function safeUi(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error('Scanner UI callback failed:', error);
  }
}

function openProgressDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROGRESS_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PROGRESS_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open scan progress database.'));
  });
}

async function loadState(): Promise<ScanState> {
  const database = await openProgressDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(PROGRESS_STORE, 'readonly').objectStore(PROGRESS_STORE).get('current');
      request.onsuccess = () => {
        const stored = request.result as ScanState | undefined;
        resolve(stored ? {
          ...stored,
          stageRecovered: Array.from({ length: RELAXATION_STAGES.length }, (_, index) => stored.stageRecovered?.[index] ?? 0),
          stageRecheck: Array.from({ length: RELAXATION_STAGES.length }, (_, index) => stored.stageRecheck?.[index] ?? emptyFunnel()),
        } : initialScanState());
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read scan progress.'));
    });
  } finally {
    database.close();
  }
}

async function persistState(state: ScanState): Promise<void> {
  const database = await openProgressDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PROGRESS_STORE, 'readwrite');
      transaction.objectStore(PROGRESS_STORE).put(state, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save scan progress.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Scan progress save was aborted.'));
    });
  } finally {
    database.close();
  }
}

async function initializeGpu(): Promise<void> {
  if (fixedContext && coarseContext) return;
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  device = await adapter.requestDevice();
  fixedContext = await initGPUFixed(device, 8);
  const module = device.createShaderModule({
    code: `
struct Params { width: u32, height: u32, maxIter: u32, _pad: u32, left: f32, top: f32, stepX: f32, stepY: f32, };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let cr = p.left + f32(id.x) * p.stepX;
  let ci = p.top + f32(id.y) * p.stepY;
  var zr = 0.0;
  var zi = 0.0;
  var iter = 0u;
  loop {
    if (iter >= p.maxIter) { break; }
    let zr2 = zr * zr;
    let zi2 = zi * zi;
    if (zr2 + zi2 > 4.0) { break; }
    zi = 2.0 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
    iter++;
  }
  out[id.y * p.width + id.x] = iter;
}`,
  });
  const compilation = await module.getCompilationInfo();
  const shaderErrors = compilation.messages.filter((message) => message.type === 'error');
  if (shaderErrors.length) throw new Error(`Coarse scouting shader failed: ${shaderErrors.map((error) => error.message).join('; ')}`);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bufferSize = COARSE_SIZE * COARSE_SIZE * 4;
  const output = device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: output } }],
  });
  coarseContext = { device, pipeline, uniform, output, readback, bindGroup };
  if (!unloadRegistered) {
    window.addEventListener('pagehide', () => device?.destroy(), { once: true });
    unloadRegistered = true;
  }
}

async function scoutBoundary(): Promise<BoundarySeed[]> {
  await initializeGpu();
  const context = coarseContext!;
  const values = new ArrayBuffer(32);
  const u32 = new Uint32Array(values);
  const f32 = new Float32Array(values);
  u32[0] = COARSE_SIZE;
  u32[1] = COARSE_SIZE;
  u32[2] = COARSE_ITERATIONS;
  f32[4] = -2.1;
  f32[5] = -1.2;
  f32[6] = 2.7 / COARSE_SIZE;
  f32[7] = 2.4 / COARSE_SIZE;
  context.device.queue.writeBuffer(context.uniform, 0, values);
  const encoder = context.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(context.pipeline);
  pass.setBindGroup(0, context.bindGroup);
  pass.dispatchWorkgroups(COARSE_SIZE / 8, COARSE_SIZE / 8);
  pass.end();
  encoder.copyBufferToBuffer(context.output, 0, context.readback, 0, COARSE_SIZE * COARSE_SIZE * 4);
  context.device.queue.submit([encoder.finish()]);
  await context.readback.mapAsync(GPUMapMode.READ);
  const iterations = new Uint32Array(context.readback.getMappedRange());
  const copy = new Uint32Array(iterations);
  context.readback.unmap();
  return extractBoundarySeeds(
    copy,
    COARSE_SIZE,
    COARSE_SIZE,
    COARSE_LEFT_Q24,
    COARSE_TOP_Q24,
    COARSE_X_STEP_Q24,
    COARSE_Y_STEP_Q24,
    COARSE_ITERATIONS,
  );
}

function updateStatus(text: string): void {
  safeUi(() => { document.querySelector<HTMLElement>('#progress')!.textContent = text; });
}

function showFunnel(funnel: ScanFunnel, stage: number): void {
  safeUi(() => {
    document.querySelector<HTMLElement>('#funnel')!.textContent =
      `Stage ${stage + 1}: candidates ${funnel.generated}; overlap rejects ${funnel.rejectedOverlap}; first-failure interior ${funnel.failedInterior}, fast escape ${funnel.failedFastEscape}, distinct ${funnel.failedDistinct}, edges ${funnel.failedEdges}; accepted ${funnel.accepted}.`;
  });
}

function downloadRegions(regions: NameRegion[], filename: string): void {
  const blob = new Blob([`${JSON.stringify(regions, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function runSelfTest(): Promise<void> {
  const start = performance.now();
  const seeds = await scoutBoundary();
  const funnel = emptyFunnel();
  const accepted: NameRegion[] = [];
  for (let index = 0; index < 50; index++) {
    const candidate = regionCandidateAt(seeds, index);
    funnel.generated++;
    if (overlapsRegion(candidate, accepted)) {
      funnel.rejectedOverlap++;
      continue;
    }
    const scaleQ24 = Math.floor(candidate.widthQ24 / 512);
    const cfg = {
      tileSize: 64, gridW: 1, gridH: 1, maxIter: REGION_PROBE_ITERATIONS,
      centerX: candidate.centerXQ24 / Q24, centerY: candidate.centerYQ24 / Q24,
      viewWidth: scaleQ24 * 64 / Q24, workgroupSize: 8, tolerance: { minExactMatchPct: 100 },
    };
    const result = await computeTileFixed(fixedContext!, 0, 0, cfg);
    const metrics = computeProbeMetrics(result.iter, REGION_PROBE_ITERATIONS);
    if (updateFunnel(funnel, metrics, RELAXATION_STAGES[0])) {
      accepted.push(candidate);
      funnel.accepted++;
    }
  }
  const elapsed = performance.now() - start;
  if (elapsed >= 30000) throw new Error(`Self-test exceeded 30 seconds (${elapsed.toFixed(0)} ms).`);
  showFunnel(funnel, 0);
  updateStatus(`Self-test PASS: 50 candidates, ${funnel.accepted} accepted, ${elapsed.toFixed(0)} ms. Seed 0x${REGION_SCAN_SEED.toString(16)}.`);
}

async function runFullScan(): Promise<void> {
  await initializeGpu();
  const started = performance.now();
  const seeds = await scoutBoundary();
  const state = await loadState();
  updateStatus(`Resuming candidate ${state.candidateIndex}; ${state.accepted.length} accepted; boundary seeds ${seeds.length}.`);
  let acceptedSinceSave = 0;
  const relaxStage = () => {
    state.stageFunnels[state.stage] = state.funnel;
    state.stage++;
    state.funnel = emptyFunnel();
    const recheck = emptyFunnel();
    state.stageRecovered[state.stage] = 0;
    for (const previous of state.probed) {
      if (state.accepted.length >= 300) break;
      if (state.accepted.some((region) => region.centerXQ24 === previous.candidate.centerXQ24
        && region.centerYQ24 === previous.candidate.centerYQ24
        && region.widthQ24 === previous.candidate.widthQ24)) continue;
      recheck.generated++;
      if (overlapsRegion(previous.candidate, state.accepted)) {
        recheck.rejectedOverlap++;
        continue;
      }
      if (updateFunnel(recheck, previous.metrics, RELAXATION_STAGES[state.stage])) {
        state.accepted.push(previous.candidate);
        recheck.accepted++;
        state.stageRecovered[state.stage]++;
        acceptedSinceSave++;
      }
    }
    state.stageRecheck[state.stage] = recheck;
    state.stageFunnels[state.stage] = state.funnel;
    safeUi(() => showFunnel(state.funnel, state.stage));
  };
  while (state.accepted.length < 300 && state.candidateIndex < CANDIDATE_LIMIT && performance.now() - started < REGION_TIME_BUDGET_MS) {
    if (state.funnel.generated >= STAGE_CANDIDATE_LIMIT && state.accepted.length < 300 && state.stage < RELAXATION_STAGES.length - 1) {
      relaxStage();
    }
    const candidate = regionCandidateAt(seeds, state.candidateIndex, REGION_SCAN_SEED);
    state.candidateIndex++;
    state.funnel.generated++;
    if (overlapsRegion(candidate, state.accepted)) {
      state.funnel.rejectedOverlap++;
    } else {
      const scaleQ24 = Math.floor(candidate.widthQ24 / 512);
      if (candidate.widthQ24 < Math.ceil(0.01 * Q24)
        || candidate.widthQ24 > Math.floor(0.2 * Q24)
        || scaleQ24 < 256) throw new Error('Candidate violates frozen width or scale_q24 constraints.');
      const cfg = {
        tileSize: 64, gridW: 1, gridH: 1, maxIter: REGION_PROBE_ITERATIONS,
        centerX: candidate.centerXQ24 / Q24, centerY: candidate.centerYQ24 / Q24,
        viewWidth: scaleQ24 * 64 / Q24, workgroupSize: 8, tolerance: { minExactMatchPct: 100 },
      };
      const result = await computeTileFixed(fixedContext!, 0, 0, cfg);
      const metrics = computeProbeMetrics(result.iter, REGION_PROBE_ITERATIONS);
      state.probed.push({ candidate, metrics });
      if (updateFunnel(state.funnel, metrics, RELAXATION_STAGES[state.stage])) {
        state.accepted.push(candidate);
        state.funnel.accepted++;
        acceptedSinceSave++;
      }
    }
    if (acceptedSinceSave >= 25 || state.candidateIndex % 500 === 0) {
      await persistState(state);
      acceptedSinceSave = 0;
    }
    if (state.candidateIndex % 500 === 0) {
      showFunnel(state.funnel, state.stage);
      updateStatus(`Candidates ${state.candidateIndex}; accepted ${state.accepted.length}; stage ${state.stage + 1}; elapsed ${Math.floor((performance.now() - started) / 1000)}s.`);
      if (state.accepted.length >= 150) updateStatus(`Milestone: ${state.accepted.length} regions saved; continuing to 300. Stage ${state.stage + 1}.`);
    }
  }
  state.stageFunnels[state.stage] = state.funnel;
  state.stageRecovered[state.stage] ??= 0;
  state.stageRecheck[state.stage] ??= emptyFunnel();
  while (state.accepted.length < 300 && state.stage < RELAXATION_STAGES.length - 1) {
    relaxStage();
    if (acceptedSinceSave >= 25) {
      await persistState(state);
      acceptedSinceSave = 0;
    }
  }
  await persistState(state);
  finalRegions = state.accepted.slice(0, 300);
  safeUi(() => {
    const finalButton = document.querySelector<HTMLButtonElement>('#download-final')!;
    finalButton.disabled = finalRegions!.length !== 300;
  });
  if (state.accepted.length >= 300) {
    updateStatus(`Complete: 300 regions. Candidate ${state.candidateIndex}; elapsed ${Math.floor((performance.now() - started) / 1000)}s.`);
  } else if (performance.now() - started >= REGION_TIME_BUDGET_MS) {
    updateStatus(`10-minute budget reached. Partial catalogue has ${state.accepted.length} regions; download partial is available. Relaxation stage ${state.stage + 1}/${RELAXATION_STAGES.length}.`);
  } else {
    updateStatus(`Candidate limit reached. Partial catalogue has ${state.accepted.length} regions; download partial is available.`);
  }
  showFunnel(state.funnel, state.stage);
  if (finalRegions.length >= 150) {
    const summary = {
      candidateIndex: state.candidateIndex,
      stage: state.stage,
      stageFunnels: state.stageFunnels,
      stageRecovered: state.stageRecovered,
      stageRecheck: state.stageRecheck,
      stageSettings: RELAXATION_STAGES.slice(0, state.stage + 1),
      funnel: state.funnel,
      accepted: finalRegions.length,
      elapsedMs: Math.round(performance.now() - started),
      seed: `0x${REGION_SCAN_SEED.toString(16)}`,
      coarseBounds: { x: [-2.1, 0.6], y: [-1.2, 1.2], maxIter: COARSE_ITERATIONS },
      probeMaxIter: REGION_PROBE_ITERATIONS,
      edgeDensityMinimumPercent: 5,
      verificationMatches: 0,
      verificationIndices: [] as number[],
    };
    let verificationMatches = 0;
    const verificationTotal = Math.min(20, finalRegions.length);
    const verificationOrder = Array.from({ length: finalRegions.length }, (_, index) => index);
    let randomState = REGION_SCAN_SEED;
    for (let index = verificationOrder.length - 1; index > 0; index--) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      const swapIndex = (randomState >>> 0) % (index + 1);
      [verificationOrder[index], verificationOrder[swapIndex]] = [verificationOrder[swapIndex], verificationOrder[index]];
    }
    const verificationIndices: number[] = [];
    for (let index = 0; index < verificationTotal; index++) {
      const selected = verificationOrder[index];
      const region = finalRegions[selected];
      const scaleQ24 = Math.floor(region.widthQ24 / 512);
      const cfg = {
        tileSize: 64, gridW: 1, gridH: 1, maxIter: REGION_PROBE_ITERATIONS,
        centerX: region.centerXQ24 / Q24, centerY: region.centerYQ24 / Q24,
        viewWidth: scaleQ24 * 64 / Q24, workgroupSize: 8, tolerance: { minExactMatchPct: 100 },
      };
      const gpu = await computeTileFixed(fixedContext!, 0, 0, cfg);
      const cpu = computeTileCPUFixed(0, 0, cfg);
      if (gpu.iter.length !== cpu.iter.length
        || gpu.z2.length !== cpu.z2.length
        || gpu.iter.some((value, pixel) => value !== cpu.iter[pixel])
        || gpu.z2.some((value, pixel) => value !== cpu.z2[pixel])) {
        throw new Error(`Seeded CPU BigInt verification failed for catalogue index ${selected}.`);
      }
      verificationMatches++;
      verificationIndices.push(selected);
      updateStatus(`Catalogue frozen (${finalRegions.length} entries); CPU BigInt verification ${verificationMatches}/${verificationTotal}.`);
    }
    summary.verificationMatches = verificationMatches;
    summary.verificationIndices = verificationIndices;
    const saveResponse = await fetch('/__region-progress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ final: true, regions: finalRegions, report: summary }),
    });
    if (!saveResponse.ok) throw new Error(`Could not freeze src/regions.json: HTTP ${saveResponse.status}`);
    const serialized = `${JSON.stringify(finalRegions, null, 2)}\n`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const areas = [...new Set(finalRegions.map((region) => region.area))];
    updateStatus(`Catalogue saved to src/regions.json: ${finalRegions.length} regions; areas=${areas.join(', ')} (${areas.length}); min distance/max width=${minimumCenterDistanceRatio(finalRegions)}; seeded CPU BigInt ${verificationMatches}/${verificationTotal} exact (indices ${verificationIndices.join(', ')}); SHA-256=${sha256}.`);
  }
}

document.querySelector<HTMLButtonElement>('#self-test')!.addEventListener('click', () => {
  if (scanRunning) return;
  scanRunning = true;
  safeUi(() => { document.querySelector<HTMLButtonElement>('#self-test')!.disabled = true; });
  void runSelfTest()
    .catch((error: unknown) => updateStatus(error instanceof Error ? error.message : String(error)))
    .finally(() => {
      scanRunning = false;
      safeUi(() => { document.querySelector<HTMLButtonElement>('#self-test')!.disabled = false; });
    });
});
document.querySelector<HTMLButtonElement>('#run-scan')!.addEventListener('click', () => {
  if (scanRunning) return;
  scanRunning = true;
  safeUi(() => { document.querySelector<HTMLButtonElement>('#run-scan')!.disabled = true; });
  void runFullScan()
    .catch((error: unknown) => updateStatus(error instanceof Error ? error.message : String(error)))
    .finally(() => {
      scanRunning = false;
      safeUi(() => { document.querySelector<HTMLButtonElement>('#run-scan')!.disabled = false; });
    });
});
document.querySelector<HTMLButtonElement>('#download-partial')!.addEventListener('click', () => {
  void loadState()
    .then((state) => downloadRegions(state.accepted, 'regions.partial.json'))
    .catch((error: unknown) => updateStatus(error instanceof Error ? error.message : String(error)));
});
document.querySelector<HTMLButtonElement>('#download-final')!.addEventListener('click', () => {
  safeUi(() => {
    if (finalRegions?.length === 300) downloadRegions(finalRegions, 'regions.json');
  });
});

void loadState().then((state) => {
  finalRegions = state.accepted.slice(0, 300);
  safeUi(() => {
    document.querySelector<HTMLButtonElement>('#download-final')!.disabled = finalRegions!.length !== 300;
  });
  if (state.accepted.length > 0) {
    updateStatus(`Saved progress loaded: candidate ${state.candidateIndex}; ${state.accepted.length} regions ready to resume.`);
  }
}).catch((error: unknown) => updateStatus(`Could not load saved scan progress: ${error instanceof Error ? error.message : String(error)}`));
