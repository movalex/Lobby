import { isTeamNote, splitThemeNotes } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  actionItemText,
  budgetLine,
  expandDone,
  groupNames,
  ideasHeading,
  mindmapDone,
  plural,
  themesDone,
  themesHint,
  themesPreviewLine,
  topicLabel,
} from './copy.ts'

describe('AI copy', () => {
  it('plural', () => {
    expect(plural(1, 'note')).toBe('1 note')
    expect(plural(3, 'note')).toBe('3 notes')
    expect(plural(2, 'person', 'people')).toBe('2 people')
  })

  it('the ideas heading echoes the prompt, collapsed and cut', () => {
    expect(ideasHeading('  names   for the\nlaunch party ')).toBe('Ideas: names for the launch party')
    expect(ideasHeading('')).toBe('Ideas')
    expect(ideasHeading(undefined)).toBe('Ideas')
    const long = ideasHeading('x'.repeat(200))
    expect(Array.from(long)).toHaveLength('Ideas: '.length + 60)
    expect(long.endsWith('…')).toBe(true)
  })

  it('action items carry their owner on a second line', () => {
    expect(actionItemText({ text: 'Book the studio', owner: 'Sam' })).toBe('Book the studio\nOwner: Sam')
    expect(actionItemText({ text: 'Write the brief', owner: null })).toBe('Write the brief')
    // wave L (L2-4): a vote-weighted item says how many votes it follows
    expect(actionItemText({ text: 'Hire a composer', owner: 'Priya', votes: 5 })).toBe(
      'Hire a composer\nOwner: Priya\n5 votes',
    )
    expect(actionItemText({ text: 'Cut the teaser', owner: null, votes: 1 })).toBe('Cut the teaser\n1 vote')
  })

  it('the themes preview counts what moves (L2-1b)', () => {
    expect(themesPreviewLine({ notes: 23, themes: 5, grows: false })).toBe('Moves 23 notes into 5 themes')
    expect(themesPreviewLine({ notes: 1, themes: 1, grows: true })).toBe(
      'Moves 1 note into 1 theme; the frame grows to fit',
    )
  })

  it('the owner’s budget line is the contract’s wording ("AI budget used today: N%")', () => {
    expect(budgetLine(0)).toBe('AI budget used today: 0%')
    expect(budgetLine(37)).toBe('AI budget used today: 37%')
    expect(budgetLine(100)).toBe('AI budget used today: 100%')
  })

  it('what "Group into themes" says afterwards', () => {
    expect(themesDone({ moved: 8, themes: 3, grew: false, skipped: 0 })).toBe(
      'Grouped 8 notes into 3 themes.',
    )
    expect(themesDone({ moved: 1, themes: 1, grew: true, skipped: 2 })).toBe(
      'Grouped 1 note into 1 theme. The frame grew to fit. 2 notes stayed where they were.',
    )
    expect(themesDone({ moved: 16, themes: 3, grew: false, skipped: 0, prompts: 3 })).toBe(
      'Grouped 16 notes into 3 themes. The 3 prompt notes stayed where they were.',
    )
  })

  it('the menu says which notes move and which prompts stay (R9)', () => {
    expect(themesHint(1, 0)).toBe('Needs two or more sticky notes')
    expect(themesHint(8, 0)).toBe('Sorts 8 notes into labelled groups')
    expect(themesHint(16, 3)).toBe('Sorts 16 notes; 3 prompt notes stay put')
  })

  it('names the groups notes already sit in (DANA-10)', () => {
    expect(groupNames(['Gameplay', 'Story'])).toBe('“Gameplay” and “Story”')
    expect(groupNames(['Gameplay', 'Story', 'Community'])).toBe('“Gameplay”, “Story” and “Community”')
    expect(groupNames(['A', 'B', 'C', 'D', 'E'])).toBe('“A”, “B”, “C” and 2 more')
  })
})

// The shared rule (contracts splitThemeNotes) the api and the menu count with (R9).
describe('which notes "Group into themes" moves', () => {
  const typed = (id: string) => ({ id, meta: {}, textLastEditedBy: 'usr_bob' })
  const seeded = (id: string) => ({ id, meta: {}, textLastEditedBy: null })
  const facts = (n: { meta: unknown; textLastEditedBy: unknown }) => n
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  it('a template’s prompts stay once the team has written two notes of its own', () => {
    const notes = [
      seeded('p1'),
      seeded('p2'),
      typed('t1'),
      { id: 'r1', meta: { drPrivateNote: { session: 's' } }, textLastEditedBy: null },
      { id: 'a1', meta: { drAi: { kind: 'idea' } }, textLastEditedBy: null },
      { id: 'm1', meta: { draftroomPrompt: 'true' }, textLastEditedBy: 'usr_bob' },
    ]
    const out = splitThemeNotes(notes, facts)
    expect(ids(out.ideas)).toEqual(['t1', 'r1', 'a1'])
    expect(ids(out.prompts).sort()).toEqual(['m1', 'p1', 'p2'])
  })

  it('sample notes alone (the Lobby tour) group as a whole; one typed note does not change that', () => {
    expect(ids(splitThemeNotes([seeded('a'), seeded('b'), seeded('c')], facts).ideas)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(ids(splitThemeNotes([seeded('a'), seeded('b'), typed('c')], facts).ideas)).toEqual(['a', 'b', 'c'])
    expect(ids(splitThemeNotes([typed('a'), typed('b')], facts).ideas)).toEqual(['a', 'b'])
    expect(isTeamNote({ meta: null, textLastEditedBy: '' })).toBe(false)
  })
})

describe('the mind map words (K7)', () => {
  it('names the topic an Expand with AI request is about, cut at 30', () => {
    expect(topicLabel('Channels')).toBe('the topic “Channels”')
    expect(topicLabel('  A  topic\nwith   space ')).toBe('the topic “A topic with space”')
    expect(topicLabel('x'.repeat(40))).toBe(`the topic “${'x'.repeat(29)}…”`)
  })

  it('counts what was added', () => {
    expect(expandDone(1)).toBe('Added 1 sub-topic.')
    expect(expandDone(5)).toBe('Added 5 sub-topics.')
    expect(mindmapDone(1)).toBe('Drafted a mind map with 1 branch.')
    expect(mindmapDone(6)).toBe('Drafted a mind map with 6 branches.')
  })
})
