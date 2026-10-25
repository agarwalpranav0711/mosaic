import { chromium } from 'playwright';
import { rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part5-1');
mkdirSync(outDir, { recursive: true });

async function computeMeanLuminanceOfPng(page, b64DataUrl) {
  return await page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((resolve) => {
      img.onload = resolve;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sumLum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sumLum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return {
      width: img.width,
      height: img.height,
      meanLuminance: sumLum / (canvas.width * canvas.height),
    };
  }, b64DataUrl);
}

async function runRecapture() {
  console.log('=== PART 5.1 IDLE SCREENS & PRIYA SHARE CARD RE-CAPTURE ===\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const reports = [];

  // 1. Idle screen 390x844
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500); // Ambient canvas rendering
    const filePath = join(outDir, 'idle-390x844.png');
    const buffer = await page.screenshot({ path: filePath });
    const stats = statSync(filePath);
    const lumStats = await computeMeanLuminanceOfPng(page, `data:image/png;base64,${buffer.toString('base64')}`);
    reports.push({
      item: 'Idle screen (390x844 mobile)',
      filename: 'idle-390x844.png',
      width: lumStats.width,
      height: lumStats.height,
      bytes: stats.size,
      meanLuminance: lumStats.meanLuminance,
    });
    await page.close();
  }

  // 2. Idle screen 1440x900
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(3500);
    const filePath = join(outDir, 'idle-1440x900.png');
    const buffer = await page.screenshot({ path: filePath });
    const stats = statSync(filePath);
    const lumStats = await computeMeanLuminanceOfPng(page, `data:image/png;base64,${buffer.toString('base64')}`);
    reports.push({
      item: 'Idle screen (1440x900 desktop)',
      filename: 'idle-1440x900.png',
      width: lumStats.width,
      height: lumStats.height,
      bytes: stats.size,
      meanLuminance: lumStats.meanLuminance,
    });
    await page.close();
  }

  // 3. Priya Share Card (1080x1350)
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(2500);

    const cardBase64 = await page.evaluate(async (planetName) => {
      const testApi = window.__mosaicHomeTest;
      const card = await testApi.buildShareCardForTest(planetName);
      return card.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    }, 'Priya');

    const filePath = join(outDir, 'share-card-priya.png');
    writeFileSync(filePath, Buffer.from(cardBase64, 'base64'));
    const stats = statSync(filePath);
    const lumStats = await computeMeanLuminanceOfPng(page, `data:image/png;base64,${cardBase64}`);
    reports.push({
      item: 'Priya Share Card (1080x1350)',
      filename: 'share-card-priya.png',
      width: lumStats.width,
      height: lumStats.height,
      bytes: stats.size,
      meanLuminance: lumStats.meanLuminance,
    });
    await page.close();
  }

  await browser.close();

  console.log('| Asset | Filename | Dimensions | File Size | Mean Luminance |');
  console.log('| :--- | :--- | :--- | :--- | :--- |');
  for (const r of reports) {
    console.log(`| ${r.item} | \`${r.filename}\` | ${r.width}x${r.height} | ${(r.bytes / 1024).toFixed(2)} KB (${r.bytes} B) | ${r.meanLuminance.toFixed(4)} |`);
  }
}

runRecapture().catch((err) => {
  console.error(err);
  process.exit(1);
});
