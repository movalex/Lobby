// OWNER: W8 (wave M, M8-2; landed by the wave M foundation). The types of the dev-auth hook (./dev-hook.ts), apart
// from it so the e2e kit can import them without pulling in the page's code.

/** What an ask through the hook answered: the response, or the rejection's code (or name) and message. */
export type WorkspaceAskHookOutcome =
  | { ok: true; answer: unknown }
  | { ok: false; code: string; message: string }

export interface WorkspaceAskDevHook {
  /** Forces availability on or off for this board's workspace; null puts the rule back. A 404 still turns it off. */
  force(on: boolean | null): void
  /** askWorkspaceAvailable() now. */
  available(): boolean
  /** askWorkspace(question), settled (so a spec can read a rejection without a page error). */
  ask(question: string, acknowledged?: boolean): Promise<WorkspaceAskHookOutcome>
}

declare global {
  interface Window {
    __lobbyWorkspaceAsk?: WorkspaceAskDevHook
  }
}
