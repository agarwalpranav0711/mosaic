import { chromium } from 'playwright';
import { rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part5');

async function computeCanvasMeanLuminance(page, canvasSelector) {
  return await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return 0;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let sumLum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sumLum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sumLum / (c.width * c.height);
  }, canvasSelector);
}

async function runPart5Verification() {
  console.log('=== PART 5 SHARE & REOPEN VERIFICATION ===\n');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  // ---------------------------------------------------------
  // S1: SHARE CARDS (1080x1350) FOR 6 TEST NAMES
  // ---------------------------------------------------------
  console.log('--- S1. SHARE CARDS (1080x1350) AUDIT ---');
  const cardTestNames = [
    { name: 'Priya', id: 'priya' },
    { name: 'Kuber', id: 'kuber' },
    { name: 'बृहस्पति ग्रह मंडल', id: 'devanagari' },
    { name: 'كوكب الفردوس الأندلسي', id: 'arabic' },
    { name: '翡翠星雲探索者世界', id: 'cjk' },
    { name: 'Supercalifragilisticexpialidocious_World', id: 'long-40' },
  ];

  const shareCardResults = [];
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(2500);

    for (const item of cardTestNames) {
      const cardBase64 = await page.evaluate(async (planetName) => {
        const testApi = window.__mosaicHomeTest;
        const card = await testApi.buildShareCardForTest(planetName);
        return card.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      }, item.name);

      const filename = `share-card-${item.id}.png`;
      const filePath = join(outDir, filename);
      writeFileSync(filePath, Buffer.from(cardBase64, 'base64'));

      // Calculate mean luminance directly from png in page
      const lum = await page.evaluate((b64) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, c.width, c.height).data;
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
              sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            }
            resolve(sum / (c.width * c.height));
          };
          img.src = 'data:image/png;base64,' + b64;
        });
      }, cardBase64);

      const stats = statSync(filePath);
      shareCardResults.push({
        name: item.name,
        filename,
        bytes: stats.size,
        meanLuminance: lum,
      });
      console.log(`- Card for "${item.name}": ${stats.size} B (${(stats.size / 1024).toFixed(1)} KB), meanLum=${lum.toFixed(4)}`);
    }
    await page.close();
  }

  // ---------------------------------------------------------
  // S2: REOPEN LINK 10-NAME PROOF & XSS TEST
  // ---------------------------------------------------------
  console.log('\n--- S2. REOPEN LINK (?n=...) 10-NAME EQUIVALENCE PROOF ---');
  const linkProofNames = [
    'Priya',
    'Rahul',
    'Aman',
    'Neha',
    'Kuber',
    'Artemis',
    'बृहस्पति',
    'كوكب',
    '宇宙',
    'Kepler-22b',
  ];

  const linkProofResults = [];
  for (const name of linkProofNames) {
    // 1. Get canonical typed parameters
    const page1 = await browser.newPage({ reducedMotion: 'reduce' });
    await page1.goto('http://127.0.0.1:4174/');
    await page1.fill('#planet-name', name);
    await page1.click('#start-button');
    await page1.waitForFunction(() => {
      const landing = document.getElementById('landing');
      return landing && landing.classList.contains('visible');
    }, { timeout: 15000 });

    const typedResult = await page1.evaluate(() => {
      return JSON.parse(document.getElementById('app').dataset.diveDebug);
    });
    await page1.close();

    // 2. Open via ?n=<name> query parameter
    const page2 = await browser.newPage({ reducedMotion: 'reduce' });
    const targetUrl = `http://127.0.0.1:4174/?n=${encodeURIComponent(name)}`;
    await page2.goto(targetUrl);

    // Verify button text
    const buttonText = await page2.locator('#start-button').textContent();
    const expectedBtnText = `See ${name}'s planet`;

    // Click button to dive
    await page2.click('#start-button');
    await page2.waitForFunction(() => {
      const landing = document.getElementById('landing');
      return landing && landing.classList.contains('visible');
    }, { timeout: 15000 });

    const linkResult = await page2.evaluate(() => {
      return JSON.parse(document.getElementById('app').dataset.diveDebug);
    });
    await page2.close();

    const planetIdMatch = typedResult.planetId === linkResult.planetId;
    const hashMatch = typedResult.finalPlanetHash === linkResult.finalPlanetHash;
    const btnMatch = buttonText === expectedBtnText;

    linkProofResults.push({
      name,
      typedId: typedResult.planetId,
      linkId: linkResult.planetId,
      typedHash: typedResult.finalPlanetHash,
      linkHash: linkResult.finalPlanetHash,
      buttonText,
      planetIdMatch,
      hashMatch,
      btnMatch,
      allMatch: planetIdMatch && hashMatch && btnMatch,
    });

    console.log(`- "${name}": planetId [${typedResult.planetId} vs ${linkResult.planetId}] hash [0x${typedResult.finalPlanetHash} vs 0x${linkResult.finalPlanetHash}] btn ["${buttonText}"] -> ${planetIdMatch && hashMatch && btnMatch ? 'PASS' : 'FAIL'}`);
  }

  // S2 XSS Safety Test
  console.log('\n--- S2. XSS SAFETY TEST (<img src=x onerror=alert(1)>) ---');
  let alertTriggered = false;
  {
    const pageXSS = await browser.newPage({ reducedMotion: 'reduce' });
    pageXSS.on('dialog', async (dialog) => {
      alertTriggered = true;
      await dialog.dismiss();
    });

    const maliciousName = '<img src=x onerror=alert(1)>';
    await pageXSS.goto(`http://127.0.0.1:4174/?n=${encodeURIComponent(maliciousName)}`);
    await pageXSS.waitForTimeout(600);

    const displayNameHTML = await pageXSS.evaluate(() => document.getElementById('name-display')?.innerHTML);
    const displayNameText = await pageXSS.evaluate(() => document.getElementById('name-display')?.textContent);
    console.log(`- Display innerHTML: ${JSON.stringify(displayNameHTML)}`);
    console.log(`- Display textContent: ${JSON.stringify(displayNameText)}`);
    console.log(`- Alert triggered: ${alertTriggered ? 'FAIL (XSS vulnerable)' : 'PASS (Safe, textContent only)'}`);
    await pageXSS.close();
  }

  // ---------------------------------------------------------
  // S5: FAILURE SCREEN (?nogpu=1)
  // ---------------------------------------------------------
  console.log('\n--- S5. FAILURE SCREEN (?nogpu=1) ---');
  {
    const pageFail = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await pageFail.goto('http://127.0.0.1:4174/?nogpu=1');
    await pageFail.waitForTimeout(500);

    const isVisible = await pageFail.evaluate(() => {
      const el = document.getElementById('webgpu-failure');
      return el && el.style.display !== 'none';
    });
    const heading = await pageFail.locator('#webgpu-failure h1').textContent();
    const msg = await pageFail.locator('#webgpu-failure p').textContent();

    const shotPath = join(outDir, 'failure-nogpu.png');
    await pageFail.screenshot({ path: shotPath });
    const stats = statSync(shotPath);
    console.log(`- Overlay visible: ${isVisible ? 'PASS' : 'FAIL'}`);
    console.log(`- Heading: "${heading}"`);
    console.log(`- Message: "${msg}"`);
    console.log(`- Saved ${shotPath} (${stats.size} B)`);
    await pageFail.close();
  }

  // ---------------------------------------------------------
  // S6: DEBUG FINGERPRINT (?debug=1)
  // ---------------------------------------------------------
  console.log('\n--- S6. DEBUG FINGERPRINT (?debug=1) ---');
  {
    const pageDebug = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await pageDebug.goto('http://127.0.0.1:4174/?debug=1');
    await pageDebug.fill('#planet-name', 'Priya');
    await pageDebug.click('#start-button');
    await pageDebug.waitForFunction(() => {
      const landing = document.getElementById('landing');
      return landing && landing.classList.contains('visible');
    }, { timeout: 15000 });

    const debugState = await pageDebug.evaluate(() => {
      const el = document.getElementById('debug-fingerprint');
      const text = document.getElementById('debug-text')?.textContent;
      const copyBtn = document.getElementById('debug-copy-btn');
      return {
        visible: el && el.style.display !== 'none',
        text,
        copyBtnText: copyBtn?.textContent,
      };
    });

    const shotPath = join(outDir, 'debug-landing-390x844.png');
    await pageDebug.screenshot({ path: shotPath });
    const stats = statSync(shotPath);
    console.log(`- Debug element visible: ${debugState.visible ? 'PASS' : 'FAIL'}`);
    console.log(`- Debug text: "${debugState.text}"`);
    console.log(`- Saved ${shotPath} (${stats.size} B)`);
    await pageDebug.close();
  }

  // Also verify without ?debug=1 that fingerprint is hidden
  {
    const pageNoDebug = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await pageNoDebug.goto('http://127.0.0.1:4174/');
    await pageNoDebug.fill('#planet-name', 'Priya');
    await pageNoDebug.click('#start-button');
    await pageNoDebug.waitForFunction(() => {
      const landing = document.getElementById('landing');
      return landing && landing.classList.contains('visible');
    }, { timeout: 15000 });

    const isHidden = await pageNoDebug.evaluate(() => {
      const el = document.getElementById('debug-fingerprint');
      return !el || el.style.display === 'none';
    });
    console.log(`- Hidden without ?debug=1: ${isHidden ? 'PASS' : 'FAIL'}`);
    await pageNoDebug.close();
  }

  await browser.close();

  console.log('\n--- ALL PART 5 AUDITS COMPLETE ---');
}

runPart5Verification().catch(console.error);
