# File previews (milestone 0): image, multipage PDF, short MP4

Status: research complete for milestone 0. Everything under "Verified" was run on this machine on 2026-09-26. Items marked **UNVERIFIED** were not run.
Scope: a proven, documented path from three generated fixtures (image, 4-page PDF, 5 s MP4) to usable previews. The processing runs in a separate worker or script, outside the tldraw sync process. This is not the production worker.

Prototype and probes (copied into the repo, runnable): `docs/research/file-previews/`

| File | Purpose |
|---|---|
| `prototype.mjs` | Generates fixtures, makes derivatives, runs negative cases, prints the manifest JSON |
| `sharp-probes.mjs`, `pdf-probes.mjs` | Library behaviour probes (limits, fonts, clamps, passwords) |
| `playback-probe.mjs`, `client-pdf-probe.mjs` | Browser checks: `<video>` playback and client-side PDF.js, run in the locally installed Chrome/Edge through `playwright-core` |
| `mp4-boxes.mjs` | Scans top-level MP4 boxes to detect faststart and truncation |
| `worker-snippets/pdf-render.ts` | Typed PDF renderer (type-checks, and runs under Node 24 type stripping) |
| `file-card/*` | Shared file-card shape schema, ShapeUtil and a runtime schema test (tldraw 5.4.2) |

```sh
cd docs/research/file-previews
pnpm install                 # pnpm 10.34.5; sharp/@napi-rs/canvas have no install scripts
pnpm -s start > manifest.json   # fixtures + derivatives + negative cases (~5.5 s here)
pnpm run probe:sharp; pnpm run probe:pdf; pnpm run probe:playback; pnpm run probe:client-pdf
pnpm run typecheck:file-card; pnpm run typecheck:worker; pnpm run test:file-card
```
Requirements: Node >= 22.13 (tested 24.19.0). `ffmpeg` and `ffprobe` must be on PATH, or set `FFMPEG_PATH` / `FFPROBE_PATH`. The two browser probes also need Chrome or Edge installed.

---

## 0. Decisions for milestone 0 (TL;DR)

1. **Images:** sharp 0.35.4 runs inside the worker process. Pass `limitInputPixels: 100_000_000` and `failOn: 'warning'`, and allowlist the libvips loaders with `sharp.block` / `sharp.unblock`. Outputs are `thumb-512.webp` and `display-2048.webp`, auto-oriented. EXIF is stripped by default (verified).
2. **PDF:** rasterize **in the worker** with pdfjs-dist 6.3.289 (the `legacy` build) and @napi-rs/canvas 1.0.9. Run it in a **child process** with a SIGKILL timeout and a per-page pixel clamp. Render the cover (page 1) eagerly and other pages lazily, one job per page. Client-side PDF.js also works (verified in Chrome) and can be the deep "page viewer" later. The canvas card uses worker PNG/WebP pages.
3. **Video:** the system `ffprobe` validates, with a forced `-f mov` demuxer and `-protocol_whitelist file`. The allowlist is H.264 (Baseline/Main/High, yuv420p) plus AAC. A poster frame comes from `ffmpeg … -frames:v 1 → PNG on stdout → sharp → WebP`. Playback uses a plain `<video>`; H.264/AAC played in Chrome 153 and Edge 154 (verified).
4. **Linux/Render:** install ffmpeg with `apt` in a `node:24.19.0-trixie-slim` image (Debian 13 ships ffmpeg 7.1.5). Do **not** use `ffmpeg-static`: it bundles an old ffmpeg 6.1.1, has no ffprobe, is GPL-3.0, and pnpm 10 skips its download script (verified).
5. **Canvas:** the file-card shape stores only stable app IDs and immutable facts, plus denormalized display hints. It never stores URLs or base64. The schema below is type-checked and runtime-validated against tldraw 5.4.2 and rejects signed URLs or `data:` URLs.

---

## 1. Versions and environment (verified)

| Item | Version | License | Evidence |
|---|---|---|---|
| Node | 24.19.0 (win32-x64) | — | `node -v` |
| sharp | **0.35.4** (libvips 8.18.6) | Apache-2.0; `@img/sharp-win32-x64` = "Apache-2.0 AND LGPL-3.0-or-later"; `@img/sharp-libvips-linux-x64@1.3.3` = LGPL-3.0-or-later | `npm view`, `sharp.versions` |
| pdfjs-dist | **6.3.289** (engines `node >=22.13.0 \|\| >=24`) | Apache-2.0 (bundles Foxit/Liberation fonts, OpenJPEG/JBIG2/QCMS wasm with their own LICENSE files) | `node_modules/pdfjs-dist/package.json`, `standard_fonts/LICENSE_*`, `wasm/LICENSE_*` |
| @napi-rs/canvas | **1.0.9** (pdfjs-dist optionalDependency `^1.0.0`) | MIT | `npm view` |
| pdf-lib | 1.17.1 (fixtures) | MIT | `npm view` |
| @cantoo/pdf-lib | 2.11.1 (encrypted fixture only, dev) | MIT | `npm view` |
| ffmpeg / ffprobe (Windows dev) | 9.0.1 full_build (gyan.dev, winget `Gyan.FFmpeg`) | GPLv3 (`ffmpeg -L`) | `ffmpeg -version`, `ffmpeg -L` |
| playwright-core | 1.63.0 (dev; no browser download) | Apache-2.0 | `npm view` |
| file-type | 22.1.1 (magic-byte sniffing, dev probe) | MIT | `npm view` |
| tldraw / @tldraw/tlschema / @tldraw/validate | 5.4.2 | tldraw license (commercial for production) | `npm pack` + tsc |
| typescript | 7.0.2 | Apache-2.0 | `npx tsc -v` |
| Chrome / Edge (installed) | 153.0.8010.53 / 154.0.4258.37 | — | `browser.version()` |

Machine: AMD Ryzen Threadripper 9970X (32 cores / 64 threads), 255 GB RAM, Windows 11 Pro 10.0.26200. **The timings below come from a very fast workstation. A Render worker with 1–2 vCPUs will be several times slower (UNVERIFIED).**

