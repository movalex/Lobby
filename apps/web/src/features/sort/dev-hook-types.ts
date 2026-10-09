// The types of the dev-auth hook (./dev-hook.ts), apart from it so the e2e specs can import them without
// pulling in the page's code (they have no Vite environment types).

/** What the stand-in AI answers (all optional; the defaults split a sort in halves and spread the scores). */
export interface FakeAiConfig {
  /** what the person chooses in the preview (default 'apply') */
  preview?: 'apply' | 'discard' | 'retry'
  /** 'sort': the groups (element ids, no `shape:`), or null for two halves named Sooner and Later */
  themes?: { name: string; ids: string[] }[] | null
  /** 'score': element id → [across, up], or null for the four quadrants in turn */
  scores?: Record<string, [number, number]> | null
  /** 'score': element ids the AI "could not score" */
  unscored?: string[]
  /** every run id the stand-in returns */
  runId?: string
}

export interface SortDevHook {
  /** runs a command of the registry by id (as the palette would); false when disabled or unknown */
  run(commandId: string, args?: unknown): Promise<boolean>
  /** the popover's state: its view, or null when it is closed */
  menu(): { view: string; ids: readonly string[] } | null
  /** stands in for the AI (null puts the real calls back) */
  fakeAi(config: FakeAiConfig | null): void
  /** the AI requests the stand-in has been asked, in order (contracts AiRunInput) */
  requests(): readonly unknown[]
  /** the previews the stand-in has been shown, in order (the title and the moves it was given) */
  previews(): { title: string; summary: string; moves: number }[]
}

declare global {
  interface Window {
    __lobbySort?: SortDevHook
  }
}
