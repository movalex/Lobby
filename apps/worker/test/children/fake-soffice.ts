// A stand-in for LibreOffice's `soffice` in tests and the e2e suite (no LibreOffice on the dev PC).
// It takes the same command line soffice gets from soffice.ts (`-env:UserInstallation=…`, `--infilter=…`,
// `--convert-to pdf --outdir DIR FILE`) and writes DIR/<name>.pdf: one page per page, slide or sheet of
// the document, carrying the document's own text, so a card shows real, distinct pages. It is NOT a
// converter: fidelity, fonts and layout are only ever checked with the real LibreOffice (deploy/nas).
//
// Test modes, given before the soffice arguments:
//   --fake-mode=hang       start a helper process, record both pids in DIR/fake-pids.json, never exit
//   --fake-mode=crash      exit 1 without output (LibreOffice crashed or refused)
//   --fake-mode=noop       exit 0 without output (what soffice does when it cannot load a file)
//   --fake-mode=garbage    write a "PDF" that is not one
//   --fake-mode=record     convert, and record argv, env and the profile's settings in DIR/fake-record.json
//   --fake-mode=pages=N    write an N-page PDF whatever the input
// and `--version` prints a version line, like soffice.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { readZipDirectory, readZipEntry } from '../../src/office-zip.ts'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  console.log('LibreOffice 0.0.0.0 fake-soffice (test stand-in)')
  process.exit(0)
}
const mode = argv.find((a) => a.startsWith('--fake-mode='))?.slice('--fake-mode='.length) ?? 'convert'
const outDir = argv[argv.indexOf('--outdir') + 1] ?? '.'
const input = argv[argv.length - 1] ?? ''
const output = join(outDir, `${basename(input, extname(input))}.pdf`)
const profileArg = argv.find((a) => a.startsWith('-env:UserInstallation='))

interface Page {
  title: string
  lines: string[]
}

const texts = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) =>
    (m[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  )

async function part(name: string): Promise<string | null> {
  const entries = await readZipDirectory(input, 10_000)
  const e = entries.find((x) => x.name === name)
  return e ? (await readZipEntry(input, e, 16 * 1024 * 1024)).toString('utf8') : null
}

async function parts(re: RegExp): Promise<string[]> {
  const entries = (await readZipDirectory(input, 10_000)).filter((e) => re.test(e.name))
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  return Promise.all(
    entries.map(async (e) => (await readZipEntry(input, e, 16 * 1024 * 1024)).toString('utf8')),
  )
}

const page = (all: string[]): Page => ({ title: all[0] ?? '', lines: all.slice(1) })

/** The document's pages as LibreOffice would lay them out, roughly: explicit breaks, slides, sheets. */
async function pagesOf(ext: string): Promise<{ pages: Page[]; landscape: boolean }> {
  switch (ext) {
    case 'docx': {
      const xml = (await part('word/document.xml')) ?? ''
      const out: string[][] = []
      for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
        if (p.includes('<w:pageBreakBefore/>') || !out.length) out.push([])
        out[out.length - 1]?.push(texts(p, 'w:t').join(''))
      }
      return { pages: out.map(page), landscape: false }
    }
    case 'odt': {
      const xml = (await part('content.xml')) ?? ''
      const out: string[][] = []
      for (const m of xml.matchAll(/<text:p(?: text:style-name="(\w+)")?>([^<]*)<\/text:p>/g)) {
        if (m[1] === 'HB' || !out.length) out.push([])
        out[out.length - 1]?.push(m[2] ?? '')
      }
      return { pages: out.map(page), landscape: false }
    }
    case 'pptx':
      return {
        pages: (await parts(/^ppt\/slides\/slide\d+\.xml$/)).map((x) => page(texts(x, 'a:t'))),
        landscape: true,
      }
    case 'odp': {
      const xml = (await part('content.xml')) ?? ''
      const slides = xml.split('<draw:page ').slice(1)
      return { pages: slides.map((s) => page(texts(s, 'text:p'))), landscape: true }
    }
    case 'xlsx': {
      const sheets = await parts(/^xl\/worksheets\/sheet\d+\.xml$/)
      return {
        pages: sheets.map((x) =>
          page([...x.matchAll(/<(?:t|v|f)>([^<]*)<\/(?:t|v|f)>/g)].map((m) => m[1] ?? '')),
        ),
        landscape: false,
      }
    }
    case 'ods': {
      const xml = (await part('content.xml')) ?? ''
      const tables = xml.split('<table:table ').slice(1)
      return { pages: tables.map((t) => page(texts(t, 'text:p'))), landscape: false }
    }
    default:
      return { pages: [], landscape: false }
  }
}

