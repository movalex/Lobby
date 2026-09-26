// Browser playback probe: serves fixtures over localhost (with Range support) and checks <video> playback
// in locally installed branded browsers via playwright-core channels (no Playwright browser download).
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  if (name === 'index.html' || name === '') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>probe</title>'); }
  const file = path.join(HERE, 'fixtures', name);
  let size;
  try { size = statSync(file).size; } catch { res.writeHead(404); return res.end(); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function probe(channel, headless) {
  const browser = await chromium.launch({ channel, headless });
  const page = await browser.newPage();
  await page.goto(`${base}/index.html`);
  const out = { channel, headless, version: browser.version() };
  out.canPlayType = await page.evaluate(() => ({
    'video/mp4; codecs="avc1.640028, mp4a.40.2"': document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
    'video/mp4; codecs="avc1.42E01E"': document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
    'video/mp4; codecs="hvc1.1.6.L93.B0"': document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    'video/webm; codecs="vp9, opus"': document.createElement('video').canPlayType('video/webm; codecs="vp9, opus"'),
  }));
  for (const file of ['video.mp4', 'video-hevc.mp4']) {
    out[file] = await page.evaluate(async (src) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = src;
      document.body.append(v);
      const r = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ result: 'timeout', readyState: v.readyState, error: v.error?.code }), 8000);
        v.addEventListener('error', () => { clearTimeout(t); resolve({ result: 'error', code: v.error?.code, message: v.error?.message }); });
        v.addEventListener('loadeddata', async () => {
          try { await v.play(); } catch (e) { clearTimeout(t); return resolve({ result: 'play-rejected', message: String(e) }); }
          setTimeout(() => { clearTimeout(t); resolve({ result: v.currentTime > 0.3 ? 'playing' : 'stalled', currentTime: Math.round(v.currentTime * 100) / 100, duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight, decodedFrames: v.getVideoPlaybackQuality?.().totalVideoFrames }); }, 1200);
        }, { once: true });
      });
      v.remove();
      return r;
    }, `${base}/${file}`);
  }
  await browser.close();
  return out;
}

const results = [];
for (const [channel, headless] of [['chrome', true], ['msedge', true]]) {
  try { results.push(await probe(channel, headless)); } catch (e) { results.push({ channel, headless, launchError: e.message.split('\n')[0] }); }
}
server.close();
console.log(JSON.stringify(results, null, 1));
