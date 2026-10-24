/**
 * WebGPU pipeline setup and dispatch for the Q8.24 fixed-point shader.
 * Supports dual output buffers (iter and final |z|^2) and chunked dispatches.
 */

import { CONFIG, validateConfigLimits } from './config';
import type { MosaicConfig } from './config';
import { shaderFixedSource, shaderFixedNegativeMulProbeSource } from './shaderFixed.wgsl';
import { floatToQ24, getScaleQ24, mulQ24 } from './cpuFixed';
import type { FixedTileResult } from './cpuFixed';

export interface GPUFixedContext {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  uniformBuffer: GPUBuffer;
  storageIterBuffer: GPUBuffer;
  storageZ2Buffer: GPUBuffer;
  readbackIterBuffer: GPUBuffer;
  readbackZ2Buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  workgroupSize: number;
}

export async function verifyNegativeQ24Multiplication(device: GPUDevice): Promise<{
  gpu: number[];
  cpu: number[];
}> {
  const module = device.createShaderModule({ code: shaderFixedNegativeMulProbeSource() });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === 'error');
  if (errors.length) throw new Error(`Negative multiply WGSL failed: ${errors.map((error) => error.message).join('; ')}`);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const output = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: output } }],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, 8);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const gpu = Array.from(new Int32Array(readback.getMappedRange()));
  readback.unmap();
  output.destroy();
  readback.destroy();
  const cpu = [
    Number(mulQ24(-1n, 1n)),
    Number(mulQ24(-16777217n, 1n)),
  ];
  if (gpu.some((value, index) => value !== cpu[index])) {
    throw new Error(`Negative Q8.24 multiplication mismatch: GPU [${gpu}], CPU [${cpu}]`);
  }
  return { gpu, cpu };
}

const UNIFORM_SIZE = 48;
const MAX_TILE_PIXELS = 512 * 512;

