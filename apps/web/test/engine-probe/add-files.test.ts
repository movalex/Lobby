/**
 * Plan §6.5 probe "addFiles keeps the first entry for an id": the checker (`browser/add-files.ts`) must pass an engine
 * that keeps the first entry, as the pinned build does, and fail one that replaces it, adds nothing, or touches the
 * files on `addFiles([])`. The real engine is checked by `add-files/run-browser.ts` (`pnpm probe:browser`): a mounted
 * <Excalidraw> needs a DOM, which the Node run does not have.
 */
import { describe, expect, it } from 'vitest'
import { type AddFilesApi, checkAddFiles, type ProbeFile } from './browser/add-files.ts'

/** The pinned engine's rule (App.addMissingFiles), as a fake: an id that is already there is skipped. */
function keepFirst(): AddFilesApi {
  let files: Record<string, ProbeFile> = {}
  return {
    addFiles: (list) => {
      const next = { ...files }
      for (const f of list) if (!next[f.id]) next[f.id] = f
      files = next
    },
    getFiles: () => files,
  }
}

describe('6.5 probe: addFiles keeps the first entry for an id', () => {
  it('passes an engine that keeps the first entry (the pinned build)', () => {
    expect(checkAddFiles(keepFirst())).toEqual({
      firstStored: true,
      firstEntryKept: true,
      firstEntryObjectKept: true,
      otherIdAdded: true,
      emptyCallNoop: true,
      ok: true,
    })
  })

  it('fails an engine whose addFiles replaces an existing id (a bump that changed the rule)', () => {
    let files: Record<string, ProbeFile> = {}
    const replacing: AddFilesApi = {
      addFiles: (list) => {
        files = { ...files, ...Object.fromEntries(list.map((f) => [f.id, f])) }
      },
      getFiles: () => files,
    }
    const r = checkAddFiles(replacing)
    expect(r.ok).toBe(false)
    expect(r.firstEntryKept).toBe(false)
    expect(r.firstStored).toBe(true)
  })

  it('fails an engine that stores a copy of the first entry, or drops files on addFiles([])', () => {
    const base = keepFirst()
    const copying: AddFilesApi = {
      addFiles: (list) => base.addFiles(list.map((f) => ({ ...f }))),
      getFiles: () => Object.fromEntries(Object.entries(base.getFiles()).map(([k, v]) => [k, { ...v }])),
    }
    expect(checkAddFiles(copying).firstEntryObjectKept).toBe(false)

    let files: Record<string, ProbeFile> = {}
    const clearing: AddFilesApi = {
      addFiles: (list) => {
        if (list.length === 0) files = {}
        for (const f of list) if (!files[f.id]) files[f.id] = f
      },
      getFiles: () => files,
    }
    const r = checkAddFiles(clearing)
    expect(r.emptyCallNoop).toBe(false)
    expect(r.ok).toBe(false)
  })

  it('fails an engine that adds nothing', () => {
    const empty: AddFilesApi = { addFiles: () => {}, getFiles: () => ({}) }
    const r = checkAddFiles(empty)
    expect(r.firstStored).toBe(false)
    expect(r.ok).toBe(false)
  })
})
