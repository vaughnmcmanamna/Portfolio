import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.NBA_DOND_SOURCE;
const playwrightRoot = process.env.PLAYWRIGHT_ROOT;
const outputRoot = process.env.CAPTURE_OUTPUT;

if (!sourceRoot || !playwrightRoot || !outputRoot) {
  throw new Error('Set NBA_DOND_SOURCE, PLAYWRIGHT_ROOT, and CAPTURE_OUTPUT.');
}

const { chromium } = await import(pathToFileURL(path.join(playwrightRoot, 'node_modules/playwright-core/index.mjs')));
const siteRoot = path.join(sourceRoot, 'dist');
const basePath = '/Deal-or-No-Deal-NBA-EDITION/';
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = requestPath.startsWith(basePath)
      ? requestPath.slice(basePath.length)
      : requestPath.slice(1);
    const requestedFile = relativePath && !relativePath.endsWith('/') ? relativePath : 'index.html';
    const absolutePath = path.resolve(siteRoot, requestedFile);
    if (!absolutePath.startsWith(path.resolve(siteRoot))) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(absolutePath);
    response.writeHead(200, { 'Content-Type': mimeTypes.get(path.extname(absolutePath)) || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

await new Promise(resolve => server.listen(4180, '127.0.0.1', resolve));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    localStorage.clear();
    let seed = 20260917;
    Math.random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  });
  await page.goto(`http://127.0.0.1:4180${basePath}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => [...document.images].every(image => image.complete));

  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true"><path d="M2 1.5v22l5.5-5 4.2 9.5 4-1.8-4.1-9.1H21z" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: `translate(${window.innerWidth - 125}px, ${window.innerHeight - 80}px)`,
      filter: 'drop-shadow(1px 2px 1px rgba(0,0,0,.45))'
    });
    document.body.append(cursor);

    window.demoMove = (x, y, duration = 650) => new Promise(resolve => {
      const start = performance.now();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(cursor).transform);
      const fromX = matrix.m41;
      const fromY = matrix.m42;
      const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const tick = now => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = ease(progress);
        cursor.style.transform = `translate(${fromX + (x - fromX) * eased}px, ${fromY + (y - fromY) * eased}px)`;
        if (progress < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });

    window.demoClick = async selector => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`Could not find ${selector}`);
      target.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(resolve => setTimeout(resolve, 150));
      const rect = target.getBoundingClientRect();
      await window.demoMove(rect.left + rect.width / 2, rect.top + rect.height / 2);
      cursor.animate([
        { transform: cursor.style.transform + ' scale(1)' },
        { transform: cursor.style.transform + ' scale(.72)' },
        { transform: cursor.style.transform + ' scale(1)' }
      ], { duration: 200 });
      target.click();
      await new Promise(resolve => setTimeout(resolve, 350));
    };
  });

  const choreography = page.evaluate(async () => {
    const wait = duration => new Promise(resolve => setTimeout(resolve, duration));
    await wait(650);
    await window.demoClick('button[aria-label^="Case 1,"]');
    await window.demoClick('button[aria-label^="Case 2,"]');
    await window.demoClick('button[aria-label^="Case 3,"]');
    await window.demoClick('button[aria-label^="Case 4,"]');
    await wait(1900);
    await window.demoClick('.no-deal-button');
    await wait(450);
    await window.demoClick('button[aria-label^="Case 5,"]');
    await window.demoClick('button[aria-label^="Case 6,"]');
    await wait(1900);
    await window.demoClick('.deal-button');
    await wait(1800);
  });

  const frameInterval = 1000 / 12;
  const startedAt = Date.now();
  let frame = 0;
  while (Date.now() - startedAt < 17000) {
    const filename = `frame-${String(frame).padStart(4, '0')}.jpg`;
    await page.screenshot({ path: path.join(outputRoot, filename), type: 'jpeg', quality: 90 });
    frame += 1;
    const nextFrameAt = startedAt + frame * frameInterval;
    const wait = nextFrameAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }
  await choreography;
  console.log(`Captured ${frame} frames to ${outputRoot}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
