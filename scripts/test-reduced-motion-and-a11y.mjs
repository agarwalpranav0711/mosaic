import { chromium } from 'playwright';

async function testReducedMotionAndA11y() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  console.log('=== D4 REDUCED MOTION & KEYBOARD TAB ACCESSIBILITY ===\n');

  // Test 1: prefers-reduced-motion: reduce
  console.log('Testing prefers-reduced-motion: reduce emulation...');
  const page1 = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await page1.goto('http://127.0.0.1:4174/');
  await page1.fill('#planet-name', 'Priya');
  await page1.click('#start-button');

  // Should immediately land after gathering without running full dive animation
  const t0 = performance.now();
  await page1.waitForFunction(() => {
    const landing = document.getElementById('landing');
    return landing && landing.classList.contains('visible');
  }, { timeout: 15000 });
  const landingElapsed = performance.now() - t0;

  const debug = await page1.evaluate(() => {
    return JSON.parse(document.getElementById('app').dataset.diveDebug);
  });

  console.log(`- Landing reached in: ${landingElapsed.toFixed(0)} ms`);
  console.log(`- reducedMotion recorded: ${debug.reducedMotion}`);
  console.log(`- Flight frames rendered: ${debug.frameTimeMedianMs === null ? '0 (skipped flight)' : 'rendered'}`);
  console.log(`- Status: ${debug.reducedMotion && debug.frameTimeMedianMs === null ? 'PASS' : 'FAIL'}\n`);
  await page1.close();

  // Test 2: Tab order and visible keyboard focus
  console.log('Testing keyboard tab order and visible focus...');
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page2.goto('http://127.0.0.1:4174/');

  // Initial tab focus: Sound toggle -> Planet name input -> Start button
  await page2.keyboard.press('Tab');
  const focus1 = await page2.evaluate(() => document.activeElement?.id);
  console.log(`- Focus step 1: <#${focus1}> (Expected: sound-toggle)`);

  await page2.keyboard.press('Tab');
  const focus2 = await page2.evaluate(() => document.activeElement?.id);
  console.log(`- Focus step 2: <#${focus2}> (Expected: planet-name)`);

  await page2.keyboard.press('Tab');
  const focus3 = await page2.evaluate(() => document.activeElement?.id);
  console.log(`- Focus step 3: <#${focus3}> (Expected: start-button)`);

  // Check visible focus ring outline on start-button
  const outlineStart = await page2.evaluate(() => {
    const btn = document.getElementById('start-button');
    btn.focus();
    const style = window.getComputedStyle(btn);
    return {
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
    };
  });
  console.log(`- Start Button Focus Ring: width=${outlineStart.outlineWidth}, style=${outlineStart.outlineStyle}`);

  await page2.close();
  await browser.close();
}

testReducedMotionAndA11y().catch(console.error);
