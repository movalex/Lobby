// The dashboard sidebar's storage meter ("Storage: 1.2 GB of 100 GB"): the byte formatting, and what
// the meter and its breakdown say (DANA-14), plus the sidebar's project wording (DANA-08).
import type { WorkspaceStorage } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { SIGN_IN_TAGLINE } from '../auth/SignInPage.tsx'
import { formatStorage, PROJECTS_HEADING, PROJECTS_HINT, storageSummary } from './Sidebar.tsx'

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

describe('formatStorage', () => {
  it('uses the units the quota messages use (binary, one decimal in GB, whole MB and KB)', () => {
    expect(formatStorage(0)).toBe('0 MB')
    expect(formatStorage(1)).toBe('1 KB')
    expect(formatStorage(12 * 1024 + 300)).toBe('12 KB')
    expect(formatStorage(MB)).toBe('1 MB')
    expect(formatStorage(250.4 * MB)).toBe('250 MB')
    expect(formatStorage(1.2 * GB)).toBe('1.2 GB')
    expect(formatStorage(1.25 * GB)).toBe('1.3 GB')
    expect(formatStorage(100 * GB)).toBe('100 GB')
    expect(formatStorage(102_400 * MB)).toBe('100 GB') // staging: DRAFTROOM_WORKSPACE_QUOTA_MB=102400
  })
})

const storage = (used: number, over: Partial<WorkspaceStorage> = {}): WorkspaceStorage => ({
  workspaceId: 'w-1',
  usedBytes: used,
  quotaBytes: 2 * GB,
  files: 3,
  maxFiles: 10_000,
  breakdown: { originals: used, previews: 0, thumbnails: 0 },
  boards: { count: 1, max: 10_000 },
  ...over,
})

describe('storageSummary (DANA-14)', () => {
  it('labels the meter and lists the breakdown the tooltip used to hide', () => {
    const s = storageSummary(
      storage(3 * KB + 5 * MB, { breakdown: { originals: 5 * MB, previews: 0, thumbnails: 3 * KB } }),
    )
    expect(s.label).toBe('Storage: 5 MB of 2 GB')
    expect(s.level).toBe('ok')
    expect(s.share).toBe("Less than 1% of this workspace's storage is in use")
    expect(s.rows).toEqual([
      { label: 'Uploaded files', value: '5 MB' },
      { label: 'File previews', value: '0 MB' },
      { label: 'Board thumbnails', value: '3 KB' },
      { label: 'Files', value: '3 of 10,000' },
    ])
    expect(s.note).toBeNull()
  })

  it('shows a sliver as soon as anything is stored, and nothing for an empty workspace', () => {
    expect(storageSummary(storage(0)).fill).toBe(0)
    expect(storageSummary(storage(0)).share).toBe("0% of this workspace's storage is in use")
    expect(storageSummary(storage(3 * KB)).fill).toBe(2)
    expect(storageSummary(storage(GB)).fill).toBe(50)
    expect(storageSummary(storage(GB)).share).toBe("50% of this workspace's storage is in use")
  })

  it('warns near the quota and at it', () => {
    expect(storageSummary(storage(1.9 * GB)).level).toBe('near')
    const full = storageSummary(storage(2.2 * GB))
    expect(full.level).toBe('full')
    expect(full.fill).toBe(100)
    expect(full.share).toBe("100% of this workspace's storage is in use")
  })

  it('mentions files no board uses any more (owners see the collector summary)', () => {
    const gc = {
      mode: 'report' as const,
      graceDays: 7,
      inFlightDays: 1,
      lastRun: null,
      unreferenced: { versions: 2, bytes: 3 * MB },
      eligible: { versions: 0, bytes: 0 },
    }
    expect(storageSummary(storage(MB, { gc })).note).toBe(
      '2 unused files (3 MB) that no board uses any more.',
    )
  })
})

describe('project wording (DANA-08)', () => {
  it('names projects as the lobbies the sign-in page promises, without promising they exist already', () => {
    expect(PROJECTS_HEADING).toBe('Project lobbies')
    expect(PROJECTS_HINT).toMatch(/lobby/)
    expect(SIGN_IN_TAGLINE).toMatch(/a lobby for each DBC project/)
    expect(SIGN_IN_TAGLINE).not.toMatch(/gets its own/)
  })
})
