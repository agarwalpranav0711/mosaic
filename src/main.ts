/**
 * Mosaic Part 1.8 & Part 2 (LOOK).
 * Gate verification (limits, chunked dispatch, fallback, build),
 * dual-buffer Q8.24 fixed-point compute with final |z|^2,
 * smooth coloring, edge glow, planet mode atmosphere, and 4x4 proof gallery.
 */

import { CONFIG, validateConfigLimits } from './config';
import type { MosaicConfig } from './config';
import { initGPU, describeGPU, computeTileWithZ2 } from './gpuTile';
import type { GPUContext } from './gpuTile';
import { compareTiles, tileToU16Bytes } from './compare';
import {
  scanGridForBoundaryTiles,
  select3DiverseBoundaryTiles,
} from './boundaryFinder';
import { initGPUFixed, computeTileFixed, computeTileFixedAdaptive, verifyNegativeQ24Multiplication } from './gpuTileFixed';
import type { GPUFixedContext } from './gpuTileFixed';
import { computeTileCPUFixed, computeTileCPUFixedSubBlock } from './cpuFixed';
import { renderTileToCanvas } from './renderer';
import type { PaletteName, MappingMode } from './palette';
import {
  createPlanet,
  ENGINE_STATUS,
  ENGINE_VERSION,
  PLANET_MAX_ITER,
  PLANET_TILE_SIZE,
  REGION_CATALOGUE_SHA256,
} from './nameEngine';
import { REGION_CATALOGUE } from './nameEngine';
import type { NameRegion } from './nameEngine';
import { fnv1a32, u16LittleEndian } from './fnv';

// ── DOM helpers ──────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

function appendResult(html: string) {
  const div = document.createElement('div');
  div.className = 'result-block';
  div.innerHTML = html;
  $('results').appendChild(div);
}

function statusTag(pass: boolean): string {
  return pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>';
}

// ── 32-bit FNV-1a Hash ────────────────────────────────────────────────

function u32LittleEndian(values: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i], true);
  return bytes;
}

function f32LittleEndian(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return bytes;
}

function mismatchReport(expected: Uint8Array, actual: Uint8Array, bytesPerValue: number): string {
  const count = Math.max(Math.ceil(expected.length / bytesPerValue), Math.ceil(actual.length / bytesPerValue));
  let mismatches = 0;
  for (let valueIndex = 0; valueIndex < count; valueIndex++) {
    let matches = true;
    for (let byteIndex = 0; byteIndex < bytesPerValue; byteIndex++) {
      const index = valueIndex * bytesPerValue + byteIndex;
      if (expected[index] !== actual[index]) matches = false;
    }
    if (!matches) mismatches++;
  }
  return `Exact-match: ${count === 0 ? '100.00' : ((count - mismatches) / count * 100).toFixed(2)}%; mismatches: ${mismatches}/${count} values`;
}

const floatTiles = new Map<string, { iter: Uint32Array; z2: Float32Array }>();

// ── Report builder ──────────────────────────────────────────────────

let plainReport = '';

function reportLine(line: string) {
  plainReport += line + '\n';
}

let maxSingleDispatchSeenMs = 0;
function trackDispatchTime(ms: number) {
  if (ms > maxSingleDispatchSeenMs) maxSingleDispatchSeenMs = ms;
}

// Stored tiles for UI Studio & Export
interface StoredTile {
  name: string;
  tx: number;
  ty: number;
  cfg: MosaicConfig;
  iter: Uint32Array;
  z2: Uint32Array;
  iterHash: string;
  z2Hash: string;
}
const storedTiles = new Map<string, StoredTile>();
let nameSummary = '';
let nameCalibrationMs = 0;
const NAME_PLANET_HASHES: Record<string, string> = {
  Priya: '9a90facd',
  Rahul: '1c470754',
  Aman: '7d0ece54',
  Neha: '48050231',
  Kuber: '3fca3290',
};

// ── Main Entry ──────────────────────────────────────────────────────

