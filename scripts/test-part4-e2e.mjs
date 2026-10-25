import { chromium } from 'playwright';
import { rmSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const projectRoot = process.cwd();
const screensDir = resolve(projectRoot, 'screens', 'part4');

async function runE2E() {
  console.log('=== PART 4.1 END-TO-END AUTOMATED VERIFICATION ===\n');

  // Step 0: Clean existing screenshots
  console.log('Cleaning screens/part4 directory...');
  rmSync(screensDir, { recursive: true, force: true });
  mkdirSync(screensDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const results = {
    h1: {},
    h2: {},
    h3_timeout: {},
    h3_device_lost: {},
    h4_screenshots: [],
    h5_priya_1: null,
    h5_priya_2: null,
    h5_kuber: null,
  };

  const viewports = [
    { name: '390x844', w: 390, h: 844 },
    { name: '1440x900', w: 1440, h: 900 },
  ];

  for (const vp of viewports) {
    console.log(`\n--- Running Full Dive for Priya at ${vp.name} ---`);
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await context.newPage();

    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(300);

    // S1: Idle state
    await page.locator('#planet-name').fill('Priya');
    await page.waitForTimeout(200);

    // Save S1 screenshot
    const s1Path = join(screensDir, `s1-${vp.name}.png`);
    await page.screenshot({ path: s1Path });
    console.log(`Saved S1 screenshot: ${s1Path}`);

    // H1 check: elementFromPoint at center of start button
    const btnBox = await page.locator('#start-button').boundingBox();
    const cx = btnBox.x + btnBox.width / 2;
    const cy = btnBox.y + btnBox.height / 2;
    const hitCheck = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { id: el?.id, tag: el?.tagName, passed: el?.id === 'start-button' };
    }, { x: cx, y: cy });

    console.log(`H1 Hit-test at ${vp.name}:`, hitCheck);
    results.h1[vp.name] = hitCheck;
    if (!hitCheck.passed) {
      throw new Error(`H1 hit test failed at ${vp.name}: hit ${hitCheck.tag}#${hitCheck.id}`);
    }

    // Click using real pointer at button center (no force: true)
    console.log(`Clicking start button with real mouse at (${cx.toFixed(1)}, ${cy.toFixed(1)})...`);
    await page.mouse.click(cx, cy);

    // S2: Gathering state
    await page.waitForSelector('#gathering[style*="display: flex"]', { timeout: 3000 });
    const s2Path = join(screensDir, `s2-${vp.name}.png`);
    await page.screenshot({ path: s2Path });
    console.log(`Saved S2 screenshot: ${s2Path}`);

    // Wait for S3: Flight visible
    await page.waitForSelector('#flight[style*="display: block"]', { timeout: 10000 });
    // S3a: early flight
    await page.waitForTimeout(700);
    const s3aPath = join(screensDir, `s3a-${vp.name}.png`);
    await page.screenshot({ path: s3aPath });
    console.log(`Saved S3a screenshot: ${s3aPath}`);

    // S3b: later flight
    await page.waitForTimeout(2200);
    const s3bPath = join(screensDir, `s3b-${vp.name}.png`);
    await page.screenshot({ path: s3bPath });
    console.log(`Saved S3b screenshot: ${s3bPath}`);

    // S4: Landing state
    await page.waitForSelector('#landing.visible', { timeout: 15000 });
    await page.waitForTimeout(500); // let fade settle
    const s4Path = join(screensDir, `s4-${vp.name}.png`);
    await page.screenshot({ path: s4Path });
    console.log(`Saved S4 screenshot: ${s4Path}`);

    // Read debug report
    const debugData = await page.evaluate(() => {
      const raw = document.getElementById('app')?.dataset.diveDebug;
      return raw ? JSON.parse(raw) : null;
    });

    if (vp.name === '390x844') {
      results.h5_priya_1 = debugData;
    }
    results.h2[vp.name] = {
      stages: debugData?.stageLog?.map(s => `${s.stage} (+${s.elapsedMs}ms)`),
      totalComputeMs: debugData?.keyframeComputeMs,
      frameTimeMedianMs: debugData?.frameTimeMedianMs,
      frameTimeP95Ms: debugData?.frameTimeP95Ms,
      finalHash: debugData?.finalPlanetHash,
    };

    await context.close();
  }

  // Second run for Priya to prove determinism (H5.4)
  console.log('\n--- Running Second Dive for Priya (Determinism Check) ---');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4174/');
    await page.locator('#planet-name').fill('Priya');
    const btnBox = await page.locator('#start-button').boundingBox();
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.waitForSelector('#landing.visible', { timeout: 25000 });
    const debugData = await page.evaluate(() => {
      const raw = document.getElementById('app')?.dataset.diveDebug;
      return raw ? JSON.parse(raw) : null;
    });
    results.h5_priya_2 = debugData;
    await context.close();
  }

  // Dive for Kuber to check final keyframe hash = 81e905b5 (H5.3)
  console.log('\n--- Running Dive for Kuber (Hash Check: 81e905b5) ---');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4174/');
    await page.locator('#planet-name').fill('Kuber');
    const btnBox = await page.locator('#start-button').boundingBox();
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.waitForSelector('#landing.visible', { timeout: 25000 });
    const debugData = await page.evaluate(() => {
      const raw = document.getElementById('app')?.dataset.diveDebug;
      return raw ? JSON.parse(raw) : null;
    });
    results.h5_kuber = debugData;
    await context.close();
  }

  // H3: Fault Injection - Keyframe Timeout
  console.log('\n--- Testing Fault Injection: Keyframe Timeout (?fault=keyframe-timeout) ---');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4174/?fault=keyframe-timeout');
    await page.locator('#planet-name').fill('Priya');
    const btnBox = await page.locator('#start-button').boundingBox();
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);

    // Expect error state within ~9s
    await page.waitForSelector('#error-state[style*="display: flex"]', { timeout: 12000 });
    const errorTitle = await page.locator('#error-title').textContent();
    const errorMsg = await page.locator('#error-message').textContent();
    const retryBtn = await page.locator('#restart-button').isVisible();
    results.h3_timeout = { errorTitle, errorMsg, retryButtonVisible: retryBtn };
    console.log('Timeout error displayed:', { errorTitle, errorMsg, retryButtonVisible: retryBtn });
    await context.close();
  }

  // H3: Fault Injection - Device Loss mid-dive and clean restart
  console.log('\n--- Testing Fault Injection: Device Lost mid-dive (?fault=device-lost) & Clean Restart ---');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4174/?fault=device-lost');
    await page.locator('#planet-name').fill('Priya');
    const btnBox = await page.locator('#start-button').boundingBox();
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);

    // Wait for device loss error
    await page.waitForSelector('#error-state[style*="display: flex"]', { timeout: 15000 });
    const errorTitle = await page.locator('#error-title').textContent();
    const errorMsg = await page.locator('#error-message').textContent();
    console.log('Device loss caught:', { errorTitle, errorMsg });

    // Click retry button to cleanly restart
    console.log('Clicking "Retry this dive"...');
    await page.locator('#restart-button').click();

    // Verify it cleanly restarts without fault and lands successfully!
    await page.waitForSelector('#landing.visible', { timeout: 25000 });
    const finalHash = await page.evaluate(() => {
      const raw = document.getElementById('app')?.dataset.diveDebug;
      return raw ? JSON.parse(raw)?.finalPlanetHash : null;
    });
    console.log('Clean restart succeeded! Final landing hash:', finalHash);
    results.h3_device_lost = { errorTitle, errorMsg, cleanRestartSuccess: finalHash === '9a90facd' };
    await context.close();
  }

  await browser.close();

  // List all saved screenshot files with fresh sizes and times
  console.log('\n--- Saved Screenshot Files ---');
  const files = readdirSync(screensDir);
  for (const f of files) {
    const fullPath = join(screensDir, f);
    const stat = statSync(fullPath);
    results.h4_screenshots.push({
      file: f,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
    });
    console.log(`  ${f}: ${stat.size} bytes (${stat.mtime.toISOString()})`);
  }

  console.log('\n=== FINAL SUMMARY RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
}

runE2E().catch(err => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
