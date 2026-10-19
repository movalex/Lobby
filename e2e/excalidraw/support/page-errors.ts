// The cross-browser smoke's page-error collector (excalidraw/xbrowser-smoke.spec.ts): every uncaught page error
// fails a smoke test, because a missing browser API throws one. Only this collector uses the list below.
import type { Page } from '@playwright/test'

/** What Playwright hands a `pageerror` listener (an Error, or what the page reported as one). */
export interface PageErrorLike {
  readonly name: string
  readonly message: string
}

/**
 * The page errors that are not failures, each matched exactly (name and message, character for character).
 *
 * - WebKit reports "ResizeObserver loop completed with undelivered notifications." as an uncaught error (an error
 *   event without an Error object, so the name is empty) whenever an observer's callback changes a size that another
 *   observer watches within the same frame. The spec says the browser then delivers the rest in the next frame, so
 *   nothing is lost and nothing threw in Lobby's code; Chromium reports no such page error. The wave V and W gates saw
 *   it on WebKit only, on `origin/main` too (docs/PROGRESS.md). Any other wording, a name, or a different error
 *   still fails the smoke.
 */
export const BENIGN_PAGE_ERRORS: readonly PageErrorLike[] = [
  { name: '', message: 'ResizeObserver loop completed with undelivered notifications.' },
]

export const isBenignPageError = (e: PageErrorLike): boolean =>
  BENIGN_PAGE_ERRORS.some((b) => b.name === e.name && b.message === e.message)

/** Uncaught exceptions in the page, collected from now on (the benign ones above left out). */
export function pageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => {
    if (!isBenignPageError(e)) errors.push(`${e.name}: ${e.message}`)
  })
  return errors
}
