import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

console.log('=== F3 NETWORK AUDIT ===\n');

// 1. Static Grep of index.html and dist/
function getAllFiles(dir, fileList = []) {
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    if (statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const targetFiles = [
  resolve(process.cwd(), 'index.html'),
  ...getAllFiles(resolve(process.cwd(), 'dist')),
];

console.log('--- 1. GREP AUDIT OF index.html AND dist/ ---');

const urlRegex = /https?:\/\/[^\s"'`<>]+/gi;
const linkRegex = /<link[^>]*>/gi;
const scriptRegex = /<script[^>]*>/gi;

let foundDisallowed = false;

for (const filePath of targetFiles) {
  const relPath = filePath.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '');
  const content = readFileSync(filePath, 'utf-8');

  // URL hits
  const urlMatches = content.match(urlRegex) || [];
  for (const u of urlMatches) {
    // Check if it's the allowed SITE_URL or XMLNS
    const isAllowedSiteUrl = u.startsWith('https://mosaic-neon.vercel.app');
    const isSvgXmlns = u === 'http://www.w3.org/2000/svg';
    console.log(`[URL] ${relPath}: ${u} (allowed: ${isAllowedSiteUrl ? 'YES (SITE_URL)' : isSvgXmlns ? 'YES (SVG namespace)' : 'NO'})`);
    if (!isAllowedSiteUrl && !isSvgXmlns) {
      foundDisallowed = true;
    }
  }

  // <link> hits
  const linkMatches = content.match(linkRegex) || [];
  for (const l of linkMatches) {
    console.log(`[LINK] ${relPath}: ${l}`);
  }

  // <script> hits
  const scriptMatches = content.match(scriptRegex) || [];
  for (const s of scriptMatches) {
    console.log(`[SCRIPT] ${relPath}: ${s}`);
  }
}

if (foundDisallowed) {
  console.error('\nERROR: Disallowed external URLs found in files!');
  process.exit(1);
} else {
  console.log('\nStatic grep audit PASSED: Only allowed SITE_URL and SVG namespace found.\n');
}

// 2. Playwright Network Request Audit
console.log('--- 2. PLAYWRIGHT RUNTIME NETWORK REQUEST AUDIT ---');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
});

const page = await browser.newPage();
const requests = [];

page.on('request', (req) => {
  const u = new URL(req.url());
  requests.push({
    url: req.url(),
    host: u.host,
    pathname: u.pathname,
    resourceType: req.resourceType(),
  });
});

await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

console.log(`Total requests made during page load: ${requests.length}`);
let externalRequests = 0;
for (const r of requests) {
  console.log(`  - [${r.resourceType}] ${r.host}${r.pathname}`);
  if (r.host !== '127.0.0.1:4174' && r.host !== 'localhost:4174') {
    externalRequests++;
  }
}

await browser.close();

if (externalRequests > 0) {
  console.error(`\nFAILED: ${externalRequests} external requests detected!`);
  process.exit(1);
} else {
  console.log('\nPlaywright network audit PASSED: Exactly ZERO external requests made!');
}
