import { mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claimNextJob,
  classifyUpload,
  dataLayout,
  derivativePath,
  enqueueJob,
  ensureLayout,
  finishJob,
  isId,
  LIMITS,
  maxUploadBytes,
  newId,
  OFFICE_FORMATS,
  officeFormat,
  officeFormatByMime,
  PREVIEW_PROFILE,
  type PreviewJob,
  requeueStale,
  sanitizeDisplayName,
  versionDir,
} from './index.ts'

const layout = () => ensureLayout(dataLayout(mkdtempSync(join(tmpdir(), 'dr-assets-'))))
const job = (): PreviewJob => ({
  assetId: newId('ast'),
  versionId: newId('ver'),
  boardId: 'board-1',
  profile: PREVIEW_PROFILE,
  enqueuedAt: new Date().toISOString(),
  attempt: 1,
})

describe('ids', () => {
  it('are unique, prefixed and satisfy the canvas-schema appId pattern', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('ast')))
    expect(ids.size).toBe(2000)
    for (const id of ids) {
      expect(isId('ast', id)).toBe(true)
      expect(id).toMatch(/^ast_[0-9A-Za-z]{10,40}$/) // canvas-schema file-card validator
    }
    expect(isId('ver', newId('ast'))).toBe(false)
  })
})

describe('paths cannot escape the data dir', () => {
  it('rejects traversal in ids and derivative names', () => {
    const l = layout()
    expect(() => versionDir(l, '../../etc', newId('ver'))).toThrow()
    expect(() => versionDir(l, newId('ast'), 'ver_..\\..\\x')).toThrow()
    expect(() => derivativePath(l, newId('ast'), newId('ver'), '../meta.json')).toThrow()
    expect(() => derivativePath(l, newId('ast'), newId('ver'), '..')).toThrow()
    expect(derivativePath(l, newId('ast'), newId('ver'), 'drv_abc.webp')).toContain('derivatives')
  })
})

describe('classification and names', () => {
  it('treats SVG as an attachment, never an inline image', () => {
    expect(classifyUpload('image/svg+xml', 'logo.svg')).toBe('other')
    expect(classifyUpload('image/png', 'a.png')).toBe('image')
    expect(classifyUpload('', 'deck.PDF')).toBe('pdf')
    expect(classifyUpload('video/mp4', 'clip.mp4')).toBe('video')
    expect(classifyUpload('application/zip', 'x.zip')).toBe('other')
  })
  it('previews Office documents as pages (kind pdf) by declared type or extension, and nothing else', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    for (const [mime, name] of [
      [docx, 'Q3 plan.bin'],
      ['', 'Q3 plan.DOCX'],
      ['application/octet-stream', 'deck.pptx'],
      ['', 'budget.xlsx'],
      ['application/vnd.oasis.opendocument.text; charset=binary', 'notes'],
      ['', 'slides.odp'],
      ['', 'sheet.ods'],
    ]) {
      expect(classifyUpload(mime as string, name as string), `${mime} ${name}`).toBe('pdf')
    }
    expect(officeFormat('', 'Q3 plan.DOCX')).toMatchObject({
      ext: 'docx',
      mime: docx,
      label: 'Word document',
    })
    expect(officeFormat('application/octet-stream', 'b.xlsx')?.label).toBe('Excel spreadsheet')
    // Macro-enabled, legacy binary and iWork formats stay attachments.
    for (const name of ['m.docm', 'm.xlsm', 'm.pptm', 'old.doc', 'old.xls', 'old.ppt', 'k.key', 'p.pages']) {
      expect(classifyUpload('', name), name).toBe('other')
      expect(officeFormat('', name), name).toBeNull()
    }
    expect(classifyUpload('application/vnd.ms-word.document.macroenabled.12', 'm.docm')).toBe('other')
    // Every existing classification is unchanged (an image or video type wins over an Office name).
    expect(classifyUpload('image/png', 'x.docx')).toBe('image')
    expect(classifyUpload('video/mp4', 'x.pptx')).toBe('video')
    expect(classifyUpload('application/pdf', 'x.docx')).toBe('pdf')
    expect(officeFormatByMime('APPLICATION/VND.OASIS.OPENDOCUMENT.SPREADSHEET')?.ext).toBe('ods')
    expect(officeFormatByMime('application/zip')).toBeNull()
    expect(OFFICE_FORMATS.map((f) => f.ext)).toEqual(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'])
  })
  it('limits Office uploads to 100 MB, and every other kind as before', () => {
    expect(LIMITS.maxOfficeBytes).toBe(100 * 1024 * 1024)
    expect(maxUploadBytes('pdf', '', 'deck.pptx')).toBe(LIMITS.maxOfficeBytes)
    expect(maxUploadBytes('pdf', 'application/vnd.oasis.opendocument.text', 'n')).toBe(LIMITS.maxOfficeBytes)
    expect(maxUploadBytes('pdf', 'application/pdf', 'scan.pdf')).toBe(LIMITS.maxBytes.pdf)
    expect(maxUploadBytes('pdf', 'application/pdf', 'scan.docx')).toBe(LIMITS.maxBytes.pdf)
    expect(maxUploadBytes('video', '', 'a.mp4')).toBe(LIMITS.maxBytes.video)
    expect(maxUploadBytes('other', '', 'a.docm')).toBe(LIMITS.maxBytes.other)
  })
  it('strips paths and control characters from display names', () => {
    expect(sanitizeDisplayName('C:\\Users\\me\\secret\\deck.pdf')).toBe('deck.pdf')
    expect(sanitizeDisplayName('../../a\u0000b.png')).toBe('ab.png')
    expect(sanitizeDisplayName('')).toBe('file')
  })
})

describe('job queue', () => {
  it('enqueue is idempotent per version', () => {
    const l = layout()
    const j = job()
    expect(enqueueJob(l, j)).toBe(true)
    expect(enqueueJob(l, j)).toBe(false)
    expect(readdirSync(l.jobs.queued)).toHaveLength(1)
  })

  it('a job is claimed by exactly one of many competing claimers', () => {
    const l = layout()
    for (let i = 0; i < 25; i++) enqueueJob(l, job())
    const claimed: string[] = []
    // interleave claimers; each claim is a rename, so no job can be handed out twice
    for (let round = 0; round < 30; round++) {
      for (let w = 0; w < 4; w++) {
        const c = claimNextJob(l)
        if (c) claimed.push(c.job.versionId)
      }
    }
    expect(claimed).toHaveLength(25)
    expect(new Set(claimed).size).toBe(25)
    expect(claimNextJob(l)).toBeNull()
  })

  it('an abandoned claim is requeued with attempt+1, a live one is not', () => {
    const l = layout()
    enqueueJob(l, job())
    enqueueJob(l, job())
    const dead = claimNextJob(l)
    const alive = claimNextJob(l)
    if (!dead || !alive) throw new Error('expected two claims')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(dead.path, old, old)
    expect(requeueStale(l, 120_000)).toEqual([dead.job.versionId])
    const again = claimNextJob(l)
    expect(again?.job.versionId).toBe(dead.job.versionId)
    expect(again?.job.attempt).toBe(2)
    finishJob(l, alive, 'done')
    expect(readdirSync(l.jobs.done)).toEqual([`${alive.job.versionId}.json`])
  })
})
