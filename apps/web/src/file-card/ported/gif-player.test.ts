// F9 / FIL-08: which elements the GIF player is for, and which request opens it. The browser path (the chip,
// the double-click, the overlay and its still on the canvas) is e2e/excalidraw/c3-polish.spec.ts.
import { describe, expect, it, vi } from 'vitest'
import { createFeatureRegistries } from '../../canvas/api/index.ts'
import { closeGifPlayer, gifPlayerRequest, isGifElement, isGifFacts, openGifPlayer } from './gif-player.tsx'

const AST = 'ast_AAAAAAAAAAAAAAAAAAAA'
const VER = 'ver_BBBBBBBBBBBBBBBBBBBB'
const file = (kind: string, mimeType: string) => ({
  assetId: AST,
  versionId: VER,
  kind,
  name: 'loop.gif',
  mimeType,
  sizeBytes: 1234,
})
const el = (fileId: string, f: unknown, over: Record<string, unknown> = {}) =>
  ({
    id: 'e1',
    type: 'image',
    fileId,
    customData: { lobby: { file: f } },
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...over,
  }) as never

describe('which files are GIFs', () => {
  it('an image file of type image/gif, in any case', () => {
    expect(isGifFacts({ kind: 'image', mimeType: 'image/gif' })).toBe(true)
    expect(isGifFacts({ kind: 'image', mimeType: 'IMAGE/GIF' })).toBe(true)
    expect(isGifFacts({ kind: 'image', mimeType: 'image/png' })).toBe(false)
    expect(isGifFacts({ kind: 'other', mimeType: 'image/gif' })).toBe(false)
    expect(isGifFacts(null)).toBe(false)
  })

  it('an element is one when it is a live image element, never a placed PDF page or a card', () => {
    expect(isGifElement(el(VER, file('image', 'image/gif')))).toBe(true)
    expect(isGifElement(el(`${VER}@display`, file('image', 'image/gif')))).toBe(true)
    expect(isGifElement(el(VER, file('image', 'image/png')))).toBe(false)
    expect(isGifElement(el(`${VER}.p1`, file('image', 'image/gif')))).toBe(false)
    expect(isGifElement(el(VER, file('pdf', 'application/pdf')))).toBe(false)
    expect(isGifElement(el(VER, file('image', 'image/gif'), { isDeleted: true }))).toBe(false)
    expect(isGifElement(null)).toBe(false)
    expect(isGifElement(el(VER, undefined))).toBe(false)
  })
})

describe('opening the player', () => {
  const ctxWith = (element: unknown, notify = vi.fn()) => {
    const registries = createFeatureRegistries()
    return {
      registries,
      notify,
      ctx: {
        registries,
        notify,
        role: 'editor',
        board: { id: 'b-test' },
        me: { user: { id: 'u-test' } },
        canvas: { get: () => element },
      } as never,
    }
  }

  it('opens for a GIF, with a fresh nonce each time, and closes', () => {
    const { ctx, registries } = ctxWith(el(VER, file('image', 'image/gif')))
    expect(gifPlayerRequest(registries).get()).toBeNull()
    expect(openGifPlayer(ctx, 'e1')).toBe(true)
    const first = gifPlayerRequest(registries).get()
    expect(first).toMatchObject({ id: 'e1' })
    openGifPlayer(ctx, 'e1')
    expect(gifPlayerRequest(registries).get()?.nonce).toBeGreaterThan(first?.nonce ?? 0)
    closeGifPlayer(registries)
    expect(gifPlayerRequest(registries).get()).toBeNull()
  })

  it('does nothing for an element that is not a GIF', () => {
    const { ctx, registries } = ctxWith(el(VER, file('image', 'image/png')))
    expect(openGifPlayer(ctx, 'e1')).toBe(false)
    expect(gifPlayerRequest(registries).get()).toBeNull()
  })
})
