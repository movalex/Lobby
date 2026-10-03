// Unit tests for the e2e port resolution (ports.ts): the historical defaults, a base's three ports, the
// single-port overrides, and the refusal of every port Chromium will not connect to (a base that lands on
// 6566 used to fail only at the first navigation, net::ERR_UNSAFE_PORT).
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertBrowserSafePort, CHROMIUM_BLOCKED_PORTS, resolvePorts } from './ports.ts'

describe('resolvePorts', () => {
  it('keeps the historical ports when nothing is set', () => {
    expect(resolvePorts({})).toEqual({ portBase: null, syncPort: 5881, apiPort: 5882, webPort: 4191 })
  })

  it('puts sync on the base, the api on base + 1 and the web port on base + 2', () => {
    expect(resolvePorts({ E2E_PORT_BASE: '7460' })).toEqual({
      portBase: 7460,
      syncPort: 7460,
      apiPort: 7461,
      webPort: 7462,
    })
  })

  it('lets a single-port variable override one port', () => {
    const p = resolvePorts({ E2E_PORT_BASE: '7460', E2E_WEB_PORT: '7480' })
    expect([p.syncPort, p.apiPort, p.webPort]).toEqual([7460, 7461, 7480])
  })

  it('still refuses a port outside 1024..65535, a base without room for + 2, and a repeated port', () => {
    expect(() => resolvePorts({ E2E_PORT_BASE: '80' })).toThrow(/between 1024 and 65535/)
    expect(() => resolvePorts({ E2E_PORT_BASE: '65534' })).toThrow(/leave room/)
    expect(() => resolvePorts({ E2E_PORT_BASE: '7460', E2E_API_PORT: '7460' })).toThrow(/must differ/)
  })
})

describe('the Chromium blocked ports', () => {
  // the ones a run could plausibly land on from a base in the 4000-10100 range the repo's runs use
  const known = [4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]

  it.each(known)('refuses %i as the web port, whichever way it was chosen', (blocked) => {
    expect(() => resolvePorts({ E2E_WEB_PORT: String(blocked) })).toThrow(/ERR_UNSAFE_PORT/)
    expect(() => resolvePorts({ E2E_API_PORT: String(blocked) })).toThrow(/ERR_UNSAFE_PORT/)
    expect(() => resolvePorts({ E2E_SYNC_PORT: String(blocked) })).toThrow(/ERR_UNSAFE_PORT/)
  })

  it('refuses a base whose base, base + 1 or base + 2 is blocked, naming the role', () => {
    expect(() => resolvePorts({ E2E_PORT_BASE: '6566' })).toThrow(/sync port.*6566/)
    expect(() => resolvePorts({ E2E_PORT_BASE: '6565' })).toThrow(/api port.*6566/)
    expect(() => resolvePorts({ E2E_PORT_BASE: '6564' })).toThrow(/web port.*E2E_PORT_BASE \+ 2.*6566/)
    expect(() => resolvePorts({ E2E_PORT_BASE: '6663' })).toThrow(/6665/)
    expect(() => resolvePorts({ E2E_PORT_BASE: '6695' })).toThrow(/6697/)
  })

  it('accepts the neighbours of a blocked port and the ports the repo has used', () => {
    for (const ok of [6565, 6567, 6001, 5999, 6664, 6670, 6696, 6698, 4191, 5881, 5882, 7460, 7499]) {
      expect(CHROMIUM_BLOCKED_PORTS.has(ok)).toBe(false)
      expect(assertBrowserSafePort('a port', ok)).toBe(ok)
    }
    for (const base of [6400, 6430, 6480, 6560, 6590, 6600, 6800, 7850, 7460]) {
      expect(() => resolvePorts({ E2E_PORT_BASE: String(base) })).not.toThrow()
    }
  })

  it('lists only restricted ports at or above 1024 (the range check owns the rest)', () => {
    for (const p of CHROMIUM_BLOCKED_PORTS) expect(p).toBeGreaterThanOrEqual(1024)
  })

  // the module itself, as playwright.config.ts and the csp runners load it: the throw happens on import
  it('makes importing ports.ts throw for a blocked base, and not for a good one', () => {
    const file = pathToFileURL(fileURLToPath(new URL('./ports.ts', import.meta.url))).href
    const run = (base: string) =>
      spawnSync(
        process.execPath,
        ['-e', `import(${JSON.stringify(file)}).then((m) => console.log(m.WEB_PORT))`],
        {
          env: { ...process.env, E2E_PORT_BASE: base, E2E_SYNC_PORT: '', E2E_API_PORT: '', E2E_WEB_PORT: '' },
          encoding: 'utf8',
          windowsHide: true,
        },
      )
    const bad = run('6564')
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toMatch(/ERR_UNSAFE_PORT/)
    const good = run('7460')
    expect(good.status).toBe(0)
    expect(good.stdout.trim()).toBe('7462')
  })
})