async function render(pages: Page[], landscape: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const [w, h] = landscape ? [960, 540] : [612, 792]
  const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '-').slice(0, 90)
  for (const [i, p] of pages.entries()) {
    const pg = doc.addPage([w, h])
    pg.drawRectangle({ x: 0, y: h - 96, width: w, height: 96, color: rgb(0.12, 0.23, 0.37) })
    pg.drawText(clean(p.title || `Page ${i + 1}`), {
      x: 40,
      y: h - 62,
      size: 26,
      font: bold,
      color: rgb(1, 1, 1),
    })
    p.lines.forEach((l, k) => {
      pg.drawText(clean(l), {
        x: 40,
        y: h - 140 - k * 26,
        size: 15,
        font: regular,
        color: rgb(0.12, 0.16, 0.22),
      })
    })
    pg.drawText(`page ${i + 1} of ${pages.length} - rendered by the test stand-in for LibreOffice`, {
      x: 40,
      y: 28,
      size: 9,
      font: regular,
      color: rgb(0.45, 0.45, 0.45),
    })
  }
  return doc.save()
}

function record() {
  const profile = profileArg ? fileURLToPath(profileArg.slice('-env:UserInstallation='.length)) : ''
  let xcu = ''
  try {
    xcu = readFileSync(join(profile, 'user', 'registrymodifications.xcu'), 'utf8')
  } catch {}
  writeFileSync(
    join(outDir, 'fake-record.json'),
    JSON.stringify({
      argv,
      env: process.env,
      cwd: process.cwd(),
      profile,
      profileFiles: safeList(profile),
      xcu,
    }),
  )
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }).map(String)
  } catch {
    return []
  }
}

switch (mode) {
  case 'hang': {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
    writeFileSync(
      join(outDir, 'fake-pids.json'),
      JSON.stringify({ soffice: process.pid, helper: helper.pid }),
    )
    setInterval(() => {}, 1 << 30)
    break
  }
  case 'crash':
    process.stderr.write('fake-soffice: simulated crash\n')
    process.exit(1)
    break
  case 'noop':
    process.stdout.write('Error: source file could not be loaded\n')
    process.exit(0)
    break
  case 'garbage':
    writeFileSync(output, 'this is not a PDF at all')
    process.exit(0)
    break
  default: {
    if (mode === 'record') record()
    const forced = /^pages=(\d+)$/.exec(mode)
    let pages: Page[]
    let landscape = false
    if (forced) {
      pages = Array.from({ length: Number(forced[1]) }, (_, i) => ({ title: `Page ${i + 1}`, lines: [] }))
    } else {
      try {
        ;({ pages, landscape } = await pagesOf(extname(input).slice(1).toLowerCase()))
      } catch {
        pages = []
      }
    }
    if (!pages.length || pages.every((p) => !p.title && !p.lines.length)) {
      // What soffice prints (and does: exit 0, no file) for a document it cannot load.
      process.stdout.write('Error: source file could not be loaded\n')
      process.exit(0)
    }
    writeFileSync(output, await render(pages, landscape))
    process.stdout.write(`convert ${input} -> ${output} using filter : writer_pdf_Export\n`)
    process.exit(0)
  }
}