export async function initGPUFixed(device: GPUDevice, workgroupSize: number = 8): Promise<GPUFixedContext> {
  const shaderModule = device.createShaderModule({
    code: shaderFixedSource(workgroupSize),
  });

  const compilationInfo = await shaderModule.getCompilationInfo();
  const errors = compilationInfo.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    throw new Error(`Fixed-point WGSL compilation error:\n${errors.map((e) => e.message).join('\n')}`);
  }

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'main' },
  });

  const uniformBuffer = device.createBuffer({
    size: UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const storageIterBuffer = device.createBuffer({
    size: MAX_TILE_PIXELS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const storageZ2Buffer = device.createBuffer({
    size: MAX_TILE_PIXELS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const readbackIterBuffer = device.createBuffer({
    size: MAX_TILE_PIXELS * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const readbackZ2Buffer = device.createBuffer({
    size: MAX_TILE_PIXELS * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: storageIterBuffer } },
      { binding: 2, resource: { buffer: storageZ2Buffer } },
    ],
  });

  return {
    device,
    pipeline,
    uniformBuffer,
    storageIterBuffer,
    storageZ2Buffer,
    readbackIterBuffer,
    readbackZ2Buffer,
    bindGroup,
    workgroupSize,
  };
}

/**
 * Standard unchunked dispatch of a fixed-point tile.
 */
export async function computeTileFixed(
  ctx: GPUFixedContext,
  tileX: number,
  tileY: number,
  cfg: MosaicConfig = CONFIG,
): Promise<FixedTileResult> {
  validateConfigLimits(cfg);
  const { device, pipeline, uniformBuffer, storageIterBuffer, storageZ2Buffer, readbackIterBuffer, readbackZ2Buffer, bindGroup } = ctx;
  const tilePixels = cfg.tileSize * cfg.tileSize;

  const uniformData = new ArrayBuffer(UNIFORM_SIZE);
  const u32View = new Uint32Array(uniformData);
  const i32View = new Int32Array(uniformData);

  u32View[0] = tileX;
  u32View[1] = tileY;
  u32View[2] = cfg.tileSize;
  u32View[3] = cfg.maxIter;
  i32View[4] = floatToQ24(cfg.centerX);
  i32View[5] = floatToQ24(cfg.centerY);
  i32View[6] = getScaleQ24(cfg);
  u32View[7] = cfg.gridW;
  u32View[8] = cfg.gridH;
  u32View[9] = 0;              // rowOffset
  u32View[10] = cfg.tileSize;  // rowCount
  u32View[11] = 0;             // pad

  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  const wgX = Math.ceil(cfg.tileSize / ctx.workgroupSize);
  const wgY = Math.ceil(cfg.tileSize / ctx.workgroupSize);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(wgX, wgY);
  pass.end();

  encoder.copyBufferToBuffer(storageIterBuffer, 0, readbackIterBuffer, 0, tilePixels * 4);
  encoder.copyBufferToBuffer(storageZ2Buffer, 0, readbackZ2Buffer, 0, tilePixels * 4);
  device.queue.submit([encoder.finish()]);

  await Promise.all([
    readbackIterBuffer.mapAsync(GPUMapMode.READ),
    readbackZ2Buffer.mapAsync(GPUMapMode.READ),
  ]);

  const iterMapped = new Uint32Array(readbackIterBuffer.getMappedRange(0, tilePixels * 4));
  const z2Mapped = new Uint32Array(readbackZ2Buffer.getMappedRange(0, tilePixels * 4));
  const iter = new Uint32Array(iterMapped);
  const z2 = new Uint32Array(z2Mapped);

  readbackIterBuffer.unmap();
  readbackZ2Buffer.unmap();

  return { iter, z2 };
}

/**
 * Chunked dispatch of a fixed-point tile (Gate G2).
 * Splits the tile rows into numChunks smaller dispatches so no single dispatch takes too long,
 * while computing the exact same mathematical pixels.
 */
export async function computeTileFixedChunked(
  ctx: GPUFixedContext,
  tileX: number,
  tileY: number,
  cfg: MosaicConfig = CONFIG,
  numChunks: number = 4,
): Promise<FixedTileResult> {
  validateConfigLimits(cfg);
  const { device, pipeline, uniformBuffer, storageIterBuffer, storageZ2Buffer, readbackIterBuffer, readbackZ2Buffer, bindGroup } = ctx;
  const tilePixels = cfg.tileSize * cfg.tileSize;
  const rowsPerChunk = Math.ceil(cfg.tileSize / numChunks);

  for (let chunk = 0; chunk < numChunks; chunk++) {
    const rowOffset = chunk * rowsPerChunk;
    const rowCount = Math.min(rowsPerChunk, cfg.tileSize - rowOffset);
    if (rowCount <= 0) break;

    const uniformData = new ArrayBuffer(UNIFORM_SIZE);
    const u32View = new Uint32Array(uniformData);
    const i32View = new Int32Array(uniformData);

    u32View[0] = tileX;
    u32View[1] = tileY;
    u32View[2] = cfg.tileSize;
    u32View[3] = cfg.maxIter;
    i32View[4] = floatToQ24(cfg.centerX);
    i32View[5] = floatToQ24(cfg.centerY);
    i32View[6] = getScaleQ24(cfg);
    u32View[7] = cfg.gridW;
    u32View[8] = cfg.gridH;
    u32View[9] = rowOffset;
    u32View[10] = rowCount;
    u32View[11] = 0;

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const wgX = Math.ceil(cfg.tileSize / ctx.workgroupSize);
    const wgY = Math.ceil(rowCount / ctx.workgroupSize);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();

    device.queue.submit([encoder.finish()]);
    // Ensure this chunk completes before writing next uniform
    await device.queue.onSubmittedWorkDone();
  }

  // Copy both output buffers to readback
  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(storageIterBuffer, 0, readbackIterBuffer, 0, tilePixels * 4);
  copyEncoder.copyBufferToBuffer(storageZ2Buffer, 0, readbackZ2Buffer, 0, tilePixels * 4);
  device.queue.submit([copyEncoder.finish()]);

  await Promise.all([
    readbackIterBuffer.mapAsync(GPUMapMode.READ),
    readbackZ2Buffer.mapAsync(GPUMapMode.READ),
  ]);

  const iterMapped = new Uint32Array(readbackIterBuffer.getMappedRange(0, tilePixels * 4));
  const z2Mapped = new Uint32Array(readbackZ2Buffer.getMappedRange(0, tilePixels * 4));
  const iter = new Uint32Array(iterMapped);
  const z2 = new Uint32Array(z2Mapped);

  readbackIterBuffer.unmap();
  readbackZ2Buffer.unmap();

  return { iter, z2 };
}

export interface AdaptiveFixedTileResult extends FixedTileResult {
  estimatedMs: number;
  chunked: boolean;
}

/** Select chunked dispatch when the caller's calibrated estimate exceeds the safety threshold. */
export async function computeTileFixedAdaptive(
  ctx: GPUFixedContext,
  tileX: number,
  tileY: number,
  cfg: MosaicConfig,
  estimatedMs: number,
  thresholdMs = 100,
  numChunks = 4,
): Promise<AdaptiveFixedTileResult> {
  if (!Number.isFinite(estimatedMs) || estimatedMs < 0) {
    throw new Error(`Invalid estimated dispatch time: ${estimatedMs}`);
  }
  const chunked = estimatedMs > thresholdMs;
  const result = chunked
    ? await computeTileFixedChunked(ctx, tileX, tileY, cfg, numChunks)
    : await computeTileFixed(ctx, tileX, tileY, cfg);
  return { ...result, estimatedMs, chunked };
}
