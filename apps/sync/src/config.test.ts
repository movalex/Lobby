import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = { DRAFTROOM_DEV_AUTH: '1', DRAFTROOM_DATA_DIR: './.data-test' }

describe('loadConfig', () => {
  it('refuses to start without exactly DRAFTROOM_DEV_AUTH=1', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(() => loadConfig({ ...base, DRAFTROOM_DEV_AUTH: v })).toThrow(/DRAFTROOM_DEV_AUTH=1/)
    }
  })

  it('requires DRAFTROOM_DATA_DIR and resolves it to an absolute path', () => {
    expect(() => loadConfig({ DRAFTROOM_DEV_AUTH: '1' })).toThrow(/DRAFTROOM_DATA_DIR/)
    expect(loadConfig(base).dataDir).toBe(resolve('./.data-test'))
  })

  it('applies the contract defaults (empty values count as unset)', () => {
    const expected = { devAuth: true, host: '127.0.0.1', port: 5858, idleEvictMs: 30_000, textLeaseMs: 5_000 }
    expect(loadConfig(base)).toMatchObject(expected)
    expect(loadConfig({ ...base, HOST: '', PORT: ' ', TEXT_LEASE_MS: '' })).toMatchObject(expected)
  })

  it('reads HOST, PORT (0 = ephemeral), IDLE_EVICT_MS and TEXT_LEASE_MS', () => {
    expect(
      loadConfig({ ...base, HOST: '0.0.0.0', PORT: '0', IDLE_EVICT_MS: '250', TEXT_LEASE_MS: '1200' }),
    ).toMatchObject({ host: '0.0.0.0', port: 0, idleEvictMs: 250, textLeaseMs: 1_200 })
  })

  it('rejects malformed or out-of-range numbers instead of silently using NaN', () => {
    for (const [k, v] of [
      ['PORT', 'abc'],
      ['PORT', '-1'],
      ['PORT', '65536'],
      ['PORT', '80.5'],
      ['IDLE_EVICT_MS', '1e3'],
      ['TEXT_LEASE_MS', '0'],
      ['TEXT_LEASE_MS', '-5'],
    ] as const) {
      expect(() => loadConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(new RegExp(k))
    }
  })
})
