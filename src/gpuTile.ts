/**
 * WebGPU setup and tile computation.
 */

import { CONFIG, getScale } from './config';
import type { MosaicConfig } from './config';
import { shaderSource } from './shader.wgsl.ts';

export interface GPUContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  uniformBuffer: GPUBuffer;
  storageBuffer: GPUBuffer;
  storageZ2Buffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  readbackZ2Buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  adapterInfo: GPUAdapterInfo;
  deviceLost: boolean;
  workgroupSize: number;
}

export interface GPUDescription {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/**
 * Size of the uniform buffer in bytes.
 * The Params struct has 9 x u32/f32 fields = 36 bytes.
 * WebGPU requires uniform buffer bindings to be a multiple of 16 bytes → 48.
 */
const UNIFORM_SIZE = 48;

/**
 * Initialize the WebGPU device, compile the shader, and create reusable buffers.
 */
export async function initGPU(
  workgroupSize: number = CONFIG.workgroupSize,
  powerPreference: GPUPowerPreference = 'high-performance',
): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new Error(
      'WebGPU is not available in this browser. ' +
      'Use a recent version of Chrome, Edge, Firefox, or Safari 26+.'
    );
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference,
  });
  if (!adapter) {
    throw new Error(
      'No WebGPU adapter found. Your browser supports WebGPU but no suitable GPU adapter is available.'
    );
  }

  const adapterInfo = adapter.info;

  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query');
  }

  const device = await adapter.requestDevice({
    requiredFeatures,
  });

  // Track device loss
  const ctx: GPUContext = {
    adapter,
    device,
    pipeline: null!,
    uniformBuffer: null!,
    storageBuffer: null!,
    storageZ2Buffer: null!,
    readbackBuffer: null!,
    readbackZ2Buffer: null!,
    bindGroup: null!,
    adapterInfo,
    deviceLost: false,
    workgroupSize,
  };

  device.lost.then((info) => {
    console.error(`WebGPU device lost: ${info.message} (reason: ${info.reason})`);
    ctx.deviceLost = true;
  });

  // Compile shader
  const shaderModule = device.createShaderModule({
    code: shaderSource(workgroupSize),
  });

  const compilationInfo = await shaderModule.getCompilationInfo();
  const errors = compilationInfo.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    const details = errors
      .map((m) => `  Line ${m.lineNum}:${m.linePos} — ${m.message}`)
      .join('\n');
    throw new Error(`WGSL compilation errors:\n${details}`);
  }
  // Log warnings if any
  for (const msg of compilationInfo.messages) {
    if (msg.type === 'warning') {
      console.warn(`WGSL warning: Line ${msg.lineNum}:${msg.linePos} — ${msg.message}`);
    }
  }

  // Create pipeline with validation error scope
  device.pushErrorScope('validation');
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'main' },
  });
  const pipelineError = await device.popErrorScope();
  if (pipelineError) {
    throw new Error(`Pipeline creation validation error: ${pipelineError.message}`);
  }
  ctx.pipeline = pipeline;

  // Create buffers (sized for up to 512x512 tiles = 1MB so difficulty experiments work seamlessly)
  const maxTilePixels = 512 * 512;

  const uniformBuffer = device.createBuffer({
    size: UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  ctx.uniformBuffer = uniformBuffer;

  const storageBuffer = device.createBuffer({
    size: maxTilePixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  ctx.storageBuffer = storageBuffer;

  const storageZ2Buffer = device.createBuffer({
    size: maxTilePixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  ctx.storageZ2Buffer = storageZ2Buffer;

  const readbackBuffer = device.createBuffer({
    size: maxTilePixels * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  ctx.readbackBuffer = readbackBuffer;

  const readbackZ2Buffer = device.createBuffer({
    size: maxTilePixels * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  ctx.readbackZ2Buffer = readbackZ2Buffer;

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: storageBuffer } },
      { binding: 2, resource: { buffer: storageZ2Buffer } },
    ],
  });
  ctx.bindGroup = bindGroup;

  return ctx;
}

/**
 * Compute a single Mandelbrot tile on the GPU.
 * Returns a NEW Uint32Array with iteration counts (tileSize*tileSize elements).
 */
export async function computeTile(
  ctx: GPUContext,
  tileX: number,
  tileY: number,
  cfg: MosaicConfig = CONFIG,
): Promise<Uint32Array> {
  return (await computeTileWithZ2(ctx, tileX, tileY, cfg)).iter;
}

export interface FloatTileResult {
  iter: Uint32Array;
  z2: Float32Array;
}

export async function computeTileWithZ2(
  ctx: GPUContext,
  tileX: number,
  tileY: number,
  cfg: MosaicConfig = CONFIG,
): Promise<FloatTileResult> {
  if (ctx.deviceLost) {
    throw new Error('GPU device lost. Please reload the page.');
  }

  const { device, pipeline, uniformBuffer, storageBuffer, storageZ2Buffer, readbackBuffer, readbackZ2Buffer, bindGroup } = ctx;
  const scale = getScale(cfg);
  const tilePixels = cfg.tileSize * cfg.tileSize;

  // Write uniform data
  // Layout matches the Params struct: 9 fields, each 4 bytes = 36 bytes, padded to 48
  const uniformData = new ArrayBuffer(UNIFORM_SIZE);
  const u32View = new Uint32Array(uniformData);
  const f32View = new Float32Array(uniformData);

  u32View[0] = tileX;
  u32View[1] = tileY;
  u32View[2] = cfg.tileSize;
  u32View[3] = cfg.maxIter;
  f32View[4] = cfg.centerX;
  f32View[5] = cfg.centerY;
  f32View[6] = scale;
  u32View[7] = cfg.gridW;
  u32View[8] = cfg.gridH;
  // Bytes 36-47 are padding (zeros), which is fine

  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Dispatch
  const wgCount = Math.ceil(cfg.tileSize / ctx.workgroupSize);

  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(wgCount, wgCount);
  pass.end();

  // Copy result to readback buffer
  encoder.copyBufferToBuffer(storageBuffer, 0, readbackBuffer, 0, tilePixels * 4);
  encoder.copyBufferToBuffer(storageZ2Buffer, 0, readbackZ2Buffer, 0, tilePixels * 4);
  device.queue.submit([encoder.finish()]);

  const validationError = await device.popErrorScope();
  if (validationError) {
    throw new Error(`Dispatch validation error: ${validationError.message}`);
  }

  // Read back
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  await readbackZ2Buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint32Array(readbackBuffer.getMappedRange(0, tilePixels * 4));
  const mappedZ2 = new Float32Array(readbackZ2Buffer.getMappedRange(0, tilePixels * 4));
  const result = { iter: new Uint32Array(mapped), z2: new Float32Array(mappedZ2) };
  readbackBuffer.unmap();
  readbackZ2Buffer.unmap();

  return result;
}

/**
 * Return human-readable GPU adapter info.
 */
export function describeGPU(ctx: GPUContext): GPUDescription {
  const info = ctx.adapterInfo;
  return {
    vendor: info.vendor || 'unknown',
    architecture: info.architecture || 'unknown',
    device: info.device || 'unknown',
    description: info.description || 'unknown',
  };
}

/**
 * Accurately measure GPU execution time using hardware timestamp-query.
 * Returns median, min, max in milliseconds.
 */
export async function measureGPUTimestamp(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  wgCount: number,
  runs: number = 10,
): Promise<{ medianMs: number; minMs: number; maxMs: number }> {
  if (!device.features.has('timestamp-query')) {
    throw new Error('timestamp-query not supported');
  }

  const querySet = device.createQuerySet({
    type: 'timestamp',
    count: 2,
  });
  const resolveBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const queryReadback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const timesMs: number[] = [];

  for (let r = 0; r < runs; r++) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({
      timestampWrites: {
        querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(wgCount, wgCount);
    pass.end();

    encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, queryReadback, 0, 16);
    device.queue.submit([encoder.finish()]);

    await queryReadback.mapAsync(GPUMapMode.READ);
    const timesU64 = new BigUint64Array(queryReadback.getMappedRange());
    const deltaNs = Number(timesU64[1] - timesU64[0]);
    timesMs.push(deltaNs / 1_000_000);
    queryReadback.unmap();
  }

  querySet.destroy();
  resolveBuffer.destroy();
  queryReadback.destroy();

  timesMs.sort((a, b) => a - b);
  const medianMs = timesMs[Math.floor(runs / 2)];
  return {
    medianMs,
    minMs: timesMs[0],
    maxMs: timesMs[runs - 1],
  };
}
