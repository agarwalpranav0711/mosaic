import { chromium } from 'playwright';

async function testBreathing() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/');

  const report = await page.evaluate(() => {
    // Check in entry scene
    const pt = document.getElementById('point');
    const styleEntry = window.getComputedStyle(pt);
    const entryBreathing = styleEntry.animationName.includes('breathe') && styleEntry.display !== 'none';

    // Switch to gathering scene
    const entry = document.getElementById('entry');
    const gathering = document.getElementById('gathering');
    entry.style.display = 'none';
    gathering.style.display = 'flex';
    pt.style.display = 'block';

    const styleGathering = window.getComputedStyle(pt);
    const gatheringBreathing = styleGathering.animationName.includes('breathe') && styleGathering.display !== 'none';

    return {
      entryBreathing,
      gatheringBreathing,
      animationDuration: styleGathering.animationDuration,
    };
  });

  console.log('Breathing check in S1 & S2:', report);
  await browser.close();
}

testBreathing().catch(console.error);
