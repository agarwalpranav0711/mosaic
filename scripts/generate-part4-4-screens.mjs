import { chromium } from 'playwright';
import { rmSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const projectRoot = process.cwd();
const outDir = resolve(projectRoot, 'screens', 'part4-4');

async function computeMeanLuminance(page) {
  return await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    // Draw ambient canvas, flight canvas or background
    const amb = document.getElementById('ambient-canvas');
    if (amb) ctx.drawImage(amb, 0, 0, canvas.width, canvas.height);
    // Draw visible elements
    const prev = document.getElementById('preview-planet');
    if (prev && prev.classList.contains('visible')) {
      const rect = prev.getBoundingClientRect();
      ctx.drawImage(prev, rect.left, rect.top, rect.width, rect.height);
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sumLum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sumLum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sumLum / (canvas.width * canvas.height);
  });
}

async function captureAndMeasure(page, filename, description) {
  const filePath = join(outDir, filename);
  await page.screenshot({ path: filePath });
  const stats = statSync(filePath);
  const lum = await computeMeanLuminance(page);
  return {
    filename,
    description,
    bytes: stats.size,
    meanLuminance: lum,
  };
}

async function generateScreens() {
  console.log('--- GENERATING PART 4.4 SCREENSHOTS & LUMINANCE AUDIT ---\n');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const results = [];

  // 1. Idle at 390x844
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500); // Wait for ambient world & sample planets init
    const item = await captureAndMeasure(page, 'idle-390x844.png', 'Idle home screen at 390x844 (ambient Mandelbrot zoom background, drifting planets, breathing point, single invitation line, celestial obsidian button)');
    results.push(item);
    await page.close();
  }

  // 2. Idle at 1440x900
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500);
    const item = await captureAndMeasure(page, 'idle-1440x900.png', 'Idle home screen at 1440x900 (wide ambient canvas, drifting satellites, center typography, celestial button)');
    results.push(item);
    await page.close();
  }

  // 3. Priya typed at 390x844 (preview visible)
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500);
    await page.fill('#planet-name', 'Priya');
    // Wait for 350ms debounce + preview render
    await page.waitForFunction(() => {
      const p = document.getElementById('preview-planet');
      return p && p.classList.contains('visible');
    }, { timeout: 10000 });
    await page.waitForTimeout(500); // Ensure crossfade complete
    const item = await captureAndMeasure(page, 'preview-priya-390x844.png', 'Live preview with "Priya" typed (192px circular preview planet at top 26% with Ice cyan halo, accent button rim)');
    results.push(item);
    await page.close();
  }

  // 4. Kuber typed at 390x844 (rehashed preview visible)
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500);
    await page.fill('#planet-name', 'Kuber');
    await page.waitForFunction(() => {
      const p = document.getElementById('preview-planet');
      return p && p.classList.contains('visible');
    }, { timeout: 10000 });
    await page.waitForTimeout(500);
    const item = await captureAndMeasure(page, 'preview-kuber-390x844.png', 'Live preview with "Kuber" typed (rehashed counter 1 planet preview, Ice palette accent glow)');
    results.push(item);
    await page.close();
  }

  // 5. Devanagari name typed at 390x844
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500);
    await page.fill('#planet-name', 'बृहस्पति');
    await page.waitForFunction(() => {
      const p = document.getElementById('preview-planet');
      return p && p.classList.contains('visible');
    }, { timeout: 10000 });
    await page.waitForTimeout(500);
    const item = await captureAndMeasure(page, 'preview-devanagari-390x844.png', 'Live preview with Devanagari name "बृहस्पति" (proper font rendering, full preview circle, glowing accent)');
    results.push(item);
    await page.close();
  }

  // 6. Mid-morph frame during 400ms crossfade
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500);
    await page.fill('#planet-name', 'Orion');
    // Wait until visible class is added, then capture immediately before 400ms crossfade finishes
    await page.waitForFunction(() => {
      const p = document.getElementById('preview-planet');
      return p && p.classList.contains('visible');
    }, { timeout: 10000 });
    await page.waitForTimeout(120); // Mid-transition at ~120ms of 400ms CSS transition
    const item = await captureAndMeasure(page, 'preview-mid-morph-390x844.png', 'Mid-morph frame during 400ms preview crossfade (opacity transitioning, breathing light fading as preview reveals)');
    results.push(item);
    await page.close();
  }

  // 7. Performance guard fallback state
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/?preview-perf=slow');
    await page.waitForTimeout(3500);
    await page.fill('#planet-name', 'SlowTest');
    // Wait for performance guard trigger
    await page.waitForFunction(() => {
      const app = document.getElementById('app');
      return app && app.dataset.previewGuardTriggered;
    }, { timeout: 10000 });
    await page.waitForTimeout(400);
    const item = await captureAndMeasure(page, 'fallback-perf-guard-390x844.png', 'Performance guard fallback state (?preview-perf=slow fault-injection triggered: live preview paused for session, gentle status notice displayed, ambient background and drifting planets maintained)');
    results.push(item);
    await page.close();
  }

  await browser.close();

  console.log('\n--- SCREENSHOT AUDIT TABLE ---');
  console.log('| File | Size (Bytes) | Mean Lum | Description |');
  console.log('|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.filename} | ${r.bytes} | ${r.meanLuminance.toFixed(4)} | ${r.description} |`);
  }
}

generateScreens().catch(console.error);