Platform prebuilts (verified with `npm view`):
- `@img/sharp-linux-x64@0.35.4`: `os: linux`, `cpu: x64`, `libc: glibc`, `config.glibc: ">=2.28"`. The win32-x64 prebuilt is installed and works here.
- `@napi-rs/canvas-linux-x64-gnu@1.0.9` (glibc) and `-win32-x64-msvc@1.0.9` exist. The linux tarball contains only `skia.linux-x64-gnu.node`; the Windows one also ships `icudtl.dat` (see the gotcha in §4.6).
- pnpm 10.34.5 writes every platform's optional package into `pnpm-lock.yaml` (`@img/sharp-linux-x64`, `@napi-rs/canvas-linux-x64-gnu` are present in a lockfile generated on Windows) and installs only the matching one. A Linux `pnpm install --frozen-lockfile` therefore gets the Linux binaries. Lockfile content was verified; the Linux install itself is **UNVERIFIED**.
- sharp 0.35.4 has **no** `install` lifecycle script, so pnpm 10's build-script blocking does not affect it (verified: no "Ignored build scripts" warning).

---

## 2. Fixtures (non-sensitive, generated locally, reproducible)

`prototype.mjs` → `generateFixtures()` writes `fixtures/`. Two runs (npm layout, then a clean pnpm install) produced **byte-identical** files on this toolchain, except `encrypted.pdf`, which uses random salts. Different ffmpeg or x264 builds (for example Debian's) will produce different bytes. **Tests must assert on probed properties, not hashes.**

| Fixture | Bytes | sha256 (prefix) | How |
|---|---|---|---|
| `image.png` 1920x1080 | 215,676 | `c5681dac3ad18b01` | ffmpeg `testsrc2`, frame 0 |
| `image-exif6.jpg` 1920x1080, EXIF Orientation=6 | 88,368 | `2983633445b1d936` | sharp `.jpeg({quality:85}).withMetadata({orientation:6})` |
| `document.pdf` 4 pages, "Page N of 4" | 2,274 | `2cd7b513b08a55e7` | pdf-lib, `PDFDocument.create({ updateMetadata: false })` |
| `video.mp4` 5 s, 1280x720@30, H.264 High/yuv420p + AAC-LC 48 kHz stereo, faststart | 1,879,365 | `12c58a82bce6cd22` | ffmpeg lavfi `testsrc2` + `sine` |
| Negative: `bomb-30000x30000.png` (167 B), `bomb-12000x12000.png` (115 B), `vector.svg`, `encrypted.pdf` (user password), `garbage.pdf`, `empty.pdf`, `truncated.pdf` (60%), `truncated.mp4` (30%), `playlist-disguised.mp4` (HLS text), `video-hevc.mp4` (HEVC/hvc1) | | | see `generateFixtures()` |

Exact commands (verified with ffmpeg 9.0.1):

```sh
# image
ffmpeg -nostdin -hide_banner -v error -y -f lavfi -i testsrc2=size=1920x1080:rate=1 -frames:v 1 \
  -fflags +bitexact -flags +bitexact fixtures/image.png

# 5 s H.264/AAC MP4
ffmpeg -nostdin -hide_banner -v error -y \
  -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 5 -map 0:v -map 1:a \
  -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -g 30 \
  -c:a aac -b:a 128k -ac 2 -movflags +faststart -map_metadata -1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact fixtures/video.mp4
```

PDF with visible page numbers (verified, pdf-lib 1.17.1):

```js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
const doc = await PDFDocument.create({ updateMetadata: false }); // no Producer/CreationDate -> reproducible
const bold = await doc.embedFont(StandardFonts.HelveticaBold);   // standard-14 font, NOT embedded
for (let i = 1; i <= 4; i++) {
  const page = doc.addPage([612, 792]);
  const label = `Page ${i} of 4`;
  page.drawText(label, { x: (612 - bold.widthOfTextAtSize(label, 72)) / 2, y: 360, size: 72, font: bold, color: rgb(0.1, 0.1, 0.1) });
}
const bytes = await doc.save();
```

Encrypted fixture (verified, @cantoo/pdf-lib 2.11.1; the default is AES-256, V5/R6):
`doc.encrypt({ userPassword: 'fixture-user-pw', ownerPassword: 'fixture-owner-pw' })`.
Decompression-bomb PNG: `craftBombPng(w, h)` writes a valid IHDR that claims `w x h`, one deflated scanline, and IEND, using `zlib.crc32` (Node >= 22.2). The file is tiny and cannot actually decode.

---

## 3. Image derivatives — sharp 0.35.4

### 3.1 Verified API facts

- **ESM exposes only a default export at runtime.** `dist/index.d.mts` *declares* named exports (`export function block`, `export const versions`, …), but `import { versions } from 'sharp'` throws `SyntaxError: The requested module 'sharp' does not provide an export named 'versions'`. Use `import sharp from 'sharp'` and then `sharp.versions`, `sharp.block(...)`. TypeScript will **not** catch this.
- `SharpOptions` (from `dist/index.d.mts`):
  `limitInputPixels?: number | boolean` (default `268402689` = 0x3FFF²), `failOn?: 'none' | 'truncated' | 'error' | 'warning'` (default `'warning'`, recommended for untrusted input), `limitInputChannels`, `unlimited?: boolean` (default false; keep it off), `autoOrient?: boolean`, `animated?: boolean`, `pages`, `page`, `sequentialRead`.
- `resize(options: ResizeOptions)` with `fit: 'inside'` and `withoutEnlargement: true`; `webp(options?: WebpOptions)`; `timeout(options: { seconds: number })`; `toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>`.
- `metadata()` reads the header only, and **it also enforces `limitInputPixels`**. With default options, a 900 MP header throws `Input image exceeds pixel limit` in 2 ms.
- `Metadata` has `width`/`height` (EXIF orientation ignored), `autoOrient: { width, height }` (orientation applied), `orientation`, `pages`, `format`.
- `sharp.block({ operation: string[] })` and `sharp.unblock(...)` exist (since 0.32.4). They are **process-global**.
- The prebuilt libvips has **no PDF loader** (`sharp.format.pdf.input.buffer === false`) and HEIF input only for `.avif`. sharp cannot rasterize PDFs or decode HEIC here.
- sharp **will rasterize SVG by default** (librsvg). `vector.svg` became a 64x64 PNG before `block()` was applied. That is why the worker allowlists loaders.
- Output WebP carries **no EXIF** (`derivativeHasExif: false`), which strips GPS and camera metadata.

### 3.2 Loader allowlist (verified names in libvips 8.18.6)

Loader class names found in the win32 `libvips-42.dll` (by string extraction): `VipsForeignLoadJpeg{File,Buffer,Source}`, `…Png{File,Buffer,Source}`, `…Webp{File,Buffer,Source}`, `…Nsgif{File,Buffer,Source}`, `…Heif{File,Buffer,Source}`, `…Tiff{File,Buffer,Source}`, `…Svg{File,Buffer,Source}`, `…Uhdr{File,Buffer,Source}`, `…Vips{File,Source}`, `…Matrix{File,Source}`, `…Csv{File,Source}`, plus base names `…Jp2k`, `…Openslide`, `…Pdf`, `…Raw`.
**GIF is `Nsgif`, not `Gif`.** Unblocking `VipsForeignLoadGifBuffer` does nothing; `VipsForeignLoadNsgifBuffer` works.

```js
import sharp from 'sharp';
sharp.block({ operation: ['VipsForeignLoad'] });            // block every loader…
sharp.unblock({ operation: [                                // …then allow only what M0 accepts
  'VipsForeignLoadJpegFile', 'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadPngFile',  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadWebpFile', 'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadNsgifFile','VipsForeignLoadNsgifBuffer',
] });
sharp.concurrency(2);   // default here was 64 (= cores); bound per-image threads in the worker
sharp.cache(false);
```
After this, SVG and PDF fail with `Input buffer contains unsupported image format` (or `Input file …` for a path). PNG, JPEG, WebP and animated GIF still load (verified).
**UNVERIFIED:** whether Ultra HDR (gain-map) JPEGs from phones route to `VipsForeignLoadUhdr*` and are refused under this allowlist. Test with a real phone photo before launch, and unblock `VipsForeignLoadUhdr{File,Buffer}` if needed.

### 3.3 Derivative code (verified in `prototype.mjs` → `processImage`)

```js
const opts = { limitInputPixels: 100_000_000, failOn: 'warning', animated: false };
const meta = await sharp(input, opts).metadata();                // header only; enforces pixel limit
if (!['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) throw new Error('format not allowed');
const { data, info } = await sharp(input, { ...opts, autoOrient: true })
  .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 80 })
  .timeout({ seconds: 20 })
  .toBuffer({ resolveWithObject: true });                      // info.width/height/size
```

### 3.4 Results (verified)

| Input | Probe | thumb-512.webp | display-2048.webp | Total |
|---|---|---|---|---|
| image.png | png 1920x1080 | 512x288, 6,262 B, 19 ms | 1920x1080, 55,238 B, 67 ms | 88–94 ms |
| image-exif6.jpg | jpeg 1920x1080, orientation 6 → display 1080x1920 | **288x512** (rotated), 6,484 B, 18 ms | 1080x1920, 55,274 B, 65 ms | 83–92 ms |
| 24 MP JPEG (6000x4000, synthetic) | — | 13 ms (JPEG shrink-on-load) | 124–133 ms | probe process max RSS 370 MB |
| bomb-30000x30000.png | — | rejected `Input image exceeds pixel limit` in 1 ms | | |
| bomb-12000x12000.png (144 MP) | **passes the sharp default limit** and reaches decode (it only fails because the crafted data is truncated: `vipspng: libpng read error`) | with `limitInputPixels: 100e6`: rejected in 1 ms | | |

Conclusion: always pass an explicit `limitInputPixels`. The default (268 MP) admits a ~0.8–1 GB decode.

---

## 4. PDF previews

### 4.1 Option comparison

| | (a) Worker-side raster (pdfjs-dist legacy + @napi-rs/canvas) | (b) Client-side PDF.js viewer |
|---|---|---|
| Verified here | Yes: page 1..N of the fixture to PNG; lazy single page; 100-page doc; encrypted/malformed errors | Yes: Chrome 153 rendered page 2 of `document.pdf` to a canvas (918x1188 at scale 1.5, 161 ms including module import); `getDocument({url})` + `GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs'` |
| What the browser downloads | Small WebP/PNG per visible page | The **original** PDF (signed URL; range requests for large files) + ~1 MB+ of pdf.js worker |
| Untrusted parsing happens | Isolated worker child process with limits | Every viewer's browser (pdf.js is built for this, but keep it updated; see CVE note) |
| Canvas performance | Cheap `<img>` per card, cacheable | Heavy if many PDFs are visible on a board |
| Best for | File-card cover, page strip, "extract page to canvas" (use page image as an image shape) | Later: full-fidelity page viewer modal with text selection and search |

**Recommendation for M0:** use (a) for the canvas card and page thumbnails. Keep (b) as the later full viewer, opened on demand in a modal and not rendered on the canvas.

### 4.2 Verified pdfjs-dist 6.3.289 API facts (`types/src/display/api.d.ts`, `legacy/build/pdf.mjs`)

- Import: `import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs'`. `legacy/build/pdf.d.mts` is `export * from "pdfjs-dist"`.
- `getDocument(src?: DocumentInitParameters): PDFDocumentLoadingTask` is **synchronous**. It throws immediately for bad `data`. A Node **`Buffer` is rejected**: `Please provide binary data as \`Uint8Array\`, rather than \`Buffer\`.` Use `new Uint8Array(await readFile(p))`.
- `DocumentInitParameters` includes `data`, `password`, `standardFontDataUrl`, `cMapUrl`, `cMapPacked`, `wasmUrl`, `iccUrl`, `useSystemFonts` (Node default false), `disableFontFace` (Node default true), `maxImageSize` (total pixels; default -1 = unlimited), `stopAtErrors` (default false), `enableXfa` (default false), `isOffscreenCanvasSupported`/`isImageDecoderSupported` (Node default false), `canvasMaxAreaInBytes`, `CanvasFactory`, `verbosity`.
- **`isEvalSupported` no longer exists** in 6.x. There is no `new Function`/eval in `pdf.mjs` or `pdf.worker.mjs` (grep). The 2024 font-eval RCE (CVE-2024-4367, fixed in 4.2.67) required that code path.
- **Factory URLs in Node are plain filesystem path strings and MUST end with `/`.** Otherwise it throws `Invalid factory url: "…" must include trailing slash.` Data is read with `fs.readFile(baseUrl + filename)`, so on Windows normalize to forward slashes.
- In Node the worker is disabled (`PDFWorker.#isWorkerDisabled = true`). Parsing runs as a "fake worker" **on the calling thread**. That is one reason to run it in a child process.
- `NodeCanvasFactory._createCanvas` does `createRequire(import.meta.url)("@napi-rs/canvas").createCanvas(w, h)`, so `@napi-rs/canvas` must resolve **from pdfjs-dist's own location**. It does under pnpm, via the optional dependency in `.pnpm/pdfjs-dist@6.3.289/node_modules/@napi-rs/canvas` (verified). It also polyfills `DOMMatrix`/`Path2D` from @napi-rs/canvas.
- `PDFDocumentProxy`: `numPages`, `getPage(n)`, `getPageLabels(): Promise<string[] | null>`, `canvasFactory` (typed `Object`), `cleanup()`, `getPermissions()`, `extractPages(...)`. **There is no `destroy()` on the document in 6.x** (`doc.destroy is not a function`, verified). Call `loadingTask.destroy()` instead.
- `RenderParameters.canvas: HTMLCanvasElement | null` is required in the type. `canvasContext` is kept "for backwards compatibility". Both forms work at runtime in Node (verified). In TypeScript the Node canvas needs `cc.canvas as unknown as HTMLCanvasElement`; without the cast, tsc reports TS2740 (verified).
- Errors: `PasswordException` (`code` 1 = `PasswordResponses.NEED_PASSWORD`, 2 = `INCORRECT_PASSWORD`), `InvalidPDFException`, `ResponseException`. If `loadingTask.onPassword` is not set, a password request **rejects** the promise and does not hang (source: `if (!loadingTask.onPassword) throw wrapReason(ex)`, verified at runtime).

### 4.3 Worker-side renderer (verified: type-checks and runs; `worker-snippets/pdf-render.ts`)

```ts
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas'
import { getDocument, VerbosityLevel, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.dirname(require.resolve('pdfjs-dist/package.json')).split(path.sep).join('/')
type NodeCanvasFactory = { create(w: number, h: number): { canvas: Canvas; context: SKRSContext2D }; destroy(cc: unknown): void }

const loadingTask = getDocument({
  data: bytes,                                   // Uint8Array
  standardFontDataUrl: `${ROOT}/standard_fonts/`, cMapUrl: `${ROOT}/cmaps/`,
  wasmUrl: `${ROOT}/wasm/`, iccUrl: `${ROOT}/iccs/`,
  useSystemFonts: false, enableXfa: false, maxImageSize: 100_000_000, verbosity: VerbosityLevel.ERRORS,
})
const doc: PDFDocumentProxy = await loadingTask.promise
const page = await doc.getPage(n)
const base = page.getViewport({ scale: 1 })                  // points (1/72 in), rotation applied
let scale = targetWidth / base.width
const px = base.width * base.height * scale * scale
if (px > 4096 * 4096) scale *= Math.sqrt((4096 * 4096) / px) // canvas pixel clamp
const viewport = page.getViewport({ scale })
const cf = doc.canvasFactory as NodeCanvasFactory
const cc = cf.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
await page.render({ canvas: cc.canvas as unknown as HTMLCanvasElement, viewport }).promise // white bg default
const png = cc.canvas.toBuffer('image/png')                  // or await cc.canvas.encode('webp', 80)
cf.destroy(cc); page.cleanup(); await loadingTask.destroy()
```

@napi-rs/canvas 1.0.9 `Canvas` encoders (from `index.d.ts`): `toBuffer('image/png')`, `toBuffer('image/jpeg' | 'image/webp', quality?)`, `encode('png' | 'webp' | 'jpeg' | 'avif' | 'gif', …): Promise<Buffer>`.

### 4.4 Results (verified)

| Case | Result |
|---|---|
| `document.pdf`, all 4 pages @1024 px wide | 1024x1326 PNG, 43.7–46.4 KB each; page 1: 55–59 ms (loads fonts), pages 2–4: 29–30 ms. Child total 371–404 ms, of which `import()` of pdf.js is 187–216 ms. Child max RSS 128–136 MB, V8 heap ~14–17 MB |
| Lazy: page 3 only @400 px | 400x518, 15.6 KB, 34–37 ms; child total 258–278 ms (mostly import + spawn) |
| 100-page generated PDF, all pages @1024 (in-process) | 4.17 s total, 42 ms/page average, max RSS 219 MB; cover only: 90 ms |
| 14400x14400 pt page, clamped to 4096x4096 | 317 ms, max RSS 198 MB |
| Same page **unclamped** (14400x14400 px, 207 MP) | 3,778 ms, **max RSS 926 MB**. The clamp is mandatory. `--max-old-space-size` does not cover canvas memory, which is native |
| Page count | `doc.numPages` = 4; `getPageLabels()` = `null` (the fixture has no /PageLabels) |
| Visual check | Rendered PNGs show "Page N of 4" in Liberation Sans (the standard-font substitute) |

### 4.5 Failure handling (verified)

| Input | Outcome (`name`: `message`) | Suggested failure code |
|---|---|---|
| encrypted.pdf, no password | `PasswordException`: "No password given", `code: 1` | `pdf_encrypted` (card shows "Password-protected PDF: download only") |
| encrypted.pdf, wrong password | `PasswordException`: "Incorrect Password", `code: 2` | — (we never prompt in the worker) |
| Owner-password-only PDF (permissions only) | **Opens and renders normally** | ready |
| garbage.pdf (`%PDF-1.7` + junk) | `InvalidPDFException`: "Invalid PDF structure." | `pdf_malformed` |
| empty.pdf | `InvalidPDFException`: "The PDF file is empty, i.e. its size is zero bytes." | `pdf_malformed` |
| truncated.pdf (first 60%) | `InvalidPDFException`: "Invalid PDF structure." (with or without object streams; `Warning: Indexing all PDF objects` is logged first) | `pdf_malformed` |
| Pages > `maxPages` (500) / page > 14400 pt | Our own `LimitError` (thrown after `numPages` / `getViewport`) | `pdf_too_large` |
| Child exceeds `childTimeoutMs` | SIGKILL through `spawn({ timeout, killSignal: 'SIGKILL' })`; mechanism verified on ffmpeg (killed at 1,518 ms for a 1,500 ms limit) | `timeout` |

### 4.6 Gotchas found (verified)

1. **Missing `standardFontDataUrl` in Node gives wrong text, silently.** pdf.js logs `Warning: UnknownErrorException: Ensure that the \`standardFontDataUrl\` API parameter is provided.` and falls back to canvas `fillText`. On this Windows machine that rendered the page in a *script/handwriting* system font. Always pass it.
2. **Native crash in that fallback path.** With a pnpm install whose native module path is longer than 260 characters (285 here), `@napi-rs/canvas` 1.0.9 on Windows aborted on the first `fillText`: `SkIcuLoader: datafile missing: \\?\…\node_modules\@napi-rs\icudtl.dat` followed by `[skia] ** ERROR ** …ParagraphBuilderImpl.cpp(182): fatal error: "check(fUnicode)"`, exit code 132 (SIGILL). Skia looked for `icudtl.dat` one directory too high. It did **not** reproduce with pnpm at a 257-character path or npm at 279 characters. The Linux package ships no `icudtl.dat`, so Linux is probably unaffected (**UNVERIFIED**). Takeaways: keep the repo at a short path on Windows, always pass `standardFontDataUrl`, and **keep pdf.js in a child process**, because a native abort must fail one job, not kill the worker.
3. Error `message`s from ffmpeg and pdf.js contain **absolute server paths**. Map them to error codes and never show raw stderr to users or store it in canvas/DB fields visible to clients.

### 4.7 Lazy page strategy (proposal)

- On `ready`: store `pageCount`, page sizes in points and `pageLabels`, and render the **cover** (page 1) as `cover-512.webp`, which becomes `posterDerivativeId`.
- Other pages: one job per `(versionId, 'pdf-page@1024w', page)`, created on demand when the viewer or strip requests a page (the idempotent unique key prevents duplicates). Cap rendering at page 200 (`maxPreviewPages`). Keep original page numbering (1-based `page` plus the optional label).
- One child process can render a *batch* of pages to amortize the ~200 ms import cost. Timeout per batch, not per page.

---

## 5. Video — ffprobe / ffmpeg / browser

### 5.1 Validation probe (verified)

```sh
ffprobe -v error -hide_banner \
  -protocol_whitelist file -f mov -enable_drefs 0 -use_absolute_path 0 \
  -show_format -show_streams -of json <input>
```
- `-f mov` forces the MP4/MOV demuxer, so a disguised HLS/concat/image2 input can never be auto-probed. `-protocol_whitelist file` forbids network protocols. `enable_drefs` and `use_absolute_path` already default to false in the 9.0.1 mov demuxer (`ffprobe -h demuxer=mov`); they are pinned for older builds.
- Relevant JSON fields for `fixtures/video.mp4`:
  `format.format_name` = `"mov,mp4,m4a,3gp,3g2,mj2"`, `format.duration` = `"5.000000"` (**string**), `format.size` = `"1879365"`, `format.tags.major_brand` = `"isom"`;
  video stream `codec_name` `"h264"`, `profile` `"High"`, `level` `31`, `pix_fmt` `"yuv420p"`, `width` 1280, `height` 720, `avg_frame_rate` `"30/1"`, `codec_tag_string` `"avc1"`;
  audio stream `codec_name` `"aac"`, `profile` `"LC"`, `sample_rate` `"48000"` (string), `channels` 2.
- M0 "playable" rule (`validateProbe` in the prototype): container matches `/mp4|mov/` and `major_brand` is not `qt`; exactly 1 video stream (ignoring `disposition.attached_pic`); ≤ 1 audio stream; video `h264` with profile in {Constrained Baseline, Baseline, Main, High} and `pix_fmt` in {yuv420p, yuvj420p} (this excludes 10-bit and 4:4:4); audio `aac`; ≤ 3840x2160; 0 < duration ≤ 10 min. Anything else is `failed` with `unsupported_codec` (attachment card; proxy transcode is a later milestone).
- ffprobe took 53–56 ms here.

### 5.2 Poster frame (verified)

```sh
ffmpeg -nostdin -hide_banner -v error \
  -protocol_whitelist file -f mov -enable_drefs 0 -use_absolute_path 0 \
  -ss <min(1, duration/2)> -i <input> \
  -map 0:v:0 -an -sn -dn -frames:v 1 -vf "scale='min(1280,iw)':-2" \
  -f image2pipe -c:v png pipe:1          # PNG on stdout -> sharp(...).webp({quality:80})
```
Result: 1280x720 `poster.webp`, 27,102 B, 117–122 ms including sharp. The frame shows the testsrc2 timestamp `00:00:01.000`, so input-side `-ss` landed exactly. Cap captured stdout (the prototype uses 32 MB) and the process time (30 s).

### 5.3 Integrity: probe is not enough (verified)

`truncated.mp4` (the first 30% of a faststart file) **passes ffprobe (duration 5000 ms) and poster extraction**. Two cheap detectors:
- `mp4-boxes.mjs`: a top-level box scan that reads only headers. `truncated=true` when a box claims bytes past EOF (verified on the fixture). It also reports `faststart` (`moov` before `mdat`): `video.mp4` is true; a default ffmpeg encode and `video-hevc.mp4` are false.
- A full decode: `ffmpeg -nostdin -v error -xerror -f mov … -i in -f null -`. It fails on the truncated file (`corrupt input packet in stream 0`) and takes 90–98 ms for the 5 s 720p fixture. For long videos, bound it with a timeout; cost at 10 min 1080p is **UNVERIFIED**.
- Non-faststart files: remux without re-encoding, `ffmpeg -f mov -i in -map 0 -c copy -movflags +faststart out.mp4` (61 ms here; verified that it moves `moov` first). Serve the remux as the playback derivative.

### 5.4 Browser playback (verified with `playback-probe.mjs`)

Served over localhost with Range support, `<video muted preload=auto>`, then `play()` and a check after 1.2 s:

| Browser (headless via playwright-core `channel`) | `canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"')` | video.mp4 (H.264 High + AAC) | video-hevc.mp4 |
|---|---|---|---|
| Chrome 153.0.8010.53 | `probably` | playing, currentTime 1.16 s, 1280x720, 40 frames decoded | playing (Windows OS decoder) |
| Edge 154.0.4258.37 | `probably` | playing, same numbers | playing |

- HEVC playing here depends on the platform and hardware. It is not portable (for example Linux Chrome or Firefox), so HEVC stays **outside** the allowlist.
- **Playwright's bundled Chromium:** the Playwright docs (`docs/src/browsers.md`, "Media codecs") say Chromium builds lack some codecs that Chrome/Edge bundle for licensing reasons, and recommend `channel: 'chrome'` / `'msedge'` for codec tests. Not tested here, because no bundled browser was downloaded (**docs-only**). E2E video tests should use `channel: 'chrome'`.
- Firefox and Safari: **UNVERIFIED** here.
- On the canvas: `<video controls preload="metadata" poster={posterUrl} src={signedUrl}>`. The storage or proxy must support `Range`/`206`. Refresh the signed URL before expiry (plan §8).

### 5.5 ffmpeg distribution: Windows dev now, Linux Docker on Render later

| Option | ffmpeg version | ffprobe | License | Notes |
|---|---|---|---|---|
| **Debian `apt install ffmpeg` in `node:24.19.0-trixie-slim`** (recommended) | 7.1.5 (`7:7.1.5-0+deb13u1`, trixie) | included | GPL; exact variant **UNVERIFIED** (run `ffmpeg -L` in the image) | Security updates come through Debian. Trixie's glibc (2.41, **UNVERIFIED**) is above sharp's `>=2.28` requirement. `node:24-bookworm-slim` would give ffmpeg 5.1.9 |
| gyan.dev full_build (Windows dev, winget) | 9.0.1 | included | GPLv3 (`ffmpeg -L`) | What is installed here. Point `FFMPEG_PATH`/`FFPROBE_PATH` at it or keep it on PATH |
| `ffmpeg-static@5.3.0` (npm) | 6.1.1 (`binary-release-tag: b6.1.1`) | **not included** (the separate `ffprobe-static@3.1.0` dates from 2022) | GPL-3.0-or-later | Downloads from GitHub in a `postinstall`. **pnpm 10 skips it by default** (verified: "Ignored build scripts: ffmpeg-static@5.3.0", and `require('ffmpeg-static')` returns a path to a missing `ffmpeg.exe`) |

Docker sketch (**UNVERIFIED**: no Docker on this machine):
```dockerfile
FROM node:24.19.0-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* && ffmpeg -hide_banner -version | head -1
RUN npm i -g pnpm@10.34.5
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter ./apps/worker...
USER node
CMD ["node", "apps/worker/dist/main.js"]
```
GPL note (not legal advice): the worker runs ffmpeg as a separate executable on our own servers, which is not distribution. Obligations such as offering source apply if we *distribute* binaries, for example by shipping the Docker image to third parties. H.264/AAC patent licensing is a separate open question.

---

## 6. Attaching previews to the canvas

### 6.1 Principle

The canvas holds **stable IDs and immutable facts**. Postgres holds **status and derivatives**, and it is authoritative. Object storage holds **bytes**. The browser exchanges a derivative ID for a short-lived URL at render time. Canvas records never contain base64 or signed URLs (Cursor_Start_Here "Architecture rules"; build plan §8).

### 6.2 Application records (proposal; later these become Postgres tables `assets`, `asset_versions`, `asset_derivatives`)

```ts
type FileKind = 'image' | 'pdf' | 'video' | 'other'
type VersionStatus = 'queued' | 'processing' | 'ready' | 'failed'

interface AssetVersion {
  id: `ver_${string}`; assetId: `ast_${string}`; workspaceId: string
  storageKey: string            // originals/<workspace>/<ver_id> — server-only, never sent to clients
  originalName: string; declaredMimeType: string | null
  sniffedMimeType: string       // magic bytes (file-type) + decoder probe; never trust the browser
  sizeBytes: number; sha256: string
  kind: FileKind; status: VersionStatus
  failure: null | { code: 'too_large' | 'too_many_pixels' | 'too_many_pages' | 'too_long' | 'pdf_encrypted'
                          | 'pdf_malformed' | 'unsupported_format' | 'unsupported_codec' | 'truncated' | 'timeout' | 'internal' }
  probe: null | { width: number; height: number; orientation: number | null }                  // image
             | { pageCount: number; pages: { widthPt: number; heightPt: number }[]; pageLabels: string[] | null } // pdf
             | { durationMs: number; width: number; height: number; videoCodec: string; audioCodec: string | null; faststart: boolean } // video
  processorVersion: string      // e.g. 'm0-2026-09-26' — bump to re-derive
}

interface Derivative {
  id: `drv_${string}`; versionId: AssetVersion['id']
  profile: 'thumb-512.webp' | 'display-2048.webp' | 'pdf-cover-512.webp' | 'pdf-page@1024w.png' | 'poster.webp' | 'probe.json' | 'playback.mp4'
  page: number | null            // pdf pages, 1-based
  mimeType: string; width: number | null; height: number | null; bytes: number
  storageKey: string             // derivatives/<ver_id>/<profile>[-p0003]
}
// UNIQUE (versionId, profile, page): the idempotency key for jobs and completion callbacks
```
`file-type@22.1.1` sniffing results (verified): PNG, JPEG, PDF and MP4 are detected; `empty.pdf`, `vector.svg` and the disguised playlist return `null`. `garbage.pdf`, `truncated.pdf`, the bombs and `truncated.mp4` **still sniff as valid**, so sniffing is only the first gate. The decoders in §3–5 are the real validation.

### 6.3 file-card shape (verified: tsc 7.0.2 against tldraw 5.4.2, plus a runtime validation/migration test)

`file-card/file-card.schema.ts` imports only `@tldraw/tlschema` and `@tldraw/validate`, so it can be shared by the sync server and the client:

```ts
import { createShapePropsMigrationIds, createShapePropsMigrationSequence, createTLSchema,
         defaultShapeSchemas, type RecordProps, type TLShape } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const FILE_CARD_TYPE = 'file-card' as const
const appId = (prefix: string) => T.string.check((v) => {
  if (!new RegExp(`^${prefix}_[0-9A-Za-z]{10,40}$`).test(v)) throw new Error(`expected ${prefix}_… id`)
})

export interface FileCardShapeProps {
  w: number; h: number
  assetId: string; versionId: string                     // app IDs (not TLAssetId), never URLs
  kind: 'image' | 'pdf' | 'video' | 'other'
  name: string; mimeType: string; sizeBytes: number
  status: 'queued' | 'processing' | 'ready' | 'failed'   // denormalised hint; Postgres is authoritative
  pageCount: number | null; durationMs: number | null
  posterDerivativeId: string | null                      // drv_…
}
declare module '@tldraw/tlschema' {
  export interface TLGlobalShapePropsMap { [FILE_CARD_TYPE]: FileCardShapeProps }
}
export type FileCardShape = TLShape<typeof FILE_CARD_TYPE>

export const fileCardShapeProps: RecordProps<FileCardShape> = {
  w: T.positiveNumber, h: T.positiveNumber,
  assetId: appId('ast'), versionId: appId('ver'),
  kind: T.literalEnum('image', 'pdf', 'video', 'other'),
  name: T.string, mimeType: T.string, sizeBytes: T.positiveInteger,
  status: T.literalEnum('queued', 'processing', 'ready', 'failed'),
  pageCount: T.nullable(T.positiveInteger), durationMs: T.nullable(T.positiveInteger),
  posterDerivativeId: T.nullable(appId('drv')),
}
export const fileCardVersions = createShapePropsMigrationIds(FILE_CARD_TYPE, { AddPosterDerivativeId: 1 })
export const fileCardShapeMigrations = createShapePropsMigrationSequence({ sequence: [{
  id: fileCardVersions.AddPosterDerivativeId,         // 'com.tldraw.shape.file-card/1'
  up: (props: any) => { props.posterDerivativeId = null },
  down: (props: any) => { delete props.posterDerivativeId },
}] })
export const draftroomSchema = createTLSchema({ shapes: {
  ...defaultShapeSchemas, [FILE_CARD_TYPE]: { props: fileCardShapeProps, migrations: fileCardShapeMigrations },
} })
```
Verified details:
- Augmenting `'@tldraw/tlschema'` also makes `TLShape<'file-card'>` resolve when imported from `'tldraw'`. The tldraw examples augment `'tldraw'` instead (`apps/examples/.../sync-custom-shape/CounterShape.tsx` at v5.4.2); for shared server code, augment `@tldraw/tlschema`. A deliberate `kind: 'docx'` fails tsc with TS2322.
- In tldraw 5.4.2, `ShapeUtil.getIndicatorPath(shape): TLIndicatorPath | undefined` is **abstract**; `indicator()` is a legacy stub. The client util (`file-card/FileCardShapeUtil.tsx`) extends `BaseBoxShapeUtil`, sets `static override props/migrations` from the shared module, and implements `getDefaultProps`, `component` and `getIndicatorPath`.
- Runtime (`schema-runtime.test.ts`, run with Node 24 type stripping, server-style with no React import): valid record → accepted; `posterDerivativeId: 'https://…?X-Amz-Signature=…'` → rejected `expected drv_… id`; `assetId: 'data:application/pdf;base64,…'` → rejected; `status: 'done'` → rejected; an extra `url` prop → rejected `Unexpected property`; `migratePersistedRecord(v0Record, persistedSchema, 'up')` → `success`, `posterDerivativeId: null`; current sequence version is 1.
- A first test that imported `createTLStore` from `'tldraw'` in plain Node did not exit within 120 s (cause not investigated). The server-style test that imports only `@tldraw/tlschema` exits normally. Server code should import `@tldraw/tlschema`/`@tldraw/sync-core`, not `tldraw`.

### 6.4 Who updates `status` / `pageCount` / `posterDerivativeId`?

The worker **never** touches the room. Options:
1. **M0 (simplest):** the client shows state from `GET /api/versions/:id` (poll or SSE). The uploading client patches the shape's hint props once, with `editor.updateShape`, when the version turns `ready`. The write is idempotent; several clients writing the same values is harmless. Viewers render from the API state when the hint is stale.
2. **Later:** the API calls an internal endpoint on the collaboration service, which patches matching file-card shapes in a room transaction. In `@tldraw/sync-core` 5.4.2, `TLSocketRoom.updateStore(updater)` is marked `@deprecated use the storage.transaction method instead`; `room.storage.transaction(txn => …)` is **synchronous only** (the callback type rejects Promises), and `txn` offers `get/set/delete/values()` from `SynchronousStorage` in `@tldraw/store`. Only the room owner writes (plan §7).
- Rendering never uses a URL stored in the record. `useDerivativeUrl(posterDerivativeId)` calls the API, which re-checks board/workspace access and returns a short-lived URL. For native tldraw image/video shapes (an alternative for plain images), `TLAssetStore.resolve?(asset: TLAsset, ctx: TLAssetContext): null | Promise<null | string> | string` (verified in `@tldraw/tlschema` 5.4.2) is the equivalent hook. Keep `asset.props.src` a stable, non-secret app reference and sign it inside `resolve`. tldraw 5.4.2 also exports an `AssetUtil` base class for custom asset types; M0 does not need it.

---

## 7. Security limits to encode (M0 values; tune after measuring on the Render instance)

| Limit | Value | Enforced by | Verified? |
|---|---|---|---|
| Max bytes | image 25 MB, PDF 100 MB, video 500 MB (build plan §8) | API reservation + worker `stat` before processing | worker check verified in prototype |
| Image pixels | 100 MP (`limitInputPixels: 100_000_000`) | sharp constructor, also applied to `metadata()` | yes: 144 MP and 900 MP headers rejected in 1 ms |
| Image formats | jpeg, png, webp, gif via the loader allowlist (§3.2); SVG/PDF/TIFF/HEIF/matrix/csv/raw/vips blocked | `sharp.block/unblock` | yes |
| sharp time | `.timeout({ seconds: 20 })` | sharp | API verified (not triggered) |
| PDF pages | reject > 500; render ≤ page 200 | worker child after `numPages` | logic verified |
| PDF page size | reject > 14,400 pt per side; canvas ≤ 4096² px | viewport clamp | yes (926 MB → 198 MB RSS) |
| PDF embedded images | `maxImageSize: 100_000_000` | pdf.js | parameter exists; effect **UNVERIFIED** |
| PDF isolation | child process, `--max-old-space-size=512` (V8 heap only), whole-run timeout 60 s, SIGKILL | `spawn(..., { timeout, killSignal: 'SIGKILL' })` | yes (kill verified on Windows) |
| PDF scripting/forms | `enableXfa: false`; 6.x has no eval/`new Function` path (source grep). Document JavaScript is only run by the viewer's scripting sandbox (`pdf.sandbox.mjs`), which the worker never loads | pdf.js | eval: source-verified; sandbox claim: docs/source-level, not exercised with a JS-bearing PDF |
| Video duration / size | ≤ 10 min, ≤ 3840x2160 | `validateProbe` | logic verified |
| Video codecs | h264 (Baseline/Main/High, yuv420p) + aac | `validateProbe` | yes (HEVC rejected) |
| ffmpeg/ffprobe input | `-nostdin -protocol_whitelist file -f mov -enable_drefs 0 -use_absolute_path 0` | CLI args | yes: disguised playlist rejected. ffmpeg 9 also refuses HLS for non-`.m3u8` names ("Not detecting m3u8/hls with non standard extension"); with a `.m3u8` name and no `-f`, HLS is detected and then blocked ("Protocol 'http' not on whitelist 'file'!") |
| ffmpeg time/output | probe 15 s, poster 30 s, stdout cap 1 MB (probe) / 32 MB (poster) | `run()` helper | timeout verified (1,518 ms kill for a 1,500 ms limit) |
| Processes | `spawn` with an argv array (never a shell); inputs saved under worker-chosen names (`<ver_id>.bin`), never user filenames; minimal child `env` (`{ PATH }`, no storage creds) | worker | yes: the prototype's `run()` passes only `{ PATH, SYSTEMROOT }` (SYSTEMROOT is needed on Windows), and all fixtures and negative cases still pass |
| Archives | ZIP/AEP/PRPROJ/etc. become attachment cards only: never expanded, never executed | policy | — |
| SVG | never inlined into the app DOM, never rasterized in M0 (attachment card). Later: rasterize in an isolated process and serve only raster derivatives; originals download from the storage origin with `Content-Disposition: attachment` | policy + loader allowlist | sharp renders SVG if not blocked (verified) |
| Memory ceiling (Linux) | container memory limit; optionally `prlimit --as=…` around ffmpeg | Docker/Render | **UNVERIFIED** |
| Errors | map to `failure.code`; never expose stderr (it contains absolute paths) | worker | observed paths in messages |

---

## 8. Worker process model (M0 shape, outside the sync loop)

```
browser --upload--> (M0: local dir / later: R2)        sync server (tldraw room) — never imports sharp/pdfjs/ffmpeg
   |                                                        ^
   +-- POST /versions -> Postgres(asset_versions: queued)   | (later) internal "patch hint props" call
                              |                             |
                        queue / poll  ---> worker process ---+--> derivatives in storage + rows in asset_derivatives
                                              |-- sharp (in-process, loader allowlist)
                                              |-- node child: pdf.js + @napi-rs/canvas (timeout, heap cap, pixel clamp)
                                              |-- ffprobe / ffmpeg children (forced demuxer, whitelist, timeouts)
```
- Idempotency key `(versionId, profile, page)`. Jobs can be retried, and a duplicate completion is a no-op.
- State: `queued → processing → ready | failed(code)`. A crashed child gives `failed(internal)` or a retry. A native abort (exit 132) is contained.
- Milestone 0 can run this as a CLI (`node apps/worker/src/process.mjs <file>`). The prototype's `processImage`, `processPdf` and `processVideo` are the starting point.

---

## 9. UNVERIFIED / open items

- Everything on **Linux x64 / Docker / Render**: sharp and @napi-rs/canvas gnu prebuilts at runtime, Debian ffmpeg 7.1.5 behaviour (HLS extension check, `-enable_drefs`), the image size, the actual license string (`ffmpeg -L`), `prlimit`, performance on 1–2 vCPU instances.
- Playwright's **bundled Chromium** codec support (docs-only); Firefox and Safari playback.
- Ultra HDR JPEGs under the loader allowlist; HEIC (not supported by the sharp prebuilt).
- The effect of pdf.js `maxImageSize` on huge embedded images; memory and time for real-world image-heavy PDFs; fonts in non-Latin PDFs (the CMaps path is configured but untested).
- Full-decode-check cost for long 1080p/4K videos; whether to gate `ready` on it or rely on the box scan.
- Who writes denormalized status into canvas records in M1+ (§6.4 option 2) and how the collaboration service finds shapes by `versionId` (a scan of `txn.values()` versus a side index).
- Licensing: GPL obligations if the Docker image is ever distributed; H.264/AAC patent pools for proxy transcoding.

## 10. Sources

- pdfjs-dist 6.3.289 package: `types/src/display/api.d.ts` (DocumentInitParameters, RenderParameters, PDFDocumentProxy, PDFDocumentLoadingTask), `types/src/display/node_utils.d.ts`, `legacy/build/pdf.mjs` (lines around `getDocument` 21962, `getFactoryUrlProp` 15097, `NodeCanvasFactory` 16139, `PDFWorker` 22765, password flow 23195).
- Official Node example: https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs
- CVE-2024-4367: https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq , https://codeanlabs.com/2024/05/cve-2024-4367-arbitrary-js-execution-in-pdf-js/
- sharp 0.35.4 package: `dist/index.d.mts` (SharpOptions, Metadata, block/unblock, ResizeOptions), `dist/index.mjs` (default export only).
- @napi-rs/canvas 1.0.9 `index.d.ts` (Canvas.toBuffer / encode).
- tldraw 5.4.2 packages: `@tldraw/tlschema` `dist-esm/index.d.mts` (TLGlobalShapePropsMap, RecordProps, createShapePropsMigrationIds/Sequence, createTLSchema, TLAssetStore, TLAssetContext), `@tldraw/editor` (ShapeUtil.getIndicatorPath, AssetUtil), `@tldraw/sync-core` (TLSocketRoom.updateStore deprecated, TLSyncStorage.transaction), `@tldraw/store` (SynchronousRecordStorage). Example: https://github.com/tldraw/tldraw/blob/v5.4.2/apps/examples/src/examples/collaboration/sync-custom-shape/CounterShape.tsx
- Playwright browsers doc ("Media codecs"): https://github.com/microsoft/playwright/blob/main/docs/src/browsers.md
- Debian ffmpeg versions: https://sources.debian.org/api/src/ffmpeg/ (trixie 7:7.1.5-0+deb13u1, bookworm 7:5.1.9-0+deb12u1); Docker Hub `library/node` tags (24.19.0-trixie-slim exists).
- npm registry metadata (`npm view`) for every version and license in §1.
