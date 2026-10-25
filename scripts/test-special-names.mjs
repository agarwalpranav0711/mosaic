import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part4-2', 'names');
mkdirSync(outDir, { recursive: true });

const testNames = [
  { id: 'long-40', name: 'SupercalifragilisticexpialidociousWorld40', label: '40-character Latin' },
  { id: 'devanagari', name: 'बृहस्पति ग्रह मंडल', label: 'Devanagari' },
  { id: 'arabic-rtl', name: 'كوكب الفردوس الأندلسي', label: 'Arabic RTL' },
  { id: 'cjk', name: '翡翠星雲探索者世界', label: 'CJK' },
];

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
];

async function runNamesTest() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  console.log('=== B2 SPECIAL NAMES & BUTTON HIT-TEST VERIFICATION ===\n');

  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

    for (const t of testNames) {
      await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      // Type the name
      await page.fill('#planet-name', t.name);
      await page.focus('#planet-name');
      await page.waitForTimeout(350);

      // Verify button hit-test
      const hitTestResult = await page.evaluate(() => {
        const btn = document.getElementById('start-button');
        const bounds = btn.getBoundingClientRect();
        const cx = bounds.left + bounds.width / 2;
        const cy = bounds.top + bounds.height / 2;
        const target = document.elementFromPoint(cx, cy);
        return {
          passed: target === btn,
          targetTag: target?.tagName,
          targetId: target?.id,
          buttonText: btn.textContent,
        };
      });

      // Verify text element is not clipped
      const textMetrics = await page.evaluate(() => {
        const display = document.getElementById('name-display');
        const control = document.getElementById('name-control');
        const displayRect = display.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        return {
          displayWidth: displayRect.width,
          displayHeight: displayRect.height,
          controlWidth: controlRect.width,
          controlHeight: controlRect.height,
          scrollHeight: display.scrollHeight,
          clientHeight: display.clientHeight,
          scrollWidth: display.scrollWidth,
          clientWidth: display.clientWidth,
          clipped: display.scrollHeight > display.clientHeight + 2 || display.scrollWidth > display.clientWidth + 2,
        };
      });

      const shotPath = resolve(outDir, `${t.id}-${vp.name}.png`);
      await page.screenshot({ path: shotPath });

      console.log(`Viewport ${vp.name} | ${t.label} ("${t.name}"):`);
      console.log(`  Button Hit-Test: ${hitTestResult.passed ? 'PASS' : 'FAIL'} (target: <${hitTestResult.targetTag} id="${hitTestResult.targetId}">)`);
      console.log(`  Clipping Check: ${!textMetrics.clipped ? 'PASS (no clipping)' : 'FAIL (clipped)'} (dims: ${Math.round(textMetrics.displayWidth)}x${Math.round(textMetrics.displayHeight)}px)`);
      console.log(`  Screenshot saved: ${shotPath}\n`);
    }

    await page.close();
  }

  await browser.close();
}

runNamesTest().catch(console.error);
