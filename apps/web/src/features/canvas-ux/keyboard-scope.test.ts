// A11Y2-02: board shortcuts act only while the board has the keyboard (keyboard-scope.ts).
import type { TLUiEventSource } from 'tldraw'
import { describe, expect, it } from 'vitest'
import {
  CHROME_SAFE_ACTIONS,
  gateKeyboardItems,
  type KeyboardSpot,
  keyboardOnBoard,
} from './keyboard-scope.ts'

const spot = (over: Partial<KeyboardSpot>): KeyboardSpot => ({
  nowhere: false,
  inContainer: false,
  onCanvas: false,
  inTldrawUi: false,
  inDialog: false,
  modalOpen: false,
  ...over,
})

describe('keyboardOnBoard', () => {
  it('the canvas, a shape editor and tldraw UI are the board', () => {
    expect(keyboardOnBoard(spot({ nowhere: true }))).toBe(true)
    expect(keyboardOnBoard(spot({ inContainer: true, onCanvas: true }))).toBe(true)
    expect(keyboardOnBoard(spot({ inContainer: true, inTldrawUi: true }))).toBe(true)
  })

  it('the top bar, the dock, Lobby overlays and dialogs are chrome', () => {
    // top bar, dock rail and panels, the Share dialog: outside the editor container
    expect(keyboardOnBoard(spot({}))).toBe(false)
    expect(keyboardOnBoard(spot({ inDialog: true }))).toBe(false)
    // Lobby overlays inside the container (selection bar, comment and AI popovers)
    expect(keyboardOnBoard(spot({ inContainer: true }))).toBe(false)
    // a tldraw dialog (the shortcuts dialog) sits in tldraw's UI
    expect(keyboardOnBoard(spot({ inContainer: true, inTldrawUi: true, inDialog: true }))).toBe(false)
    // <body> while a modal is open (a busy dialog button dropped the keyboard)
    expect(keyboardOnBoard(spot({ nowhere: true, modalOpen: true }))).toBe(false)
  })
})

describe('gateKeyboardItems', () => {
  const make = () => {
    const ran: string[] = []
    const item = (id: string, kbd?: string) => ({
      id,
      kbd,
      onSelect: (source: TLUiEventSource) => void ran.push(`${id}:${source}`),
    })
    const items = {
      delete: item('delete', '⌫,del'),
      undo: item('undo', 'cmd+z,ctrl+z'),
      'zoom-to-fit': item('zoom-to-fit', 'alt+1,shift+1'),
      text: item('text', 't'),
      'no-key': item('no-key'),
    }
    return { ran, items }
  }

  it('drops a key press from the chrome but keeps history and camera keys', () => {
    const { ran, items } = make()
    const gated = gateKeyboardItems(items, () => false, CHROME_SAFE_ACTIONS)
    for (const i of Object.values(gated)) i.onSelect('kbd')
    expect(ran).toEqual(['undo:kbd', 'zoom-to-fit:kbd', 'no-key:kbd'])
  })

  it('never blocks menus, buttons and the toolbar, and lets keys through on the board', () => {
    const { ran, items } = make()
    let onBoard = false
    const gated = gateKeyboardItems(items, () => onBoard, CHROME_SAFE_ACTIONS)
    gated.delete?.onSelect('context-menu')
    gated.text?.onSelect('toolbar')
    onBoard = true
    gated.delete?.onSelect('kbd')
    gated.text?.onSelect('kbd')
    expect(ran).toEqual(['delete:context-menu', 'text:toolbar', 'delete:kbd', 'text:kbd'])
  })

  it('leaves the items it was given, and their keys, untouched', () => {
    const { items } = make()
    const gated = gateKeyboardItems(items, () => false, CHROME_SAFE_ACTIONS)
    expect(gated.delete).not.toBe(items.delete)
    expect(gated.delete?.kbd).toBe('⌫,del')
    expect(gated['no-key']).toBe(items['no-key'])
    expect(Object.keys(gated)).toEqual(Object.keys(items))
  })
})
