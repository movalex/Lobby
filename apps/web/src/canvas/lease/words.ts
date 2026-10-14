// Wave P review (P-005): what the text lease's messages call the element being typed in. A lease is on a note, a
// shape's or a connector's label (the lease is the container's) or a free text, and the words said "this note" for
// every one of them: "Dana is typing in this note" on a rectangle. They name the element's kind now.

/** What a lease's element is called in its messages. */
export type LeaseThing = 'note' | 'shape' | 'connector' | 'text'

/** The kind of the lease's element (the container, or a free text): a note, a connector, a text, else a shape. */
export function leaseThingOf(el: { readonly type: string } | null | undefined): LeaseThing {
  const type = el?.type
  if (type === 'stickynote') return 'note'
  if (type === 'arrow') return 'connector'
  if (type === 'text') return 'text'
  return el ? 'shape' : 'note'
}

/** "Dana is typing in this shape" (a deny). */
export const typingIn = (holder: string, thing: LeaseThing) => `${holder} is typing in this ${thing}`

/** "Not saved — Dana is editing this shape now" (a lost lease, a New element's deny). */
export const editingNow = (holder: string, thing: LeaseThing) =>
  `Not saved — ${holder} is editing this ${thing} now`

/** "The shape did not open, so what you typed was not saved." */
export const didNotOpenTyped = (thing: LeaseThing) =>
  `The ${thing} did not open, so what you typed was not saved.`

/** "The shape did not open. Please try again." */
export const didNotOpen = (thing: LeaseThing) => `The ${thing} did not open. Please try again.`

/** "This shape was deleted before it opened." */
export const deletedBeforeOpen = (thing: LeaseThing) => `This ${thing} was deleted before it opened.`

/** "Opening the shape… (Esc cancels)", with the keys typed meanwhile. */
export const opening = (thing: LeaseThing, typed: number) =>
  typed > 0 ? `Opening the ${thing}… (${typed} typed, Esc cancels)` : `Opening the ${thing}… (Esc cancels)`
