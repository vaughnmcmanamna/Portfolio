import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = process.env.COD_STATS_SOURCE;
const playwrightRoot = process.env.PLAYWRIGHT_ROOT;
const outputRoot = process.env.CAPTURE_OUTPUT;

if (!sourceRoot || !playwrightRoot || !outputRoot) {
  throw new Error('Set COD_STATS_SOURCE, PLAYWRIGHT_ROOT, and CAPTURE_OUTPUT.');
}

const { chromium } = await import(pathToFileURL(path.join(playwrightRoot, 'node_modules/playwright-core/index.mjs')));
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
]);

const server = createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
    const absolutePath = path.resolve(sourceRoot, relativePath);
    if (!absolutePath.startsWith(path.resolve(sourceRoot))) {
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

await new Promise(resolve => server.listen(4179, '127.0.0.1', resolve));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1168, height: 730 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4179/', { waitUntil: 'networkidle' });

  await page.evaluate(async () => {
    const excelDate = value => new Date((Number(value) - 25569) * 86400 * 1000);
    localStorage.removeItem('codStatsData');

    handleUpload = async function () {
      const input = document.getElementById('csvFileInput');
      const feedback = document.getElementById('uploadFeedback');
      const uploadButton = document.getElementById('uploadButton');
      if (!input.files.length) return;

      feedback.textContent = 'Processing your data...';
      feedback.className = 'upload-feedback info';
      uploadButton.disabled = true;
      uploadButton.textContent = 'Processing...';
      await new Promise(resolve => setTimeout(resolve, 550));

      const rows = d3.csvParse(await input.files[0].text());
      const data = rows.map(row => {
        const kills = Number(row.Kills || 0);
        const deaths = Number(row.Deaths || 0);
        const isWin = String(row['Match Outcome']).toLowerCase() === 'win';
        return {
          ...row,
          'UTC Timestamp': excelDate(row['UTC Timestamp']),
          Kills: kills,
          Deaths: deaths,
          Score: Number(row.Score || 0),
          Skill: Number(row.Skill || 0),
          'Damage Done': Number(row.Damage || 0),
          'Damage Taken': Number(row['Damage Taken'] || 0),
          'K/D Ratio': deaths ? kills / deaths : kills,
          'EKIA/D Ratio': deaths ? kills / deaths : kills,
          'Accuracy %': 0,
          'Headshot %': 0,
          'Total XP': 1,
          isRanked: true,
          isWin,
          'Match Outcome': isWin ? 'win' : 'loss',
        };
      });

      state.data = data;
      state.sortedData = [...data].sort((a, b) => a['UTC Timestamp'] - b['UTC Timestamp']);
      populateControls(data);
      updateVisualization();
      feedback.textContent = `Success! Loaded ${data.length} matches.`;
      feedback.className = 'upload-feedback success';
      uploadButton.disabled = false;
      uploadButton.textContent = 'Upload';
      await new Promise(resolve => setTimeout(resolve, 450));
      closeUploadModal();
    };

    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true"><path d="M2 1.5v22l5.5-5 4.2 9.5 4-1.8-4.1-9.1H21z" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: `translate(${window.innerWidth - 110}px, ${window.innerHeight - 65}px)`,
      filter: 'drop-shadow(1px 2px 1px rgba(0,0,0,.35))'
    });
    document.body.append(cursor);

    window.demoMove = (x, y, duration = 900) => new Promise(resolve => {
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
      const rect = target.getBoundingClientRect();
      await window.demoMove(rect.left + rect.width / 2, rect.top + rect.height / 2, 950);
      cursor.animate([{ transform: cursor.style.transform + ' scale(1)' }, { transform: cursor.style.transform + ' scale(.72)' }, { transform: cursor.style.transform + ' scale(1)' }], { duration: 220 });
      target.click();
      await new Promise(resolve => setTimeout(resolve, 700));
    };

    window.demoPointAt = async selector => {
      const target = document.querySelector(selector);
      const rect = target.getBoundingClientRect();
      await window.demoMove(rect.left + rect.width / 2, rect.top + rect.height / 2, 850);
      cursor.animate([{ opacity: 1 }, { opacity: .45 }, { opacity: 1 }], { duration: 240 });
    };
  });

  const choreography = (async () => {
    await page.waitForTimeout(600);
    await page.evaluate(() => window.demoClick('.nav-actions .btn-primary'));
    await page.waitForTimeout(350);
    await page.locator('#csvFileInput').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.demoPointAt('#csvFileInput'));
    await page.locator('#csvFileInput').setInputFiles(path.join(sourceRoot, 'samples', 'ranked_grinder.csv'));
    await page.waitForTimeout(400);
    await page.locator('#uploadButton').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.demoClick('#uploadButton'));
    await page.waitForTimeout(1100);
    await page.evaluate(() => window.demoClick('a[data-route="analytics"]'));
    await page.waitForTimeout(1150);
    await page.evaluate(() => window.demoClick('a[data-route="matches"]'));
    await page.waitForTimeout(1500);
  })();

  const frameInterval = 1000 / 12;
  const startedAt = Date.now();
  let frame = 0;
  while (Date.now() - startedAt < 12000) {
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
