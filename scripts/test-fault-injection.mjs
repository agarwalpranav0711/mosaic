import { chromium } from 'playwright';

async function testFaultInjection() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  console.log('=== D3 FAULT INJECTION VERIFICATION ===\n');

  // Test 1: ?fault=keyframe-timeout
  console.log('Testing fault injection: keyframe-timeout...');
  const page1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page1.goto('http://127.0.0.1:4174/?fault=keyframe-timeout');
  await page1.fill('#planet-name', 'Priya');
  await page1.click('#start-button');

  await page1.waitForFunction(() => {
    const err = document.getElementById('error-state');
    return err && err.style.display !== 'none';
  }, { timeout: 15000 });

  const timeoutMsg = await page1.textContent('#error-message');
  console.log(`- Timeout Error Message: "${timeoutMsg}"`);
  console.log(`- Status: ${timeoutMsg?.includes('8 seconds') ? 'PASS' : 'FAIL'}\n`);
  await page1.close();

  // Test 2: ?fault=device-lost
  console.log('Testing fault injection: device-lost...');
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page2.goto('http://127.0.0.1:4174/?fault=device-lost');
  await page2.fill('#planet-name', 'Priya');
  await page2.click('#start-button');

  await page2.waitForFunction(() => {
    const err = document.getElementById('error-state');
    return err && err.style.display !== 'none';
  }, { timeout: 15000 });

  const lostMsg = await page2.textContent('#error-message');
  console.log(`- Device-Lost Error Message: "${lostMsg}"`);
  console.log(`- Status: ${lostMsg?.includes('GPU device stopped') || lostMsg?.includes('GPU device was lost') ? 'PASS' : 'FAIL'}`);

  // Test Retry button
  console.log('Testing Retry button after device-loss...');
  await page2.click('#restart-button');
  await page2.waitForFunction(() => {
    const landing = document.getElementById('landing');
    return landing && landing.classList.contains('visible');
  }, { timeout: 30000 });
  console.log('- Retry completed and landed: PASS\n');

  await page2.close();
  await browser.close();
}

testFaultInjection().catch(console.error);
