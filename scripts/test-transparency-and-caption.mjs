import { chromium } from 'playwright';

async function testTransparencyAndCaption() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4174/');

  console.log('=== C4 S4 LANDING TRANSPARENCY & CAPTION VERIFICATION ===\n');

  // Start dive with Priya
  await page.fill('#planet-name', 'Priya');
  await page.click('#start-button');

  // Wait for landing
  await page.waitForFunction(() => {
    const landing = document.getElementById('landing');
    return landing && landing.classList.contains('visible');
  }, { timeout: 30000 });
  await page.waitForTimeout(500);

  const proof = await page.evaluate(() => {
    const canvas = document.getElementById('planet-portrait');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Sample corners and far outer edges
    const pTopLeft = ctx.getImageData(0, 0, 1, 1).data;
    const pTopRight = ctx.getImageData(w - 1, 0, 1, 1).data;
    const pBottomLeft = ctx.getImageData(0, h - 1, 1, 1).data;
    const pBottomRight = ctx.getImageData(w - 1, h - 1, 1, 1).data;
    const pTopMid = ctx.getImageData(Math.round(w / 2), 0, 1, 1).data;
    const pLeftMid = ctx.getImageData(0, Math.round(h / 2), 1, 1).data;

    // Center pixel of planet (should be opaque, alpha 255)
    const pCenter = ctx.getImageData(Math.round(w / 2), Math.round(h / 2), 1, 1).data;

    // Check caption strip area at bottom (y = 990, x = 30)
    // If caption strip were present, it would be solid rgba(8, 12, 18, 0.82) with text
    const pCaptionArea = ctx.getImageData(30, h - 25, 1, 1).data;

    // Page background under canvas
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const appBg = window.getComputedStyle(document.getElementById('app')).backgroundColor;

    return {
      canvasDimensions: { width: w, height: h },
      corners: {
        topLeftAlpha: pTopLeft[3],
        topRightAlpha: pTopRight[3],
        bottomLeftAlpha: pBottomLeft[3],
        bottomRightAlpha: pBottomRight[3],
        topMidAlpha: pTopMid[3],
        leftMidAlpha: pLeftMid[3],
      },
      centerAlpha: pCenter[3],
      captionAreaAlpha: pCaptionArea[3],
      pageBg: {
        body: bodyBg,
        app: appBg,
      },
    };
  });

  console.log('Proof of Canvas Transparency (corners alpha === 0):');
  console.log(`- Top-Left (0,0) Alpha: ${proof.corners.topLeftAlpha} (Expected: 0)`);
  console.log(`- Top-Right (${proof.canvasDimensions.width-1},0) Alpha: ${proof.corners.topRightAlpha} (Expected: 0)`);
  console.log(`- Bottom-Left (0,${proof.canvasDimensions.height-1}) Alpha: ${proof.corners.bottomLeftAlpha} (Expected: 0)`);
  console.log(`- Bottom-Right (${proof.canvasDimensions.width-1},${proof.canvasDimensions.height-1}) Alpha: ${proof.corners.bottomRightAlpha} (Expected: 0)`);
  console.log(`- Top-Mid Edge Alpha: ${proof.corners.topMidAlpha} (Expected: 0)`);
  console.log(`- Left-Mid Edge Alpha: ${proof.corners.leftMidAlpha} (Expected: 0)`);
  console.log(`- Planet Center Alpha: ${proof.centerAlpha} (Expected: 255)`);
  console.log(`- In-Page Caption Area Alpha: ${proof.captionAreaAlpha} (Expected: 0 outside halo)`);
  console.log(`- Page Background: body=${proof.pageBg.body}, app=${proof.pageBg.app} (Expected: rgb(0, 0, 0))\n`);

  const cornersTransparent = Object.values(proof.corners).every(a => a === 0);
  const pagePureBlack = proof.pageBg.body === 'rgb(0, 0, 0)' && proof.pageBg.app === 'rgb(0, 0, 0)';

  console.log(`RESULT: Corners Transparent = ${cornersTransparent ? 'PASS' : 'FAIL'}; Pure #000000 Page = ${pagePureBlack ? 'PASS' : 'FAIL'}`);

  await browser.close();
}

testTransparencyAndCaption().catch(console.error);
