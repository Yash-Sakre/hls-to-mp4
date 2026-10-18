// Smoke test of the built demo (`npm run demo:build` first): drives the UI in
// headless Chrome and saves screenshots. `node test/e2e/demo.mjs [outDir] [--public]`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? path.join(root, 'test/e2e/.out'));
const withPublic = process.argv.includes('--public');
fs.mkdirSync(outDir, { recursive: true });

const server = await preview({ configFile: path.join(root, 'demo/vite.config.js'), preview: { port: 47124, host: '127.0.0.1' }, logLevel: 'error' });
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
let failed = 0;
const report = (ok, name, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '✔' : '✘'} ${name.padEnd(48)} ${detail}`);
};

const exportThroughUi = async (page, { preset, start, end }) => {
  await page.getByRole('button', { name: preset }).click();
  await page.locator('.info').waitFor({ timeout: 30000 });
  await page.getByRole('radio', { name: 'Seconds' }).click();
  await page.getByLabel('Start (s)').fill(String(start));
  await page.getByLabel('End (s)').fill(String(end));
  await page.getByRole('button', { name: 'Build MP4' }).click();
  await page.locator('.result video').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('.result video')?.readyState >= 1, null, { timeout: 30000 });
  return page.evaluate(() => {
    const video = document.querySelector('.result video');
    return { duration: video.duration, width: video.videoWidth, facts: document.querySelector('.result .facts')?.innerText };
  });
};

try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(base);
    await page.getByText('ffmpeg ready').waitFor({ timeout: 60000 });
    const result = await exportThroughUi(page, { preset: 'MPEG-TS · H.264 + AAC · program date-time', start: 5, end: 15 });
    report(result.duration > 9.9 && result.duration < 12.3 && result.width === 640, `UI export, local TS sample (${scheme})`, `${result.duration.toFixed(2)} s, ${result.width}px`);
    await page.screenshot({ path: path.join(outDir, `demo-${scheme}.png`), fullPage: true });
    report(errors.length === 0, `no page errors (${scheme})`, errors.join(' | '));
    await page.close();
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await mobile.goto(base);
  await mobile.getByText('ffmpeg ready').waitFor({ timeout: 60000 });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report(overflow <= 0, 'mobile: no horizontal scroll', `overflow ${overflow}px`);
  await mobile.screenshot({ path: path.join(outDir, 'demo-mobile.png'), fullPage: true });
  await mobile.close();

  if (withPublic) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    await page.getByText('ffmpeg ready').waitFor({ timeout: 60000 });
    const result = await exportThroughUi(page, { preset: 'Apple bipbop · fMP4 · separate audio', start: 10, end: 30 });
    report(result.duration > 19.9 && result.duration < 26.5, 'UI export, Apple fMP4 + separate audio (public)', `${result.duration.toFixed(2)} s, ${result.width}px · ${result.facts?.replace(/\n/g, ' ')}`);
    const resultMux = await exportThroughUi(page, { preset: 'Big Buck Bunny · TS · multi-bitrate (Mux)', start: 60, end: 75 });
    report(resultMux.duration > 14.9 && resultMux.duration < 26, 'UI export, Mux Big Buck Bunny TS (public)', `${resultMux.duration.toFixed(2)} s, ${resultMux.width}px · ${resultMux.facts?.replace(/\n/g, ' ')}`);
    await page.screenshot({ path: path.join(outDir, 'demo-public.png'), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
console.log(failed ? `\n${failed} demo check(s) failed` : '\nDemo checks passed');
process.exit(failed ? 1 : 0);
