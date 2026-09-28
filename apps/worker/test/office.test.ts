// Office documents: detection by content, the container checks that run before LibreOffice, the
// conversion runner's isolation and failure handling, and the whole job (convert → PDF pages) through
// processJob. LibreOffice itself is not installed on the dev PC: soffice is played by
// test/children/fake-soffice.ts, which takes the same command line and writes a real PDF. The real
// LibreOffice runs on the NAS (deploy/nas/README.md "Office previews").
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DataLayout, LIMITS, OFFICE_FORMATS, officeFormatByMime } from '@draftroom/dev-assets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAILURE_MESSAGES } from '../../api/src/worker/protocol.ts'
import { FAILURE_CODES, PreviewError, userMessage } from '../src/errors.ts'
import {
  checkOfficeContainer,
  localOfficeConverter,
  type OfficeConverter,
  officeInput,
  officeOff,
  sofficeCommand,
} from '../src/office.ts'
import { cfbDirectoryNames, readZipDirectory } from '../src/office-zip.ts'
import { sniffFile } from '../src/sniff.ts'
import { convertWithSoffice, HARDENING_XCU, IMPORT_FILTERS } from '../src/soffice.ts'
import {
  cleanupLayouts,
  derivativeFiles,
  ensureFixtures,
  fixturePath,
  type Ingested,
  ingest,
  jobsIn,
  metaOf,
  processNext,
  tempLayout,
} from './helpers.ts'

export const FAKE_SOFFICE = fileURLToPath(new URL('./children/fake-soffice.ts', import.meta.url))

const scratchRoots: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'drw-office-'))
  scratchRoots.push(d)
  return d
}

