// CRIT-38: the paste check on Excalidraw's own clipboard (content.ts filesBoardCannotShow, withoutElements)
// and the read-only drop notice.
import { describe, expect, it } from 'vitest'
import {
  type ClipboardElement,
  filesBoardCannotShow,
  filesLeftOutNotice,
  type PastedFile,
  readOnlyDropNotice,
  withoutElements,
} from './content.ts'

const VER = (n: number) => `ver_${String(n).padStart(20, '0')}`
const AST = (n: number) => `ast_${String(n).padStart(20, '0')}`

const image = (id: string, n: number, opts: { fileId?: string; facts?: unknown } = {}): ClipboardElement => ({
  id,
  type: 'image',
  fileId: opts.fileId ?? VER(n),
  customData: {
    lobby: { file: opts.facts === undefined ? { assetId: AST(n), versionId: VER(n) } : opts.facts },
  },
})
const note = (id: string): ClipboardElement => ({ id, type: 'stickynote' })

function checker(servable: Record<string, boolean | null | 'throw'>, known: string[] = []) {
  const asked: PastedFile[] = []
  return {
    asked,
    check: {
      known: (v: string) => known.includes(v),
      servable: async (f: PastedFile) => {
        asked.push(f)
        const answer = servable[f.versionId]
        if (answer === 'throw') throw new Error('network')
        return answer ?? null
      },
    },
  }
}

describe('filesBoardCannotShow', () => {
  it('leaves out the files the board cannot show, and only those', async () => {
    const { check, asked } = checker({ [VER(1)]: true, [VER(2)]: false })
    const drop = await filesBoardCannotShow([note('n'), image('a', 1), image('b', 2)], check)
    expect([...drop]).toEqual(['b'])
    expect(asked).toEqual([
      { assetId: AST(1), versionId: VER(1) },
      { assetId: AST(2), versionId: VER(2) },
    ])
  })

  it('does not ask about a version this board already shows, and asks once per version', async () => {
    const { check, asked } = checker({ [VER(2)]: false }, [VER(1)])
    const drop = await filesBoardCannotShow(
      [image('a', 1), image('b', 2), image('c', 2, { fileId: `${VER(2)}@display` })],
      check,
    )
    expect([...drop].sort()).toEqual(['b', 'c'])
    expect(asked).toEqual([{ assetId: AST(2), versionId: VER(2) }])
  })

  it('a placed PDF page is checked by its PDF version', async () => {
    const { check, asked } = checker({ [VER(3)]: false })
    const page = image('p', 3, { fileId: `${VER(3)}.p2` })
    expect([...(await filesBoardCannotShow([page], check))]).toEqual(['p'])
    expect(asked).toEqual([{ assetId: AST(3), versionId: VER(3) }])
  })

  it('another app’s images (no Lobby version) and missing or mismatched facts are left out unasked', async () => {
    const { check, asked } = checker({})
    const drop = await filesBoardCannotShow(
      [
        { id: 'x', type: 'image', fileId: 'a1b2c3d4e5f6' },
        { id: 'y', type: 'image', fileId: null },
        image('z', 4, { facts: null }),
        image('w', 5, { facts: { assetId: AST(5), versionId: VER(6) } }),
        image('v', 7, { facts: { assetId: 'not-an-asset', versionId: VER(7) } }),
      ],
      check,
    )
    expect([...drop].sort()).toEqual(['v', 'w', 'x', 'y', 'z'])
    expect(asked).toEqual([])
  })

  it('a version on this board passes without facts (the room fills them in)', async () => {
    const { check } = checker({}, [VER(8)])
    expect((await filesBoardCannotShow([image('a', 8, { facts: null })], check)).size).toBe(0)
  })

  it('an answer it could not get keeps the file (the room decides)', async () => {
    const { check } = checker({ [VER(1)]: null, [VER(2)]: 'throw' })
    expect((await filesBoardCannotShow([image('a', 1), image('b', 2)], check)).size).toBe(0)
  })
})

describe('withoutElements', () => {
  it('removes the dropped elements and every binding to them', () => {
    const arrow = {
      id: 'arrow',
      type: 'arrow',
      startBinding: { elementId: 'img' },
      endBinding: { elementId: 'n1' },
    }
    const n1 = { id: 'n1', type: 'stickynote', boundElements: [{ id: 'arrow', type: 'arrow' }] }
    const img = { id: 'img', type: 'image', boundElements: [{ id: 'arrow', type: 'arrow' }] }
    const box = {
      id: 'box',
      type: 'rectangle',
      boundElements: [
        { id: 'img', type: 'arrow' },
        { id: 'label', type: 'text' },
      ],
    }
    const lone = { id: 'lone', type: 'rectangle', boundElements: [{ id: 'img', type: 'arrow' }] }
    const out = withoutElements<ClipboardElement>([arrow, n1, img, box, lone], new Set(['img']))
    expect(out.map((e) => e.id)).toEqual(['arrow', 'n1', 'box', 'lone'])
    expect(out[0]).toEqual({ ...arrow, startBinding: null })
    expect(out[1]).toBe(n1) // untouched elements are passed through as they are
    expect(out[2]?.boundElements).toEqual([{ id: 'label', type: 'text' }])
    expect(out[3]?.boundElements).toBeNull()
  })

  it('an empty drop set keeps the paste', () => {
    const els = [note('a'), note('b')]
    expect(withoutElements(els, new Set())).toEqual(els)
  })
})

describe('notices', () => {
  it('say how many files were left out and why', () => {
    expect(filesLeftOutNotice(1)).toMatch(/^One image or file was left out .* another board. Upload it/)
    expect(filesLeftOutNotice(3)).toMatch(/^3 images or files were left out .* Upload them/)
  })

  it('a read-only drop says what the person can do, an archived board why nothing can be added', () => {
    expect(readOnlyDropNotice('files', false)).toBe('You can view this board but not add files to it.')
    expect(readOnlyDropNotice('text', false)).toBe('You can view this board but not add to it.')
    expect(readOnlyDropNotice('url', true)).toBe('This board is archived, so nothing can be added to it.')
  })
})
