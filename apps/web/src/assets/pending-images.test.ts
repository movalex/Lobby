import { describe, expect, it } from 'vitest'
import { cssString, pendingImageAssets, pendingNamesCss, whilePending } from './pending-images.ts'

describe('F8: pending image tiles', () => {
  it('lists an asset while a resolve waits on it (concurrent resolves counted)', async () => {
    let finishA: (v: string) => void = () => {}
    let finishB: (v: string) => void = () => {}
    const a = whilePending('asset:1', new Promise<string>((r) => (finishA = r)))
    const b = whilePending('asset:1', new Promise<string>((r) => (finishB = r)))
    expect([...pendingImageAssets.get()]).toEqual(['asset:1'])
    finishA('a')
    expect(await a).toBe('a')
    expect(pendingImageAssets.get().has('asset:1')).toBe(true)
    finishB('b')
    expect(await b).toBe('b')
    expect(pendingImageAssets.get().size).toBe(0)
  })

  it('stops listing it when the wait fails', async () => {
    await expect(whilePending('asset:2', Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(pendingImageAssets.get().has('asset:2')).toBe(false)
  })

  it('escapes file names so they can never leave the CSS string', () => {
    expect(cssString('photo.jpg')).toBe('"photo.jpg"')
    const hostile = 'a"; } body { display: none } </style><script>x</script>\\\n.png'
    const out = cssString(hostile)
    // One string token: starts and ends with a quote, and no unescaped quote, brace-closing or tag.
    expect(out.startsWith('"') && out.endsWith('"')).toBe(true)
    const inner = out.slice(1, -1)
    expect(inner).not.toMatch(/(^|[^\\])"/)
    expect(inner).not.toContain('<')
    expect(inner).not.toContain('\n')
    expect(cssString('café 写真.png')).toBe('"caf\\e9  \\5199 \\771f .png"')
  })

  it('writes one rule per pending shape, keyed by the shape id', () => {
    const css = pendingNamesCss([{ shapeId: 'shape:abc', name: 'moodboard-01.jpg' }])
    expect(css).toBe('.tl-shape[data-shape-id="shape:abc"] { --dr-pending-name: "moodboard-01.jpg"; }')
    expect(pendingNamesCss([{ shapeId: 'shape:x', name: '' }])).toContain('--dr-pending-name: "Image"')
  })
})
