// Office documents: detection by content, the container checks that run before LibreOffice, the
// conversion runner's isolation and failure handling, and the whole job (convert → PDF pages) through
// processJob. LibreOffice itself is not installed on the dev PC: soffice is played by
// test/children/fake-soffice.ts, which takes the same command line and writes a real PDF. The real
// LibreOffice runs on the NAS (deploy/nas/README.md "Office previews").
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DataLayout, LIMITS, OFFICE_FORMATS, officeFormatByMime } from '@draftroom/dev-assets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAILURE_MESSAGES } from '../../api/src/worker/protocol.ts'
import { decoyMacroDocx, understatedBombDocx, zip } from '../scripts/office-fixtures.ts'
import { FAILURE_CODES, PreviewError, userMessage } from '../src/errors.ts'
import {
  checkOfficeContainer,
  localOfficeConverter,
  type OfficeConverter,
  officeInput,
  officeOff,
  sofficeCommand,
} from '../src/office.ts'
import { cfbDirectoryNames, readZipDirectory, readZipEntry } from '../src/office-zip.ts'
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

// The teardown flake of wave W (EPERM on a drw-office-* folder): the escape test's helper runs with its
// working directory inside a scratch folder. On Windows a kill only starts its termination, and the dying
// process holds that directory for about 15 ms more, although `process.kill(pid, 0)` already says it is
// gone; a removal in that window fails with EPERM. So the helper is killed and waited for, and a scratch
// folder is removed with retries (rmSync retries EPERM and EBUSY), never once.

/** Kills a process the stand-in let escape and waits until the OS says it is gone. */
async function killAndWait(pid: number, ms = 10_000): Promise<boolean> {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
  const until = Date.now() + ms
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
  return !alive(pid)
}
/** helpers that left the process tree on purpose, killed before any scratch folder is removed */
const escapedHelpers = new Set<number>()
/**
 * Removes a scratch folder, riding out the moment a just-killed process still holds it. Its own retry
 * loop: Node 24's native rmSync fails at once on Windows whatever `maxRetries` says (tried).
 */
async function removeScratch(d: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    try {
      rmSync(d, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() > until) throw e
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

let l: DataLayout
beforeAll(async () => {
  await ensureFixtures()
  l = tempLayout()
})
afterAll(async () => {
  for (const pid of escapedHelpers) await killAndWait(pid)
  escapedHelpers.clear()
  cleanupLayouts()
  for (const d of scratchRoots.splice(0)) await removeScratch(d)
})

describe('the test teardown', () => {
  it('removes a scratch folder that a just-killed helper had as its working directory', async () => {
    const d = mkdtempSync(join(tmpdir(), 'drw-office-'))
    const cwd = join(d, 'scratch')
    mkdirSync(cwd)
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      detached: true,
      stdio: 'ignore',
      cwd,
    })
    helper.unref()
    try {
      await new Promise((r) => setTimeout(r, 200))
      expect(await killAndWait(helper.pid as number)).toBe(true)
      // straight after the kill, as afterAll does it
      await removeScratch(d)
      expect(existsSync(d)).toBe(false)
    } finally {
      try {
        process.kill(helper.pid as number, 'SIGKILL')
      } catch {}
      scratchRoots.push(d)
    }
  })
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

  it('a zip bomb that understates its sizes is refused too: no entry may inflate past what it declares', async () => {
    const f = join(scratch(), 'understated.docx')
    writeFileSync(f, understatedBombDocx(64))
    const entries = await readZipDirectory(f, 100)
    // It declares next to nothing, so the declared-size cap alone lets it through.
    expect(entries.reduce((n, e) => n + e.size, 0)).toBeLessThan(64 * 1024)
    await expect(officeInput(f, await sniffFile(f))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    // The real documents still pass (every entry inflates to exactly its declared size).
    for (const [file] of DOCS) {
      expect(await officeInput(fixturePath(file), await sniffFile(fixturePath(file))), file).not.toBeNull()
    }
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

  it('macros are refused by what LibreOffice would read (the central directory), not only by what the sniffer saw', async () => {
    const dir = scratch()
    // A decoy local [Content_Types].xml makes file-type see a .docx; the listed one is macro-enabled.
    const decoy = join(dir, 'decoy.docx')
    writeFileSync(decoy, decoyMacroDocx())
    const s = await sniffFile(decoy)
    expect(s.ext).toBe('docx')
    await expect(officeInput(decoy, s)).rejects.toMatchObject({ code: 'TYPE_MISMATCH' })
    // A VBA project inside a package that otherwise calls itself a plain .docx.
    const vba = join(dir, 'vba.docx')
    const parts = await readZipDirectory(fixturePath('document.docx'), 100)
    writeFileSync(
      vba,
      zip([
        ...(await Promise.all(
          parts.map(async (e) => ({
            name: e.name,
            data: await readZipEntry(fixturePath('document.docx'), e, 1024 * 1024),
          })),
        )),
        { name: 'word/vbaProject.bin', data: Buffer.from('not really VBA') },
      ]),
    )
    const sv = await sniffFile(vba)
    expect(sv.ext).toBe('docx')
    await expect(officeInput(vba, sv)).rejects.toMatchObject({ code: 'TYPE_MISMATCH' })
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

  it('an output that grows past the size cap is stopped while it is being written, not after', async () => {
    const out = scratch()
    const t0 = Date.now()
    await expect(
      convertWithSoffice(fixturePath('document.docx'), 'docx', out, {
        command: [process.execPath, FAKE_SOFFICE, '--fake-mode=flood'],
        workRoot: scratch(),
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    // The stand-in would write 256 MiB over ~13 s: it was killed within a few MiB of the cap.
    expect(Date.now() - t0).toBeLessThan(6_000)
    const pdf = join(out, 'document.pdf')
    expect(existsSync(pdf) ? readFileSync(pdf).length : 0).toBeLessThan(32 * 1024 * 1024)
  })

  it('a helper that escapes the process tree and holds the pipes cannot keep the runner waiting', async () => {
    const out = scratch()
    const t0 = Date.now()
    try {
      await expect(
        convertWithSoffice(fixturePath('document.docx'), 'docx', out, {
          command: [process.execPath, FAKE_SOFFICE, '--fake-mode=escape'],
          workRoot: scratch(),
          timeoutMs: 60_000,
          maxOutputBytes: LIMITS.maxBytes.pdf,
        }),
      ).rejects.toMatchObject({ code: 'OFFICE_INVALID' }) // exited 0 without output
      expect(Date.now() - t0).toBeLessThan(10_000) // not the helper's 30 s
    } finally {
      let helper: number | undefined
      try {
        ;({ helper } = JSON.parse(readFileSync(join(out, 'fake-pids.json'), 'utf8')) as { helper: number })
      } catch {}
      if (helper) {
        escapedHelpers.add(helper)
        // gone before afterAll removes the scratch folder it may still be holding
        expect(await killAndWait(helper)).toBe(true)
        escapedHelpers.delete(helper)
      }
    }
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
    await expectOfficeFailure(
      ingest(l, null, { name: 'understated.docx', mimeType: '', bytes: understatedBombDocx(16) }),
      'FILE_TOO_LARGE',
      { office: never },
    )
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