/** The local converter with the stand-in soffice (and a test mode). */
export function fakeConverter(workRoot: string, mode?: string): OfficeConverter {
  return localOfficeConverter({
    command: [process.execPath, FAKE_SOFFICE, ...(mode ? [`--fake-mode=${mode}`] : [])],
    workRoot,
  })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let l: DataLayout
beforeAll(async () => {
  await ensureFixtures()
  l = tempLayout()
})
afterAll(() => {
  cleanupLayouts()
  for (const d of scratchRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DOCS = [
  ['document.docx', 'docx', 3],
  ['slides.pptx', 'pptx', 3],
  ['sheet.xlsx', 'xlsx', 2],
  ['document.odt', 'odt', 3],
  ['slides.odp', 'odp', 3],
  ['sheet.ods', 'ods', 1],
] as const

describe('detection by content', () => {
  it.each(DOCS)('%s sniffs as its Office format and passes the container checks', async (file, ext) => {
    const s = await sniffFile(fixturePath(file))
    const format = OFFICE_FORMATS.find((f) => f.ext === ext)
    expect(s.mime).toBe(format?.mime)
    expect(await officeInput(fixturePath(file), s)).toBe(format)
  })

  it('a real PDF, an image or a plain ZIP is not an Office document (the PDF path or a type mismatch decides)', async () => {
    for (const f of ['document.pdf', 'image.png', 'notes.zip']) {
      expect(await officeInput(fixturePath(f), await sniffFile(fixturePath(f))), f).toBeNull()
    }
  })

  it('a truncated package is refused before conversion', async () => {
    const f = fixturePath('truncated.docx')
    await expect(officeInput(f, await sniffFile(f))).rejects.toMatchObject({ code: 'OFFICE_INVALID' })
  })

  it('a zip bomb is refused from its declared sizes, without inflating anything', async () => {
    const f = fixturePath('bomb.docx')
    const entries = await readZipDirectory(f, 100)
    expect(entries.reduce((n, e) => n + e.size, 0)).toBeGreaterThan(LIMITS.officeMaxUnzippedBytes)
    const t0 = Date.now()
    await expect(officeInput(f, await sniffFile(f))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('password-protected documents are named as such: OOXML (MS-CFB) and ODF (manifest)', async () => {
    const cfb = fixturePath('encrypted.docx')
    expect(await cfbDirectoryNames(cfb)).toEqual(['Root Entry', 'EncryptionInfo', 'EncryptedPackage'])
    const s = await sniffFile(cfb)
    expect(s.mime).toBe('application/x-cfb')
    await expect(officeInput(cfb, s)).rejects.toMatchObject({ code: 'OFFICE_ENCRYPTED' })
    const odt = fixturePath('encrypted.odt')
    await expect(officeInput(odt, await sniffFile(odt))).rejects.toMatchObject({ code: 'OFFICE_ENCRYPTED' })
  })

  it('a macro-enabled package under a .docx name is not converted', async () => {
    const f = fixturePath('macro.docx')
    const s = await sniffFile(f)
    expect(s.ext).toBe('docm')
    expect(officeFormatByMime(s.mime)).toBeNull()
    expect(await officeInput(f, s)).toBeNull()
  })

  it('a package missing the parts every document of its family has is refused', async () => {
    const dir = scratch()
    // A ZIP that file-type calls docx (its [Content_Types].xml) but that has no _rels/.rels.
    const bytes = readFileSync(fixturePath('document.docx'))
    const f = join(dir, 'no-rels.docx')
    writeFileSync(f, Buffer.from(bytes.toString('latin1').replaceAll('_rels/.rels', '_rels/.relz'), 'latin1'))
    const format = OFFICE_FORMATS[0]
    if (!format) throw new Error('no formats')
    await expect(checkOfficeContainer(f, format)).rejects.toMatchObject({
      code: 'OFFICE_INVALID',
      detail: 'missing _rels/.rels',
    })
  })
})

describe('the LibreOffice runner (soffice.ts)', () => {
  it('runs soffice with a fresh hardened profile, the forced import filter and a minimal environment, then removes its scratch', async () => {
    const work = scratch()
    const out = scratch()
    process.env.DRAFTROOM_OFFICE_TEST_CANARY = 'must-not-reach-soffice'
    try {
      const pdf = await convertWithSoffice(fixturePath('slides.pptx'), 'pptx', out, {
        command: [process.execPath, FAKE_SOFFICE, '--fake-mode=record'],
        workRoot: work,
        timeoutMs: 30_000,
        maxOutputBytes: LIMITS.maxBytes.pdf,
      })
      expect(pdf).toBe(join(out, 'document.pdf'))
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
    } finally {
      delete process.env.DRAFTROOM_OFFICE_TEST_CANARY
    }
    const rec = JSON.parse(readFileSync(join(out, 'fake-record.json'), 'utf8')) as {
      argv: string[]
      env: Record<string, string>
      profile: string
      xcu: string
    }
    expect(rec.argv).toEqual(
      expect.arrayContaining([
        '--headless',
        '--norestore',
        '--nolockcheck',
        `--infilter=${IMPORT_FILTERS.pptx}`,
        '--convert-to',
        'pdf',
        '--outdir',
        out,
      ]),
    )
    expect(rec.argv.at(-1)).toMatch(/[\\/]lo-[^\\/]+[\\/]document\.pptx$/) // a copy with the right extension
    // A per-job profile inside the job's scratch, holding the hardening settings.
    expect(rec.profile.startsWith(work)).toBe(true)
    expect(rec.xcu).toBe(HARDENING_XCU)
    expect(rec.xcu).toContain('<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value>')
    expect(rec.xcu).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value>')
    // Nothing of the worker's environment but PATH (and the Windows basics); HOME/TMPDIR in the scratch.
    const allowed = new Set([
      'PATH',
      'HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'SAL_USE_VCLPLUGIN',
      'SAL_DISABLE_OPENCL',
      'LANG',
      'SYSTEMROOT',
      'USERPROFILE',
    ])
    // On Windows libuv always copies a fixed set of system variables into a child's environment (its
    // required_vars: HOMEDRIVE, USERNAME, WINDIR...), and keeps per-drive directories in "=C:"-style names.
    if (process.platform === 'win32') {
      for (const k of [
        'HOMEDRIVE',
        'HOMEPATH',
        'LOGONSERVER',
        'SYSTEMDRIVE',
        'USERDOMAIN',
        'USERNAME',
        'WINDIR',
      ])
        allowed.add(k)
    }
    for (const k of Object.keys(rec.env).filter((k) => !k.startsWith('='))) {
      expect(allowed.has(k.toUpperCase()), `unexpected env ${k}`).toBe(true)
    }
    expect(JSON.stringify(rec.env)).not.toContain('must-not-reach-soffice')
    expect(rec.env.HOME?.startsWith(work)).toBe(true)
    expect(rec.env.TMPDIR?.startsWith(work)).toBe(true)
    // The scratch (profile, HOME, the input copy) is gone.
    expect(existsSync(rec.profile)).toBe(false)
  })

  it('a hung soffice is killed with its whole process tree at the timeout', async () => {
    const out = scratch()
    const t0 = Date.now()
    await expect(
      convertWithSoffice(fixturePath('document.docx'), 'docx', out, {
        command: [process.execPath, FAKE_SOFFICE, '--fake-mode=hang'],
        workRoot: scratch(),
        timeoutMs: 2_000,
        maxOutputBytes: LIMITS.maxBytes.pdf,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(Date.now() - t0).toBeLessThan(10_000)
    const pids = JSON.parse(readFileSync(join(out, 'fake-pids.json'), 'utf8')) as {
      soffice: number
      helper: number
    }
    const deadline = Date.now() + 5_000
    while ((alive(pids.soffice) || alive(pids.helper)) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100))
    expect({ soffice: alive(pids.soffice), helper: alive(pids.helper) }).toEqual({
      soffice: false,
      helper: false,
    })
  })

  it.each([
    ['crash', 'OFFICE_INVALID'],
    ['noop', 'OFFICE_INVALID'],
    ['garbage', 'OFFICE_INVALID'],
  ])('soffice mode %s → %s', async (mode, code) => {
    await expect(
      convertWithSoffice(fixturePath('document.docx'), 'docx', scratch(), {
        command: [process.execPath, FAKE_SOFFICE, `--fake-mode=${mode}`],
        workRoot: scratch(),
        timeoutMs: 30_000,
        maxOutputBytes: LIMITS.maxBytes.pdf,
      }),
    ).rejects.toMatchObject({ code })
  })

  it('an output above the size cap is refused', async () => {
    await expect(
      convertWithSoffice(fixturePath('document.docx'), 'docx', scratch(), {
        command: [process.execPath, FAKE_SOFFICE],
        workRoot: scratch(),
        timeoutMs: 30_000,
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('a missing soffice is OFFICE_UNAVAILABLE (a permanent, honest failure), not a retry loop', async () => {
    await expect(
      convertWithSoffice(fixturePath('document.docx'), 'docx', scratch(), {
        command: [join(scratch(), 'no-such-soffice')],
        workRoot: scratch(),
        timeoutMs: 30_000,
        maxOutputBytes: LIMITS.maxBytes.pdf,
      }),
    ).rejects.toMatchObject({ code: 'OFFICE_UNAVAILABLE' })
  })

  it('an abort kills soffice and says so', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort('test'), 500)
    await expect(
      convertWithSoffice(fixturePath('document.docx'), 'docx', scratch(), {
        command: [process.execPath, FAKE_SOFFICE, '--fake-mode=hang'],
        workRoot: scratch(),
        timeoutMs: 30_000,
        maxOutputBytes: LIMITS.maxBytes.pdf,
        signal: ctl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortedError' })
  })

  it('a Node stand-in runs with this Node; anything else is an executable', () => {
    expect(sofficeCommand(undefined)).toEqual(['soffice'])
    expect(sofficeCommand('/usr/bin/soffice')).toEqual(['/usr/bin/soffice'])
    expect(sofficeCommand(FAKE_SOFFICE)).toEqual([process.execPath, FAKE_SOFFICE])
  })
})

/** Runs the job and checks what every Office failure must satisfy (as negatives.test.ts does for M0 kinds). */
async function expectOfficeFailure(i: Ingested, code: string, opts: Parameters<typeof processNext>[1] = {}) {
  const out = await processNext(l, opts)
  expect(out).toEqual({ result: 'failed', status: 'failed', code })
  const m = metaOf(l, i)
  expect(m.status).toBe('failed')
  expect(m.attempts).toBe(1) // permanent: never retried
  expect(m.error).toEqual({ code, message: userMessage(code as Parameters<typeof userMessage>[0]) })
  expect(m.derivatives).toEqual([])
  expect(derivativeFiles(l, i)).toEqual([])
  expect(jobsIn(l, 'processing')).toEqual([])
  return m
}

describe('a whole job (processJob)', () => {
  it.each(DOCS)(
    '%s becomes ready with its pages rendered through the PDF pipeline',
    async (file, ext, pages) => {
      const format = OFFICE_FORMATS.find((f) => f.ext === ext)
      const i = ingest(l, file, { name: `Quarterly plan.${ext}`, mimeType: '' })
      expect(i.meta.kind).toBe('pdf') // classified by extension
      const out = await processNext(l, { office: fakeConverter(scratch()) })
      expect(out).toMatchObject({ result: 'done', status: 'ready' })
      const m = metaOf(l, i)
      // The confirmed type is the Office one: the original stays an attachment, the card says "converted".
      expect(m.mimeType).toBe(format?.mime)
      expect(m.probe.pageCount).toBe(pages)
      const rendered = m.derivatives.filter((d) => d.role === 'page').map((d) => d.page)
      expect(rendered).toEqual(Array.from({ length: pages }, (_, k) => k + 1))
      expect(m.derivatives.filter((d) => d.role === 'thumb')).toHaveLength(1)
      // The converted PDF and every scratch directory are gone: only the referenced derivatives remain.
      expect(derivativeFiles(l, i)).toEqual(m.derivatives.map((d) => d.file).sort())
    },
  )

  it('works whatever the upload declared, as long as the content is an Office document', async () => {
    const i = ingest(l, 'document.docx', {
      name: 'from-a-phone',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect(i.meta.kind).toBe('pdf') // by declared type
    expect(await processNext(l, { office: fakeConverter(scratch()) })).toMatchObject({ status: 'ready' })
  })

  it('a real PDF under a .docx name is previewed as the PDF it is (no conversion)', async () => {
    const i = ingest(l, 'document.pdf', { name: 'misnamed.docx', mimeType: '' })
    const out = await processNext(l, { office: officeOff() }) // conversion would fail: it is never asked
    expect(out).toMatchObject({ status: 'ready' })
    expect(metaOf(l, i).mimeType).toBe('application/pdf')
  })

  it('a document that times out in LibreOffice fails with TIMEOUT and is not retried', async () => {
    const i = ingest(l, 'document.docx', { name: 'slow.docx', mimeType: '' })
    await expectOfficeFailure(i, 'TIMEOUT', {
      office: fakeConverter(scratch(), 'hang'),
      officeTimeoutMs: 1_500,
    })
  })

  it('a corrupt document fails with the Office message, before or after LibreOffice', async () => {
    await expectOfficeFailure(ingest(l, 'truncated.docx', { mimeType: '' }), 'OFFICE_INVALID', {
      office: fakeConverter(scratch()),
    })
    // Passes the container checks; the converter cannot load it (soffice: exit 0, no output).
    await expectOfficeFailure(ingest(l, 'broken.docx', { mimeType: '' }), 'OFFICE_INVALID', {
      office: fakeConverter(scratch()),
    })
  })

  it('password-protected documents say so', async () => {
    for (const f of ['encrypted.docx', 'encrypted.odt']) {
      await expectOfficeFailure(ingest(l, f, { mimeType: '' }), 'OFFICE_ENCRYPTED', {
        office: fakeConverter(scratch()),
      })
    }
  })

  it('a zip bomb and a macro-enabled package are refused without conversion', async () => {
    const never: OfficeConverter = {
      describe: 'must not be called',
      convert: () => Promise.reject(new Error('converter called')),
    }
    await expectOfficeFailure(ingest(l, 'bomb.docx', { mimeType: '' }), 'FILE_TOO_LARGE', { office: never })
    await expectOfficeFailure(ingest(l, 'macro.docx', { mimeType: '' }), 'TYPE_MISMATCH', { office: never })
  })

  it('too many pages after conversion is worded for the document, not "this PDF"', async () => {
    const i = ingest(l, 'document.docx', { name: 'huge.docx', mimeType: '' })
    const m = await expectOfficeFailure(i, 'OFFICE_TOO_MANY_PAGES', {
      office: fakeConverter(scratch(), `pages=${LIMITS.maxPdfPages + 1}`),
    })
    expect(m.probe.pageCount).toBe(LIMITS.maxPdfPages + 1)
    expect(m.error?.message).toBe('This document has too many pages to preview. You can still download it.')
  })

  it('with Office previews off (or no LibreOffice), the document stays downloadable with an honest message', async () => {
    await expectOfficeFailure(ingest(l, 'slides.pptx', { mimeType: '' }), 'OFFICE_UNAVAILABLE', {
      office: officeOff(),
    })
    await expectOfficeFailure(ingest(l, 'sheet.xlsx', { mimeType: '' }), 'OFFICE_UNAVAILABLE', {
      office: localOfficeConverter({ command: [join(scratch(), 'missing-soffice')], workRoot: scratch() }),
    })
  })

  it('a converter crash is permanent (the same document would crash again)', async () => {
    await expectOfficeFailure(ingest(l, 'document.odt', { mimeType: '' }), 'OFFICE_INVALID', {
      office: fakeConverter(scratch(), 'crash'),
    })
  })
})

describe('failure messages', () => {
  it('the api shows the same fixed text for every code the worker reports', () => {
    for (const code of FAILURE_CODES) expect(FAILURE_MESSAGES[code], code).toBe(userMessage(code))
  })

  it('Office messages name the document, never paths, tools or libraries', () => {
    for (const code of [
      'OFFICE_ENCRYPTED',
      'OFFICE_INVALID',
      'OFFICE_TOO_MANY_PAGES',
      'OFFICE_UNAVAILABLE',
    ] as const) {
      const m = userMessage(code)
      expect(m).toMatch(/document|Office/)
      expect(m).not.toMatch(/[\\/]|LibreOffice|soffice|PDF child|zip/i)
    }
    expect(new PreviewError('OFFICE_INVALID', 'x').message).toBe('OFFICE_INVALID: x')
  })
})
