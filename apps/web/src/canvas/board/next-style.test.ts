// W5-40 (CR-W5-3A-1): the next connector's kind (straight, curved, elbow) is the engine's arrow type
// ('sharp', 'round', 'elbow'), set by `styles.setNext({ arrowKind })` and read back by `styles.next()`;
// a connector pick never reaches the corners of the next rectangle (`currentItemRoundness`).
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { describe, expect, it } from 'vitest'
import { arrowKindOf, nextStylePatch, nextStyles } from './handles.ts'

const apiWith = (appState: Record<string, unknown>) =>
  ({ getAppState: () => appState }) as unknown as ExcalidrawImperativeAPI

describe('the next connector kind (W5-40)', () => {
  it('maps the engine arrow types to the kinds the style panel shows', () => {
    expect(arrowKindOf('sharp')).toBe('straight')
    expect(arrowKindOf('round')).toBe('curved')
    expect(arrowKindOf('elbow')).toBe('elbow')
    // an arrow type the engine may add later is straight, never curved
    expect(arrowKindOf(undefined)).toBe('straight')
    expect(arrowKindOf('proportional')).toBe('straight')
  })

  it('writes each kind as its arrow type, and only that (the next shape keeps its corners)', () => {
    expect(nextStylePatch({ arrowKind: 'straight' })).toEqual({ currentItemArrowType: 'sharp' })
    expect(nextStylePatch({ arrowKind: 'curved' })).toEqual({ currentItemArrowType: 'round' })
    expect(nextStylePatch({ arrowKind: 'elbow' })).toEqual({ currentItemArrowType: 'elbow' })
  })

  it('Elbow, then Straight, ends straight (it ended curved before: Straight wrote the engine curved type)', () => {
    // the style panel's picks, in order, applied to an engine state the way setNext applies them
    const state: Record<string, unknown> = { currentItemArrowType: 'sharp', currentItemRoundness: 'sharp' }
    for (const kind of ['elbow', 'straight'] as const)
      Object.assign(state, nextStylePatch({ arrowKind: kind }))
    expect(state.currentItemArrowType).toBe('sharp')
    expect(nextStyles(apiWith(state)).arrowKind).toBe('straight')
    expect(nextStyles(apiWith(state)).elbowed).toBe(false)
  })

  it('reads the kind, the elbow flag and the shape corners apart', () => {
    const read = (type: string, corners: string) =>
      nextStyles(apiWith({ currentItemArrowType: type, currentItemRoundness: corners }))
    expect(read('sharp', 'sharp')).toMatchObject({
      arrowKind: 'straight',
      elbowed: false,
      roundness: 'sharp',
    })
    expect(read('round', 'sharp')).toMatchObject({ arrowKind: 'curved', elbowed: false, roundness: 'sharp' })
    expect(read('elbow', 'round')).toMatchObject({ arrowKind: 'elbow', elbowed: true, roundness: 'round' })
    // curved connectors on rounded shapes and straight connectors on rounded shapes both read as they are
    expect(read('sharp', 'round')).toMatchObject({ arrowKind: 'straight', roundness: 'round' })
  })

  it('writes the corners as the corners, with or without a connector kind', () => {
    expect(nextStylePatch({ roundness: 'round' })).toEqual({ currentItemRoundness: 'round' })
    expect(nextStylePatch({ roundness: 'sharp', arrowKind: 'curved' })).toEqual({
      currentItemRoundness: 'sharp',
      currentItemArrowType: 'round',
    })
  })

  it('a whole next-style read written back (the highlighter restores what it found) changes nothing', () => {
    const state = { currentItemArrowType: 'elbow', currentItemRoundness: 'round', currentItemOpacity: 100 }
    const back = nextStylePatch(nextStyles(apiWith(state)))
    expect(back.currentItemArrowType).toBe('elbow')
    expect(back.currentItemRoundness).toBe('round')
  })

  it('an older pick, elbowed with roundness and no arrowKind, is one connector pick and leaves the corners', () => {
    expect(nextStylePatch({ elbowed: true, roundness: 'sharp' })).toEqual({ currentItemArrowType: 'elbow' })
    // Straight used to write the curved type here, so the next connector stayed curved
    expect(nextStylePatch({ elbowed: false, roundness: 'sharp' })).toEqual({ currentItemArrowType: 'sharp' })
    expect(nextStylePatch({ elbowed: false, roundness: 'round' })).toEqual({ currentItemArrowType: 'round' })
    expect(nextStylePatch({ elbowed: false })).toEqual({ currentItemArrowType: 'sharp' })
  })
})
