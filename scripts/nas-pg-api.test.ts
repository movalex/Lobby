// scripts/nas-pg-api.sh (the wave V integration): two runs at once must not touch each other. In wave V two
// workstreams' runs removed each other's draftroom-pg* containers and folder, which had fixed names. These run the
// script dry (DRY_RUN=1, the default: every SSH command is printed, nothing reaches the NAS) and read what it would do:
// every name it creates or removes carries its run id, it takes the NAS lock (an atomic mkdir) before it creates
// anything, and its cleanup removes only its own names and releases the lock only while it holds it.
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

/** The commands a dry run would send to the NAS, one per line. */
function dryRun(args: string[], runId?: string): string[] {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DRY_RUN: '1',
    EVIDENCE_DIR: mkdtempSync(join(tmpdir(), 'nas-pg-dry-')),
  }
  if (runId) env.RUN_ID = runId
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
  expect(r.status, r.stderr).toBe(0)
  // the run's log holds every command (a suite's own output goes to its file, the log gets the command too)
  const dir = env.EVIDENCE_DIR ?? ''
  const log = readdirSync(dir).find((f) => /^nas-pg-.*\.log$/.test(f)) ?? ''
  return readFileSync(join(dir, log), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d\d:\d\d:\d\d /, ''))
    .filter((l) => l.startsWith('[dry-run]'))
    .map((l) => l.replace(/^\[dry-run\] (<stdin> \| )?ssh \S+ -- /, ''))
}

/** What a command removes: container, network and folder names. */
const removals = (cmds: string[]) =>
  cmds.flatMap((c) => [
    ...[...c.matchAll(/docker rm -f (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/docker network rm (\S+)/g)].map((m) => m[1] ?? ''),
    ...[...c.matchAll(/rm -rf -- (\S+?);?(?:\s|$)/g)].map((m) => m[1] ?? ''),
  ])

describe.skipIf(!hasBash || !hasGit)('nas-pg-api.sh: one run never touches another', () => {
  it('names everything it makes after its run id, takes the lock before it makes anything, removes only its own', () => {
    const cmds = dryRun(['HEAD', '--only', 'db'], 'test-run-a')
    const lockAt = cmds.findIndex((c) =>
      /mkdir \/volume3\/Apps\/draftroom-pg-runs\/lock 2>\/dev\/null/.test(c),
    )
    const firstMade = cmds.findIndex((c) => /docker run|docker network create|mkdir -p \S+\/src/.test(c))
    expect(lockAt).toBeGreaterThan(-1)
    expect(firstMade).toBeGreaterThan(lockAt)
    // what it creates
    const made = cmds.flatMap((c) => [
      ...[...c.matchAll(/--name (\S+)/g)].map((m) => m[1] ?? ''),
      ...[...c.matchAll(/docker network create --internal (\S+)/g)].map((m) => m[1] ?? ''),
    ])
    expect(made.sort()).toEqual([
      'draftroom-pg-test-run-a',
      'draftroom-pg-test-run-a-install',
      'draftroom-pg-test-run-a-net',
      'draftroom-pg-test-run-a-test',
    ])
    // what it removes: its own names, its own folder, and the lock only behind an owner check of its id
    const removed = removals(cmds)
    expect(removed.length).toBeGreaterThan(0)
    for (const name of removed)
      expect(name, name).toMatch(
        /^(draftroom-pg-test-run-a(-[a-z]+)?|\/volume3\/Apps\/draftroom-pg-runs\/(test-run-a|lock))$/,
      )
    const lockRemoval = cmds.filter((c) => c.includes('rm -rf -- /volume3/Apps/draftroom-pg-runs/lock'))
    expect(lockRemoval).toHaveLength(1)
    expect(lockRemoval[0]).toContain("= 'test-run-a' ]")
    // the names of the script before run ids are never removed, nor anything outside draftroom-pg
    expect(removed).not.toContain('draftroom-pg')
    expect(removed).not.toContain('draftroom-pg-net')
    expect(removed).not.toContain('/volume3/Apps/draftroom-pg')
    expect(cmds.join('\n')).not.toMatch(/prune|docker ps -aq|compose down|systemctl|docker rmi/)
  })

  it('--remove <run> removes that run and nothing else; a bad run id is refused', () => {
    const cmds = dryRun(['--remove', 'test-run-b'])
    expect(removals(cmds).sort()).toEqual([
      '/volume3/Apps/draftroom-pg-runs/lock',
      '/volume3/Apps/draftroom-pg-runs/test-run-b',
      'draftroom-pg-test-run-b',
      'draftroom-pg-test-run-b-install',
      'draftroom-pg-test-run-b-net',
      'draftroom-pg-test-run-b-test',
    ])
    const bad = spawnSync('bash', [SCRIPT, '--remove', 'Bad;id'], {
      cwd: ROOT,
      env: { ...process.env, DRY_RUN: '1', EVIDENCE_DIR: mkdtempSync(join(tmpdir(), 'nas-pg-dry-')) },
      encoding: 'utf8',
    })
    expect(bad.status).toBe(2)
  })

  it('the script says why: the lock, the stale takeover and the refusal while another run is live', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    expect(text).toContain('STOP: another run holds the NAS lock')
    expect(text).toContain('STOP: a run of the script before run ids is live')
    expect(text).toMatch(/LOCK_STALE_S="\$\{LOCK_STALE_S:-21600\}"/)
    // WS4's fix stays: a preflight STOP disarms the cleanup
    expect(text.match(/\{ trap - EXIT; log "STOP: less than/g)).toHaveLength(2)
  })
})
