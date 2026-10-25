import { chromium } from 'playwright';
import { rmSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const projectRoot = process.cwd();
const outDir = resolve(projectRoot, 'screens', 'part4-3');

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
];

const PROG_POINTS = [
  { raw: 0.00, label: '0pct' },
  { raw: 0.10, label: '10pct' },
  { raw: 0.25, label: '25pct' },
  { raw: 0.50, label: '50pct' },
  { raw: 0.75, label: '75pct' },
  { raw: 1.00, label: '100pct' },
];

async function generateScreens() {
  console.log('--- GENERATING PART 4.3 SCREENSHOTS & LUMINANCE AUDIT ---');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const luminanceResults = {};

  for (const vp of VIEWPORTS) {
    console.log(`\nProcessing viewport ${vp.name}...`);
    luminanceResults[vp.name] = [];
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(300);

    // 1. S1 with typed normal name ("Priya")
    await page.locator('#planet-name').fill('Priya');
    await page.waitForTimeout(300);
    const s1File = `s1-priya-typed-${vp.name}.png`;
    const s1Path = join(outDir, s1File);
    await page.screenshot({ path: s1Path });
    console.log(`Saved ${s1File}`);

    // Click to start dive and wait for keyframes ready
    const btnBox = await page.locator('#start-button').boundingBox();
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);

    // Wait until keyframes are prepared and flight begins
    await page.waitForFunction(() => {
      const testHook = window.__mosaicDiveTest;
      return testHook && typeof testHook.renderFrameAt === 'function' && (testHook.getPreparedFrames()?.length ?? 0) > 0;
    }, { timeout: 30000 });

    // Step through the 6 progress points
    for (const pt of PROG_POINTS) {
      const stats = await page.evaluate((progress) => {
        const testHook = window.__mosaicDiveTest;
        testHook.renderFrameAt(progress);
        const fl = document.getElementById('flight');
        fl.style.display = 'block';
        fl.style.opacity = '1';

        const ctx = fl.getContext('2d');
        const imgData = ctx.getImageData(0, 0, fl.width, fl.height).data;
        let sumLum = 0;
        let nonZero = 0;
        for (let i = 0; i < imgData.length; i += 4) {
          const r = imgData[i];
          const g = imgData[i + 1];
          const b = imgData[i + 2];
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          sumLum += lum;
          if (lum > 2) nonZero++;
        }
        return {
          meanLum: sumLum / (fl.width * fl.height),
          nonZeroPct: (nonZero / (fl.width * fl.height)) * 100,
        };
      }, pt.raw);

      luminanceResults[vp.name].push({
        label: pt.label,
        raw: pt.raw,
        meanLum: stats.meanLum,
        nonZeroPct: stats.nonZeroPct,
      });

      const frameFile = `flight-${pt.label}-${vp.name}.png`;
      const framePath = join(outDir, frameFile);
      await page.screenshot({ path: framePath });
      console.log(`Saved ${frameFile}: Mean Luminance = ${stats.meanLum.toFixed(4)}, Non-zero = ${stats.nonZeroPct.toFixed(2)}%`);
    }

    await context.close();
  }

  await browser.close();

  console.log('\n--- SUMMARY OF SCREENSHOTS IN screens/part4-3 ---');
  const files = readdirSync(outDir).sort();
  for (const f of files) {
    const sz = statSync(join(outDir, f)).size;
    console.log(`${f.padEnd(30)} ${String(sz).padStart(8)} bytes`);
  }

  console.log('\n--- LUMINANCE TABLE ---');
  console.log(JSON.stringify(luminanceResults, null, 2));
}

generateScreens().catch(console.error);
