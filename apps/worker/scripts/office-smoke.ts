// Real-LibreOffice check of the Office pipeline. Not part of vitest: LibreOffice is not installed on the
// dev PC, so the unit tests use a stand-in (test/children/fake-soffice.ts) and THIS is how the real
// converter is exercised, inside the worker image (deploy/nas/README.md "Office previews"):
//
//   node apps/worker/scripts/office-smoke.ts <fixtures dir> [--socket PATH --jobs DIR] [--images] [--probes]
//
// For every Office fixture (make-fixtures.ts) it runs the production path, processJob() on a temporary
// local layout with the real converter (soffice on PATH, or the office sidecar with --socket), and prints
// one JSON line: outcome, failure code, confirmed type, page count, conversion and total time. With
// --images it adds the cover thumb and page 1 as base64 WebP (to look at). With --probes (local soffice
// only) it converts two hostile documents twice, once with the hardened job profile and once with a
// default profile as the control: a section linked to local files (/etc/hostname, /proc/1/environ) and
// an auto-run Basic macro. It ends with the container's peak memory when cgroup v2 exposes it.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  claimNextJob,
  dataLayout,
  derivativePath,
  enqueueJob,
  ensureLayout,
  newId,
  OFFICE_FORMATS,
  originalPath,
  PREVIEW_PROFILE,
  readMeta,
  versionDir,
  writeMeta,
} from '@draftroom/dev-assets'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { localOfficeConverter, type OfficeConverter } from '../src/office.ts'
import { socketOfficeConverter } from '../src/office-client.ts'
import { processJob } from '../src/processJob.ts'
import { run } from '../src/run.ts'
import { convertWithSoffice, sofficeEnv } from '../src/soffice.ts'
import { zip } from './office-fixtures.ts'

const args = process.argv.slice(2)
const fixtures = args[0]
if (!fixtures || fixtures.startsWith('--')) {
  console.error('usage: office-smoke.ts <fixtures dir> [--socket PATH --jobs DIR] [--images] [--probes]')
  process.exit(2)
}
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const socket = opt('--socket')
const jobs = opt('--jobs')
const images = args.includes('--images')
const out = (o: unknown) => console.log(JSON.stringify(o))

const FILES = [
  'document.docx',
  'slides.pptx',
  'sheet.xlsx',
  'document.odt',
  'slides.odp',
  'sheet.ods',
  'truncated.docx',
  'broken.docx',
  'macro.docx',
  'encrypted.docx',
  'encrypted.odt',
  'bomb.docx',
]

let lastConvertMs = 0
function timed(c: OfficeConverter): OfficeConverter {
  return {
    describe: c.describe,
    async convert(input, format, outDir, o) {
      const t0 = Date.now()
      try {
        return await c.convert(input, format, outDir, o)
      } finally {
        lastConvertMs = Date.now() - t0
      }
    },
  }
}

const converter = timed(
  socket && jobs
    ? socketOfficeConverter({ socketPath: socket, jobsDir: jobs })
    : localOfficeConverter({ command: ['soffice'], workRoot: tmpdir() }),
)

