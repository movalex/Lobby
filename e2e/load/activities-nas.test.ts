// e2e/load/activities-nas.sh (the wave V fix wave): the NAS load run has the run-id and lock safety of
// scripts/nas-pg-api.sh (review g1 and m8). Run dry (DRY_RUN=1, the default: every SSH command is printed, nothing
// reaches the NAS): every name it creates or removes carries its run id, it takes the NAS lock before it creates
// anything, its cleanup removes only its own names and releases the lock only while it holds it, reserved and colliding
// ids are refused, and --remove takes the same lock as its own id.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'e2e', 'load', 'activities-nas.sh')
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
const hasGit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).status === 0

const RUN = 'r-20261019120000-loada'
const LOCK = '/volume3/Apps/draftroom-load-runs/lock'

function dry(args: string[], runId?: string): { status: number | null; cmds: string[]; stderr: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DRY_RUN: '1',
    EVIDENCE_DIR: mkdtempSync(join(tmpdir(), 'nas-load-dry-')),
  }
  delete env.RUN_ID
  if (runId !== undefined) env.RUN_ID = runId
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
  const dir = env.EVIDENCE_DIR ?? ''
  const log = readdirSync(dir).find((f) => /^nas-load-.*\.log$/.test(f)) ?? ''
  const cmds = log
    ? readFileSync(join(dir, log), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\d\d:\d\d:\d\d /, ''))
        .filter((l) => l.startsWith('[dry-run]'))
        .map((l) => l.replace(/^\[dry-run\] (<stdin> \| )?ssh \S+ -- /, ''))
    : []
  return { status: r.status, cmds, stderr: r.stderr }
}

const removals = (cmds: string[]) =>
  cmds.flatMap((c) => [
    ...[...c.matchAll(/docker rm -f (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/docker network rm (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/rm -rf -- (\S+?);?(?:\s|$)/g)].map((m) => m[1] ?? ''),
  ])

const OWN = [
  `draftroom-load-${RUN}`,
  `draftroom-load-${RUN}-install`,
  `draftroom-load-${RUN}-api`,
  `draftroom-load-${RUN}-run`,
  `draftroom-load-${RUN}-net`,
]

// a dry run still lists the commit's archive (git archive | tar -t): seconds on Windows
describe.skipIf(!hasBash || !hasGit)(
  'activities-nas.sh: one load run never touches another',
  { timeout: 120_000 },
  () => {
    it('names everything it makes after its run id, takes the lock before it makes anything, removes only its own', () => {
      const r = dry(['HEAD', '--participants', '2', '--bursts', '1'], RUN)
      expect(r.status, r.stderr).toBe(0)
      const lockAt = r.cmds.findIndex((c) => c.includes(`mkdir ${LOCK} 2>/dev/null`))
      const firstMade = r.cmds.findIndex((c) => /docker run|docker network create|mkdir -p \S+\/src/.test(c))
      expect(lockAt).toBeGreaterThan(-1)
      expect(firstMade).toBeGreaterThan(lockAt)
      const made = r.cmds.flatMap((c) => [
        ...[...c.matchAll(/--name (\S+)/g)].map((m) => m[1] ?? ''),
        ...[...c.matchAll(/docker network create --internal (\S+)/g)].map((m) => m[1] ?? ''),
      ])
      // (the load command shows twice in a dry run's log: its own line, and the summary grep of its output)
      expect([...new Set(made)].sort()).toEqual([...OWN].sort())
      // the api is reached and the database named by this run's names only
      expect(r.cmds.join('\n')).toContain(`--api http://draftroom-load-${RUN}-api:3101`)
      const removed = removals(r.cmds)
      expect(removed.length).toBeGreaterThan(0)
      for (const name of removed)
        expect([...OWN, `/volume3/Apps/draftroom-load-runs/${RUN}`, LOCK]).toContain(name)
      const lockRemoval = r.cmds.filter((c) => c.includes(`rm -rf -- ${LOCK}`))
      expect(lockRemoval).toHaveLength(1)
      expect(lockRemoval[0]).toContain(`= '${RUN}' ]`)
      // never the fixed names of the script before run ids, never anything outside draftroom-load
      for (const fixed of ['draftroom-load-pg', 'draftroom-load-net', '/volume3/Apps/draftroom-load'])
        expect(removed).not.toContain(fixed)
      expect(r.cmds.join('\n')).not.toMatch(/prune|docker ps -aq|compose down|systemctl|docker rmi/)
    })

    it('refuses lock, reserved names and colliding ids before any command', () => {
      for (const id of ['lock', 'runs', `${RUN}-api`, `${RUN}-run`, `${RUN}-net`, 'draftroom', 'Bad;id']) {
        const asRun = dry(['HEAD'], id)
        expect([id, asRun.status]).toEqual([id, 2])
        expect(asRun.cmds).toEqual([])
        const asRemove = dry(['--remove', id])
        expect([id, asRemove.status]).toEqual([id, 2])
        expect(asRemove.cmds).toEqual([])
      }
    })

    it('--remove takes the lock first as its own id, removes that run only, and releases only its own lock', () => {
      const r = dry(['--remove', RUN])
      expect(r.status, r.stderr).toBe(0)
      const lockAt = r.cmds.findIndex((c) => c.includes(`mkdir ${LOCK} 2>/dev/null`))
      const firstRemoval = r.cmds.findIndex((c) => /docker rm -f|docker network rm|rm -rf --/.test(c))
      expect(lockAt).toBeGreaterThan(-1)
      expect(firstRemoval).toBeGreaterThan(lockAt)
      const remover = r.cmds[lockAt]?.match(/echo '(r-[0-9]{14}-[a-z0-9]{4,16}) '/)?.[1] ?? ''
      expect(remover).toMatch(/^r-[0-9]{14}-[a-z0-9]{4,16}$/)
      expect(remover).not.toBe(RUN)
      expect(removals(r.cmds).sort()).toEqual(
        [...OWN, LOCK, `/volume3/Apps/draftroom-load-runs/${RUN}`].sort(),
      )
      const lockRemoval = r.cmds.filter((c) => c.includes(`rm -rf -- ${LOCK}`))
      expect(lockRemoval).toHaveLength(1)
      expect(lockRemoval[0]).toContain(`= '${remover}' ]`)
    })

    it('the script says why it stops', () => {
      const text = readFileSync(SCRIPT, 'utf8')
      expect(text).toContain('STOP: another run holds the NAS lock')
      expect(text).toContain('STOP: a run of the script before run ids is live')
      expect(text).toContain('STOP: run $RUN is live: it holds the NAS lock')
      expect(text.match(/\{ trap - EXIT; log "STOP: less than/g)).toHaveLength(2)
    })
  },
)
