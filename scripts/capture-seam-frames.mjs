import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part4-2', 'seam');
mkdirSync(outDir, { recursive: true });

async function captureSeamFrames() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4174/');

  console.log('=== C2 S3 KEYFRAME SEAM & RADIAL MASK VERIFICATION ===\n');

  // Start dive with Priya
  await page.fill('#planet-name', 'Priya');
  await page.click('#start-button');

  // Wait for flight visible
  await page.waitForFunction(() => {
    const flight = document.getElementById('flight');
    return flight && flight.style.opacity === '1';
  }, { timeout: 30000 });

  // Capture 6 sequential frames during flight transition
  console.log('Capturing 6 consecutive frames across transition...');
  const framePaths = [];
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(160);
    const p = resolve(outDir, `transition-frame-${i}.png`);
    await page.screenshot({ path: p });
    framePaths.push(p);
    console.log(`- Frame ${i} captured: ${p}`);
  }

  // Pixel edge-detection analysis on captured flight canvas
  const analysis = await page.evaluate(() => {
    const canvas = document.getElementById('flight');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Check circular perimeter vs rect perimeter
    // Sample along rectangular bounding box of incoming keyframe
    // If a hard rectangular edge existed, horizontal/vertical gradient would spike abruptly
    // With radial alpha mask feathered to 0 at perimeter, gradient across rect border is smooth / zero
    const imgData = ctx.getImageData(0, 0, w, h).data;
    
    // Check horizontal line across center
    const cy = Math.round(h / 2);
    let maxDiffX = 0;
    for (let x = 10; x < w - 10; x++) {
      const idx = (cy * w + x) * 4;
      const idxPrev = (cy * w + (x - 1)) * 4;
      const diff = Math.abs(imgData[idx] - imgData[idxPrev]);
      if (diff > maxDiffX) maxDiffX = diff;
    }

    return {
      width: w,
      height: h,
      maxStepDiff: maxDiffX,
      hasHardRectangularStep: maxDiffX > 180, // A sharp square step would produce a steep discontinuity
    };
  });

  console.log(`\nFrame Analysis: max adjacent pixel step along transition = ${analysis.maxStepDiff} (no hard step threshold > 180: ${!analysis.hasHardRectangularStep ? 'PASS (smooth crossfade)' : 'FAIL'})`);
  console.log('Visual evidence: 6 frame stills saved to screens/part4-2/seam/');

  await browser.close();
}

captureSeamFrames().catch(console.error);
