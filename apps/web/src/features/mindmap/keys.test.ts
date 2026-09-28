import { describe, expect, it } from 'vitest'
import type { KeyEventLike } from '../canvas-ux/keys.ts'
import { type TopicKeyState, topicKeyIntent } from './keys.ts'

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

const selected: TopicKeyState = {
  topicSelected: true,
  editingTopic: false,
  isIdle: true,
  isReadonly: false,
  menusOpen: false,
  targetIsTextField: false,
  justLeftEditing: false,
  locked: false,
}
const editing: TopicKeyState = { ...selected, topicSelected: false, editingTopic: true, isIdle: false }

describe('mind-map keys', () => {
  it('with a topic selected: Tab child, Enter sibling, Shift+Tab up a level, arrows move, F2 and typing edit', () => {
    expect(topicKeyIntent(key('Tab'), selected)).toEqual({ kind: 'child' })
    expect(topicKeyIntent(key('Enter'), selected)).toEqual({ kind: 'sibling' })
    expect(topicKeyIntent(key('Tab', { shiftKey: true }), selected)).toEqual({ kind: 'promote' })
    expect(topicKeyIntent(key('ArrowRight'), selected)).toEqual({ kind: 'nav', dir: 'right' })
    expect(topicKeyIntent(key('ArrowUp'), selected)).toEqual({ kind: 'nav', dir: 'up' })
    expect(topicKeyIntent(key('F2'), selected)).toEqual({ kind: 'edit', text: '' })
    expect(topicKeyIntent(key('q'), selected)).toEqual({ kind: 'edit', text: 'q' })
    expect(topicKeyIntent(key('É', { shiftKey: true }), selected)).toEqual({ kind: 'edit', text: 'É' })
  })

  it('while typing in a topic: Tab, Enter and Shift+Tab act; Shift+Enter and everything else stay text', () => {
    expect(topicKeyIntent(key('Tab'), editing)).toEqual({ kind: 'child' })
    expect(topicKeyIntent(key('Enter'), editing)).toEqual({ kind: 'sibling' })
    expect(topicKeyIntent(key('Tab', { shiftKey: true }), editing)).toEqual({ kind: 'promote' })
    expect(topicKeyIntent(key('Enter', { shiftKey: true }), editing)).toBeNull()
    expect(topicKeyIntent(key('a'), editing)).toBeNull()
    expect(topicKeyIntent(key('ArrowLeft'), editing)).toBeNull()
    expect(topicKeyIntent(key('Escape'), editing)).toBeNull()
  })

  it('never with Ctrl, Cmd or Alt, during composition, or with a menu open', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      expect(topicKeyIntent(key('Tab', mods), selected)).toBeNull()
      expect(topicKeyIntent(key('Enter', mods), editing)).toBeNull()
    }
    expect(topicKeyIntent(key('Tab'), { ...selected, menusOpen: true })).toBeNull()
    // Ctrl/Cmd+Enter stays tldraw's (finish editing / adjust styles).
    expect(topicKeyIntent(key('Enter', { ctrlKey: true }), editing)).toBeNull()
  })

  it('not when the key goes to another text field, or nothing (or not a topic) is selected', () => {
    expect(topicKeyIntent(key('Tab'), { ...selected, targetIsTextField: true })).toBeNull()
    expect(topicKeyIntent(key('Tab'), { ...selected, topicSelected: false })).toBeNull()
    expect(topicKeyIntent(key('Tab'), { ...selected, isIdle: false })).toBeNull()
  })

  it('read-only people keep only the arrow keys', () => {
    const ro = { ...selected, isReadonly: true }
    expect(topicKeyIntent(key('ArrowDown'), ro)).toEqual({ kind: 'nav', dir: 'down' })
    for (const k of ['Tab', 'Enter', 'F2', 'x']) expect(topicKeyIntent(key(k), ro)).toBeNull()
    expect(topicKeyIntent(key('Tab'), { ...editing, isReadonly: true })).toBeNull()
  })

  it('right after Esc, a letter is a tool key again (RETRO-02); a locked topic is not typed into', () => {
    expect(topicKeyIntent(key('n'), { ...selected, justLeftEditing: true })).toBeNull()
    expect(topicKeyIntent(key('Tab'), { ...selected, justLeftEditing: true })).toEqual({ kind: 'child' })
    expect(topicKeyIntent(key('n'), { ...selected, locked: true })).toBeNull()
    expect(topicKeyIntent(key('F2'), { ...selected, locked: true })).toBeNull()
  })

  it('Space, [ and ] keep their board meaning (pan, z-order)', () => {
    for (const k of [' ', '[', ']']) expect(topicKeyIntent(key(k), selected)).toBeNull()
  })
})
