import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoticeInput } from './board-context.ts'

interface Notice extends Required<Omit<NoticeInput, 'testId'>> {
  testId: string
  seq: number
}

const DEFAULT_TIMEOUT_MS = 5000

export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const seq = useRef(0)

  const dismiss = useCallback((key: string) => {
    const t = timers.current.get(key)
    if (t) clearTimeout(t)
    timers.current.delete(key)
    setNotices((all) => all.filter((n) => n.key !== key))
  }, [])

  const notify = useCallback(
    (input: NoticeInput) => {
      const n: Notice = {
        key: input.key,
        text: input.text,
        tone: input.tone ?? 'info',
        testId: input.testId ?? 'app-toast',
        timeoutMs: input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs,
        seq: ++seq.current,
      }
      // Same key replaces in place (a burst of lease denials is one toast whose timer restarts).
      setNotices((all) => [...all.filter((x) => x.key !== n.key), n].slice(-4))
      const prev = timers.current.get(n.key)
      if (prev) clearTimeout(prev)
      timers.current.delete(n.key)
      if (n.timeoutMs !== null)
        timers.current.set(
          n.key,
          setTimeout(() => dismiss(n.key), n.timeoutMs),
        )
    },
    [dismiss],
  )

  useEffect(() => {
    const all = timers.current
    return () => {
      for (const t of all.values()) clearTimeout(t)
      all.clear()
    }
  }, [])

  return { notices, notify, dismiss }
}

export function NoticeRegion({ notices, onDismiss }: { notices: Notice[]; onDismiss(key: string): void }) {
  return (
    <section className="dr-notices" aria-live="polite" aria-label="Notifications">
      {notices.map((n) => (
        <div key={n.key} className={`dr-notice dr-notice--${n.tone}`} data-testid={n.testId} role="status">
          <span>{n.text}</span>
          <button
            type="button"
            className="dr-notice__close"
            onClick={() => onDismiss(n.key)}
            aria-label="Dismiss"
          >
            {/* an icon, not a "×" character, so the toast's text content is just the message */}
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </section>
  )
}
