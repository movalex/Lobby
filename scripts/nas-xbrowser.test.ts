// scripts/nas-xbrowser.sh (the Firefox/WebKit runs on the NAS): the run-id and lock rules of scripts/nas-pg-api.sh
// (two runs at once never touch each other's containers or folder), plus what this script adds: the test container has
// no network, the only container with network is the install, the Playwright image is the commit's exact pin and is
// removed only when this run pulled it, and no argument reaches a NAS shell unquoted. These run the script dry
// (DRY_RUN=1, the default: every SSH command is printed, nothing reaches the NAS).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'nas-xbrowser.sh')
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
const hasGit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).status === 0

const RUN_A = 'r-20261019120000-ffa1'
const RUN_B = 'r-20261019120000-ffb1'
const RUNS = '/volume3/Apps/draftroom-load-ff-runs'
const LOCK = `${RUNS}/lock`

interface Dry {
  status: number | null
  cmds: string[]
  stderr: string
  dir: string
}
function dry(args: string[], runId?: string): Dry {
  const dir = mkdtempSync(join(tmpdir(), 'nas-xb-dry-'))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DRY_RUN: '1',
    EVIDENCE_DIR: dir,
  }
  delete env.RUN_ID
  if (runId !== undefined) env.RUN_ID = runId
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
  const log = readdirSync(dir).find((f) => /^nas-xbrowser-.*\.log$/.test(f)) ?? ''
  const cmds = log
    ? readFileSync(join(dir, log), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\d\d:\d\d:\d\d /, ''))
        .filter((l) => l.startsWith('[dry-run]'))
        .map((l) => l.replace(/^\[dry-run\] (<stdin> \| )?ssh \S+ -- /, ''))
    : []
  return { status: r.status, cmds, stderr: r.stderr, dir }
}
function dryOk(args: string[], runId?: string): Dry {
  const r = dry(args, runId)
  expect(r.status, r.stderr).toBe(0)
  return r
}
const removals = (cmds: string[]) =>
  cmds.flatMap((c) => [
    ...[...c.matchAll(/docker rm -f (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/docker network rm (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/rm -rf -- (\S+?);?(?:\s|$)/g)].map((m) => m[1] ?? ''),
  ])
const lockTakenAt = (cmds: string[]) => cmds.findIndex((c) => c.includes(`mkdir ${LOCK} 2>/dev/null`))

describe.skipIf(!hasBash || !hasGit)(
  'nas-xbrowser.sh: one run never touches another, and the browsers have no network',
  () => {
    it('names everything after its run id, takes the lock before it makes anything, removes only its own', () => {
      const { cmds } = dryOk(['HEAD', '--specs', 'xbrowser-smoke.spec.ts'], RUN_A)
      const lockAt = lockTakenAt(cmds)
      const firstMade = cmds.findIndex((c) => /docker run|docker pull|mkdir -p \S+\/src/.test(c))
      expect(lockAt).toBeGreaterThan(-1)
      expect(firstMade).toBeGreaterThan(lockAt)
      const made = cmds.flatMap((c) => [...c.matchAll(/--name (\S+)/g)].map((m) => m[1] ?? ''))
      expect(made.sort()).toEqual([`draftroom-load-ff-${RUN_A}-install`, `draftroom-load-ff-${RUN_A}-test`])
      for (const name of removals(cmds))
        expect([
          `draftroom-load-ff-${RUN_A}-install`,
          `draftroom-load-ff-${RUN_A}-test`,
          `${RUNS}/${RUN_A}`,
          LOCK,
        ]).toContain(name)
      const lockRemoval = cmds.filter((c) => c.includes(`rm -rf -- ${LOCK}`))
      expect(lockRemoval).toHaveLength(1)
      expect(lockRemoval[0]).toContain(`= '${RUN_A}' ]`)
      expect(cmds.join('\n')).not.toMatch(
        /prune|docker ps -aq|compose down|systemctl|docker rmi|network create/,
      )
    })

    it('only the install has network; the test container runs with --network none and publishes nothing', () => {
      const { cmds } = dryOk(['HEAD'], RUN_A)
      const runs = cmds.filter((c) => c.includes('docker run'))
      expect(runs).toHaveLength(2)
      const test = runs.find((c) => c.includes(`--name draftroom-load-ff-${RUN_A}-test`)) ?? ''
      const install = runs.find((c) => c.includes(`--name draftroom-load-ff-${RUN_A}-install`)) ?? ''
      expect(test).toContain('--network none')
      expect(install).not.toContain('--network')
      for (const c of runs)
        expect(c).not.toMatch(/\s(-p|--publish|--publish-all|-P)\s|--network host|--privileged/)
      // the image is the commit's exact @playwright/test pin
      const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
      const pin = ws.match(/^ {2}'@playwright\/test': (\d+\.\d+\.\d+)$/m)?.[1]
      expect(pin).toBeTruthy()
      for (const c of runs) expect(c).toContain(`'mcr.microsoft.com/playwright:v${pin}-noble'`)
    })

    it('the image goes only when this run pulled it (its marker) and no container uses it', () => {
      const text = readFileSync(SCRIPT, 'utf8')
      expect(text).toMatch(
        /docker image inspect '\$IMG' >\/dev\/null 2>&1 \|\| \{ docker pull '\$IMG' >\/dev\/null && echo '\$IMG' > \$S\/pulled-image/,
      )
      expect(text).toMatch(/docker ps -a --filter ancestor=\$img/)
      expect(text.match(/docker image rm/g)).toHaveLength(1)
    })

    it('specs, browsers and a grep reach the run script quoted; a bad one is refused before anything', () => {
      const r = dryOk(
        ['HEAD', '--browsers', 'firefox', '--specs', 'v1-poll.spec.ts', '--grep', "a (b) 'c'; rm -rf /"],
        RUN_A,
      )
      const inner = readFileSync(join(r.dir, `xb-inner-${RUN_A}.sh`), 'utf8')
      expect(inner).toContain(
        "--project=firefox excalidraw/v1-poll.spec.ts --grep a\\ \\(b\\)\\ \\'c\\'\\;\\ rm\\ -rf\\ /",
      )
      for (const bad of [
        ['--specs', '../x.spec.ts'],
        ['--specs', 'a.spec.ts;rm'],
        ['--browsers', 'firefox;id'],
        ['--browsers', 'edge'],
        ['--repeat-each', '0'],
        ['--repeat-each', '1;id'],
      ]) {
        const refused = dry(['HEAD', ...bad], RUN_A)
        expect([bad, refused.status]).toEqual([bad, 2])
        expect(refused.cmds).toEqual([])
      }
    })

    it('a run id that is lock, another id plus -install or -test, or not r-<time>-<random> is refused before anything', () => {
      for (const id of [
        'lock',
        'runs',
        `${RUN_A}-install`,
        `${RUN_A}-test`,
        'r-20261019120000-abc',
        'Bad;id',
      ]) {
        const asRun = dry(['HEAD'], id)
        expect([id, asRun.status]).toEqual([id, 2])
        expect(asRun.cmds).toEqual([])
        const asRemove = dry(['--remove', id])
        expect([id, asRemove.status]).toEqual([id, 2])
        expect(asRemove.cmds).toEqual([])
      }
    })

    it('--remove <run> takes the lock as its own id, removes that run only, and releases only its own lock', () => {
      const { cmds } = dryOk(['--remove', RUN_B])
      const lockAt = lockTakenAt(cmds)
      expect(lockAt).toBeGreaterThan(-1)
      expect(cmds.findIndex((c) => /docker rm -f|rm -rf --/.test(c))).toBeGreaterThan(lockAt)
      const remover = cmds[lockAt]?.match(/echo '(r-[0-9]{14}-[a-z0-9]{4,16}) '/)?.[1] ?? ''
      expect(remover).toMatch(/^r-[0-9]{14}-[a-z0-9]{4,16}$/)
      expect(remover).not.toBe(RUN_B)
      expect(removals(cmds).sort()).toEqual([
        LOCK,
        `${RUNS}/${RUN_B}`,
        `draftroom-load-ff-${RUN_B}-install`,
        `draftroom-load-ff-${RUN_B}-test`,
      ])
      const lockRemoval = cmds.filter((c) => c.includes(`rm -rf -- ${LOCK}`))
      expect(lockRemoval).toHaveLength(1)
      expect(lockRemoval[0]).toContain(`= '${remover}' ]`)
    })

    it('the script says why it stops: the lock, the stale takeover, a live run to remove, the disk, memory and folder caps', () => {
      const text = readFileSync(SCRIPT, 'utf8')
      expect(text).toContain('STOP: another run holds the NAS lock')
      expect(text).toContain('STOP: run $RUN is live: it holds the NAS lock')
      expect(text).toContain('STOP: the run folder is over its cap')
      expect(text).toMatch(/LOCK_STALE_S="\$\{LOCK_STALE_S:-21600\}"/)
      expect(text).toMatch(
        /if \[\[ "\$DRY_RUN" == "0" \]\]; then acquire_lock; else lock_try >\/dev\/null; fi/,
      )
      // a preflight STOP happens before the cleanup is armed
      const pre = text.indexOf('# 1. preflight')
      const armed = text.indexOf('else trap cleanup EXIT; fi')
      const stop = text.indexOf('STOP: less than $' + '{MIN_FREE_GB} GB free')
      expect(stop).toBeGreaterThan(pre)
      expect(stop).toBeLessThan(armed)
    })
  },
)
