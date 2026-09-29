// The spike B harness types (docs/EXCALIDRAW-MIGRATION.md §8.1, §8.6.2), frozen at the contracts step C0
// (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned. O3 implements them in
// `e2e/spike-b/support/**` (everything but this file and ports.ts); every owner's spec imports
// `harness` from `./harness.ts` and these types.
//
// Browsers are separate Chromium PROCESSES (not contexts of one browser), each signed in as a different
// dev user; a third check browser is a third Chromium process. Simultaneous actions are released by a
// barrier so they start within 20 ms of each other. After every check the harness compares every
// browser's element map, deleted elements included, with the test snapshot through hash.ts, and runs the
// invariant checker on the snapshot; a check whose `horizon` moved is invalid and re-run.

import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { PushRecord } from '../../../apps/web/src/canvas/sync/types.ts'
import type { Violation } from '../../../packages/canvas-schema/src/invariants.ts'
import type {
  ClientMessage,
  LeaseHookRequest,
  Op,
  ServerMessage,
  TestSnapshot,
} from '../../../packages/canvas-schema/src/protocol.ts'
import type { StackPorts } from './ports.ts'

// ---- stacks ------------------------------------------------------------------------------------------

export interface StackOptions {
  /** the stack's port base (ports.ts STACKS); default SPIKE_B_PORT_BASE or the lead's 7850 */
  readonly base?: number
  /** default `excalidraw`; `tldraw` for the R0 stand-in (O4) */
  readonly engine?: 'excalidraw' | 'tldraw'
  /** default true: sync runs with DRAFTROOM_TEST_HOOKS=1 */
  readonly testHooks?: boolean
  /** a data dir to use (B8's staging runs: inside spike-b8/); default a fresh temp dir */
  readonly dataDir?: string
  /** extra sync env; DRAFTROOM_BACKUP_STORE is always `off` and R2_* never reach it (§8.6.7) */
  readonly syncEnv?: Readonly<Record<string, string>>
}

/** A dev user of the stack's dev sign-in (a distinct user per browser process). */
export interface DevUser {
  readonly handle: string
  readonly name: string
}

/** One running api + sync (+ the served web build) on a port base. */
export interface SpikeBStack {
  readonly ports: StackPorts
  readonly dataDir: string
  /** the per-run internal secret (the test routes need it); never printed */
  readonly internalSecret: string
  readonly engine: 'excalidraw' | 'tldraw'
  /** creates a board through the api as `owner` and shares it with `members` at `role` */
  createBoard(opts: {
    readonly owner: DevUser
    readonly members?: readonly { readonly user: DevUser; readonly role: 'editor' | 'commenter' | 'viewer' }[]
    readonly title?: string
  }): Promise<{ readonly boardId: string }>
  /** SIGKILL (default) or SIGINT the sync process */
  killSync(signal?: 'SIGKILL' | 'SIGINT'): Promise<void>
  restartSync(): Promise<void>
  stop(): Promise<void>
}

// ---- browsers ------------------------------------------------------------------------------------------

export interface BrowserOptions {
  /** a label for logs and evidence ("A", "B", "C") */
  readonly name: string
  /** touch emulation (B12, L11) */
  readonly touch?: boolean
  readonly viewport?: { readonly width: number; readonly height: number }
  /** a guest instead of a dev user (A3) */
  readonly guest?: boolean
}

/** One Chromium process, signed in as one user, with one page. */
export interface BrowserProcess {
  readonly name: string
  readonly user: DevUser
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  /** opens /b/:boardId and waits until the board is ready (the facade exists and the welcome is applied) */
  openBoard(boardId: string): Promise<void>
  close(): Promise<void>
}

/** Releases every party's action together (within 20 ms). */
export interface Barrier {
  /** the number of parties it waits for */
  readonly parties: number
  /** resolves when all parties arrived; each party awaits it right before its action */
  arrive(): Promise<void>
}

