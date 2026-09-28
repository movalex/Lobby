/**
 * Bindability checks for the server's cross-element invariants (plan §2.4.4), using Excalidraw's own
 * predicates so an engine bump that changes them is caught by the probe suite, not by users.
 *
 * - `isBindable`: what an arrow may bind to (element `index.js:3659-3661`): rectangle, stickynote,
 *   diamond, ellipse, image, iframe, embeddable, frame, magicframe, and free (unbound) text.
 * - `isTextContainer`: what may hold a bound label (element `index.js:3668-3670`): rectangle,
 *   stickynote, diamond, ellipse, arrow.
 */
import { raw } from './raw.ts'
import type { EngineElement } from './types.ts'

type Candidate = Pick<EngineElement, 'type' | 'locked'> & { containerId?: string | null }

/** Types Lobby's server refuses (plan §3.1); `iframe` and `embeddable` are never stored, so never bindable. */
const REFUSED = new Set(['selection', 'magicframe', 'iframe', 'embeddable'])

export const isBindable = (el: Candidate | null | undefined): boolean =>
  el != null && !REFUSED.has(el.type) && raw.isBindableElement(el as EngineElement, true)

export const isTextContainer = (el: Candidate | null | undefined): boolean =>
  el != null && raw.isTextBindableContainer(el as EngineElement, true)

/** The engine's own answers, unfiltered, for the probe suite. */
export const engineBindableTypes = (types: readonly string[]) =>
  types.filter((type) => raw.isBindableElement({ type, locked: false } as unknown as EngineElement, true))

export const engineTextContainerTypes = (types: readonly string[]) =>
  types.filter((type) =>
    raw.isTextBindableContainer({ type, locked: false } as unknown as EngineElement, true),
  )
