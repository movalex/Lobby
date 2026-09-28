// The dashboard sidebar's storage line ("Storage: 1.2 GB of 100 GB"): the byte formatting.
import { describe, expect, it } from 'vitest'
import { formatStorage } from './Sidebar.tsx'

const MB = 1024 * 1024
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
