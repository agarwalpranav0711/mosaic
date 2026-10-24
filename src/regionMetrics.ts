export interface ProbeMetrics {
  interiorPixels: number;
  fastEscapePixels: number;
  distinctIterations: number;
  edgePixels: number;
  edgeDensityPercent: number;
  totalPixels: number;
}

export function computeProbeMetrics(iter: Uint32Array, maxIter: number): ProbeMetrics {
  const size = 64;
  const totalPixels = iter.length;
  if (totalPixels !== size * size) throw new Error(`Probe must be ${size}x${size}.`);
  let interiorPixels = 0;
  let fastEscapePixels = 0;
  const distinct = new Set<number>();
  let edgePixels = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const value = iter[index];
      if (value >= maxIter) interiorPixels++;
      if (value < 10) fastEscapePixels++;
      distinct.add(value);
      const hasEdge = (x > 0 && Math.abs(value - iter[index - 1]) >= 2)
        || (x + 1 < size && Math.abs(value - iter[index + 1]) >= 2)
        || (y > 0 && Math.abs(value - iter[index - size]) >= 2)
        || (y + 1 < size && Math.abs(value - iter[index + size]) >= 2);
      if (hasEdge) edgePixels++;
    }
  }
  return {
    interiorPixels,
    fastEscapePixels,
    distinctIterations: distinct.size,
    edgePixels,
    edgeDensityPercent: edgePixels * 100 / totalPixels,
    totalPixels,
  };
}
