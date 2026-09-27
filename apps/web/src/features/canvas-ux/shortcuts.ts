// Miro keyboard parity for tldraw 5.4.2 (docs/FEATURES-M2-CONTRACTS.md canvas-ux; checklist MAK-05/06/07/10/11/12,
// docs/research/miro-official-behaviors.md §5). Pure data + helpers so the map is unit-testable in Node.
//
// tldraw kbd syntax (verified in tldraw/src/lib/ui/hooks/useKeyboardShortcuts.ts + ui/kbd-utils.ts):
// comma-separated alternatives; `cmd+`, `ctrl+`, `alt+`, `shift+` modifiers (legacy `$` = cmd/ctrl,
// `?` = alt, `!` = shift); keys match `event.key` lowercased. Menus and the shortcuts dialog display ONLY
// the first alternative, character by character, so a named key like "pageup" would render as
// "P+A+G+E+U+P". A leading `[[PgUp]]` alternative is display-only: tldraw renders `[[…]]` atomically
// and its parsed key ("[[pgup]]") can never equal a real `event.key`.

/** Replacement `kbd` strings for existing tldraw actions (first alternative = what menus show). */
export const ACTION_KBD_OVERRIDES: Readonly<Record<string, string>> = {
  // MAK-10: Alt/Option+1 fit, Alt/Option+2 selection, Ctrl/Cmd+0 100% (tldraw's handler calls
  // preventDefault, so the browser's own zoom reset does not run). tldraw's Shift+1/2/0 keep working.
  'zoom-to-fit': 'alt+1,shift+1',
  'zoom-to-selection': 'alt+2,shift+2',
  'zoom-to-100': 'cmd+0,ctrl+0,shift+0',
  // MAK-05: Ctrl/Cmd+Shift+L. tldraw's bare Shift+L is dropped (Shift+letters type into a selected
  // note under type-to-edit, and Miro users never learned it).
  'toggle-lock': 'cmd+shift+l,ctrl+shift+l',
  // MAK-06: PgUp/PgDn to front/back, Shift+PgUp/PgDn one step; tldraw's ] [ and Alt+] Alt+[ kept.
  'bring-to-front': '[[PgUp]],pageup,]',
  'send-to-back': '[[PgDn]],pagedown,[',
  'bring-forward': 'shift+[[PgUp]],shift+pageup,alt+]',
  'send-backward': 'shift+[[PgDn]],shift+pagedown,alt+[',
}

/**
 * Replacement `kbd` strings for existing tldraw tools. `null` removes the key.
 * MAK-07: L (and A) start the bound connector (tldraw's arrow); the unbound line tool loses L and
 * gets no key (checklist open decision 4: fine for a creative team, still one level down in the toolbar).
 * Pen: P first (Miro), keeping tldraw's D/B/X.
 */
export const TOOL_KBD_OVERRIDES: Readonly<Record<string, string | null>> = {
  arrow: 'l,a',
  line: null,
  draw: 'p,d,b,x',
}

/** Actions this feature adds (ids are prefixed so they never shadow a tldraw action). */
export const NEW_ACTION_KBDS = {
  /** MAK-12: board search instead of the browser's find. */
  'dr-board-search': 'cmd+f,ctrl+f',
  /** MAK-11: show/hide the minimap. */
  'dr-toggle-minimap': 'm',
} as const

/**
 * Keys other features own. Comments binds C (comment tool) and Shift+C (show/hide pins); canvas-ux
 * must never bind them. Checked by the tests against the full merged map.
 */
export const RESERVED_FOR_OTHER_FEATURES: readonly string[] = ['c', 'shift+c']

/**
 * Ids tldraw's own registration skips (useKeyboardShortcuts SKIP_KBDS): clipboard keys come from
 * native events, and the asset tool shares Ctrl/Cmd+U with the insert-media action.
 */
export const TLDRAW_SKIPPED_KBD_IDS: readonly string[] = ['copy', 'cut', 'paste', 'asset']

export interface KbdItem {
  id: string
  kbd?: string
}

/**
 * Returns a copy of `items` with the `overrides` applied. Ids missing from `items` are reported in
 * `missing` (a tldraw upgrade renamed them) and never created.
 */
export function applyKbdOverrides<T extends KbdItem>(
  items: Readonly<Record<string, T>>,
  overrides: Readonly<Record<string, string | null>>,
): { items: Record<string, T>; missing: string[] } {
  const out: Record<string, T> = { ...items }
  const missing: string[] = []
  for (const [id, kbd] of Object.entries(overrides)) {
    const item = out[id]
    if (!item) {
      missing.push(id)
      continue
    }
    const next = { ...item }
    if (kbd === null) delete next.kbd
    else next.kbd = kbd
    out[id] = next
  }
  return { items: out, missing }
}

