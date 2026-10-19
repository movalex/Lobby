// scripts/nas-pg-api.sh (the wave V integration): two runs at once must not touch each other. In wave V two
// workstreams' runs removed each other's draftroom-pg* containers and folder, which had fixed names. These run the
// script dry (DRY_RUN=1, the default: every SSH command is printed, nothing reaches the NAS) and read what it would do:
// every name it creates or removes carries its run id, it takes the NAS lock (an atomic mkdir) before it creates
// anything, and its cleanup removes only its own names and releases the lock only while it holds it. The fix wave
// (review m8): run ids are strict (never `lock`, never another id plus -install/-test/-net), and --remove takes the
// same lock and refuses while the run it removes is live.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'nas-pg-api.sh')
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
const hasGit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).status === 0

const RUN_A = 'r-20261019120000-testa'
const RUN_B = 'r-20261019120000-testb'
const LOCK = '/volume3/Apps/draftroom-pg-runs/lock'

/** Runs the script dry; its status and the commands it would send to the NAS, one per line. */
function dry(args: string[], runId?: string): { status: number | null; cmds: string[]; stderr: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DRY_RUN: '1',
    EVIDENCE_DIR: mkdtempSync(join(tmpdir(), 'nas-pg-dry-')),
  }
  delete env.RUN_ID
  if (runId !== undefined) env.RUN_ID = runId
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
  // the run's log holds every command (a suite's own output goes to its file, the log gets the command too)
  const dir = env.EVIDENCE_DIR ?? ''
  const log = readdirSync(dir).find((f) => /^nas-pg-.*\.log$/.test(f)) ?? ''
  const cmds = log
    ? readFileSync(join(dir, log), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\d\d:\d\d:\d\d /, ''))
        .filter((l) => l.startsWith('[dry-run]'))
        .map((l) => l.replace(/^\[dry-run\] (<stdin> \| )?ssh \S+ -- /, ''))
    : []
  return { status: r.status, cmds, stderr: r.stderr }
}
function dryRun(args: string[], runId?: string): string[] {
  const r = dry(args, runId)
  expect(r.status, r.stderr).toBe(0)
  return r.cmds
}

