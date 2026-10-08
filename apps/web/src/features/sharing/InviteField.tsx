// K5-5 (wave K): the Share dialog's "Invite people" field as a combobox with a real suggestion list (it was
// an <input list> with a datalist: browsers showed it or not, matched only from the start of what an option
// says, and said "No one matches" while the person was still typing a colleague's name).
//
// Typing the start of someone's @handle or name (or a word of it) lists them under the field
// (share-model.ts parseInviteTarget's 'partial', inviteMatches): ArrowDown / ArrowUp move through the list
// (the field keeps the keyboard: aria-activedescendant), Enter or a press picks (the field then says
// "@handle", or the name), Escape closes the list and leaves the dialog open, Tab leaves. Picking grants
// nothing: Invite does, as before, and the server has the final word. The hint under the field is one line,
// said once (share-model.ts inviteHintText).
import type { OutsideStatus, WorkspaceMember } from '@draftroom/contracts'
import type { KeyboardEvent, Ref } from 'react'
import { initialsFor, safeColor } from '../../lib/identity.ts'
import { OutsideStatusTag } from '../people/ExternalTag.tsx'

/** The list's state: whether it is shown, and which option the keyboard is on. */
export interface SuggestState {
  readonly open: boolean
  readonly active: number
}

export const CLOSED: SuggestState = { open: false, active: 0 }

/**
 * What a key in the field does to the list of `count` suggestions: the next state, the option it picks
 * (Enter), and whether the field must not act on the key itself (no form submit, no dialog close, no caret
 * move).
 */
export function suggestionKey(
  state: SuggestState,
  key: string,
  count: number,
): { state: SuggestState; pick: number | null; handled: boolean } {
  if (count <= 0) return { state: CLOSED, pick: null, handled: false }
  const active = Math.min(Math.max(0, state.active), count - 1)
  switch (key) {
    case 'ArrowDown':
      return {
        state: { open: true, active: state.open ? (active + 1) % count : 0 },
        pick: null,
        handled: true,
      }
    case 'ArrowUp':
      return {
        state: { open: true, active: state.open ? (active - 1 + count) % count : count - 1 },
        pick: null,
        handled: true,
      }
    case 'Enter':
      return state.open
        ? { state: CLOSED, pick: active, handled: true }
        : { state, pick: null, handled: false }
    case 'Escape':
      return state.open
        ? { state: { open: false, active }, pick: null, handled: true }
        : { state, pick: null, handled: false }
    case 'Tab':
      return { state: { open: false, active }, pick: null, handled: false }
    default:
      return { state, pick: null, handled: false }
  }
}

/** The id of option `i` of the list `listId` (aria-activedescendant). */
export const optionId = (listId: string, i: number) => `${listId}-opt-${i}`

export function InviteInput({
  id,
  listId,
  hintId,
  value,
  state,
  count,
  inputRef,
  onChange,
  onKey,
  onBlur,
}: {
  id: string
  listId: string
  hintId: string
  value: string
  state: SuggestState
  /** How many suggestions there are for what is typed. */
  count: number
  inputRef?: Ref<HTMLInputElement>
  onChange(text: string): void
  /** A key the list handled (the event's default is already prevented). */
  onKey(e: KeyboardEvent<HTMLInputElement>): void
  onBlur(): void
}) {
  const open = state.open && count > 0
  return (
    <input
      ref={inputRef}
      id={id}
      className="dr-input dr-sharing__invite-input"
      data-testid="share-invite-input"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? optionId(listId, state.active) : undefined}
      aria-describedby={hintId}
      placeholder="@handle, name or email"
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKey}
      onBlur={onBlur}
    />
  )
}

/** One person in the list: avatar, name, @handle, and whether they already have access. */
function Suggestion({
  member,
  id,
  active,
  hasAccess,
  onPick,
  onHover,
}: {
  member: WorkspaceMember & { outside?: OutsideStatus }
  id: string
  active: boolean
  hasAccess: boolean
  onPick(): void
  onHover(): void
}) {
  const { user } = member
  return (
    // the field keeps the keyboard (aria-activedescendant); its keys pick (ArrowDown/ArrowUp/Enter, suggestionKey)
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are the combobox field's, not the option's
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      className="dr-sharing__suggestion"
      data-testid="share-invite-suggestion"
      data-user-id={user.id}
      data-active={active || undefined}
      // the field keeps the focus (and the list stays) while the press lands
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      onPointerEnter={onHover}
    >
      <span
        className="dr-avatar dr-avatar--static dr-avatar--sm"
        style={{ background: safeColor(user.color, user.id) }}
        aria-hidden="true"
      >
        {initialsFor(user.name)}
      </span>
      <span className="dr-sharing__suggestion-text">
        <span className="dr-sharing__suggestion-name">
          {user.name}
          <OutsideStatusTag outside={member.outside} domain={member.emailDomain} />
        </span>
        <span className="dr-sharing__suggestion-sub">
          {[user.handle ? `@${user.handle}` : '', hasAccess ? 'has access' : ''].filter(Boolean).join(' · ')}
        </span>
      </span>
    </div>
  )
}

export function SuggestionList({
  id,
  members,
  state,
  hasAccess,
  onPick,
  onHover,
}: {
  id: string
  members: readonly WorkspaceMember[]
  state: SuggestState
  hasAccess(userId: string): boolean
  onPick(member: WorkspaceMember): void
  onHover(index: number): void
}) {
  if (!state.open || members.length === 0) return null
  return (
    <div
      id={id}
      role="listbox"
      className="dr-sharing__suggestions"
      data-testid="share-invite-suggestions"
      aria-label="People in the workspace"
    >
      {members.map((m, i) => (
        <Suggestion
          key={m.user.id}
          id={optionId(id, i)}
          member={m}
          active={i === state.active}
          hasAccess={hasAccess(m.user.id)}
          onPick={() => onPick(m)}
          onHover={() => onHover(i)}
        />
      ))}
    </div>
  )
}

/** The one line under the field (share-model.ts inviteHintText), announced politely as it changes. */
export function InviteHint({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className="dr-share__hint" data-testid="share-invite-hint" role="status">
      {text}
    </p>
  )
}
