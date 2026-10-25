import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Test vite.config.ts logic for siteUrlPlugin
const viteConfigFile = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf-8');

function testTransform(siteUrl) {
  if (!siteUrl || !siteUrl.trim()) {
    throw new Error('SITE_URL in src/config.ts is empty.');
  }
  if (siteUrl.includes('mosaic.vercel.app')) {
    throw new Error(`SITE_URL still contains placeholder 'mosaic.vercel.app': ${siteUrl}`);
  }
  const cleanUrl = siteUrl.replace(/\/+$/u, '');
  const html = '<meta property="og:image" content="__SITE_URL__/og-preview.png">';
  return html.replace(/__SITE_URL__/gu, cleanUrl);
}

let emptyFailed = false;
try {
  testTransform('');
} catch (e) {
  emptyFailed = true;
  console.log('✓ Caught empty SITE_URL:', e.message);
}

let placeholderFailed = false;
try {
  testTransform('https://mosaic.vercel.app');
} catch (e) {
  placeholderFailed = true;
  console.log('✓ Caught placeholder mosaic.vercel.app:', e.message);
}

const successTransformed = testTransform('https://mosaic-neon.vercel.app');
console.log('✓ Transformed valid SITE_URL:', successTransformed);

if (!emptyFailed || !placeholderFailed) {
  console.error('Guard test failed!');
  process.exit(1);
} else {
  console.log('SITE_URL plugin guard test passed!');
}