/** tldraw's splitKbd: split on commas, where "x,," means the key "," after "x". */
export function splitKbd(kbd: string): string[] {
  if (!kbd) return []
  const keys = kbd.split(',')
  let index = keys.lastIndexOf('')
  while (index >= 0) {
    if (index === 0) {
      keys.splice(0, 1)
    } else {
      keys[index - 1] += ','
      keys.splice(index, 1)
    }
    index = keys.lastIndexOf('')
  }
  return keys
}

const MODIFIERS: Record<string, 'shift' | 'alt' | 'ctrl' | 'meta'> = {
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
}
const KEY_ALIASES: Record<string, string> = {
  '⌫': 'backspace',
  del: 'delete',
  esc: 'escape',
  return: 'enter',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  space: ' ',
}

/** Legacy symbols ($ = cmd/ctrl, ? = alt, ! = shift) expanded like tldraw's getHotkeysStringFromKbd. */
function expandLegacy(alt: string): string[] {
  if (!/[!?$]/.test(alt)) return [alt]
  const shift = alt.includes('!')
  const opt = alt.includes('?')
  const cmd = alt.includes('$')
  const key = alt.replace(/[!?$]/g, '')
  const mods = [shift ? 'shift+' : '', opt ? 'alt+' : ''].join('')
  return cmd ? [`cmd+${mods}${key}`, `ctrl+${mods}${key}`] : [`${mods}${key}`]
}

/**
 * Canonical chords a kbd string actually listens for, e.g. 'cmd+shift+l,ctrl+shift+l' →
 * ['meta+shift+l', 'ctrl+shift+l']. Display-only `[[…]]` alternatives are dropped (they can never match).
 */
export function chordsOf(kbd: string | undefined): string[] {
  if (!kbd) return []
  const out: string[] = []
  for (const raw of splitKbd(kbd.replace(/\s/g, ''))) {
    if (raw.includes('[[')) continue
    for (const alt of expandLegacy(raw)) {
      const parts = alt.split('+')
      // "shift++" style never occurs in tldraw; a trailing empty part means the key is "+".
      let key = parts.pop() ?? ''
      if (key === '' && parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop()
        key = '+'
      }
      const mods = new Set<string>()
      for (const p of parts) {
        const m = MODIFIERS[p.toLowerCase()]
        if (m) mods.add(m)
      }
      key = key.toLowerCase()
      key = KEY_ALIASES[key] ?? key
      if (!key) continue
      const order = ['ctrl', 'meta', 'alt', 'shift'].filter((m) => mods.has(m))
      out.push([...order, key].join('+'))
    }
  }
  return out
}

/** Chords bound to more than one id (ignoring the ids tldraw itself never registers). */
export function findKbdConflicts(
  items: Iterable<KbdItem>,
  skipIds: readonly string[] = TLDRAW_SKIPPED_KBD_IDS,
): Map<string, string[]> {
  const byChord = new Map<string, string[]>()
  for (const item of items) {
    if (skipIds.includes(item.id)) continue
    for (const chord of new Set(chordsOf(item.kbd))) {
      const ids = byChord.get(chord)
      if (ids) ids.push(item.id)
      else byChord.set(chord, [item.id])
    }
  }
  return new Map([...byChord].filter(([, ids]) => ids.length > 1))
}

/** Human label for a tooltip, from the first alternative: 'cmd+f,ctrl+f' → 'Ctrl+F' (Windows) / '⌘F' (Mac). */
export function kbdLabel(kbd: string, isMac: boolean): string {
  const first = splitKbd(kbd.replace(/\s/g, ''))[0] ?? ''
  const atomic = /^(.*?)\[\[(.+)\]\]$/.exec(first)
  const parts = atomic ? [...(atomic[1] ?? '').split('+').filter(Boolean), atomic[2] ?? ''] : first.split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((p) => MODIFIERS[p.toLowerCase()]).filter(Boolean)
  const glyph = (m: string) =>
    isMac
      ? ({ meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' } as Record<string, string>)[m]
      : ({ meta: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } as Record<string, string>)[m]
  const label = key.length === 1 ? key.toUpperCase() : key
  const shown = [...new Set(mods.map((m) => glyph(m as string) ?? ''))]
  return isMac ? `${shown.join('')}${label}` : [...shown, label].join('+')
}
