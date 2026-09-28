import { describe, expect, it } from 'vitest'
import {
  assertValidBlobKey,
  BlobStoreError,
  blobKeyProblem,
  blobKeys,
  isBlobStoreError,
  isValidBlobKey,
  MAX_PRESIGN_EXPIRES_SEC,
  presignedPutHeaders,
} from '../src/index.ts'

describe('blob keys', () => {
  it('accepts the contract keys and ordinary segments', () => {
    for (const k of [
      'assets/ast_3fKq0aZ9xY7wV5uT4sR2/ver_AbCdEfGhIjKlMnOpQrSt/original',
      'assets/ast_3fKq0aZ9xY7wV5uT4sR2/ver_AbCdEfGhIjKlMnOpQrSt/d/drv_0123456789abcdefghij.webp',
      'test/run-1/a-b_c.d',
      'x',
      'a'.repeat(255),
      'console/nullable/auxiliary', // device names only match whole segments (with any extension)
    ]) {
      expect(blobKeyProblem(k), k).toBeNull()
      expect(isValidBlobKey(k)).toBe(true)
    }
  })

  it('names the problem for each refused shape', () => {
    const cases: Array<[unknown, string]> = [
      [42, 'not a string'],
      ['', 'empty'],
      ['x'.repeat(513), 'too long'],
      ['/a', 'empty segment'],
      ['a/', 'empty segment'],
      ['a//b', 'empty segment'],
      [`a/${'b'.repeat(256)}`, 'segment too long'],
      ['a/b c', 'character outside'],
      ['a\\b', 'character outside'],
      ['a:b', 'character outside'],
      ['a/~tmp', 'character outside'],
      ['..', 'dot'],
      ['a/../b', 'dot'],
      ['a/.', 'dot'],
      ['a/.env', 'dot'],
      ['a/b.', 'dot'],
      ['CON', 'reserved device name'],
      ['a/nul.txt', 'reserved device name'],
      ['a/Com1', 'reserved device name'],
      ['lpt9.log/x', 'reserved device name'],
    ]
    for (const [k, problem] of cases) expect(blobKeyProblem(k), String(k)).toContain(problem)
  })

  it('assertValidBlobKey throws INVALID_KEY without echoing the key', () => {
    let err: unknown
    try {
      assertValidBlobKey('../../secret-name')
    } catch (e) {
      err = e
    }
    expect(isBlobStoreError(err, 'INVALID_KEY')).toBe(true)
    expect((err as Error).message.includes('secret-name')).toBe(false)
  })

  it('builds the contract keys and refuses ids that are not one segment', () => {
    expect(blobKeys.original('ast_a1', 'ver_b2')).toBe('assets/ast_a1/ver_b2/original')
    expect(blobKeys.derivative('ast_a1', 'ver_b2', 'drv_c3', 'webp')).toBe(
      'assets/ast_a1/ver_b2/d/drv_c3.webp',
    )
    expect(blobKeys.derivative('ast_a1', 'ver_b2', 'drv_c3', 'png')).toBe('assets/ast_a1/ver_b2/d/drv_c3.png')
    expect(() => blobKeys.original('ast_a1/..', 'ver_b2')).toThrow(BlobStoreError)
    expect(() => blobKeys.original('ast_a1', 'x/y')).toThrow(BlobStoreError)
    expect(() => blobKeys.original('', 'ver_b2')).toThrow(BlobStoreError)
    expect(() => blobKeys.derivative('ast_a1', 'ver_b2', 'drv_c3', 'svg' as 'png')).toThrow(BlobStoreError)
  })

  it('presignedPutHeaders gives exactly the signed headers', () => {
    expect(presignedPutHeaders({ contentType: 'image/webp', contentLength: 12 })).toEqual({
      'Content-Type': 'image/webp',
      'Content-Length': '12',
    })
    expect(presignedPutHeaders({ contentType: 'image/png' })).toEqual({ 'Content-Type': 'image/png' })
    expect(() => presignedPutHeaders({ contentType: 'a\nb' })).toThrow(BlobStoreError)
    expect(MAX_PRESIGN_EXPIRES_SEC).toBe(900)
  })
})
