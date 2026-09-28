import { describe, expect, it } from 'vitest'
import { ListBoardsWithThumbnailsResponse, ThumbnailVersion, thumbnailPath } from './index.ts'

const board = {
  id: 'b-abc123defg',
  workspaceId: 'wsp_0123456789abcdefghij',
  projectId: null,
  title: 'Retro',
  visibility: 'private',
  status: 'active',
  trashedAt: null,
  createdBy: 'usr_0123456789abcdefghij',
  createdAt: '2026-09-27T12:00:00.000Z',
  updatedAt: '2026-09-27T12:00:00.000Z',
  lastOpenedAt: null,
  role: 'owner',
}

describe('thumbnail contracts', () => {
  it('board lists carry thumbnailVersion and starred (parsed through the index re-export)', () => {
    const version = '0123456789abcdef01234567'
    const parsed = ListBoardsWithThumbnailsResponse.parse({
      boards: [{ ...board, starred: true, thumbnailVersion: version }],
    })
    expect(parsed.boards[0]).toMatchObject({ starred: true, thumbnailVersion: version })
    // An older server (no field): null, not a parse failure.
    expect(ListBoardsWithThumbnailsResponse.parse({ boards: [board] }).boards[0]).toMatchObject({
      starred: false,
      thumbnailVersion: null,
    })
    expect(
      ListBoardsWithThumbnailsResponse.safeParse({ boards: [{ ...board, thumbnailVersion: '../x' }] })
        .success,
    ).toBe(false)
  })

  it('versions are opaque lowercase hex; the image URL carries one as ?v=', () => {
    expect(ThumbnailVersion.safeParse('0123456789abcdef01234567').success).toBe(true)
    expect(ThumbnailVersion.safeParse('0123456789ABCDEF01234567').success).toBe(false)
    expect(thumbnailPath('b-abc123defg')).toBe('/api/boards/b-abc123defg/thumbnail')
    expect(thumbnailPath('b-abc123defg', 'ff00')).toBe('/api/boards/b-abc123defg/thumbnail?v=ff00')
    expect(thumbnailPath('b/../x', null)).toBe('/api/boards/b%2F..%2Fx/thumbnail')
  })
})
