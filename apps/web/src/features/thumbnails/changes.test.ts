import type { TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { changesContent, type RecordsDiff } from './changes.ts'

const rec = (typeName: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${typeName}:x`, typeName, ...extra }) as unknown as TLRecord
const diff = (d: Partial<RecordsDiff>): RecordsDiff => ({ added: {}, updated: {}, removed: {}, ...d })
const startView = { drStartView: { pageId: 'page:page', x: 0, y: 0, w: 100, h: 60 } }

describe('which local changes can change the thumbnail', () => {
  it('shapes, bindings, pages and assets, added, changed or removed', () => {
    for (const t of ['shape', 'binding', 'page', 'asset']) {
      expect(changesContent(diff({ added: { a: rec(t) } })), t).toBe(true)
      expect(changesContent(diff({ removed: { a: rec(t) } })), t).toBe(true)
      expect(changesContent(diff({ updated: { a: [rec(t), rec(t)] } })), t).toBe(true)
    }
  })

  it('not the user record tldraw writes when a board opens', () => {
    expect(changesContent(diff({ added: { u: rec('user') } }))).toBe(false)
    expect(changesContent(diff({ updated: { u: [rec('user'), rec('user', { name: 'B' })] } }))).toBe(false)
  })

  it("the document record only when the owner's start view changes", () => {
    const before = rec('document', { meta: {} })
    const withView = rec('document', { meta: startView })
    const settings = rec('document', { meta: { drWorkshop: { hideCursors: true } } })
    expect(changesContent(diff({ updated: { d: [before, withView] } }))).toBe(true)
    expect(changesContent(diff({ updated: { d: [withView, before] } }))).toBe(true)
    expect(changesContent(diff({ updated: { d: [before, settings] } }))).toBe(false)
    expect(changesContent(diff({}))).toBe(false)
  })
})
