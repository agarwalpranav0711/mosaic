/**
 * All tunable constants for Mosaic, Part 1.
 *
 * Derived value `scale` = viewWidth / (gridW * tileSize)
 * With defaults: 3.0 / (64 * 128) = ~0.000366
 *
 * f32 precision note: IEEE 754 float32 has ~7 decimal digits of precision.
 * At scale ~0.000366, pixel coordinates map to complex values with plenty of
 * precision headroom. Deep zoom (scale < ~1e-7) would start losing detail
 * and would need f64 emulation (double-float tricks). Deep zoom is out of
 * scope for Mosaic.
 */
export interface MosaicConfig {
  tileSize: number;
  gridW: number;
  gridH: number;
  maxIter: number;
  centerX: number;
  centerY: number;
  viewWidth: number;
  workgroupSize: number;
  tolerance: { minExactMatchPct: number };
}

export const SITE_URL = 'https://mosaic-neon.vercel.app';
export const ENGINE_VERSION = 1;

/**
 * All tunable constants for Mosaic, Part 1 & 1.5.
 * Defaults are UNCHANGED.
 */
export const CONFIG: MosaicConfig = {
  tileSize: 128,        // pixels per tile side
  gridW: 64,            // tiles across
  gridH: 64,            // tiles down  -> 8192 x 8192 total (4,096 tiles)
  maxIter: 500,         // max Mandelbrot iterations
  centerX: -0.5,        // view center, real axis
  centerY: 0.0,         // view center, imaginary axis
  viewWidth: 3.0,       // width of the whole image in complex-plane units
  workgroupSize: 8,     // must match the shader
  tolerance: { minExactMatchPct: 99.0 },
};

/**
 * View 2: Boundary-rich region (Seahorse valley / bulbs)
 */
export const VIEW_ZOOMED = {
  centerX: -0.75,
  centerY: 0.1,
  viewWidth: 0.5,
};

/** Complex-plane units per pixel. */
export function getScale(cfg: Pick<MosaicConfig, 'viewWidth' | 'gridW' | 'tileSize'> = CONFIG): number {
  return cfg.viewWidth / (cfg.gridW * cfg.tileSize);
}

/** Check f32 precision safety. IEEE 754 float32 machine epsilon is ~1.19e-7. */
export function checkF32ScaleSafety(scale: number): { safe: boolean; warning?: string } {
  if (scale < 1.19e-7) {
    return { safe: false, warning: 'scale < 1.19e-7: f32 precision loss is severe (pixel step below machine epsilon)' };
  }
  if (scale < 1e-6) {
    return { safe: true, warning: 'scale < 1e-6: approaching f32 limits, subtle precision artifacts possible' };
  }
  return { safe: true };
}

/**
 * Validate configuration limits (Part 1.8):
 * - maxIter above 65,535 throws a clear error (no silent clamp).
 * - scale_q24 below 16 units per pixel throws a clear error.
 */
export function validateConfigLimits(cfg: Pick<MosaicConfig, 'maxIter' | 'viewWidth' | 'gridW' | 'tileSize'>): void {
  if (cfg.maxIter > 65535) {
    throw new Error(`maxIter exceeds u16 limit (65535): received ${cfg.maxIter}`);
  }
  const scale = cfg.viewWidth / (cfg.gridW * cfg.tileSize);
  const scaleQ24 = Math.round(scale * 16777216);
  if (scaleQ24 < 16) {
    throw new Error(`scale_q24 is below minimum safe threshold (16 units/pixel): received ${scaleQ24}`);
  }
}

