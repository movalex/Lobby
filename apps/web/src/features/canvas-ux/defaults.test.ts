import { describe, expect, it } from 'vitest'
import {
  CAMERA_MOVING_TIMEOUT_MS,
  fontDefaultPatch,
  MAX_SHAPES_PER_PAGE,
  snapDefaultPatch,
  startToolFor,
} from './defaults.ts'

describe('alignment guides default (MAK-02)', () => {
  it('turns snapping on when the user never chose', () => {
    expect(snapDefaultPatch({})).toEqual({ isSnapMode: true })
    expect(snapDefaultPatch({ isSnapMode: null })).toEqual({ isSnapMode: true })
  })
  it('respects an explicit choice, on or off', () => {
    expect(snapDefaultPatch({ isSnapMode: false })).toBeNull()
    expect(snapDefaultPatch({ isSnapMode: true })).toBeNull()
  })
})

describe('sans by default (RETRO-21a)', () => {
  it('sets sans when no font was ever chosen', () => {
    expect(fontDefaultPatch({})).toBe('sans')
    expect(fontDefaultPatch(undefined)).toBe('sans')
    expect(fontDefaultPatch({ 'tldraw:color': 'blue' })).toBe('sans')
  })
  it('never overrides an explicit choice (handwriting included)', () => {
    expect(fontDefaultPatch({ 'tldraw:font': 'draw' })).toBeNull()
    expect(fontDefaultPatch({ 'tldraw:font': 'serif' })).toBeNull()
    expect(fontDefaultPatch({ 'tldraw:font': 'sans' })).toBeNull()
  })
})

describe('camera "moving" window (PERF-04)', () => {
  it('outlasts one slow frame (tldraw default 64 ms) without delaying the sharp re-render much', () => {
    expect(CAMERA_MOVING_TIMEOUT_MS).toBeGreaterThanOrEqual(250)
    expect(CAMERA_MOVING_TIMEOUT_MS).toBeLessThanOrEqual(300)
  })
})

describe('start tool on touch devices (PRI-13)', () => {
  it('read-only people on a coarse pointer start on the Hand tool; everyone else keeps select', () => {
    expect(startToolFor({ coarsePointer: true, readonly: true })).toBe('hand')
    expect(startToolFor({ coarsePointer: true, readonly: false })).toBeNull()
    expect(startToolFor({ coarsePointer: false, readonly: true })).toBeNull()
    expect(startToolFor({ coarsePointer: false, readonly: false })).toBeNull()
  })
})

describe('shape cap (PRF-02)', () => {
  it('allows a 5,000-object board plus a 500-note paste', () => {
    expect(MAX_SHAPES_PER_PAGE).toBeGreaterThanOrEqual(10_000)
    expect(4000 + 500).toBeLessThanOrEqual(MAX_SHAPES_PER_PAGE)
  })
})
