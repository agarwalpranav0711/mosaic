import { chromium } from 'playwright';

async function verifyB2C2D2() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/dev/index.html');
  await page.waitForTimeout(500);

  // Click Run All Checks
  console.log('Clicking "Run All Checks & Generate Gallery"...');
  await page.locator('#btn-run').click();

  // Wait for button to be enabled again
  await page.waitForFunction(() => {
    const btn = document.getElementById('btn-run');
    return btn && !btn.disabled && btn.textContent.includes('Re-run');
  }, { timeout: 30000 });

  // Read results
  const reportText = await page.evaluate(() => {
    const el = document.getElementById('results');
    return el ? el.innerText : '';
  });

  console.log('Results output:\n', reportText);

  await browser.close();
}

verifyB2C2D2().catch(console.error);