/** What a command removes: container, network and folder names. */
const removals = (cmds: string[]) =>
  cmds.flatMap((c) => [
    ...[...c.matchAll(/docker rm -f (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/docker network rm (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/rm -rf -- (\S+?);?(?:\s|$)/g)].map((m) => m[1] ?? ''),
  ])

const lockTakenAt = (cmds: string[]) =>
  cmds.findIndex((c) => /mkdir \/volume3\/Apps\/draftroom-pg-runs\/lock 2>\/dev\/null/.test(c))

describe.skipIf(!hasBash || !hasGit)('nas-pg-api.sh: one run never touches another', () => {
  it('names everything it makes after its run id, takes the lock before it makes anything, removes only its own', () => {
    const cmds = dryRun(['HEAD', '--only', 'db'], RUN_A)
    const lockAt = lockTakenAt(cmds)
    const firstMade = cmds.findIndex((c) => /docker run|docker network create|mkdir -p \S+\/src/.test(c))
    expect(lockAt).toBeGreaterThan(-1)
    expect(firstMade).toBeGreaterThan(lockAt)
    // what it creates
    const made = cmds.flatMap((c) => [
      ...[...c.matchAll(/--name (\S+)/g)].map((m) => m[1] ?? ''),
      ...[...c.matchAll(/docker network create --internal (\S+)/g)].map((m) => m[1] ?? ''),
    ])
    expect(made.sort()).toEqual([
      `draftroom-pg-${RUN_A}`,
      `draftroom-pg-${RUN_A}-install`,
      `draftroom-pg-${RUN_A}-net`,
      `draftroom-pg-${RUN_A}-test`,
    ])
    // what it removes: its own names, its own folder, and the lock only behind an owner check of its id
    const removed = removals(cmds)
    expect(removed.length).toBeGreaterThan(0)
    for (const name of removed)
      expect([
        `draftroom-pg-${RUN_A}`,
        `draftroom-pg-${RUN_A}-install`,
        `draftroom-pg-${RUN_A}-net`,
        `draftroom-pg-${RUN_A}-test`,
        `/volume3/Apps/draftroom-pg-runs/${RUN_A}`,
        LOCK,
      ]).toContain(name)
    const lockRemoval = cmds.filter((c) => c.includes(`rm -rf -- ${LOCK}`))
    expect(lockRemoval).toHaveLength(1)
    expect(lockRemoval[0]).toContain(`= '${RUN_A}' ]`)
    // the names of the script before run ids are never removed, nor anything outside draftroom-pg
    expect(removed).not.toContain('draftroom-pg')
    expect(removed).not.toContain('draftroom-pg-net')
    expect(removed).not.toContain('/volume3/Apps/draftroom-pg')
    expect(cmds.join('\n')).not.toMatch(/prune|docker ps -aq|compose down|systemctl|docker rmi/)
  })

  it('the default run id is r-<time>-<random> and passes its own rule', () => {
    const cmds = dryRun(['HEAD', '--only', 'db'])
    const pg = cmds.flatMap((c) => [...c.matchAll(/--name (draftroom-pg-\S+?)(?:-install|-test)?\s/g)])
    expect(pg.length).toBeGreaterThan(0)
    for (const m of pg) expect(m[1]).toMatch(/^draftroom-pg-r-[0-9]{14}-[a-z0-9]{4,16}$/)
  })

  it('a run id that is lock, a reserved name or another id plus -install, -test or -net is refused before anything (review m8)', () => {
    for (const id of [
      'lock',
      'LOCK',
      'runs',
      `${RUN_A}-install`,
      `${RUN_A}-test`,
      `${RUN_A}-net`,
      'r-2026101912000-short',
      'r-20261019120000-abc',
      'r-20261019120000-ABCD',
      'test-run-a',
      'Bad;id',
    ]) {
      const asRun = dry(['HEAD', '--only', 'db'], id)
      expect([id, asRun.status]).toEqual([id, 2])
      expect(asRun.cmds).toEqual([])
      const asRemove = dry(['--remove', id])
      expect([id, asRemove.status]).toEqual([id, 2])
      expect(asRemove.cmds).toEqual([])
    }
  })

  it('--remove <run> takes the NAS lock first (as its own id), removes that run and nothing else, and releases only its own lock (review m8)', () => {
    const cmds = dryRun(['--remove', RUN_B])
    const lockAt = lockTakenAt(cmds)
    const firstRemoval = cmds.findIndex((c) => /docker rm -f|docker network rm|rm -rf --/.test(c))
    expect(lockAt).toBeGreaterThan(-1)
    expect(firstRemoval).toBeGreaterThan(lockAt)
    // the remover's lock owner line is its own id, never the run's (so it cannot release a lock that run holds)
    const remover = cmds[lockAt]?.match(/echo '(r-[0-9]{14}-[a-z0-9]{4,16}) '/)?.[1] ?? ''
    expect(remover).toMatch(/^r-[0-9]{14}-[a-z0-9]{4,16}$/)
    expect(remover).not.toBe(RUN_B)
    expect(removals(cmds).sort()).toEqual([
      LOCK,
      `/volume3/Apps/draftroom-pg-runs/${RUN_B}`,
      `draftroom-pg-${RUN_B}`,
      `draftroom-pg-${RUN_B}-install`,
      `draftroom-pg-${RUN_B}-net`,
      `draftroom-pg-${RUN_B}-test`,
    ])
    const lockRemoval = cmds.filter((c) => c.includes(`rm -rf -- ${LOCK}`))
    expect(lockRemoval).toHaveLength(1)
    expect(lockRemoval[0]).toContain(`= '${remover}' ]`)
    expect(lockRemoval[0]).not.toContain(`= '${RUN_B}' ]`)
    // a kept run of the script before the rule (<14 digits>-<pid>-<random>) can still be removed
    expect(removals(dryRun(['--remove', '20261019053812-4242-17']))).toContain(
      'draftroom-pg-20261019053812-4242-17',
    )
  })

  it('the script says why: the lock, the stale takeover and the refusals while another run, or the run to remove, is live', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    expect(text).toContain('STOP: another run holds the NAS lock')
    expect(text).toContain('STOP: a run of the script before run ids is live')
    expect(text).toContain('STOP: run $RUN is live: it holds the NAS lock')
    expect(text).toMatch(/LOCK_STALE_S="\$\{LOCK_STALE_S:-21600\}"/)
    // WS4's fix stays: a preflight STOP disarms the cleanup
    expect(text.match(/\{ trap - EXIT; log "STOP: less than/g)).toHaveLength(2)
    // --remove goes through the same lock as a run
    expect(text).toMatch(/if \[\[ "\$DRY_RUN" == "0" \]\]; then acquire_lock; else lock_try >\/dev\/null; fi/)
  })
})
