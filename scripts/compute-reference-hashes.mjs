import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function computeReferenceHashes() {
  console.log('--- COMPUTING REFERENCE HASHES FOR ALL 5 REFERENCE NAMES ---');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForTimeout(1500);

  const results = [];
  const referenceNames = ['Priya', 'Rahul', 'Aman', 'Neha', 'Kuber'];

  for (const name of referenceNames) {
    const data = await page.evaluate(async (planetName) => {
      const input = document.getElementById('planet-name');
      input.value = planetName;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const form = document.getElementById('entry');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      while (true) {
        const el = document.getElementById('app');
        const raw = el?.dataset?.diveDebug;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.finalPlanetHash && parsed.keyframes) {
              const debugEl = document.getElementById('debug-text');
              return {
                name: planetName,
                planetId: parsed.planetId,
                paletteIndex: parsed.paletteIndex,
                finalPlanetHash: parsed.finalPlanetHash,
                debugText: debugEl ? debugEl.textContent : '',
                keyframesCount: parsed.keyframes.length,
              };
            }
          } catch {}
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }, name);

    // Get counter from createPlanet
    const counter = await page.evaluate(async (planetName) => {
      const { createPlanet } = await import('/src/nameEngine.ts');
      const testApi = window.__mosaicHomeTest;
      const p = await testApi.computeFinalPlanet(planetName);
      return p.counter;
    }, name);

    results.push({
      ...data,
      counter,
    });

    // Reset to entry for next name
    await page.evaluate(() => {
      document.getElementById('again-button')?.click();
    });
    await page.waitForTimeout(500);
  }

  await browser.close();

  const paletteNames = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];

  let md = `# Reference Hashes Table (Engine Version 1)\n\n`;
  md += `Computed on hardware: **NVIDIA GeForce RTX 3050 Laptop GPU** (Google Chrome 155, Windows 11, Direct3D12 backend via ANGLE).\n\n`;
  md += `Use this reference table to verify deterministic cross-device execution on phones and other GPUs.\n\n`;
  md += `| Name | Planet ID | Rehash Counter | Palette Index | Palette Name | Final 512 Keyframe Hash |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  console.log('\n--- REFERENCE HASHES TABLE ---');
  for (const r of results) {
    const palName = paletteNames[r.paletteIndex] || 'Unknown';
    const row = `| **${r.name}** | \`${r.planetId}\` | ${r.counter} | ${r.paletteIndex} | ${palName} | \`0x${r.finalPlanetHash}\` |`;
    console.log(row);
    md += `${row}\n`;
  }

  md += `\n## Invariant Checklist\n\n`;
  md += `- Priya: Planet ID \`81357026\`, final keyframe \`0x9a90facd\`\n`;
  md += `- Rahul: Planet ID \`184b2ca5\`\n`;
  md += `- Aman: Planet ID \`e57d2897\` (rehash counter 3)\n`;
  md += `- Neha: Planet ID \`ed0aa39e\`\n`;
  md += `- Kuber: Planet ID \`81e905b5\` (rehash counter 1), final keyframe \`0x3fca3290\`\n`;
  md += `- Fixed tiles: B2 \`0x985dade1\`, C2 \`0x329ac730\`, D2 \`0xa63eed4d\`, Heavy \`0x8a1e2fc9\`\n`;
  md += `- regions.json SHA-256: \`793adc48b7b93dc7226395233d2fc7a2140afa331cfcb07f705db9dec22d8238\`\n`;

  const mdPath = resolve(process.cwd(), 'REFERENCE-HASHES.md');
  writeFileSync(mdPath, md);
  console.log(`\nWritten to ${mdPath}`);
}

computeReferenceHashes().catch(console.error);
