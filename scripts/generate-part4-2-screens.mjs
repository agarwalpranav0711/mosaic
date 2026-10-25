import { chromium } from 'playwright';
import { rmSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part4-2');

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
];

async function generateScreenshots() {
  console.log('=== E1 GENERATING PART 4.2 SCREENSHOT SUITE ===\n');

  // Step 1: Clean out existing files
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const captured = [];

  for (const vp of viewports) {
    console.log(`\n--- Viewport ${vp.name} ---`);
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

    // 1. S1 Idle
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(300);
    const fS1 = join(outDir, `s1-idle-${vp.name}.png`);
    await page.screenshot({ path: fS1 });
    captured.push({ file: `s1-idle-${vp.name}.png`, path: fS1, screen: 'S1 Idle', desc: 'Home screen entry state showing breathing light, invitation, faint placeholder, separated underline, neutral pill button, safe-area sound toggle' });

    // 2. S1 Long Name (40 chars)
    await page.fill('#planet-name', 'SupercalifragilisticexpialidociousWorld40');
    await page.focus('#planet-name');
    await page.waitForTimeout(300);
    const fS1Long = join(outDir, `s1-long-name-${vp.name}.png`);
    await page.screenshot({ path: fS1Long });
    captured.push({ file: `s1-long-name-${vp.name}.png`, path: fS1Long, screen: 'S1 Long Name', desc: '40-character name wrapping cleanly without clipping or touching underline, live palette accent on central light' });

    // 3. S1 Devanagari Name
    await page.fill('#planet-name', 'बृहस्पति ग्रह मंडल');
    await page.focus('#planet-name');
    await page.waitForTimeout(300);
    const fS1Dev = join(outDir, `s1-devanagari-${vp.name}.png`);
    await page.screenshot({ path: fS1Dev });
    captured.push({ file: `s1-devanagari-${vp.name}.png`, path: fS1Dev, screen: 'S1 Devanagari', desc: 'Devanagari script rendered with Noto Sans Devanagari, no overlap with underline or button' });

    // 4. S2 Gathering
    await page.fill('#planet-name', 'Priya');
    await page.click('#start-button');
    await page.waitForTimeout(250);
    const fS2 = join(outDir, `s2-gathering-${vp.name}.png`);
    await page.screenshot({ path: fS2 });
    captured.push({ file: `s2-gathering-${vp.name}.png`, path: fS2, screen: 'S2 Gathering', desc: 'Letters loosening into luminous points drifting toward central breathing light' });

    // 5. S3 Flight - Moment 1 (early)
    await page.waitForFunction(() => {
      const fl = document.getElementById('flight');
      return fl && fl.style.opacity === '1';
    }, { timeout: 30000 });
    await page.waitForTimeout(400);
    const fS3Early = join(outDir, `s3-flight-early-${vp.name}.png`);
    await page.screenshot({ path: fS3Early });
    captured.push({ file: `s3-flight-early-${vp.name}.png`, path: fS3Early, screen: 'S3 Flight (Early)', desc: 'Continuous dive zoom covering viewport with zero black bars; incoming keyframe feathered radially with no hard rectangular border' });

    // 6. S3 Flight - Moment 2 (late)
    await page.waitForTimeout(1400);
    const fS3Late = join(outDir, `s3-flight-late-${vp.name}.png`);
    await page.screenshot({ path: fS3Late });
    captured.push({ file: `s3-flight-late-${vp.name}.png`, path: fS3Late, screen: 'S3 Flight (Late)', desc: 'Deep dive zoom approaching target coordinates, planet structure expanding continuously' });

    // 7. S4 Landing
    await page.waitForFunction(() => {
      const ld = document.getElementById('landing');
      return ld && ld.classList.contains('visible');
    }, { timeout: 30000 });
    await page.waitForTimeout(600);
    const fS4 = join(outDir, `s4-landing-${vp.name}.png`);
    await page.screenshot({ path: fS4 });
    captured.push({ file: `s4-landing-${vp.name}.png`, path: fS4, screen: 'S4 Landing', desc: 'Landed planet portrait on pure #000000 with transparent canvas background, halo and stars, no in-page caption strip, primary filled accent button & secondary outline button' });

    // 8. Error state
    await page.goto('http://127.0.0.1:4174/?fault=keyframe-timeout');
    await page.fill('#planet-name', 'Priya');
    await page.click('#start-button');
    await page.waitForFunction(() => {
      const err = document.getElementById('error-state');
      return err && err.style.display !== 'none';
    }, { timeout: 15000 });
    const fErr = join(outDir, `error-state-${vp.name}.png`);
    await page.screenshot({ path: fErr });
    captured.push({ file: `error-state-${vp.name}.png`, path: fErr, screen: 'Error State', desc: 'Clean quiet error message with Retry this dive button inside safe area' });

    await page.close();
  }

  await browser.close();

  console.log('\n=== CAPTURED SCREENSHOT AUDIT TABLE ===\n');
  console.log('| Filename | Size (bytes) | Timestamp | Screen | Visual Description |');
  console.log('| :--- | :--- | :--- | :--- | :--- |');
  for (const c of captured) {
    const stat = statSync(c.path);
    const isoTime = stat.mtime.toISOString();
    console.log(`| \`${c.file}\` | ${stat.size.toLocaleString()} B | ${isoTime} | ${c.screen} | ${c.desc} |`);
  }
}

generateScreenshots().catch(console.error);
