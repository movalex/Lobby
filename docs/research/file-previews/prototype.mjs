#!/usr/bin/env node
// Draftroom milestone-0 file-preview prototype (scratch, NOT production).
//
//   node prototype.mjs            -> generate fixtures, derive previews, print manifest JSON
//   node prototype.mjs --fixtures -> only generate fixtures
//
// Internal child-process entry point (spawned by the parent, isolated + time-boxed):
//   node --max-old-space-size=512 prototype.mjs --pdf-child <pdfPath> <outDir> <pages|"cover"|"all"> <targetWidth>
//
// Requirements: Node >= 22.13 (tested 24.19.0), ffmpeg + ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH),
// npm deps: sharp@0.35.4 pdfjs-dist@6.3.289 @napi-rs/canvas@1.0.9 pdf-lib@1.17.1 @cantoo/pdf-lib@2.11.1 (fixture-only)

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'out');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Security / resource limits (milestone-0 proposals; tune with measurements)
// ---------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  image: {
    maxBytes: 25 * 1024 * 1024,
    maxInputPixels: 100_000_000, // 100 MP; sharp default is 268_402_689 (0x3FFF^2)
    allowedFormats: ['jpeg', 'png', 'webp', 'gif'], // sharp metadata().format values; NO svg, NO pdf, NO tiff in M0
    sharpTimeoutSeconds: 20,
  },
  pdf: {
    maxBytes: 100 * 1024 * 1024,
    maxPages: 500, // reject documents above this outright
    maxPreviewPages: 200, // never render beyond this page number
    maxPageRenderPixels: 4096 * 4096, // canvas size cap per page (native memory ~= px * 4 bytes)
    maxEmbeddedImagePixels: 100_000_000, // pdf.js maxImageSize (skip huge embedded images)
    maxPagePoints: 14_400, // 200 inches; reject absurd MediaBox
    childHeapMb: 512, // --max-old-space-size for the child (V8 heap only; canvas memory is native)
    childTimeoutMs: 60_000, // whole child run (N pages)
  },
  video: {
    maxBytes: 500 * 1024 * 1024,
    maxDurationMs: 10 * 60 * 1000,
    maxWidth: 3840,
    maxHeight: 2160,
    allowedVideoCodecs: ['h264'],
    allowedH264Profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'],
    allowedPixFmts: ['yuv420p', 'yuvj420p'],
    allowedAudioCodecs: ['aac'],
    probeTimeoutMs: 15_000,
    posterTimeoutMs: 30_000,
    maxProbeStdoutBytes: 1024 * 1024,
  },
});