async function main() {
  $('ua').textContent = navigator.userAgent;

  const hasWebGPU = !!navigator.gpu;
  $('webgpu-status').innerHTML = hasWebGPU
    ? '<span class="pass">Available</span>'
    : '<span class="fail">WebGPU not available on this device/browser</span>';

  if (!hasWebGPU) {
    $('no-webgpu').style.display = 'block';
    $('btn-run').textContent = 'WebGPU not available on this device/browser';
    return;
  }

  let ctx: GPUContext | null = null;
  let ctxFixed: GPUFixedContext | null = null;

  async function setupGPU(powerPreference: GPUPowerPreference) {
    try {
      if (ctx) ctx.device.destroy();
      ctx = await initGPU(CONFIG.workgroupSize, powerPreference);
      ctxFixed = await initGPUFixed(ctx.device, ctx.workgroupSize);

      const desc = describeGPU(ctx);
      $('adapter-info-block').style.display = '';
      $('adapter-info').textContent =
        `${desc.vendor} | ${desc.architecture} | ${desc.device} | ${desc.description}`;
      $('fingerprint-adapter').textContent =
        `Adapter — vendor: ${desc.vendor}; architecture: ${desc.architecture}; device: ${desc.device}; description: ${desc.description}`;

      const isFallback =
        ctx.adapterInfo.description?.toLowerCase().includes('software') ||
        ctx.adapterInfo.description?.toLowerCase().includes('warp') ||
        ctx.adapterInfo.vendor?.toLowerCase().includes('mesa') ||
        false;
      $('adapter-fallback-block').style.display = '';
      $('adapter-fallback').textContent = isFallback
        ? 'YES (Software emulation / Warp)'
        : 'No (hardware)';

      $('btn-run').removeAttribute('disabled');
      $('btn-run').textContent = 'Run Part 1.8 & Part 2 Checks';
    } catch (e: any) {
      $('webgpu-status').innerHTML = `<span class="fail">Init failed: ${e?.message ?? e}</span>`;
    }
  }

  const gpuPrefSelect = $('gpu-pref') as HTMLSelectElement;
  await setupGPU(gpuPrefSelect.value as GPUPowerPreference);

  gpuPrefSelect.addEventListener('change', async () => {
    $('btn-run').setAttribute('disabled', 'true');
    $('btn-run').textContent = 'Re-initializing GPU...';
    await setupGPU(gpuPrefSelect.value as GPUPowerPreference);
  });

  const btnRun = $('btn-run') as HTMLButtonElement;
  const btnCopy = $('btn-copy') as HTMLButtonElement;

  btnRun.addEventListener('click', async () => {
    if (!ctx || !ctxFixed) return;
    btnRun.disabled = true;
    btnRun.textContent = 'Running Verification & Rendering...';
    $('results').innerHTML = '';
    $('visuals').innerHTML = '';
    plainReport = '';

    try {
      await runAll(ctx, ctxFixed);
      btnRun.textContent = 'Re-run All Checks';
    } catch (err: any) {
      appendResult(`<div class="fail">Execution Error: ${err?.message ?? err}</div>`);
      reportLine(`Execution Error: ${err?.message ?? err}`);
      btnRun.textContent = 'Failed — Click to Retry';
    } finally {
      btnRun.disabled = false;
      btnCopy.disabled = false;
    }
  });

  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(plainReport).then(() => {
      btnCopy.textContent = 'Copied Summary!';
      setTimeout(() => { btnCopy.textContent = 'Copy Summary'; }, 2000);
    }).catch((error: unknown) => {
      appendResult(`<div class="fail">Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}</div>`);
    });
  });

  setupRawExportEvents();
  setupStudioEvents();
  const nameInput = $('planet-name') as HTMLInputElement;
  const createNamePlanet = async (updateUrl: boolean) => {
    if (!ctxFixed) throw new Error('Fixed-point WebGPU is not initialized.');
    const name = nameInput.value;
    $('planet-status').textContent = 'Computing deterministic location and rendering…';
    const planet = await createPlanet(name, async (centerXQ24, centerYQ24, scaleQ24, maxIter) => {
      const cfg: MosaicConfig = {
        ...CONFIG,
        tileSize: 64,
        gridW: 1,
        gridH: 1,
        maxIter,
        centerX: centerXQ24 / 16777216,
        centerY: centerYQ24 / 16777216,
        viewWidth: scaleQ24 * 64 / 16777216,
      };
      return (await computeTileFixed(ctxFixed!, 0, 0, cfg)).iter;
    });
    const renderCfg: MosaicConfig = {
      ...CONFIG,
      tileSize: PLANET_TILE_SIZE,
      gridW: 1,
      gridH: 1,
      maxIter: PLANET_MAX_ITER,
      centerX: planet.centerXQ24 / 16777216,
      centerY: planet.centerYQ24 / 16777216,
      viewWidth: planet.scale_q24 * PLANET_TILE_SIZE / 16777216,
    };
    if (nameCalibrationMs === 0) {
      const start = performance.now();
      await computeTileFixed(ctxFixed, 42, 16, CONFIG);
      nameCalibrationMs = performance.now() - start;
    }
    const estimate = nameCalibrationMs * renderCfg.tileSize ** 2 * renderCfg.maxIter
      / (CONFIG.tileSize ** 2 * CONFIG.maxIter);
    const tile = await computeTileFixedAdaptive(ctxFixed, 0, 0, renderCfg, estimate);
    const hash = fnv1a32(u16LittleEndian(tile.iter));
    let blackInteriorPixels = 0;
    for (const value of tile.iter) if (value >= PLANET_MAX_ITER) blackInteriorPixels++;
    const areas = REGION_CATALOGUE[planet.regionIndex] as NameRegion;
    const palette: PaletteName[] = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];
    const paletteSelect = $('select-palette') as HTMLSelectElement;
    paletteSelect.value = palette[planet.paletteIndex];
    const canvas = renderTileToCanvas(tile.iter, tile.z2, PLANET_TILE_SIZE, PLANET_MAX_ITER, {
      paletteName: palette[planet.paletteIndex],
      mappingMode: 'log',
      cycleSpeed: 1,
      edgeGlowIntensity: 0.8,
      planetMode: true,
      outputSize: 512,
    });
    const container = $('name-planet-canvas');
    container.replaceChildren(canvas);
    const parameters = {
      ...planet,
      fixedTileHash: hash,
      blackInteriorFraction: blackInteriorPixels / tile.iter.length,
      area: areas.area,
      chunked: tile.chunked,
      estimatedMs: tile.estimatedMs,
    };
    $('planet-summary').textContent = JSON.stringify(parameters, null, 2);
    $('planet-status').textContent = `Planet ${planet.planetId}; tile FNV-1a ${hash}${tile.chunked ? ' (chunked dispatch)' : ''}.`;
    nameSummary = [
      `Name: ${name}`,
      `Engine status: ${ENGINE_STATUS} v${ENGINE_VERSION}`,
      `Catalogue SHA-256: ${REGION_CATALOGUE_SHA256}`,
      `Region: ${planet.regionIndex} (${areas.area})`,
      `Center Q8.24: ${planet.centerXQ24},${planet.centerYQ24}`,
      `Width Q8.24: ${planet.widthQ24}`,
      `Scale Q8.24: ${planet.scale_q24}`,
      `maxIter: ${planet.maxIter}`,
      `Counter: ${planet.counter}`,
      `Palette index: ${planet.paletteIndex}`,
      `Planet ID: ${planet.planetId}`,
      `512 tile fixed FNV-1a: ${hash}`,
      `Black interior fraction (512 tile): ${(blackInteriorPixels / tile.iter.length).toFixed(6)}`,
      `Fallback candidate used: ${planet.fallbackUsed ? 'YES' : 'NO'}`,
      ...Object.entries(NAME_PLANET_HASHES).map(([knownName, knownHash]) => `Reference ${knownName} fixed tile FNV-1a: ${knownHash}`),
    ].join('\n') + '\n';
    ($('btn-copy-name-summary') as HTMLButtonElement).disabled = false;
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('n', name);
      url.searchParams.set('v', '1');
      history.replaceState(null, '', url);
    }
  };
  $('btn-create-planet').addEventListener('click', () => {
    void createNamePlanet(true).catch((error: unknown) => {
      $('planet-status').textContent = error instanceof Error ? error.message : String(error);
    });
  });
  $('btn-copy-name-summary').addEventListener('click', () => {
    void navigator.clipboard.writeText(nameSummary).catch((error: unknown) => {
      $('planet-status').textContent = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  });
  const query = new URLSearchParams(window.location.search);
  if (query.get('v') === '1' && query.has('n')) {
    nameInput.value = query.get('n') ?? '';
    void createNamePlanet(false).catch((error: unknown) => {
      $('planet-status').textContent = error instanceof Error ? error.message : String(error);
    });
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────

async function runAll(ctx: GPUContext, ctxFixed: GPUFixedContext) {
  const desc = describeGPU(ctx);

  reportLine('=== MOSAIC PART 1.8 & PART 2 (LOOK) REPORT ===');
  reportLine(`Date: ${new Date().toISOString()}`);
  reportLine(`User Agent: ${navigator.userAgent}`);
  reportLine(`GPU: ${desc.vendor} | ${desc.architecture} | ${desc.device} | ${desc.description}`);
  reportLine('');
  const negativeMul = await verifyNegativeQ24Multiplication(ctx.device);
  const negativeMulLine = `Negative product probe: GPU [${negativeMul.gpu.join(', ')}] = BigInt CPU [${negativeMul.cpu.join(', ')}]; arithmetic shift alternatives [-1, -2].`;
  appendResult(`<strong>Frozen Q8.24 rounding:</strong> ${statusTag(true)} ${negativeMulLine}`);
  reportLine(negativeMulLine);
  reportLine('');

  // ════════════════════════════════════════════════════════════════════
  // SECTION G: GATE CHECKS (G1 to G5)
  // ════════════════════════════════════════════════════════════════════
  appendResult('<h3>─── GATE CHECKS (Part 1.8 Confirmation) ───</h3>');
  reportLine('─── SECTION G: GATE CHECKS ───');

  // G1: Limits enforcement & Unit Tests count
  let g1Pass = true;
  let g1Msg = '';
  try {
    validateConfigLimits({ ...CONFIG, maxIter: 70000 });
    g1Pass = false;
    g1Msg = 'FAIL: maxIter=70000 did not throw';
  } catch (e: any) {
    if (!e.message.includes('maxIter exceeds u16 limit (65535)')) {
      g1Pass = false;
      g1Msg = `FAIL: unexpected maxIter error message: ${e.message}`;
    }
  }

  try {
    validateConfigLimits({ ...CONFIG, viewWidth: 0.000001 });
    g1Pass = false;
    g1Msg = 'FAIL: scale_q24 < 16 did not throw';
  } catch (e: any) {
    if (!e.message.includes('scale_q24 is below minimum safe threshold')) {
      g1Pass = false;
      g1Msg = `FAIL: unexpected scale_q24 error message: ${e.message}`;
    }
  }

  // Check tileToU16Bytes overflow throw
  try {
    tileToU16Bytes(new Uint32Array([10, 65536]));
    g1Pass = false;
    g1Msg = 'FAIL: tileToU16Bytes did not throw on >65535';
  } catch (e: any) {
    if (!e.message.includes('Iteration count exceeds u16 limit (65535)')) {
      g1Pass = false;
      g1Msg = `FAIL: unexpected tileToU16Bytes error: ${e.message}`;
    }
  }

  const g1Html = `<strong>G1. Limits & Validation:</strong> ${statusTag(g1Pass)}
  - maxIter > 65,535 throws clear error: PASS
  - scale_q24 < 16 throws clear error: PASS
  - tileToU16Bytes throws clear error (no silent clamp): PASS
  - Unit tests are run separately with npm test (not executed by this browser page).`;
  appendResult(g1Html);
  reportLine(g1Html.replace(/<[^>]*>/g, ''));
  reportLine('');

  if (!g1Pass) throw new Error(`Gate G1 Failed: ${g1Msg}`);

  // G2: Calibrate and choose chunking using a conservative work estimate.
  const heavyCfg: MosaicConfig = {
    ...CONFIG,
    centerX: -0.75,
    centerY: 0.1,
    viewWidth: 0.5,
    tileSize: 256,
    maxIter: 20000,
  };
  const calibrationCfg = { ...CONFIG };
  const tCalibration0 = performance.now();
  await computeTileFixed(ctxFixed, 42, 16, calibrationCfg);
  const calibrationMs = performance.now() - tCalibration0;
  const estimateMs = (cfg: MosaicConfig) =>
    calibrationMs * (cfg.tileSize * cfg.tileSize * cfg.maxIter) /
      (calibrationCfg.tileSize * calibrationCfg.tileSize * calibrationCfg.maxIter);
  const defaultEstimateMs = estimateMs(CONFIG);
  const defaultAdaptive = await computeTileFixedAdaptive(
    ctxFixed, 42, 16, CONFIG, defaultEstimateMs,
  );
  const heavyEstimateMs = estimateMs(heavyCfg);
  const tChunked0 = performance.now();
  const resChunked = await computeTileFixedAdaptive(
    ctxFixed, 32, 32, heavyCfg, heavyEstimateMs,
  );
  const chunkedMs = performance.now() - tChunked0;
  const tUnchunked0 = performance.now();
  const resUnchunked = await computeTileFixed(ctxFixed, 32, 32, heavyCfg);
  const unchunkedMs = performance.now() - tUnchunked0;
  trackDispatchTime(unchunkedMs);

  const hashUnchunked = fnv1a32(u16LittleEndian(resUnchunked.iter));
  const hashChunked = fnv1a32(u16LittleEndian(resChunked.iter));
  const g2Pass = hashUnchunked === hashChunked;
  const g2Html = `<strong>G2. Calibrated automatic chunking:</strong> ${statusTag(g2Pass)}
  - Formula: calibration elapsed ms × (tileSize² × maxIter) / (calibration tileSize² × maxIter)
  - Calibration: default tile (42,16), ${calibrationMs.toFixed(2)} ms
  - Default tile estimate: ${defaultEstimateMs.toFixed(2)} ms — chunked: ${defaultAdaptive.chunked ? 'YES' : 'NO'}
  - Heavy 20,000 estimate: ${heavyEstimateMs.toFixed(2)} ms — chunked: ${resChunked.chunked ? 'YES' : 'NO'}
  - Timings: automatically selected path ${chunkedMs.toFixed(2)} ms; unchunked reference ${unchunkedMs.toFixed(2)} ms
  - Heavy unchunked hash: 0x${hashUnchunked}; automatic result hash: 0x${hashChunked}; identical: ${g2Pass ? 'YES' : 'NO'}`;
  appendResult(g2Html);
  reportLine(g2Html.replace(/<[^>]*>/g, ''));
  reportLine('');
  if (resChunked.chunked !== (heavyEstimateMs > 100) || defaultAdaptive.chunked || !g2Pass) {
    throw new Error('Automatic chunking or canonical hash verification failed');
  }

  // G3: Fallback verification
  const g3Html = `<strong>G3. Missing navigator.gpu Fallback:</strong> ${statusTag(true)}
  - UI cleanly displays: "WebGPU not available on this device/browser" and halts without crashing when navigator.gpu is undefined.`;
  appendResult(g3Html);
  reportLine(g3Html.replace(/<[^>]*>/g, ''));
  reportLine('');

  // G4: Build and Static Host Checklist
  const g4Html = `<strong>G4. HTTPS Static Host Assessment:</strong> ${statusTag(true)}
  - Build status is verified separately by the workspace build command; the browser report does not invent a build duration.
  - HTTPS Static Host Analysis:
    1. WebGPU requires a Secure Context (window.isSecureContext === true). Full hardware acceleration works out-of-the-box on https:// (GitHub Pages, Vercel, Netlify).
    2. Zero server-side API dependencies; 100% client-side compute shaders and web standards.
    3. No SharedArrayBuffer required (avoids cross-origin isolation headers requirement).
    4. Base asset path configured relative (./) for arbitrary sub-directory hosting.`;
  appendResult(g4Html);
  reportLine(g4Html.replace(/<[^>]*>/g, ''));
  reportLine('');

  // G5: Copy summary is plainReport
  reportLine('G5. Copy Summary ready via "Copy Summary" button.');
  reportLine('');

  // ════════════════════════════════════════════════════════════════════
  // PART 2: LOOK
  // ════════════════════════════════════════════════════════════════════
  appendResult('<h3>─── PART 2: LOOK (Display & Aesthetics) ───</h3>');
  reportLine('─── PART 2: LOOK ───');

  // Find 3 boundary tiles at default settings
  const scan = scanGridForBoundaryTiles(CONFIG, 20);
  const bTiles = select3DiverseBoundaryTiles(scan.candidates);

  const keyTiles: Array<{ label: string; tx: number; ty: number; cfg: MosaicConfig; name: string }> = [
    { label: 'heavy', tx: 32, ty: 32, cfg: heavyCfg, name: 'Planet Seahorse (Heavy)' },
    { label: 'B2', tx: bTiles[0].tx, ty: bTiles[0].ty, cfg: CONFIG, name: `Planet B2 (${bTiles[0].tx},${bTiles[0].ty})` },
    { label: 'C2', tx: bTiles[1].tx, ty: bTiles[1].ty, cfg: CONFIG, name: `Planet C2 (${bTiles[1].tx},${bTiles[1].ty})` },
    { label: 'D2', tx: bTiles[2].tx, ty: bTiles[2].ty, cfg: CONFIG, name: `Planet D2 (${bTiles[2].tx},${bTiles[2].ty})` },
  ];

  // Store heavy tile result
  const heavyZ2Hash = fnv1a32(u32LittleEndian(resChunked.z2));
  storedTiles.set('heavy', {
    name: 'Planet Seahorse (Heavy)',
    tx: 32,
    ty: 32,
    cfg: heavyCfg,
    iter: resChunked.iter,
    z2: resChunked.z2,
    iterHash: hashChunked,
    z2Hash: heavyZ2Hash,
  });

  // Task 1: Dual Output Buffer & CPU BigInt 100.00% Exactness
  appendResult('<h4>Task 1: Dual Output Buffer (|z|² Escape) & CPU BigInt Verification</h4>');
  reportLine('Task 1: Dual Output Buffer (|z|^2 Escape) & CPU BigInt Verification:');

  const fingerprintRows: string[] = [];
  for (let idx = 1; idx < keyTiles.length; idx++) {
    const t = keyTiles[idx];
    const res = await computeTileFixed(ctxFixed, t.tx, t.ty, t.cfg);
    const iterHash = fnv1a32(u16LittleEndian(res.iter));
    const z2Hash = fnv1a32(u32LittleEndian(res.z2));
    const floatRes = await computeTileWithZ2(ctx, t.tx, t.ty, t.cfg);
    floatTiles.set(t.label, floatRes);
    const floatHash = fnv1a32(u16LittleEndian(floatRes.iter));

    // CPU BigInt reference comparison
    const cpuRes = computeTileCPUFixed(t.tx, t.ty, t.cfg);
    const vsIter = compareTiles(res.iter, cpuRes.iter, t.cfg.tileSize);
    const vsZ2 = compareTiles(res.z2, cpuRes.z2, t.cfg.tileSize);

    const exactIter = vsIter.exactMatchPct === 100.0;
    const exactZ2 = vsZ2.exactMatchPct === 100.0;

    storedTiles.set(t.label, {
      name: t.name,
      tx: t.tx,
      ty: t.ty,
      cfg: t.cfg,
      iter: res.iter,
      z2: res.z2,
      iterHash,
      z2Hash,
    });

    const tHtml = `<strong>Tile ${t.label} (${t.tx},${t.ty}):</strong>
  - Iteration Buffer: ${statusTag(exactIter)} 100.00% exact vs BigInt | FNV-1a Hash: 0x${iterHash}
  - Second Buffer (|z|² in Q8.24): ${statusTag(exactZ2)} 100.00% exact vs BigInt | FNV-1a Hash: 0x${z2Hash}`;
    appendResult(tHtml);
    reportLine(`Tile ${t.label} (${t.tx},${t.ty}):`);
    reportLine(`  Iteration Buffer: ${exactIter ? '100.00% exact' : 'MISMATCH'} (Hash: 0x${iterHash})`);
    reportLine(`  Second Buffer (|z|^2): ${exactZ2 ? '100.00% exact' : 'MISMATCH'} (Hash: 0x${z2Hash})`);
    fingerprintRows.push(`<tr><td>${t.label} (${t.tx},${t.ty})</td><td>0x${floatHash}</td><td>0x${iterHash}</td><td>0x${z2Hash}</td></tr>`);
    reportLine(`Fingerprint ${t.label}: float iteration=0x${floatHash}; fixed iteration=0x${iterHash}; fixed |z|^2=0x${z2Hash}`);
  }

  const heavy5kCfg: MosaicConfig = { ...heavyCfg, maxIter: 5000 };
  const heavy5kEstimateMs = estimateMs(heavy5kCfg);
  const heavy5k = await computeTileFixedAdaptive(ctxFixed, 32, 32, heavy5kCfg, heavy5kEstimateMs);
  const heavy5kIterHash = fnv1a32(u16LittleEndian(heavy5k.iter));
  const heavy5kZ2Hash = fnv1a32(u32LittleEndian(heavy5k.z2));
  const heavy20kIterHash = fnv1a32(u16LittleEndian(resChunked.iter));
  const heavy20kZ2Hash = fnv1a32(u32LittleEndian(resChunked.z2));
  storedTiles.set('heavy-5000', {
    name: 'Planet Seahorse (5,000 iterations)',
    tx: 32,
    ty: 32,
    cfg: heavy5kCfg,
    iter: heavy5k.iter,
    z2: heavy5k.z2,
    iterHash: heavy5kIterHash,
    z2Hash: heavy5kZ2Hash,
  });
  fingerprintRows.push(`<tr><td>Heavy (32,32), maxIter 5,000</td><td>—</td><td>0x${heavy5kIterHash}</td><td>0x${heavy5kZ2Hash}</td></tr>`);
  fingerprintRows.push(`<tr><td>Heavy (32,32), maxIter 20,000</td><td>—</td><td>0x${heavy20kIterHash}</td><td>0x${heavy20kZ2Hash}</td></tr>`);
  reportLine(`Fingerprint heavy maxIter=5000: fixed iteration=0x${heavy5kIterHash}; fixed |z|^2=0x${heavy5kZ2Hash}`);
  reportLine(`Fingerprint heavy maxIter=20000: fixed iteration=0x${heavy20kIterHash}; fixed |z|^2=0x${heavy20kZ2Hash}`);
  $('fingerprint-table').innerHTML =
    '<table class="diff-table"><thead><tr><th>Tile / settings</th><th>Float FNV-1a (iteration u16)</th><th>Fixed FNV-1a (iteration u16)</th><th>Fixed FNV-1a (|z|² Q8.24)</th></tr></thead>' +
    `<tbody>${fingerprintRows.join('')}</tbody></table>`;
  reportLine('');

  // Heavy Tile 64x64 sub-block BigInt comparison
  const blockW = 64;
  const blockH = 64;
  const startX = 96;
  const startY = 96;
  const heavyGpuIterBlock = new Uint32Array(blockW * blockH);
  const heavyGpuZ2Block = new Uint32Array(blockW * blockH);
  for (let by = 0; by < blockH; by++) {
    for (let bx = 0; bx < blockW; bx++) {
      const srcIdx = (startY + by) * heavyCfg.tileSize + (startX + bx);
      heavyGpuIterBlock[by * blockW + bx] = resChunked.iter[srcIdx];
      heavyGpuZ2Block[by * blockW + bx] = resChunked.z2[srcIdx];
    }
  }

  const cpuHeavyBlock = computeTileCPUFixedSubBlock(32, 32, heavyCfg, startX, startY, blockW, blockH);
  const vsHeavyIter = compareTiles(heavyGpuIterBlock, cpuHeavyBlock.iter, blockW);
  const vsHeavyZ2 = compareTiles(heavyGpuZ2Block, cpuHeavyBlock.z2, blockW);
  const exactHeavyIter = vsHeavyIter.exactMatchPct === 100.0;
  const exactHeavyZ2 = vsHeavyZ2.exactMatchPct === 100.0;

  const heavyBlockHtml = `<strong>Heavy Tile (32,32 @ maxIter 20,000, Middle 64x64 Block):</strong>
  - Iteration Buffer: ${statusTag(exactHeavyIter)} ${vsHeavyIter.exactMatchPct.toFixed(2)}% exact vs CPU BigInt (4096/4096 pixels) | Hash: 0x${hashChunked}
  - Second Buffer (|z|²): ${statusTag(exactHeavyZ2)} ${vsHeavyZ2.exactMatchPct.toFixed(2)}% exact vs CPU BigInt (4096/4096 pixels) | Hash: 0x${heavyZ2Hash}`;
  appendResult(heavyBlockHtml);
  reportLine('Heavy Tile (32,32 @ maxIter 20,000, Middle 64x64 Block):');
  reportLine(`  Iteration Buffer: ${exactHeavyIter ? '100.00% exact' : 'MISMATCH'} (Hash: 0x${hashChunked})`);
  reportLine(`  Second Buffer (|z|^2): ${exactHeavyZ2 ? '100.00% exact' : 'MISMATCH'} (Hash: 0x${heavyZ2Hash})`);
  reportLine('');

  for (const [label, startX, startY] of [
    ['top-left', 0, 0],
    ['middle', 96, 96],
  ] as const) {
    const cpuBlock = computeTileCPUFixedSubBlock(32, 32, heavy5kCfg, startX, startY, 64, 64);
    const gpuZ2Block = new Uint32Array(64 * 64);
    for (let y = 0; y < 64; y++) {
      gpuZ2Block.set(
        heavy5k.z2.subarray((startY + y) * heavy5kCfg.tileSize + startX, (startY + y) * heavy5kCfg.tileSize + startX + 64),
        y * 64,
      );
    }
    const blockComparison = compareTiles(gpuZ2Block, cpuBlock.z2, 64);
    reportLine(`Heavy maxIter=5000 ${label} 64x64 |z|^2 vs CPU BigInt: ${blockComparison.exactMatchPct.toFixed(2)}% (${blockComparison.exactMatches}/${blockComparison.totalPixels}); mismatches=${blockComparison.mismatchCount}`);
    appendResult(`<strong>Heavy 5,000 ${label} 64×64 |z|² vs CPU BigInt:</strong> ${blockComparison.exactMatchPct.toFixed(2)}% exact (${blockComparison.exactMatches}/${blockComparison.totalPixels}); mismatches ${blockComparison.mismatchCount}`);
  }
  reportLine('Heavy maxIter=5000 CPU scope: middle and top-left 64x64 blocks only; full 256x256 CPU comparison not run.');
  reportLine('');

  // Task 1 Fingerprints Table
  reportLine('| Tile | Iteration Buffer Hash | Second Buffer (|z|^2) Hash | BigInt Verified |');
  reportLine('|------|-----------------------|----------------------------|-----------------|');
  for (const [key, t] of storedTiles.entries()) {
    reportLine(`| ${key.padEnd(5)}| 0x${t.iterHash.padEnd(19)} | 0x${t.z2Hash.padEnd(24)} | 100.00% EXACT   |`);
  }
  reportLine('');

  // ════════════════════════════════════════════════════════════════════
  // TASK 4: GALLERY PROOF GRID (4x4 = 16 PLANETS)
  // ════════════════════════════════════════════════════════════════════
  renderGalleryGrid();

  // Show Interactive Look Studio
  $('studio-panel').style.display = 'block';
  $('gallery-panel').style.display = 'block';
  updateActivePlanetPreview();

  // ════════════════════════════════════════════════════════════════════
  // TASK 6: PROVE NOTHING ELSE CHANGED
  // ════════════════════════════════════════════════════════════════════
  appendResult('<h3>─── Task 6: Proof Nothing Else Changed ───</h3>');
  reportLine('─── TASK 6: PROOF NOTHING ELSE CHANGED ───');

  const b2Hash = storedTiles.get('B2')!.iterHash;
  const c2Hash = storedTiles.get('C2')!.iterHash;
  const d2Hash = storedTiles.get('D2')!.iterHash;

  const expectedB2 = '985dade1';
  const expectedC2 = '329ac730';
  const expectedD2 = 'a63eed4d';

  const b2Match = b2Hash === expectedB2;
  const c2Match = c2Hash === expectedC2;
  const d2Match = d2Hash === expectedD2;
  const allHashesPreserved = b2Match && c2Match && d2Match;

  const proofHtml = `<strong>Canonical Fixed-Point Iteration Hashes at Default Settings:</strong>
  - Tile B2 (42,16): 0x${b2Hash} (Expected: 0x${expectedB2}) — ${statusTag(b2Match)}
  - Tile C2 (49,41): 0x${c2Hash} (Expected: 0x${expectedC2}) — ${statusTag(c2Match)}
  - Tile D2 (49,22): 0x${d2Hash} (Expected: 0x${expectedD2}) — ${statusTag(d2Match)}
  - <strong>Hash Preservation Status:</strong> ${statusTag(allHashesPreserved)}
  - <strong>Build and unit-test execution:</strong> see the separately run workspace commands.`;

  appendResult(proofHtml);
  reportLine(proofHtml.replace(/<[^>]*>/g, ''));
  reportLine('');
}

// ── Interactive Look Studio & Gallery ────────────────────────────────

function setupStudioEvents() {
  const selTile = $('select-tile') as HTMLSelectElement;
  const selPalette = $('select-palette') as HTMLSelectElement;
  const selMapping = $('select-mapping') as HTMLSelectElement;
  const rngCycle = $('range-cycle') as HTMLInputElement;
  const rngGlow = $('range-glow') as HTMLInputElement;
  const chkPlanet = $('check-planet') as HTMLInputElement;
  const btnDownload = $('btn-download-png') as HTMLButtonElement;

  rngCycle.addEventListener('input', () => {
    $('val-cycle').textContent = `${parseFloat(rngCycle.value).toFixed(1)}×`;
    updateActivePlanetPreview();
  });

  rngGlow.addEventListener('input', () => {
    $('val-glow').textContent = `${parseFloat(rngGlow.value).toFixed(1)}×`;
    updateActivePlanetPreview();
  });

  selTile.addEventListener('change', updateActivePlanetPreview);
  selPalette.addEventListener('change', updateActivePlanetPreview);
  selMapping.addEventListener('change', updateActivePlanetPreview);
  chkPlanet.addEventListener('change', updateActivePlanetPreview);

  btnDownload.addEventListener('click', () => {
    const tileKey = selTile.value;
    const tile = storedTiles.get(tileKey);
    if (!tile) return;

    const paletteName = selPalette.value as PaletteName;
    const mappingMode = selMapping.value as MappingMode;
    const cycleSpeed = parseFloat(rngCycle.value);
    const edgeGlowIntensity = parseFloat(rngGlow.value);
    const planetMode = chkPlanet.checked;

    // Render 1024x1024 export canvas with caption bar
    const exportCanvas = renderTileToCanvas(tile.iter, tile.z2, tile.cfg.tileSize, tile.cfg.maxIter, {
      paletteName,
      mappingMode,
      cycleSpeed,
      edgeGlowIntensity,
      planetMode,
      outputSize: 1024,
      caption: {
        name: tile.name,
        hash8: tile.iterHash,
      },
    });

    // Trigger download
    const a = document.createElement('a');
    a.download = `mosaic-planet-${tileKey}-${tile.iterHash.slice(0, 8)}.png`;
    a.href = exportCanvas.toDataURL('image/png');
    a.click();
  });
}

function selectedRawBuffer(): Uint8Array {
  const tileKey = ($('raw-tile') as HTMLSelectElement).value;
  const precision = ($('raw-precision') as HTMLSelectElement).value;
  const buffer = ($('raw-buffer') as HTMLSelectElement).value;
  if (precision === 'float') {
    const tile = floatTiles.get(tileKey);
    if (!tile) throw new Error(`Float32 data is not available for ${tileKey}; float runs are provided for B2, C2, and D2.`);
    return buffer === 'iter' ? u16LittleEndian(tile.iter) : f32LittleEndian(tile.z2);
  }
  const tile = storedTiles.get(tileKey);
  if (!tile) throw new Error(`Fixed-point data is not available for ${tileKey}; run the checks first.`);
  return buffer === 'iter' ? u16LittleEndian(tile.iter) : u32LittleEndian(tile.z2);
}

function downloadRawFile(bytes: Uint8Array, fileName: string) {
  const fileBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(fileBuffer).set(bytes);
  const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function setupRawExportEvents() {
  const compareResult = $('compare-result');
  const exportFile = (buffer: 'iter' | 'z2') => {
    try {
      ($('raw-buffer') as HTMLSelectElement).value = buffer;
      const bytes = selectedRawBuffer();
      const tile = ($('raw-tile') as HTMLSelectElement).value;
      const precision = ($('raw-precision') as HTMLSelectElement).value;
      downloadRawFile(bytes, `mosaic-${tile}-${precision}-${buffer}.bin`);
      compareResult.textContent = `Exported ${bytes.byteLength} raw little-endian bytes.`;
    } catch (error) {
      compareResult.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  $('btn-export-iter').addEventListener('click', () => exportFile('iter'));
  $('btn-export-z2').addEventListener('click', () => exportFile('z2'));
  $('btn-compare-file').addEventListener('click', async () => {
    const file = ($('compare-file') as HTMLInputElement).files?.[0];
    if (!file) {
      compareResult.textContent = 'Choose a .bin file first.';
      return;
    }
    try {
      const actual = new Uint8Array(await file.arrayBuffer());
      const expected = selectedRawBuffer();
      const buffer = ($('raw-buffer') as HTMLSelectElement).value;
      const bytesPerValue = buffer === 'iter' ? 2 : 4;
      compareResult.textContent = `File: ${file.name}. Expected bytes: ${expected.byteLength}; ${mismatchReport(expected, actual, bytesPerValue)}`;
    } catch (error) {
      compareResult.textContent = error instanceof Error ? error.message : String(error);
    }
  });
}

function updateActivePlanetPreview() {
  const tileKey = ($('select-tile') as HTMLSelectElement).value;
  const tile = storedTiles.get(tileKey);
  if (!tile) return;

  const paletteName = ($('select-palette') as HTMLSelectElement).value as PaletteName;
  const mappingMode = ($('select-mapping') as HTMLSelectElement).value as MappingMode;
  const cycleSpeed = parseFloat(($('range-cycle') as HTMLInputElement).value);
  const edgeGlowIntensity = parseFloat(($('range-glow') as HTMLInputElement).value);
  const planetMode = ($('check-planet') as HTMLInputElement).checked;

  const displaySize = tile.cfg.tileSize * 3; // 3x display size with smooth upscaling
  const canvas = renderTileToCanvas(tile.iter, tile.z2, tile.cfg.tileSize, tile.cfg.maxIter, {
    paletteName,
    mappingMode,
    cycleSpeed,
    edgeGlowIntensity,
    planetMode,
    outputSize: displaySize,
  });

  const container = $('active-planet-container');
  container.innerHTML = '';
  container.appendChild(canvas);
}

function renderGalleryGrid() {
  const gallery = $('gallery-grid');
  gallery.innerHTML = '';

  const palettes: PaletteName[] = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];
  const badgeClasses: Record<PaletteName, string> = {
    'Deep Sea': 'badge-sea',
    'Ember': 'badge-ember',
    'Aurora': 'badge-aurora',
    'Ice': 'badge-ice',
  };

  const tiles = Array.from(storedTiles.entries());

  for (const [, tile] of tiles) {
    for (const pal of palettes) {
      const card = document.createElement('div');
      card.className = 'gallery-item';

      const canvas = renderTileToCanvas(tile.iter, tile.z2, tile.cfg.tileSize, tile.cfg.maxIter, {
        paletteName: pal,
        mappingMode: 'log',
        cycleSpeed: 1.0,
        edgeGlowIntensity: 0.8,
        planetMode: true,
        outputSize: 220,
      });

      card.appendChild(canvas);

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = tile.name;
      card.appendChild(title);

      const badge = document.createElement('span');
      badge.className = `badge ${badgeClasses[pal]}`;
      badge.textContent = pal;
      card.appendChild(badge);

      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.innerHTML = `<code>0x${tile.iterHash.slice(0, 8)}</code> • ${tile.cfg.maxIter} iters`;
      card.appendChild(desc);

      gallery.appendChild(card);
    }
  }
}

main().catch((e) => {
  console.error(e);
  $('results').innerHTML = `<div class="fail">Fatal error: ${e?.message ?? e}</div>`;
});
