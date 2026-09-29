// The type of `window.lobbySpikeFeatures` (test-hooks.ts), types only, so e2e specs import it without
// pulling in app code (the spike B specs: b5-r2-*, b7-*, b12-*).

export interface LobbySpikeFeatures {
  me(): { uid: string; role: string; guest: boolean } | null
  /** tags `ids` with `name` (defines the board's tag first when new) */
  tag(ids: string[], name: string, color?: string): { ok: boolean; key?: string; error?: string }
  untag(ids: string[], key: string): void
  tagsOf(id: string): { key: string; name: string; color: string }[]
  /** my +1 on `id` (set, clear, or toggle) */
  plusOne(id: string, want?: boolean): boolean
  plusOnesOf(id: string): string[]
  /** the workshop state as the features hold it (after a fresh read) */
  workshop(): Promise<{
    voteOpen: boolean
    voteId: string | null
    myVotes: Record<string, number>
    myRemaining: number | null
    timerMs: number | null
  }>
  startVote(opts?: { votesPerPerson?: number }): Promise<void>
  closeVote(): Promise<void>
  /** casts on the element `id` (as the vote tool does on a press there) */
  vote(id: string, delta?: 1 | -1): Promise<{ ok: boolean; code?: string }>
  startTimer(ms: number): Promise<void>
  stopTimer(): Promise<void>
  /** comment threads the pins show */
  threads(): { id: string; anchor: unknown; body: string }[]
  refreshThreads(): Promise<void>
  collapse(topicId: string, collapsed: boolean): boolean
  /** the collapse prototype's hidden set (as computed from the scene, and as the overrides hold it) */
  hidden(): { computed: string[]; overrides: string[] }
  exportSvg(
    only?: string[],
  ): Promise<{ text: string; bytes: number; embeddedFiles: string[]; embeddedFonts: string[] }>
  /** PNG export as a data: URL (size in bytes too) */
  exportPng(only?: string[]): Promise<{ dataUrl: string; bytes: number }>
  /** the loader's state (B7: fetches in flight, addFiles calls, …) */
  loader(): { states: Record<string, number>; stats: Record<string, number> } | null
  /**
   * B7: uploads bytes (base64) through `/api`, waits for the worker (up to `waitMs`), and places one
   * `image` element holding only the version id and the card facts.
   */
  upload(
    base64: string,
    name: string,
    mimeType: string,
    opts?: { at?: { x: number; y: number }; waitMs?: number },
  ): Promise<{
    elementId: string
    versionId: string
    assetId: string
    kind: string
    status: string
    pageCount: number | null
  }>
  /** the open file-card viewer (its version id), or null */
  viewer(): string | null
  closeViewer(): void
}

declare global {
  interface Window {
    lobbySpikeFeatures?: LobbySpikeFeatures
  }
}
