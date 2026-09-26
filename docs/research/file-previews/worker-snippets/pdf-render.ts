// Typed (TS) version of the worker-side PDF page renderer. Type-checks against pdfjs-dist 6.3.289 +
// @napi-rs/canvas 1.0.9 and runs directly under Node 24 type stripping:
//   node worker-snippets/pdf-render.ts fixtures/document.pdf 2 800
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas'
import { getDocument, VerbosityLevel, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json')).split(path.sep).join('/')

// doc.canvasFactory is typed as `Object` in 6.3.289; this is the shape NodeCanvasFactory actually has.
type NodeCanvasAndContext = { canvas: Canvas; context: SKRSContext2D }
type NodeCanvasFactory = {
	create(width: number, height: number): NodeCanvasAndContext
	destroy(cc: NodeCanvasAndContext): void
}

export interface RenderedPage {
	page: number
	widthPt: number
	heightPt: number
	png: Buffer
	width: number
	height: number
}

export async function openPdf(bytes: Uint8Array, maxImagePixels = 100_000_000) {
	const loadingTask = getDocument({
		data: bytes, // must be a Uint8Array, NOT a Node Buffer (pdf.js throws on Buffer)
		standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`, // required in Node or text falls back to canvas fillText
		cMapUrl: `${PDFJS_ROOT}/cmaps/`,
		wasmUrl: `${PDFJS_ROOT}/wasm/`,
		iccUrl: `${PDFJS_ROOT}/iccs/`,
		useSystemFonts: false,
		enableXfa: false,
		maxImageSize: maxImagePixels,
		verbosity: VerbosityLevel.ERRORS,
	})
	const doc: PDFDocumentProxy = await loadingTask.promise // rejects: PasswordException / InvalidPDFException
	return { doc, destroy: () => loadingTask.destroy() } // PDFDocumentProxy has no destroy() in 6.x
}

export async function renderPage(doc: PDFDocumentProxy, pageNumber: number, targetWidth: number, maxPixels = 4096 * 4096): Promise<RenderedPage> {
	const page = await doc.getPage(pageNumber)
	try {
		const base = page.getViewport({ scale: 1 })
		let scale = targetWidth / base.width
		const px = base.width * base.height * scale * scale
		if (px > maxPixels) scale *= Math.sqrt(maxPixels / px)
		const viewport = page.getViewport({ scale })
		const cf = doc.canvasFactory as NodeCanvasFactory
		const cc = cf.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
		try {
			// RenderParameters.canvas is typed HTMLCanvasElement | null; the Node canvas needs a cast.
			await page.render({ canvas: cc.canvas as unknown as HTMLCanvasElement, viewport }).promise
			return { page: pageNumber, widthPt: base.width, heightPt: base.height, png: cc.canvas.toBuffer('image/png'), width: cc.canvas.width, height: cc.canvas.height }
		} finally {
			cf.destroy(cc)
		}
	} finally {
		page.cleanup()
	}
}

if (process.argv[1]?.endsWith('pdf-render.ts')) {
	const [file, pageArg = '1', widthArg = '1024'] = process.argv.slice(2)
	const { doc, destroy } = await openPdf(new Uint8Array(await readFile(file)))
	try {
		const r = await renderPage(doc, Number(pageArg), Number(widthArg))
		const out = `${path.basename(file)}.p${r.page}.ts-render.png`
		await writeFile(out, r.png)
		console.log(JSON.stringify({ numPages: doc.numPages, page: r.page, widthPt: r.widthPt, heightPt: r.heightPt, width: r.width, height: r.height, bytes: r.png.length, out }))
	} finally {
		await destroy()
	}
}
