// G2: the Share dialog never waits on the clipboard. A write that rejects (no permission, no focus) or
// never answers (an unfocused window, a permission prompt) must settle as "couldn't copy" within the
// timeout, so the "Creating…" button and the new link do not depend on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPY_TIMEOUT_MS, copyBounded } from './share-copy.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const stubClipboard = (writeText: (text: string) => Promise<void>) =>
  vi.stubGlobal('navigator', { clipboard: { writeText } })

/** The state of a promise right now, without waiting for it. */
async function settled<T>(p: Promise<T>): Promise<{ done: false } | { done: true; value: T }> {
  const pending = Symbol('pending')
  const v = await Promise.race([p, Promise.resolve(pending)])
  return v === pending ? { done: false } : { done: true, value: v as T }
}

describe('copyBounded', () => {
  it('true when the browser copies', async () => {
    const written: string[] = []
    stubClipboard(async (t) => void written.push(t))
    await expect(copyBounded('https://lobby.example/invite/abc')).resolves.toBe(true)
    expect(written).toEqual(['https://lobby.example/invite/abc'])
  })

  it('false at once when the browser refuses (a rejected write, e.g. "Document is not focused")', async () => {
    stubClipboard(() => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')))
    await expect(copyBounded('x')).resolves.toBe(false)
  })

  it('false when there is no clipboard API at all (an insecure context)', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyBounded('x')).resolves.toBe(false)
  })

  it('false after the timeout when the write never settles, and not before', async () => {
    stubClipboard(() => new Promise<void>(() => {}))
    const p = copyBounded('x')
    await vi.advanceTimersByTimeAsync(COPY_TIMEOUT_MS - 1)
    expect(await settled(p)).toEqual({ done: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(p)).toEqual({ done: true, value: false })
  })

  it('honours a shorter timeout and an injected copy', async () => {
    const p = copyBounded('x', 50, () => new Promise<boolean>(() => {}))
    await vi.advanceTimersByTimeAsync(50)
    expect(await settled(p)).toEqual({ done: true, value: false })
    await expect(copyBounded('x', 50, async () => true)).resolves.toBe(true)
    await expect(copyBounded('x', 50, async () => false)).resolves.toBe(false)
    await expect(
      copyBounded('x', 50, () => {
        throw new Error('sync throw')
      }),
    ).resolves.toBe(false)
  })

  it('a copy that succeeds after the timeout does not change the answer already given', async () => {
    let finish: (ok: boolean) => void = () => {}
    const p = copyBounded('x', 100, () => new Promise<boolean>((r) => (finish = r)))
    await vi.advanceTimersByTimeAsync(100)
    expect(await settled(p)).toEqual({ done: true, value: false })
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(await settled(p)).toEqual({ done: true, value: false })
  })

  it('leaves no timer behind once the copy answered', async () => {
    stubClipboard(async () => {})
    await copyBounded('x')
    expect(vi.getTimerCount()).toBe(0)
  })
})
