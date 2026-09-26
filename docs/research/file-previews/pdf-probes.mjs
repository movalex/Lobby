// Extra pdf.js probes: fonts, canvasContext vs canvas, scale, clamp, truncation, owner-only encryption.
// Usage: node pdf-probes.mjs <probe>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out-probes');
await mkdir(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/');
const probe = process.argv[2];

async function makePdf(pages, { size = [612, 792], useObjectStreams = true } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create({ updateMetadata: false });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage(size);
    p.drawRectangle({ x: 0, y: size[1] - 120, width: size[0], height: 120, color: rgb(0.2, 0.4, 0.9) });
    p.drawText(`Page ${i} of ${pages}`, { x: 60, y: size[1] / 2, size: 64, font: bold });
    for (let k = 0; k < 40; k++) p.drawText(`Line ${k} lorem ipsum dolor sit amet ${i}`, { x: 60, y: 60 + k * 14, size: 11, font: bold, color: rgb(0.3, 0.3, 0.3) });
  }
  return new Uint8Array(await doc.save({ useObjectStreams }));
}

async function render(data, { pages = [1], width = 1024, fonts = true, useCtx = false, maxPx = 4096 * 4096 } = {}) {
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const warnings = [];
  const origWarn = console.log;
  console.log = (...a) => warnings.push(a.join(' ')); // pdf.js logs warnings via console.log
  const task = getDocument({ data, ...(fonts ? { standardFontDataUrl: `${root}/standard_fonts/` } : {}), cMapUrl: `${root}/cmaps/`, wasmUrl: `${root}/wasm/`, verbosity: VerbosityLevel.WARNINGS });
  const t0 = performance.now();
  const out = { pages: [] };
  try {
    const doc = await task.promise;
    out.numPages = doc.numPages;
    out.loadMs = Math.round(performance.now() - t0);
    const list = pages === 'all' ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : pages;
    for (const n of list) {
      const t1 = performance.now();
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      let scale = width / base.width;
      const px = base.width * base.height * scale * scale;
      if (px > maxPx) scale *= Math.sqrt(maxPx / px);
      const vp = page.getViewport({ scale });
      const cc = doc.canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
      await page.render(useCtx ? { canvasContext: cc.context, viewport: vp } : { canvas: cc.canvas, viewport: vp }).promise;
      const png = cc.canvas.toBuffer('image/png');
      if (n <= 2) await writeFile(path.join(OUT, `${probe}-p${n}.png`), png);
      doc.canvasFactory.destroy(cc);
      page.cleanup();
      out.pages.push({ n, w: Math.ceil(vp.width), h: Math.ceil(vp.height), bytes: png.length, ms: Math.round(performance.now() - t1) });
    }
  } catch (e) {
    out.error = { name: e.name, message: e.message, code: e.code };
  } finally {
    await task.destroy();
    console.log = origWarn;
  }
  out.totalMs = Math.round(performance.now() - t0);
  out.maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  out.warnings = [...new Set(warnings)].slice(0, 5);
  return out;
}

const summarize = (r) => ({ ...r, pages: r.pages.length > 6 ? { count: r.pages.length, first: r.pages[0], last: r.pages.at(-1), avgMs: Math.round(r.pages.reduce((s, p) => s + p.ms, 0) / r.pages.length) } : r.pages });
let result;
switch (probe) {
  case 'no-fonts': result = await render(await makePdf(1), { fonts: false }); break;
  case 'ctx': result = await render(await makePdf(1), { useCtx: true }); break;
  case 'pages100-all': result = await render(await makePdf(100), { pages: 'all', width: 1024 }); break;
  case 'pages100-cover': result = await render(await makePdf(100), { pages: [1], width: 1024 }); break;
  case 'huge-page': result = await render(await makePdf(1, { size: [14400, 14400] }), { width: 14400 }); break;
  case 'huge-page-noclamp': result = await render(await makePdf(1, { size: [14400, 14400] }), { width: 14400, maxPx: Infinity }); break;
  case 'truncated-no-objstm': {
    const full = await makePdf(4, { useObjectStreams: false });
    result = await render(full.slice(0, Math.floor(full.length * 0.6)), { pages: 'all' });
    result.inputBytes = Math.floor(full.length * 0.6);
    break;
  }
  case 'owner-only-encrypted': {
    const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText('owner-only', { x: 72, y: 700, size: 24, font });
    doc.encrypt({ ownerPassword: 'owner-only-pw', permissions: { printing: false, copying: false } });
    result = await render(new Uint8Array(await doc.save()));
    break;
  }
  case 'wrong-password': {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await readFile(path.join(HERE, 'fixtures', 'encrypted.pdf')));
    const task = getDocument({ data, password: 'nope' });
    try { await task.promise; result = 'opened?!'; } catch (e) { result = { name: e.name, message: e.message, code: e.code }; } finally { await task.destroy(); }
    const task2 = getDocument({ data: new Uint8Array(await readFile(path.join(HERE, 'fixtures', 'encrypted.pdf'))), password: 'fixture-user-pw', standardFontDataUrl: `${root}/standard_fonts/` });
    const d2 = await task2.promise; result = { wrong: result, correctPasswordNumPages: d2.numPages }; await task2.destroy();
    break;
  }
  case 'buffer-input': {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    try { const t = getDocument({ data: await readFile(path.join(HERE, 'fixtures', 'document.pdf')) }); await t.promise; result = 'accepted Buffer'; await t.destroy(); } catch (e) { result = { name: e.name, message: e.message }; }
    break;
  }
  default: throw new Error('unknown probe ' + probe);
}
process.stdout.write(JSON.stringify({ probe, result: typeof result === 'object' && result.pages ? summarize(result) : result }, null, 1) + '\n');