/** A raw WebSocket opened INSIDE a page with the page's own ticket (forged frames, §6.3). */
export interface ForgeSocket {
  /** sends a message or any raw string */
  send(frame: ClientMessage | string): Promise<void>
  /** the next server message of `type` (after the ones already read), or a timeout error */
  next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: T }>>
  /** every server message received so far */
  messages(): Promise<readonly ServerMessage[]>
  /** resolves when the socket closes */
  closed(): Promise<{ readonly code: number; readonly reason: string }>
  close(): Promise<void>
}

// ---- convergence and invariants -------------------------------------------------------------------------

/** The test snapshot (live elements and tombstones) and its hash.ts digest. */
export type Snapshot = TestSnapshot & { readonly hash: string }

export interface InvariantReport {
  readonly ok: boolean
  readonly violations: readonly Violation[]
}

export interface ConvergenceReport {
  /** every map's hash equals the snapshot's, and the horizon did not move since `since` */
  readonly ok: boolean
  readonly snapshot: Snapshot
  /** browser or client name → its hash */
  readonly hashes: Readonly<Record<string, string>>
  readonly horizonMoved: boolean
}

// ---- the client side of the test hooks (they call O1's routes; the relay and the cut need no server) ----

export type LeaseGrantMode =
  | { readonly delayMs: number }
  | { readonly hold: true }
  | { readonly release: true }
  | { readonly off: true }

/** No-ops unless the stack runs with DRAFTROOM_TEST_HOOKS=1. */
export interface TestHooks {
  /** L12: the next grants on `board` are delayed, held, released or normal (→ POST …/lease-hook) */
  leaseGrant(board: string, mode: LeaseGrantMode): Promise<void>
  /** D4: the next `n` COMMITs of `board`'s room throw (→ POST …/fail-commit) */
  failNextCommits(board: string, n: number): Promise<void>
  /** U9: a `routeWebSocket` relay that delays every frame by ms/2 each way; returns its removal */
  withLatency(page: Page, ms: number): Promise<() => Promise<void>>
  /** D5, D6, L7: cut the page's board socket (the route holds its reconnects) and restore it */
  cutSocket(page: Page): Promise<void>
  restoreSocket(page: Page): Promise<void>
}
/** The request body a `LeaseGrantMode` becomes. */
export type LeaseHookBody = LeaseHookRequest

// ---- the B10 push recorder ---------------------------------------------------------------------------------

/** A browser page (read through the facade's `pushedOps()`) or a headless client (its core's `pushLog()`). */
export type PushTarget = Page | { readonly name: string; readonly pushLog: () => readonly PushRecord[] }

/** The pushes a target sent since `recordPushes` started on it. */
export interface PushLog {
  count(): Promise<number>
  ops(): Promise<readonly Op[]>
  byElement(id: string): Promise<readonly Op[]>
}
export type RecordPushes = (target: PushTarget) => Promise<PushLog>

// ---- the harness entry points (O3's ./harness.ts exports `harness: SpikeBHarness`) ------------------------------

export interface SpikeBHarness {
  startStack(opts?: StackOptions): Promise<SpikeBStack>
  launchBrowser(stack: SpikeBStack, user: DevUser, opts: BrowserOptions): Promise<BrowserProcess>
  /** a fresh dev user for this run (distinct handle per call) */
  devUser(label: string): DevUser
  createBarrier(parties: number): Barrier
  forgeSocket(page: Page, boardId: string): Promise<ForgeSocket>
  readSnapshot(stack: SpikeBStack, boardId: string): Promise<Snapshot>
  checkInvariants(snapshot: Snapshot): InvariantReport
  /** hashes every page's (and headless client's) map, deleted elements included, against the test snapshot */
  converged(
    stack: SpikeBStack,
    boardId: string,
    targets: readonly (BrowserProcess | { readonly name: string; hash(): Promise<string> })[],
    opts?: { readonly horizonAtStart?: number; readonly timeoutMs?: number },
  ): Promise<ConvergenceReport>
  recordPushes: RecordPushes
  testHooks(stack: SpikeBStack): TestHooks
}
