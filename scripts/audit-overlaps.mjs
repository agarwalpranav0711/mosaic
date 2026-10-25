import { chromium } from 'playwright';

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4174/';

async function auditScene(page, sceneName, viewport) {
  return await page.evaluate(({ sceneName, viewport }) => {
    // Select candidates for bounding box audit
    const elementsToAudit = [];

    // Helper to get non-hidden visible elements
    const getVisible = (selector, label) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { element: el, label: label || selector, rect };
    };

    if (sceneName === 'S1 idle' || sceneName === 'S1 Priya') {
      const sound = getVisible('#sound-toggle', 'Sound toggle');
      const invitation = getVisible('#invitation', 'Invitation text ("Give the dark a name.")');
      const nameDisplay = getVisible('#name-display', 'Name display text');
      const startButton = getVisible('#start-button', 'Start button ("Fall into your planet")');
      const statusMessage = getVisible('#status-message', 'Status message');
      
      // Check for underline element or simulated underline rect
      let underline = getVisible('#name-underline', 'Underline mark');
      if (!underline && nameDisplay) {
        // If CSS text-decoration is used, measure text metrics vs underline offset
        const style = window.getComputedStyle(nameDisplay.element);
        if (style.textDecorationLine.includes('underline')) {
          // Bounding box of underline under current CSS
          const r = nameDisplay.rect;
          // Font size and approx baseline / descender
          const fontSize = parseFloat(style.fontSize);
          const offset = parseFloat(style.textUnderlineOffset) || 10;
          // Approx baseline is ~ 0.8 * fontSize down from top of text box
          // Descender extends to ~ 1.05 * fontSize
          const underlineY = r.top + fontSize * 0.8 + offset;
          underline = {
            element: nameDisplay.element,
            label: 'CSS text-decoration underline',
            rect: { left: r.left, right: r.right, top: underlineY, bottom: underlineY + 2, width: r.width, height: 2 },
            isVirtual: true,
          };
          
          // Specifically detect if descenders like 'p' cross the underline:
          // A 'p' character has a descender extending to r.top + fontSize * 1.05
          if (nameDisplay.element.textContent.includes('p') || nameDisplay.element.textContent.includes('y')) {
            const descenderBottom = r.top + fontSize * 1.02;
            if (descenderBottom >= underlineY) {
              // Descender crosses underline!
              return [{
                elem1: 'Name descender ("p"/"y")',
                elem2: 'Name underline',
                rect1: { top: r.top, bottom: descenderBottom, left: r.left, right: r.right },
                rect2: underline.rect,
                details: `Descender bottom (${descenderBottom.toFixed(1)}px) crosses underline top (${underlineY.toFixed(1)}px)`,
              }];
            }
          }
        }
      }

      [sound, invitation, nameDisplay, underline, startButton, statusMessage].filter(Boolean).forEach(x => elementsToAudit.push(x));

      // Check Sound toggle proximity to top edge / safe area (A2 item 2)
      if (sound) {
        if (sound.rect.top < 16) {
          elementsToAudit.push({
            elem1: 'Sound toggle',
            elem2: 'Top viewport edge / notch safe-area (<16px margin)',
            rect1: sound.rect,
            rect2: { top: 0, bottom: 16, left: sound.rect.left, right: sound.rect.right },
            isEdgeCollision: true,
          });
        }
      }
    } else if (sceneName === 'S2 gathering') {
      const sound = getVisible('#sound-toggle', 'Sound toggle');
      const point = getVisible('#point', 'Central point of light');
      const msg = getVisible('#gathering-message', 'Gathering message');
      [sound, point, msg].filter(Boolean).forEach(x => elementsToAudit.push(x));
    } else if (sceneName === 'S3 flight') {
      const sound = getVisible('#sound-toggle', 'Sound toggle');
      if (sound) elementsToAudit.push(sound);
    } else if (sceneName === 'S4 landing') {
      const portrait = getVisible('#planet-portrait', 'Planet portrait canvas');
      const name = getVisible('#landing-name', 'Landing planet name');
      const saveBtn = getVisible('#save-button', 'Save button ("Save my planet")');
      const againBtn = getVisible('#again-button', 'Try another button ("Try another name")');
      [portrait, name, saveBtn, againBtn].filter(Boolean).forEach(x => elementsToAudit.push(x));
    } else if (sceneName === 'Error state') {
      const title = getVisible('#error-title', 'Error title ("The dive stopped.")');
      const message = getVisible('#error-message', 'Error message');
      const restartBtn = getVisible('#restart-button', 'Restart button ("Retry this dive")');
      [title, message, restartBtn].filter(Boolean).forEach(x => elementsToAudit.push(x));
    }

    // Now find any overlapping pairs
    const overlaps = [];
    for (let i = 0; i < elementsToAudit.length; i++) {
      for (let j = i + 1; j < elementsToAudit.length; j++) {
        const a = elementsToAudit[i];
        const b = elementsToAudit[j];
        if (a.isEdgeCollision) {
          overlaps.push(a);
          continue;
        }
        if (b.isEdgeCollision) continue;

        // Ignore ancestor/descendant pairs
        if (a.element && b.element && (a.element.contains(b.element) || b.element.contains(a.element))) {
          continue;
        }

        const ra = a.rect;
        const rb = b.rect;
        const xOverlap = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
        const yOverlap = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));

        if (xOverlap > 0.5 && yOverlap > 0.5) {
          overlaps.push({
            elem1: a.label,
            elem2: b.label,
            rect1: { left: Math.round(ra.left), top: Math.round(ra.top), width: Math.round(ra.width), height: Math.round(ra.height) },
            rect2: { left: Math.round(rb.left), top: Math.round(rb.top), width: Math.round(rb.width), height: Math.round(rb.height) },
            overlapArea: Math.round(xOverlap * yOverlap),
          });
        }
      }
    }
    return overlaps;
  }, { sceneName, viewport });
}

