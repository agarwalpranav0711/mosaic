/**
 * WGSL compute shader for Mandelbrot tile computation using Q8.24 fixed-point arithmetic.
 *
 * Part 2 Task 1:
 * - Buffer 0: Uniform Params (includes chunking offsets rowOffset, rowCount)
 * - Buffer 1: out_iter (array<u32>) - unchanged canonical iteration counts
 * - Buffer 2: out_z2 (array<u32>) - final |z|^2 at escape in Q8.24 integer format
 */

const MUL_Q24_WGSL = `
fn mul_q24(a: i32, b: i32) -> i32 {
  let neg = (a < 0) != (b < 0);
  let ua = u32(abs(a));
  let ub = u32(abs(b));

  let a_lo = ua & 0xffffu;
  let a_hi = ua >> 16u;
  let b_lo = ub & 0xffffu;
  let b_hi = ub >> 16u;

  let p0 = a_lo * b_lo;
  let p1 = a_lo * b_hi;
  let p2 = a_hi * b_lo;
  let p3 = a_hi * b_hi;

  let mid = (p0 >> 16u) + (p1 & 0xffffu) + (p2 & 0xffffu);
  let prod_lo = (p0 & 0xffffu) | ((mid & 0xffffu) << 16u);
  let prod_hi = p3 + (p1 >> 16u) + (p2 >> 16u) + (mid >> 16u);
  let res_u = (prod_lo >> 24u) | (prod_hi << 8u);
  if (neg) { return -i32(res_u); }
  return i32(res_u);
}
`;

export function shaderFixedSource(workgroupSize: number = 8): string {
  return /* wgsl */ `
struct Params {
  tileX: u32,
  tileY: u32,
  tileSize: u32,
  maxIter: u32,
  centerX: i32,
  centerY: i32,
  scale: i32,
  gridW: u32,
  gridH: u32,
  rowOffset: u32,
  rowCount: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> out_iter: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_z2: array<u32>;

// Q8.24 multiplication truncates the magnitude, then reapplies the sign (toward zero).
${MUL_Q24_WGSL}

@compute @workgroup_size(${workgroupSize}, ${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.tileSize || id.y >= p.rowCount) { return; }
  let actualY = id.y + p.rowOffset;
  if (actualY >= p.tileSize) { return; }

  let halfW = i32(p.gridW * p.tileSize) >> 1;
  let halfH = i32(p.gridH * p.tileSize) >> 1;

  let px = i32(p.tileX * p.tileSize + id.x) - halfW;
  let py = i32(p.tileY * p.tileSize + actualY) - halfH;

  let cr = p.centerX + px * p.scale;
  let ci = p.centerY + py * p.scale;

  // 4.0 in Q8.24 is 4 * 2^24 = 67108864
  let ESCAPE_RADIUS_SQ = 67108864;

  var zr = 0;
  var zi = 0;
  var i = 0u;
  var final_z2 = 0;

  loop {
    let zr2 = mul_q24(zr, zr);
    let zi2 = mul_q24(zi, zi);
    let z2 = zr2 + zi2;
    if (i >= p.maxIter) {
      final_z2 = z2;
      break;
    }
    if (z2 > ESCAPE_RADIUS_SQ) {
      final_z2 = z2;
      break;
    }
    let t = (zr2 - zi2) + cr;
    let zr_zi = mul_q24(zr, zi);
    zi = (zr_zi << 1) + ci;
    zr = t;
    i = i + 1u;
  }

  let idx = actualY * p.tileSize + id.x;
  out_iter[idx] = i;
  out_z2[idx] = u32(final_z2);
}
`;
}

export function shaderFixedNegativeMulProbeSource(pairs: ReadonlyArray<readonly [bigint, bigint]>): string {
  const outputs = pairs.map(([a, b], index) =>
    `  output[${index}] = mul_q24(${a}, ${b});`,
  ).join('\n');
  return `
${MUL_Q24_WGSL}
@group(0) @binding(0) var<storage, read_write> output: array<i32>;
@compute @workgroup_size(1)
fn main() {
${outputs}
}
`;
}
