// sharp 0.35.4 probes: default pixel limit, SVG default behaviour, loader allowlist coverage, timing/memory.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFile(path.join(HERE, 'fixtures', n));
const res = {};
const attempt = async (label, fn) => {
  const t0 = performance.now();
  try { res[label] = { ok: true, value: await fn(), ms: Math.round(performance.now() - t0) }; }
  catch (e) { res[label] = { ok: false, error: e.message, ms: Math.round(performance.now() - t0) }; }
};

// 1. Header-only metadata() on a bomb: reports the claimed size without decoding
await attempt('metadata(bomb 30000x30000) default opts', async () => { const m = await sharp(await fx('bomb-30000x30000.png')).metadata(); return `${m.width}x${m.height}`; });
// 2. Default limitInputPixels (268402689) lets a 144 MP header through to decode
await attempt('resize(bomb 12000x12000) default limit', async () => (await sharp(await fx('bomb-12000x12000.png')).resize(256).png().toBuffer()).length);
await attempt('resize(bomb 12000x12000) limit=100e6', async () => (await sharp(await fx('bomb-12000x12000.png'), { limitInputPixels: 100_000_000 }).resize(256).png().toBuffer()).length);
await attempt('resize(bomb 30000x30000) default limit', async () => (await sharp(await fx('bomb-30000x30000.png')).resize(256).png().toBuffer()).length);
// 3. Unlocked sharp WILL rasterise SVG (librsvg) - this is why the worker allowlists loaders
await attempt('SVG before block()', async () => { const { info } = await sharp(await fx('vector.svg')).png().toBuffer({ resolveWithObject: true }); return `${info.format} ${info.width}x${info.height}`; });
// Make WebP + animated GIF inputs while loaders are still unblocked
const webp = await sharp(await fx('image.png')).resize(320).webp().toBuffer();
const gifAnimated = await sharp([
  { create: { width: 64, height: 64, channels: 3, background: '#f00' } },
  { create: { width: 64, height: 64, channels: 3, background: '#0f0' } },
  { create: { width: 64, height: 64, channels: 3, background: '#00f' } },
], { join: { animated: true } }).gif().toBuffer();

sharp.block({ operation: ['VipsForeignLoad'] });
// NOTE: 'VipsForeignLoadGif*' does not exist in libvips 8.18.6; GIF input is 'VipsForeignLoadNsgif*' (verified).
sharp.unblock({ operation: ['VipsForeignLoadJpegFile', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngFile', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpFile', 'VipsForeignLoadWebpBuffer', 'VipsForeignLoadNsgifFile', 'VipsForeignLoadNsgifBuffer'] });

await attempt('SVG after block()', async () => (await sharp(await fx('vector.svg')).png().toBuffer()).length);
await attempt('SVG file path after block()', async () => (await sharp(path.join(HERE, 'fixtures', 'vector.svg')).png().toBuffer()).length);
await attempt('PNG buffer after block()', async () => (await sharp(await fx('image.png')).metadata()).format);
await attempt('PNG file path after block()', async () => (await sharp(path.join(HERE, 'fixtures', 'image.png')).metadata()).format);
await attempt('JPEG buffer after block()', async () => (await sharp(await fx('image-exif6.jpg')).metadata()).format);
await attempt('WebP buffer after block()', async () => (await sharp(webp).metadata()).format);
await attempt('GIF (animated) after block(): metadata pages', async () => { const m = await sharp(gifAnimated).metadata(); return { format: m.format, pages: m.pages }; });
await attempt('GIF animated:false -> first frame webp', async () => { const { info } = await sharp(gifAnimated, { animated: false }).webp().toBuffer({ resolveWithObject: true }); return `${info.width}x${info.height}`; });
await attempt('PDF buffer via sharp (prebuilt has no pdf loader)', async () => (await sharp(await fx('document.pdf')).metadata()).format);
// 4. Rough cost of a 24 MP JPEG -> 512 thumb (shrink-on-load) vs 2048 display
const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#888' } }).jpeg({ quality: 90 }).toBuffer();
await attempt('24MP JPEG -> thumb-512.webp', async () => (await sharp(big, { limitInputPixels: 100_000_000 }).resize({ width: 512, height: 512, fit: 'inside' }).webp({ quality: 80 }).toBuffer()).length);
await attempt('24MP JPEG -> display-2048.webp', async () => (await sharp(big, { limitInputPixels: 100_000_000 }).resize({ width: 2048, height: 2048, fit: 'inside' }).webp({ quality: 82 }).toBuffer()).length);
res.maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
res.concurrencyDefault = sharp.concurrency();
console.log(JSON.stringify(res, null, 1));