// ---------------------------------------------------------------------------
// Process helper: spawn with hard timeout (SIGKILL) and bounded stdout capture
// ---------------------------------------------------------------------------
export function run(cmd, args, { timeoutMs = 30_000, maxStdoutBytes = 64 * 1024 * 1024, env } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs, // Node kills the child with killSignal when exceeded
      killSignal: 'SIGKILL',
      // Minimal environment: children never see storage/DB credentials. SYSTEMROOT is needed on Windows.
      env: env ?? { PATH: process.env.PATH ?? '', ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) },
    });
    const out = [];
    let outBytes = 0;
    let err = '';
    let overflow = false;
    child.stdout.on('data', (b) => {
      outBytes += b.length;
      if (outBytes > maxStdoutBytes) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(b);
    });
    child.stderr.on('data', (b) => {
      if (err.length < 16_384) err += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const ms = Math.round(performance.now() - t0);
      const res = { code, signal, ms, stdout: Buffer.concat(out), stderr: err.trim() };
      if (overflow) return reject(Object.assign(new Error(`stdout exceeded ${maxStdoutBytes} bytes`), res));
      if (signal) return reject(Object.assign(new Error(`killed by ${signal} after ${ms}ms (timeout ${timeoutMs}ms)`), res, { timedOut: ms >= timeoutMs - 50 }));
      if (code !== 0) return reject(Object.assign(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`), res));
      resolve(res);
    });
  });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pkgVersion = (name) => JSON.parse(require('node:fs').readFileSync(path.join(HERE, 'node_modules', name, 'package.json'), 'utf8')).version;
const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

// ---------------------------------------------------------------------------
// 1. Fixture generation (deterministic where the tools allow)
// ---------------------------------------------------------------------------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
/** Tiny PNG whose IHDR claims width x height (decompression-bomb header). */
function craftBombPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const idat = zlib.deflateSync(Buffer.alloc(1 + width * 3)); // one scanline only
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function makeFixturePdf(pageCount = 4) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  // updateMetadata:false -> no Producer/CreationDate/ModDate, so bytes are reproducible
  const doc = await PDFDocument.create({ updateMetadata: false });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const colors = [rgb(0.23, 0.51, 0.96), rgb(0.06, 0.73, 0.51), rgb(0.96, 0.62, 0.04), rgb(0.93, 0.27, 0.27), rgb(0.55, 0.36, 0.96)];
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([612, 792]); // US Letter, points
    const { width, height } = page.getSize();
    page.drawRectangle({ x: 0, y: height - 120, width, height: 120, color: colors[(i - 1) % colors.length] });
    page.drawText('Draftroom fixture PDF', { x: 48, y: height - 75, size: 28, font: bold, color: rgb(1, 1, 1) });
    const label = `Page ${i} of ${pageCount}`;
    const size = 72;
    const w = bold.widthOfTextAtSize(label, size);
    page.drawText(label, { x: (width - w) / 2, y: height / 2 - size / 2, size, font: bold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`Generated test document. Non-sensitive. Page number ${i}.`, { x: 48, y: 96, size: 14, font: regular, color: rgb(0.3, 0.3, 0.3) });
    page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 2 });
  }
  return Buffer.from(await doc.save());
}

async function makeEncryptedPdf() {
  // Fixture-only dependency: @cantoo/pdf-lib (MIT fork of pdf-lib with encrypt()). Output is random per run.
  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Encrypted fixture', { x: 72, y: 700, size: 24, font });
  doc.encrypt({ userPassword: 'fixture-user-pw', ownerPassword: 'fixture-owner-pw' });
  return Buffer.from(await doc.save());
}

export async function generateFixtures() {
  await mkdir(FIX, { recursive: true });
  const sharp = (await import('sharp')).default;
  const made = [];
  const record = async (name, buf) => {
    await writeFile(path.join(FIX, name), buf);
    made.push({ name, bytes: buf.length, sha256: sha256(buf) });
  };
  const ff = (args, t = 60_000) => run(FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], { timeoutMs: t });

  // Image (PNG): ffmpeg lavfi testsrc2 first frame, 1920x1080
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-frames:v', '1', '-fflags', '+bitexact', '-flags', '+bitexact', path.join(FIX, 'image.png')]);
  const png = await readFile(path.join(FIX, 'image.png'));
  made.push({ name: 'image.png', bytes: png.length, sha256: sha256(png) });

  // Image (JPEG) with EXIF Orientation=6 (stored 1920x1080, displays 1080x1920) to exercise autoOrient
  await record('image-exif6.jpg', await sharp(png).jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toBuffer());

  // PDF: 4 pages, visible "Page N of 4"
  await record('document.pdf', await makeFixturePdf(4));

  // MP4: 5 s H.264 High / yuv420p + AAC-LC stereo 48 kHz, faststart
  await ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '5', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-map_metadata', '-1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    path.join(FIX, 'video.mp4'),
  ]);
  const mp4 = await readFile(path.join(FIX, 'video.mp4'));
  made.push({ name: 'video.mp4', bytes: mp4.length, sha256: sha256(mp4) });

  // ---- negative fixtures ----
  await record('bomb-30000x30000.png', craftBombPng(30000, 30000)); // 900 MP: above sharp default AND our limit
  await record('bomb-12000x12000.png', craftBombPng(12000, 12000)); // 144 MP: below sharp default, above our 100 MP limit
  await record('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'));
  await record('encrypted.pdf', await makeEncryptedPdf());
  await record('garbage.pdf', Buffer.from('%PDF-1.7\n' + 'this is not really a pdf\n'.repeat(40)));
  await record('empty.pdf', Buffer.alloc(0));
  const pdf = await readFile(path.join(FIX, 'document.pdf'));
  await record('truncated.pdf', pdf.subarray(0, Math.floor(pdf.length * 0.6)));
  await record('truncated.mp4', mp4.subarray(0, Math.floor(mp4.length * 0.3)));
  // HLS playlist disguised as .mp4 (classic ffmpeg format-confusion/SSRF vector). The URL is never fetched.
  await record('playlist-disguised.mp4', Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://127.0.0.1:9/never-fetched.ts\n#EXT-X-ENDLIST\n'));
  // HEVC in MP4: valid file, but not in the M0 browser-playback allowlist -> needs proxy
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', path.join(FIX, 'video-hevc.mp4')]);
  const hevc = await readFile(path.join(FIX, 'video-hevc.mp4'));
  made.push({ name: 'video-hevc.mp4', bytes: hevc.length, sha256: sha256(hevc) });
  return made;
}

// ---------------------------------------------------------------------------
// 2. Image derivatives (sharp, in-process in the worker; libvips is native + threaded)
// ---------------------------------------------------------------------------
let sharpLocked = false;
async function getLockedSharp() {
  const sharp = (await import('sharp')).default; // NOTE: sharp 0.35 ESM has ONLY a default export at runtime
  if (!sharpLocked) {
    // Allowlist loaders: block every libvips loader, then re-enable only what we accept.
    sharp.block({ operation: ['VipsForeignLoad'] });
    sharp.unblock({
      operation: [
        'VipsForeignLoadJpegFile', 'VipsForeignLoadJpegBuffer',
        'VipsForeignLoadPngFile', 'VipsForeignLoadPngBuffer',
        'VipsForeignLoadWebpFile', 'VipsForeignLoadWebpBuffer',
        // GIF is decoded by libnsgif in libvips 8.18 -> class names are *Nsgif*, NOT *Gif* (verified)
        'VipsForeignLoadNsgifFile', 'VipsForeignLoadNsgifBuffer',
      ],
    });
    sharp.concurrency(2); // libvips threads per image; keep the worker from saturating the box
    sharp.cache(false);
    sharpLocked = true;
  }
  return sharp;
}

export async function processImage(file, outDir) {
  const t0 = performance.now();
  const sharp = await getLockedSharp();
  const input = await readFile(file);
  if (input.length > LIMITS.image.maxBytes) throw new Error(`image exceeds ${LIMITS.image.maxBytes} bytes`);
  const opts = { limitInputPixels: LIMITS.image.maxInputPixels, failOn: 'warning', animated: false };
  const meta = await sharp(input, opts).metadata(); // header parse only
  if (!LIMITS.image.allowedFormats.includes(meta.format)) throw new Error(`image format ${meta.format} not allowed`);
  if (meta.width * meta.height > LIMITS.image.maxInputPixels) throw new Error(`image ${meta.width}x${meta.height} exceeds pixel limit`);
  const profiles = [
    { profile: 'thumb-512.webp', size: 512, quality: 80 },
    { profile: 'display-2048.webp', size: 2048, quality: 82 },
  ];
  const derivatives = [];
  for (const p of profiles) {
    const t1 = performance.now();
    const { data, info } = await sharp(input, { ...opts, autoOrient: true })
      .resize({ width: p.size, height: p.size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: p.quality })
      .timeout({ seconds: LIMITS.image.sharpTimeoutSeconds })
      .toBuffer({ resolveWithObject: true });
    const out = path.join(outDir, `${path.basename(file)}.${p.profile}`);
    await writeFile(out, data);
    derivatives.push({ profile: p.profile, path: path.relative(HERE, out), mimeType: 'image/webp', bytes: info.size, width: info.width, height: info.height, ms: Math.round(performance.now() - t1) });
  }
  const outMeta = await sharp(await readFile(path.join(HERE, derivatives[0].path))).metadata();
  return {
    kind: 'image',
    status: 'ready',
    probe: { format: meta.format, width: meta.width, height: meta.height, orientation: meta.orientation ?? null, displayWidth: meta.autoOrient.width, displayHeight: meta.autoOrient.height, hasAlpha: meta.hasAlpha, pages: meta.pages ?? 1 },
    derivatives,
    derivativeHasExif: Boolean(outMeta.exif),
    ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// 3. PDF page previews (pdfjs-dist legacy build + @napi-rs/canvas) in an isolated child process
// ---------------------------------------------------------------------------
async function pdfChild([pdfPath, outDir, pagesArg, targetWidthArg]) {
  const t0 = performance.now();
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const importMs = Math.round(performance.now() - t0);
  const root = path.dirname(require.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/');
  const targetWidth = Number(targetWidthArg);
  const data = new Uint8Array(await readFile(pdfPath)); // pdf.js rejects Node Buffer; must be Uint8Array
  const loadingTask = getDocument({
    data,
    // Factory URLs are plain filesystem paths in Node and MUST end with '/'
    standardFontDataUrl: `${root}/standard_fonts/`,
    cMapUrl: `${root}/cmaps/`,
    wasmUrl: `${root}/wasm/`,
    iccUrl: `${root}/iccs/`,
    useSystemFonts: false,
    enableXfa: false,
    maxImageSize: LIMITS.pdf.maxEmbeddedImagePixels,
    verbosity: VerbosityLevel.ERRORS,
  });
  const result = { pageCount: 0, pageLabels: null, pages: [], importMs, loadMs: 0, totalMs: 0 };
  try {
    const doc = await loadingTask.promise;
    result.loadMs = Math.round(performance.now() - t0);
    result.pageCount = doc.numPages;
    result.pageLabels = await doc.getPageLabels(); // null unless the PDF defines /PageLabels
    if (doc.numPages > LIMITS.pdf.maxPages) throw Object.assign(new Error(`PDF has ${doc.numPages} pages (max ${LIMITS.pdf.maxPages})`), { name: 'LimitError' });
    const want = pagesArg === 'all' ? Array.from({ length: Math.min(doc.numPages, LIMITS.pdf.maxPreviewPages) }, (_, i) => i + 1)
      : pagesArg === 'cover' ? [1]
      : pagesArg.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= Math.min(doc.numPages, LIMITS.pdf.maxPreviewPages));
    const cf = doc.canvasFactory;
    for (const n of want) {
      const t1 = performance.now();
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 }); // PDF points, rotation applied
      if (base.width > LIMITS.pdf.maxPagePoints || base.height > LIMITS.pdf.maxPagePoints) throw Object.assign(new Error(`page ${n} is ${base.width}x${base.height}pt`), { name: 'LimitError' });
      let scale = targetWidth / base.width;
      const px = base.width * scale * base.height * scale;
      if (px > LIMITS.pdf.maxPageRenderPixels) scale *= Math.sqrt(LIMITS.pdf.maxPageRenderPixels / px);
      const viewport = page.getViewport({ scale });
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      const cc = cf.create(w, h);
      await page.render({ canvas: cc.canvas, viewport }).promise; // background defaults to white
      const png = cc.canvas.toBuffer('image/png');
      const out = path.join(outDir, `${path.basename(pdfPath)}.page-${String(n).padStart(4, '0')}@${targetWidth}w.png`);
      await writeFile(out, png);
      cf.destroy(cc);
      page.cleanup();
      result.pages.push({ page: n, widthPt: Math.round(base.width * 100) / 100, heightPt: Math.round(base.height * 100) / 100, rotate: page.rotate, png: { path: path.relative(HERE, out), width: w, height: h, bytes: png.length }, ms: Math.round(performance.now() - t1) });
    }
    // NOTE: PDFDocumentProxy has no destroy() in pdfjs-dist 6.x; the loading task is destroyed in `finally`.
  } catch (e) {
    result.error = { name: e?.name ?? 'Error', message: String(e?.message ?? e), code: e?.code };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
  result.totalMs = Math.round(performance.now() - t0);
  const ru = process.resourceUsage();
  result.child = { maxRssMB: Math.round(ru.maxRSS / 1024), heapUsedMB: mb(process.memoryUsage().heapUsed) };
  process.stdout.write(JSON.stringify(result));
}

export async function processPdf(file, outDir, pages = 'all', targetWidth = 1024) {
  const t0 = performance.now();
  const { length } = await readFile(file);
  if (length > LIMITS.pdf.maxBytes) throw new Error(`pdf exceeds ${LIMITS.pdf.maxBytes} bytes`);
  const res = await run(process.execPath, [`--max-old-space-size=${LIMITS.pdf.childHeapMb}`, fileURLToPath(import.meta.url), '--pdf-child', file, outDir, String(pages), String(targetWidth)], { timeoutMs: LIMITS.pdf.childTimeoutMs, maxStdoutBytes: 1024 * 1024 });
  const r = JSON.parse(res.stdout.toString('utf8'));
  return {
    kind: 'pdf',
    status: r.error ? 'failed' : 'ready',
    pageCount: r.pageCount,
    error: r.error,
    pages: r.pages,
    pageLabels: r.pageLabels,
    timing: { parentWallMs: Math.round(performance.now() - t0), childTotalMs: r.totalMs, childImportMs: r.importMs, childLoadMs: r.loadMs },
    child: r.child,
    stderr: res.stderr || undefined,
  };
}

// ---------------------------------------------------------------------------
// 4. Video: ffprobe validation + ffmpeg poster frame
// ---------------------------------------------------------------------------
// Force the MP4/MOV demuxer (no auto-probing into HLS/concat/image2...), file protocol only, and pin the
// mov demuxer's external-reference options off (they default to off in ffmpeg 9.0.1; pinned for older builds).
const FF_INPUT_HARDENING = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];

export async function probeVideo(file, { forceDemuxer = true } = {}) {
  const args = ['-v', 'error', '-hide_banner', ...(forceDemuxer ? FF_INPUT_HARDENING : ['-protocol_whitelist', 'file']), '-show_format', '-show_streams', '-of', 'json', file];
  const res = await run(FFPROBE, args, { timeoutMs: LIMITS.video.probeTimeoutMs, maxStdoutBytes: LIMITS.video.maxProbeStdoutBytes });
  return JSON.parse(res.stdout.toString('utf8'));
}

export function validateProbe(p) {
  const L = LIMITS.video;
  const problems = [];
  const v = p.streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = p.streams.filter((s) => s.codec_type === 'audio');
  if (!/mp4|mov/.test(p.format?.format_name ?? '')) problems.push(`container ${p.format?.format_name}`);
  const brand = p.format?.tags?.major_brand?.trim();
  if (brand === 'qt') problems.push('QuickTime .mov brand (needs proxy in M0)');
  if (v.length !== 1) problems.push(`${v.length} video streams`);
  if (a.length > 1) problems.push(`${a.length} audio streams`);
  const vs = v[0];
  if (vs) {
    if (!L.allowedVideoCodecs.includes(vs.codec_name)) problems.push(`video codec ${vs.codec_name}`);
    else if (!L.allowedH264Profiles.includes(vs.profile)) problems.push(`h264 profile ${vs.profile}`);
    if (!L.allowedPixFmts.includes(vs.pix_fmt)) problems.push(`pix_fmt ${vs.pix_fmt}`);
    if (vs.width > L.maxWidth || vs.height > L.maxHeight) problems.push(`${vs.width}x${vs.height} too large`);
  }
  if (a[0] && !L.allowedAudioCodecs.includes(a[0].codec_name)) problems.push(`audio codec ${a[0].codec_name}`);
  const durationMs = Math.round(Number(p.format?.duration ?? vs?.duration ?? NaN) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) problems.push('unknown duration');
  else if (durationMs > L.maxDurationMs) problems.push(`duration ${durationMs}ms > ${L.maxDurationMs}ms`);
  const [fn, fd] = String(vs?.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    playable: problems.length === 0,
    problems,
    summary: {
      container: p.format?.format_name, majorBrand: brand ?? null, durationMs, sizeBytes: Number(p.format?.size), bitRate: Number(p.format?.bit_rate),
      video: vs ? { codec: vs.codec_name, profile: vs.profile, level: vs.level, pixFmt: vs.pix_fmt, width: vs.width, height: vs.height, fps: fd ? Math.round((fn / fd) * 1000) / 1000 : null, rotation: vs.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0 } : null,
      audio: a[0] ? { codec: a[0].codec_name, profile: a[0].profile, sampleRate: Number(a[0].sample_rate), channels: a[0].channels } : null,
    },
  };
}

export async function processVideo(file, outDir) {
  const t0 = performance.now();
  const { length } = await readFile(file);
  if (length > LIMITS.video.maxBytes) throw new Error(`video exceeds ${LIMITS.video.maxBytes} bytes`);
  const probe = await probeVideo(file);
  const probeMs = Math.round(performance.now() - t0);
  const v = validateProbe(probe);
  const probePath = path.join(outDir, `${path.basename(file)}.probe.json`);
  await writeFile(probePath, JSON.stringify(probe, null, 2));
  const derivatives = [{ profile: 'probe.json', path: path.relative(HERE, probePath), mimeType: 'application/json', bytes: (await readFile(probePath)).length }];
  // Poster: seek (input-side, fast) to min(1s, duration/2); decode one frame; downscale; PNG to stdout.
  const seek = Math.max(0, Math.min(1, (v.summary.durationMs || 0) / 2000));
  const t1 = performance.now();
  const poster = await run(FFMPEG, [
    '-nostdin', '-hide_banner', '-v', 'error', ...FF_INPUT_HARDENING, '-ss', seek.toFixed(3), '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ], { timeoutMs: LIMITS.video.posterTimeoutMs, maxStdoutBytes: 32 * 1024 * 1024 });
  const sharp = await getLockedSharp();
  const { data, info } = await sharp(poster.stdout, { limitInputPixels: LIMITS.image.maxInputPixels }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  const posterPath = path.join(outDir, `${path.basename(file)}.poster.webp`);
  await writeFile(posterPath, data);
  derivatives.push({ profile: 'poster.webp', path: path.relative(HERE, posterPath), mimeType: 'image/webp', bytes: info.size, width: info.width, height: info.height, seekSec: seek, ms: Math.round(performance.now() - t1) });
  return { kind: 'video', status: v.playable ? 'ready' : 'failed', playable: v.playable, problems: v.problems, probe: v.summary, derivatives, timing: { probeMs, posterMs: derivatives[1].ms, totalMs: Math.round(performance.now() - t0) } };
}

// ---------------------------------------------------------------------------
// Negative cases: every one must end in a clean, classified failure
// ---------------------------------------------------------------------------
async function expectFailure(label, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    const failed = r?.status === 'failed';
    return { case: label, outcome: failed ? 'failed-cleanly' : 'UNEXPECTED-SUCCESS', detail: r?.error ?? r?.problems ?? null, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { case: label, outcome: 'failed-cleanly', detail: { name: e.name, message: String(e.message).slice(0, 240), code: e.code, signal: e.signal, timedOut: e.timedOut }, ms: Math.round(performance.now() - t0) };
  }
}

async function main() {
  const t0 = performance.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const fixtures = await generateFixtures();
  if (process.argv.includes('--fixtures')) {
    console.log(JSON.stringify(fixtures, null, 2));
    return;
  }
  const f = (n) => path.join(FIX, n);
  const sharp = await getLockedSharp();
  const ffv = (await run(FFMPEG, ['-hide_banner', '-version'])).stdout.toString().split('\n')[0].trim();
  const assets = [];
  assets.push({ source: 'fixtures/image.png', ...(await processImage(f('image.png'), OUT)) });
  assets.push({ source: 'fixtures/image-exif6.jpg', ...(await processImage(f('image-exif6.jpg'), OUT)) });
  assets.push({ source: 'fixtures/document.pdf', ...(await processPdf(f('document.pdf'), OUT, 'all', 1024)) });
  assets.push({ source: 'fixtures/document.pdf (lazy: page 3 only)', ...(await processPdf(f('document.pdf'), OUT, '3', 400)) });
  assets.push({ source: 'fixtures/video.mp4', ...(await processVideo(f('video.mp4'), OUT)) });

  const negative = [];
  negative.push(await expectFailure('bomb-30000x30000.png (900 MP)', () => processImage(f('bomb-30000x30000.png'), OUT)));
  negative.push(await expectFailure('bomb-12000x12000.png (144 MP) - under sharp default, over our limit', () => processImage(f('bomb-12000x12000.png'), OUT)));
  negative.push(await expectFailure('vector.svg via locked sharp', () => processImage(f('vector.svg'), OUT)));
  negative.push(await expectFailure('encrypted.pdf', () => processPdf(f('encrypted.pdf'), OUT)));
  negative.push(await expectFailure('garbage.pdf', () => processPdf(f('garbage.pdf'), OUT)));
  negative.push(await expectFailure('empty.pdf', () => processPdf(f('empty.pdf'), OUT)));
  negative.push({ ...(await (async () => { const r = await processPdf(f('truncated.pdf'), OUT, 'all', 256); return { case: 'truncated.pdf (60% of bytes) - pdf.js xref recovery', outcome: r.status, pageCount: r.pageCount, pagesRendered: r.pages?.length ?? 0, detail: r.error ?? null }; })()) });
  negative.push(await expectFailure('playlist-disguised.mp4 (forced mov demuxer)', () => processVideo(f('playlist-disguised.mp4'), OUT)));
  negative.push(await expectFailure('playlist-disguised.mp4 (auto-probe, file-only protocol whitelist)', () => probeVideo(f('playlist-disguised.mp4'), { forceDemuxer: false })));
  await writeFile(f('playlist.m3u8'), await readFile(f('playlist-disguised.mp4')));
  negative.push(await expectFailure('playlist.m3u8 (auto-probe detects HLS; http blocked by whitelist)', () => probeVideo(f('playlist.m3u8'), { forceDemuxer: false })));
  negative.push(await expectFailure('playlist.m3u8 (forced mov demuxer)', () => probeVideo(f('playlist.m3u8'))));
  negative.push(await expectFailure('video-hevc.mp4 (not in playback allowlist)', () => processVideo(f('video-hevc.mp4'), OUT)));
  {
    // probe + poster can SUCCEED on a faststart file whose tail is missing; only a full decode pass catches it
    const r = await processVideo(f('truncated.mp4'), OUT);
    const dec = await expectFailure('decode check', () => run(FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', ...FF_INPUT_HARDENING, '-i', f('truncated.mp4'), '-f', 'null', '-'], { timeoutMs: 30_000 }));
    const full = await run(FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', ...FF_INPUT_HARDENING, '-i', f('video.mp4'), '-f', 'null', '-'], { timeoutMs: 30_000 });
    negative.push({ case: 'truncated.mp4 (first 30% of bytes)', probeAndPosterStatus: r.status, probedDurationMs: r.probe.durationMs, decodeCheck: dec.outcome, decodeError: dec.detail?.message?.slice(0, 200), decodeCheckMs: dec.ms, goodFileFullDecodeMs: full.ms, goodFileDecodeStderr: full.stderr || '' });
  }
  negative.push(await expectFailure('ffmpeg hard timeout (endless lavfi source, 1500 ms)', () => run(FFMPEG, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'null', '-'], { timeoutMs: 1500 })));

  const manifest = {
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: Math.round(os.totalmem() / 2 ** 30) },
    versions: {
      sharp: sharp.versions.sharp, libvips: sharp.versions.vips,
      'pdfjs-dist': pkgVersion('pdfjs-dist'),
      '@napi-rs/canvas': pkgVersion('@napi-rs/canvas'),
      'pdf-lib': pkgVersion('pdf-lib'),
      '@cantoo/pdf-lib': pkgVersion('@cantoo/pdf-lib'),
      ffmpeg: ffv,
    },
    limits: LIMITS,
    fixtures,
    assets,
    negative,
    totalMs: Math.round(performance.now() - t0),
  };
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[2] === '--pdf-child') {
  await pdfChild(process.argv.slice(3));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