async function runOne(file: string) {
  const root = await mkdtemp(join(tmpdir(), 'office-smoke-'))
  try {
    const l = ensureLayout(dataLayout(root))
    const assetId = newId('ast')
    const versionId = newId('ver')
    await mkdir(versionDir(l, assetId, versionId), { recursive: true })
    const bytes = await readFile(join(fixtures as string, file))
    await writeFile(originalPath(l, assetId, versionId), bytes)
    const now = new Date().toISOString()
    writeMeta(l, {
      schemaVersion: 1,
      assetId,
      versionId,
      boardId: 'board-smoke',
      name: 'original',
      declaredMimeType: 'application/octet-stream',
      mimeType: 'application/octet-stream',
      kind: 'pdf',
      sizeBytes: bytes.length,
      sha256: '',
      uploadedBy: 'smoke',
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      attempts: 0,
      error: null,
      probe: {
        width: null,
        height: null,
        pageCount: null,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
      derivatives: [],
    })
    enqueueJob(l, {
      assetId,
      versionId,
      boardId: 'board-smoke',
      profile: PREVIEW_PROFILE,
      enqueuedAt: now,
      attempt: 1,
    })
    const claim = claimNextJob(l)
    if (!claim) throw new Error('claim failed')
    lastConvertMs = 0
    const logs: string[] = []
    const t0 = Date.now()
    const outcome = await processJob(l, claim, { office: converter, log: (s) => logs.push(s) })
    const ms = Date.now() - t0
    const m = readMeta(l, assetId, versionId)
    const pic = (role: string, page: number | null) => {
      const d = m?.derivatives.find((x) => x.role === role && x.page === page)
      return d
        ? {
            width: d.width,
            height: d.height,
            webp: readFileSync(derivativePath(l, assetId, versionId, d.file)).toString('base64'),
          }
        : null
    }
    out({
      file,
      outcome: outcome.result,
      code: m?.error?.code ?? null,
      mime: m?.mimeType,
      pages: m?.probe.pageCount ?? null,
      derivatives: m?.derivatives.length ?? 0,
      convertMs: lastConvertMs,
      totalMs: ms,
      log: logs.map((s) => s.replace(versionId, 'ver')),
      ...(images && m?.status === 'ready' ? { thumb: pic('thumb', 1), page1: pic('page', 1) } : {}),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---- hostile probes ------------------------------------------------------------------------------------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"'
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
const odtManifest = (extra: string) =>
  `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${extra}</manifest:manifest>`

/** Sections whose content LibreOffice would load from local files if it updated links. */
function linkedOdt(): Buffer {
  const section = (name: string, href: string) =>
    `<text:section text:name="${name}"><text:section-source xlink:href="${href}" xlink:type="simple"/><text:p>cached ${name}</text:p></text:section>`
  return zip([
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), store: true },
    {
      name: 'content.xml',
      data: Buffer.from(
        `${XML}<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:text><text:p>Link probe</text:p>${section('host', 'file:///etc/hostname')}${section('environ', 'file:///proc/1/environ')}</office:text></office:body></office:document-content>`,
      ),
    },
    { name: 'META-INF/manifest.xml', data: Buffer.from(odtManifest('')) },
  ])
}

/** A picture linked (not embedded) to a local file of the LibreOffice install: rendering it reads that file. */
const LINKED_PICTURE = '/usr/lib/libreoffice/share/gallery/backgrounds/floral.png'
function linkedPictureOdt(): Buffer {
  return zip([
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), store: true },
    {
      name: 'content.xml',
      data: Buffer.from(
        `${XML}<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:text><text:p>Linked picture probe</text:p><text:p><draw:frame xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" text:anchor-type="as-char" svg:width="4cm" svg:height="4cm"><draw:image xlink:href="file://${LINKED_PICTURE}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p></office:text></office:body></office:document-content>`,
      ),
    },
    { name: 'META-INF/manifest.xml', data: Buffer.from(odtManifest('')) },
  ])
}

async function pdfImages(path: string): Promise<number> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false }).promise
  let n = 0
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    n += ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject).length
  }
  return n
}

const MACRO_MARKER = '/tmp/lobby-macro-ran'

