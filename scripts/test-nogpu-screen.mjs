import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part5-1');
mkdirSync(outDir, { recursive: true });

async function testNoGpu() {
  console.log('=== TESTING ?nogpu=1 FAILURE SCREEN ===\n');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 390, height: 844 }, // mobile viewport
  });

  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4174/?nogpu=1');
  await page.waitForTimeout(500);

  const failureSec = page.locator('#webgpu-failure');
  const isVisible = await failureSec.isVisible();
  console.log('Failure screen visible:', isVisible);

  const inAppHint = page.locator('#in-app-hint');
  const hintText = await inAppHint.textContent();
  console.log('In-app hint text:', hintText);

  const copyBtn = page.locator('#copy-link-btn');
  const btnText = await copyBtn.textContent();
  console.log('Copy button text:', btnText);

  // Click the copy button
  await copyBtn.click();
  await page.waitForTimeout(100);
  const afterClickText = await copyBtn.textContent();
  console.log('Copy button text after click:', afterClickText);

  // Take screenshot
  const screenshotPath = resolve(outDir, 'failure-nogpu.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Screenshot saved to:', screenshotPath);

  // Also take desktop view
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopPath = resolve(outDir, 'failure-nogpu-desktop.png');
  await page.screenshot({ path: desktopPath });
  console.log('Desktop screenshot saved to:', desktopPath);

  await browser.close();
}

testNoGpu().catch((err) => {
  console.error(err);
  process.exit(1);
});
