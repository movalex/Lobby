// Wave J: the "External" tag next to the name of someone outside Dark Burn Creative and Trailer Park
// Group (Share dialog lists, the people list, comment authors, the @mention picker), and the "Not
// confirmed" one a manager sees for an account Lobby cannot tell about. Name-only guests keep their
// " (guest)" and get neither (the callers leave them out).
import type { OutsideStatus } from '@draftroom/contracts'
import { externalTagText, externalTagTitle, outsideTag } from './outside.ts'
import './outside.css'

/** The plain tag (no status lookup): `domain` only where the viewer may see it. */
export function ExternalTag({
  domain = null,
  compact = false,
}: {
  domain?: string | null
  compact?: boolean
}) {
  return (
    <span
      className={`dr-ext-tag${compact ? ' dr-ext-tag--compact' : ''}`}
      data-testid="external-tag"
      data-domain={domain ?? undefined}
      title={externalTagTitle(domain)}
    >
      {externalTagText(compact ? null : domain)}
    </span>
  )
}

/**
 * The one-time confirm before inviting, approving or raising someone outside (the Share dialog): the
 * owner's words (contracts outsideConfirmText), then "{yes}" or Cancel.
 */
export function OutsideConfirm({
  text,
  yes,
  onYes,
  onNo,
}: {
  text: string
  yes: string
  onYes(): void
  onNo(): void
}) {
  return (
    <fieldset className="dr-outside-confirm" data-testid="outside-confirm">
      <legend className="dr-sr-only">Outside Dark Burn and Trailer Park Group</legend>
      <span data-testid="outside-confirm-text">{text}</span>
      <span className="dr-outside-confirm__actions">
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="outside-confirm-yes"
          // biome-ignore lint/a11y/noAutofocus: the confirmation the action just asked for
          autoFocus
          onClick={onYes}
        >
          {yes}
        </button>
        <button type="button" className="dr-btn dr-btn--sm" data-testid="outside-confirm-no" onClick={onNo}>
          Cancel
        </button>
      </span>
    </fieldset>
  )
}

/** A manager list's tag from the server's fields: External, Not confirmed, or nothing. */
export function OutsideStatusTag({
  outside,
  domain,
  guest = false,
}: {
  outside: OutsideStatus | undefined
  domain: string | null | undefined
  guest?: boolean
}) {
  const tag = outsideTag(outside, domain, guest)
  if (!tag) return null
  if (tag.kind === 'external') return <ExternalTag domain={domain ?? null} />
  return (
    <span className="dr-ext-tag dr-ext-tag--unconfirmed" data-testid="unconfirmed-tag" title={tag.title}>
      {tag.text}
    </span>
  )
}
