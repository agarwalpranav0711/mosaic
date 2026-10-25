import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function checkLuminance() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();

  const files = [
    'screens/part4-2/s3-flight-early-390x844.png',
    'screens/part4-2/s3-flight-early-1440x900.png',
  ];

  for (const file of files) {
    const fullPath = resolve(process.cwd(), file);
    const dataUrl = `data:image/png;base64,${readFileSync(fullPath).toString('base64')}`;

    const stats = await page.evaluate(async (url) => {
      const img = new Image();
      await new Promise(r => { img.onload = r; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let totalLum = 0;
      let nonZeroCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        totalLum += lum;
        if (lum > 2) nonZeroCount++;
      }
      return {
        width: img.width,
        height: img.height,
        meanLuminance: totalLum / (c.width * c.height),
        nonZeroPct: (nonZeroCount / (c.width * c.height)) * 100,
      };
    }, dataUrl);

    console.log(`${file}:`);
    console.log(`  Dimensions: ${stats.width}x${stats.height}`);
    console.log(`  Mean Luminance: ${stats.meanLuminance.toFixed(4)}`);
    console.log(`  Non-zero pixels: ${stats.nonZeroPct.toFixed(2)}%\n`);
  }

  await browser.close();
}

checkLuminance().catch(console.error);