/** A Basic macro bound to the document's load events that writes MACRO_MARKER. */
function macroOdt(): Buffer {
  const listener = (event: string) =>
    `<script:event-listener script:language="ooo:script" script:event-name="${event}" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document" xlink:type="simple"/>`
  const basic = `Sub Main\n  Dim n As Integer\n  n = FreeFile\n  Open "${MACRO_MARKER}" For Output As #n\n  Print #n, "macro ran"\n  Close #n\nEnd Sub\n`
  return zip([
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), store: true },
    {
      name: 'content.xml',
      data: Buffer.from(
        `${XML}<office:document-content ${ODF_NS} office:version="1.3"><office:scripts><office:event-listeners>${listener('dom:load')}${listener('office:load')}</office:event-listeners></office:scripts><office:body><office:text><text:p>Macro probe</text:p></office:text></office:body></office:document-content>`,
      ),
    },
    {
      name: 'Basic/script-lc.xml',
      data: Buffer.from(
        `${XML}<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd"><library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink"><library:library library:name="Standard" xlink:href="Basic/Standard/script-lb.xml/" xlink:type="simple" library:link="false"/></library:libraries>`,
      ),
    },
    {
      name: 'Basic/Standard/script-lb.xml',
      data: Buffer.from(
        `${XML}<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd"><library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false"><library:element library:name="Module1"/></library:library>`,
      ),
    },
    {
      name: 'Basic/Standard/Module1.xml',
      data: Buffer.from(
        `${XML}<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd"><script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">${basic.replace(/"/g, '&quot;')}</script:module>`,
      ),
    },
    {
      name: 'META-INF/manifest.xml',
      data: Buffer.from(
        odtManifest(
          ['Basic/script-lc.xml', 'Basic/Standard/script-lb.xml', 'Basic/Standard/Module1.xml']
            .map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="text/xml"/>`)
            .join(''),
        ),
      ),
    },
  ])
}

async function pdfText(path: string): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false }).promise
  let text = ''
  for (let n = 1; n <= doc.numPages; n++) {
    const c = await (await doc.getPage(n)).getTextContent()
    text += `${c.items.map((i) => ('str' in i ? i.str : '')).join(' ')}\n`
  }
  return text
}

/** soffice with an empty default profile: the control, to show what the hardening changes. */
async function vanilla(input: string, outDir: string): Promise<string | null> {
  const scratch = await mkdtemp(join(tmpdir(), 'lo-vanilla-'))
  try {
    const r = await run(
      'soffice',
      [
        `-env:UserInstallation=${pathToFileURL(join(scratch, 'profile')).href}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        input,
      ],
      { timeoutMs: 120_000, maxStdoutBytes: 65536, env: sofficeEnv(scratch), cwd: scratch, killTree: true },
    )
    const pdf = join(outDir, 'document.pdf')
    return r.code === 0 && existsSync(pdf) ? pdf : null
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function probes() {
  const canary = process.env.PROBE_CANARY ?? ''
  const host = hostname()
  for (const [name, build] of [
    ['linked-picture', linkedPictureOdt],
    ['linked-sections', linkedOdt],
    ['macro', macroOdt],
  ] as const) {
    for (const mode of ['hardened', 'vanilla'] as const) {
      rmSync(MACRO_MARKER, { force: true })
      const dir = await mkdtemp(join(tmpdir(), 'office-probe-'))
      try {
        const input = join(dir, 'document.odt')
        await writeFile(input, build())
        const outDir = join(dir, 'out')
        await mkdir(outDir)
        let pdf: string | null = null
        let error: string | null = null
        try {
          pdf =
            mode === 'hardened'
              ? await convertWithSoffice(input, 'odt', outDir, {
                  command: ['soffice'],
                  workRoot: tmpdir(),
                  timeoutMs: 120_000,
                  maxOutputBytes: 100 * 1024 * 1024,
                })
              : await vanilla(input, outDir)
        } catch (e) {
          error = (e as Error).message
        }
        const text = pdf ? await pdfText(pdf) : ''
        out({
          probe: name,
          mode,
          converted: pdf !== null,
          error,
          hostnameInPreview: host.length > 0 && text.includes(host),
          canaryInPreview: canary.length > 0 && text.includes(canary),
          cachedTextInPreview: text.includes('cached'),
          picturesInPreview: pdf ? await pdfImages(pdf) : null,
          macroRan: existsSync(MACRO_MARKER),
          text: text.replace(/\s+/g, ' ').slice(0, 300),
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}

for (const f of FILES) await runOne(f)
if (args.includes('--probes')) await probes()
const peak = ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes'].find((p) =>
  existsSync(p),
)
out({
  done: true,
  converter: converter.describe,
  formats: OFFICE_FORMATS.map((f) => f.ext),
  cgroupPeakMiB: peak ? Math.round(Number(readFileSync(peak, 'utf8').trim()) / 1048576) : null,
})
