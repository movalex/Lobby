// Option (b) probe: client-side PDF.js (pdfjs-dist 6.3.289 browser build) rendering a page on demand in Chrome.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const types = { '.mjs': 'text/javascript', '.pdf': 'application/pdf', '.html': 'text/html' };
const rangeHits = [];
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><canvas id="c"></canvas>');
  }
  const file = p.startsWith('/pdfjs/') ? path.join(HERE, 'node_modules/pdfjs-dist', p.slice(7)) : path.join(HERE, 'fixtures', path.basename(p));
  let size;
  try { size = statSync(file).size; } catch { res.writeHead(404); return res.end(); }
  const h = { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (m && file.endsWith('.pdf')) rangeHits.push(req.headers.range);
  if (m) {
    const s = Number(m[1]); const e = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { ...h, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
    return createReadStream(file, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { ...h, 'content-length': size });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(base + '/');
const result = await page.evaluate(async () => {
  const t0 = performance.now();
  const pdfjs = await import('/pdfjs/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
  const task = pdfjs.getDocument({ url: '/fixtures/document.pdf' });
  const doc = await task.promise;
  const pg = await doc.getPage(2);
  const vp = pg.getViewport({ scale: 1.5 });
  const canvas = document.getElementById('c');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  await pg.render({ canvas, viewport: vp }).promise;
  const ctx = canvas.getContext('2d');
  // count dark pixels in the middle band where "Page 2 of 4" is drawn
  const img = ctx.getImageData(0, Math.floor(canvas.height * 0.4), canvas.width, Math.floor(canvas.height * 0.2)).data;
  let dark = 0; for (let i = 0; i < img.length; i += 4) if (img[i] < 80 && img[i + 1] < 80 && img[i + 2] < 80) dark++;
  const out = { version: pdfjs.version, numPages: doc.numPages, w: canvas.width, h: canvas.height, darkPixelsInLabelBand: dark, ms: Math.round(performance.now() - t0) };
  await task.destroy();
  return out;
});
await browser.close();
server.close();
console.log(JSON.stringify({ ...result, pdfRangeRequests: rangeHits.length }, null, 1));
