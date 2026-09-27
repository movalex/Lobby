import type { TLAsset, TLAssetStore } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { trackUploads } from './uploads.ts'

const asset = { id: 'asset:a' } as TLAsset
const file = new File(['x'], 'x.png', { type: 'image/png' })

describe('trackUploads', () => {
  it('counts uploads while they run, including failed ones, and keeps the other methods', async () => {
    let finish: (v: { src: string }) => void = () => {}
    let fail: (e: Error) => void = () => {}
    const calls: string[] = []
    const base: TLAssetStore = {
      upload: (_a, f) =>
        new Promise((resolve, reject) => {
          calls.push(f.name)
          if (calls.length === 1) finish = resolve
          else fail = reject
        }),
      resolve: () => 'resolved',
    }
    const { store, inFlight } = trackUploads(base)
    expect(inFlight.get()).toBe(0)
    const first = store.upload(asset, file)
    const second = store.upload(asset, file).catch((e: Error) => e.message)
    expect(inFlight.get()).toBe(2)
    finish({ src: '/files/ok' })
    await expect(first).resolves.toEqual({ src: '/files/ok' })
    expect(inFlight.get()).toBe(1)
    fail(new Error('boom'))
    await expect(second).resolves.toBe('boom')
    expect(inFlight.get()).toBe(0)
    expect(store.resolve?.(asset, {} as never)).toBe('resolved')
  })
})
