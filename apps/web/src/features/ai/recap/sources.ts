// Wave V (the foundation; docs/WAVE-V-CONTRACTS.md §6.5): the recap's source registry, so the features that ran in a
// session (live activities: WS2; breakouts: WS4) add their non-AI section to Wrap up without editing the recap code.
// OWNER: the wave V lead (this file); WS5 owns the rest of ./ (it draws the sections in the panel, the Markdown and the
// Recap frame, and adds the session CSV).
//
// A source collects one section for a recap: a title and a few lines, aggregates only (an anonymous activity's
// results never name anyone; a breakout lists group names and member counts, not people). It reads its own feature's
// api (GET /api/boards/:bid/activities, GET /api/boards/:bid/breakouts) or what this tab already holds; it never
// writes. A source that has nothing to say for the window answers null. collectRecapSections asks every source at
// once, each within RECAP_SOURCE_TIMEOUT_MS; one that fails or is late is left out (the recap never waits on it, and
// never says why): the recap's own sections (votes, planned vs actual, AI) stand alone.
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import type { RecapScopeName } from './window.ts'

/** The registered sources' ids (one line each here, through the lead). */
export type RecapSourceId = 'activities' | 'word-clouds' | 'breakouts'

export interface RecapSourceInput {
  readonly ctx: CanvasFeatureContext
  readonly scope: RecapScopeName
  /** the recap's window start (ms), null: no start (the whole board) */
  readonly since: number | null
  readonly now: number
  /** aborted when the recap is replaced or closed, or the source is late */
  readonly signal: AbortSignal
}

export interface RecapSectionLine {
  /** one line, plain text ("Which option? 14 answers: A 8, B 6") */
  readonly text: string
  /** optional element ids it is about (a placed chart), for the panel's links */
  readonly ids?: readonly string[]
}

export interface RecapSection {
  readonly id: RecapSourceId
  /** "Polls and scales", "Word clouds", "Breakouts" */
  readonly title: string
  readonly lines: readonly RecapSectionLine[]
}

export interface RecapSourceSpec {
  readonly id: RecapSourceId
  /** order among the sources (low first): the sections show after the recap's own, in this order */
  readonly order: number
  collect(input: RecapSourceInput): Promise<RecapSection | null>
}

/** How long a source may take before the recap goes on without it. */
export const RECAP_SOURCE_TIMEOUT_MS = 2_500
/** The most lines one section shows. */
export const RECAP_SECTION_LINES_MAX = 10

const sources = new Map<RecapSourceId, RecapSourceSpec>()

/** Adds (or replaces) a source; returns its removal. Registered once, at module load or on the feature's mount. */
export function registerRecapSource(spec: RecapSourceSpec): () => void {
  sources.set(spec.id, spec)
  return () => {
    if (sources.get(spec.id) === spec) sources.delete(spec.id)
  }
}

/** The registered sources, in order. */
export const recapSources = (): RecapSourceSpec[] =>
  [...sources.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * Every source's section for one recap, in order: the ones that answered a section with at least one line, within the
 * timeout, cut to RECAP_SECTION_LINES_MAX lines. Never throws.
 */
export async function collectRecapSections(
  input: Omit<RecapSourceInput, 'signal'> & { signal?: AbortSignal },
  timeoutMs: number = RECAP_SOURCE_TIMEOUT_MS,
): Promise<RecapSection[]> {
  const list = recapSources()
  const answers = await Promise.all(
    list.map(async (s): Promise<RecapSection | null> => {
      const ctl = new AbortController()
      const stop = () => ctl.abort()
      input.signal?.addEventListener('abort', stop, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const late = new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            ctl.abort()
            resolve(null)
          }, timeoutMs)
        })
        const section = await Promise.race([s.collect({ ...input, signal: ctl.signal }), late])
        if (!section || section.id !== s.id || ctl.signal.aborted) return null
        const lines: readonly RecapSectionLine[] = section.lines
          .filter((l) => l.text.trim())
          .slice(0, RECAP_SECTION_LINES_MAX)
        return lines.length ? { ...section, lines } : null
      } catch {
        return null
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        input.signal?.removeEventListener('abort', stop)
      }
    }),
  )
  if (input.signal?.aborted) return []
  return answers.filter((a): a is RecapSection => a !== null)
}
