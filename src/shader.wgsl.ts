/**
 * WGSL compute shader for Mandelbrot tile computation.
 *
 * Params struct layout (std140-like WebGPU uniform rules):
 *   offset 0:  tileX     (u32, 4 bytes)
 *   offset 4:  tileY     (u32, 4 bytes)
 *   offset 8:  tileSize  (u32, 4 bytes)
 *   offset 12: maxIter   (u32, 4 bytes)
 *   offset 16: centerX   (f32, 4 bytes)
 *   offset 20: centerY   (f32, 4 bytes)
 *   offset 24: scale     (f32, 4 bytes)
 *   offset 28: gridW     (u32, 4 bytes)
 *   offset 32: gridH     (u32, 4 bytes)
 *   --- padding to 16-byte alignment: 12 bytes ---
 *   Total: 48 bytes
 *
 * WebGPU uniform structs are laid out with each member aligned to its own
 * alignment. All our members are scalar (4-byte alignment), so they pack
 * tightly. But the struct's total size must be a multiple of 16 bytes
 * (the largest alignment of any member, rounded up to 16 for uniform buffers).
 * 9 × 4 = 36 → padded to 48.
 */

export function shaderSource(workgroupSize: number = 8): string {
  return /* wgsl */ `
struct Params {
  tileX: u32,
  tileY: u32,
  tileSize: u32,
  maxIter: u32,
  centerX: f32,
  centerY: f32,
  scale: f32,
  gridW: u32,
  gridH: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_z2: array<f32>;

@compute @workgroup_size(${workgroupSize}, ${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.tileSize || id.y >= p.tileSize) { return; }

  let px = f32(p.tileX * p.tileSize + id.x) - f32(p.gridW * p.tileSize) * 0.5;
  let py = f32(p.tileY * p.tileSize + id.y) - f32(p.gridH * p.tileSize) * 0.5;
  let cr = p.centerX + px * p.scale;
  let ci = p.centerY + py * p.scale;

  var zr = 0.0;
  var zi = 0.0;
  var i = 0u;
  var final_z2 = 0.0;
  loop {
    let zr2 = zr * zr;
    let zi2 = zi * zi;
    let z2 = zr2 + zi2;
    if (i >= p.maxIter || z2 > 4.0) {
      final_z2 = z2;
      break;
    }
    let t = zr2 - zi2 + cr;
    zi = 2.0 * zr * zi + ci;
    zr = t;
    i = i + 1u;
  }
  let idx = id.y * p.tileSize + id.x;
  out[idx] = i;
  out_z2[idx] = final_z2;
}
`;
}