async function runAudit() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('=== RUNNING PLAYWRIGHT OVERLAP AUDIT ===\n');
  const results = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // 1. S1 idle (empty)
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    const oS1Empty = await auditScene(page, 'S1 idle', vp);
    results.push({ viewport: vp.name, scene: 'S1 idle (empty)', overlaps: oS1Empty });

    // 2. S1 Priya
    await page.fill('#planet-name', 'Priya');
    await page.focus('#planet-name');
    await page.waitForTimeout(100);
    const oS1Priya = await auditScene(page, 'S1 Priya', vp);
    results.push({ viewport: vp.name, scene: 'S1 Priya', overlaps: oS1Priya });

    // 3. S2 gathering
    await page.evaluate(() => {
      // Trigger gathering scene display
      const entry = document.getElementById('entry');
      const gathering = document.getElementById('gathering');
      if (entry) entry.style.display = 'none';
      if (gathering) gathering.style.display = 'flex';
    });
    await page.waitForTimeout(100);
    const oS2 = await auditScene(page, 'S2 gathering', vp);
    results.push({ viewport: vp.name, scene: 'S2 gathering', overlaps: oS2 });

    // 4. S3 flight
    await page.evaluate(() => {
      const gathering = document.getElementById('gathering');
      const flight = document.getElementById('flight');
      if (gathering) gathering.style.display = 'none';
      if (flight) { flight.style.display = 'block'; flight.style.opacity = '1'; }
    });
    await page.waitForTimeout(100);
    const oS3 = await auditScene(page, 'S3 flight', vp);
    results.push({ viewport: vp.name, scene: 'S3 flight', overlaps: oS3 });

    // 5. S4 landing
    await page.evaluate(() => {
      const flight = document.getElementById('flight');
      const landing = document.getElementById('landing');
      if (flight) flight.style.display = 'none';
      if (landing) {
        landing.style.display = 'flex';
        landing.classList.add('visible');
        document.getElementById('landing-name').textContent = 'Priya';
      }
    });
    await page.waitForTimeout(100);
    const oS4 = await auditScene(page, 'S4 landing', vp);
    results.push({ viewport: vp.name, scene: 'S4 landing', overlaps: oS4 });

    // 6. Error state
    await page.evaluate(() => {
      const landing = document.getElementById('landing');
      const err = document.getElementById('error-state');
      if (landing) landing.style.display = 'none';
      if (err) {
        err.style.display = 'flex';
        document.getElementById('error-message').textContent = 'A 512×512 keyframe did not finish within 60 seconds.';
      }
    });
    await page.waitForTimeout(100);
    const oErr = await auditScene(page, 'Error state', vp);
    results.push({ viewport: vp.name, scene: 'Error state', overlaps: oErr });
  }

  await browser.close();

  // Print results table
  console.log('| Viewport | Screen / State | Overlaps Detected | Details |');
  console.log('| :--- | :--- | :--- | :--- |');
  let totalOverlaps = 0;
  for (const r of results) {
    const count = r.overlaps.length;
    totalOverlaps += count;
    const desc = count === 0
      ? '0 (Clean)'
      : r.overlaps.map(o => `${o.elem1 || o.elem1} ⚡ ${o.elem2} (${o.details || 'Area: ' + o.overlapArea + 'px²'})`).join('; ');
    console.log(`| ${r.viewport} | ${r.scene} | ${count} | ${desc} |`);
  }
  console.log(`\nTotal overlaps found: ${totalOverlaps}`);
  return results;
}

runAudit().catch(err => {
  console.error(err);
  process.exit(1);
});
