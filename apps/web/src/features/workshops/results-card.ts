// Wave M (W2, M2-4): the "Results are in" card's life, as a small state machine (pure; the workshop store holds the
// state in `resultsNews`, ./store.ts, and WorkshopOverlay.tsx draws the card).
//
// The card is news for a person who was on the board when a vote was revealed. It used to stay for 30 s or until
// closed, and came back every time the Voting panel closed: a facilitator who had already opened the panel and put
// the results on the board kept it (FTU-12). Now the card is done as soon as its person has acted on the results:
//
//   results (a vote revealed in front of this tab)   -> the card for that vote
//   the Voting panel opens                           -> gone (the panel shows the same ranking)
//   Results to board                                 -> gone (the results are on the board)
//   See all results / the close button / 30 s        -> gone
//   another vote starts                              -> gone (the card was about the old one)
//
// and it does not come back for the same vote: only a newer reveal makes a new card.

/** The card's news: which vote, and which showing (a new reveal is a new seq). */
export interface ResultsNews {
  readonly sessionId: string
  readonly seq: number
}

export type ResultsCardEvent =
  /** this tab saw the results of `sessionId` come in (`seq`: the store's next news number) */
  | { readonly kind: 'results'; readonly sessionId: string; readonly seq: number }
  /** the dock opened a panel (null: none) */
  | { readonly kind: 'panel'; readonly panel: string | null }
  /** the vote the store holds is now `sessionId` (null: none) */
  | { readonly kind: 'vote'; readonly sessionId: string | null }
  /** "Results to board" was pressed */
  | { readonly kind: 'to-board' }
  /** the card’s "See all results" */
  | { readonly kind: 'see-all' }
  /** the card’s close button */
  | { readonly kind: 'close' }
  /** RESULTS_CARD_MS passed */
  | { readonly kind: 'timeout' }

/** Why a card went (the events that end one without a successor). */
export type ResultsCardDismissal = 'to-board' | 'see-all' | 'close' | 'timeout'

/** The card after `event`. */
export function nextResultsNews(news: ResultsNews | null, event: ResultsCardEvent): ResultsNews | null {
  switch (event.kind) {
    case 'results':
      return { sessionId: event.sessionId, seq: event.seq }
    case 'panel':
      return event.panel === 'voting' ? null : news
    case 'vote':
      return event.sessionId === news?.sessionId ? news : null
    case 'to-board':
    case 'see-all':
    case 'close':
    case 'timeout':
      return null
  }
}

/** Whether the card is drawn: there is news, the vote is revealed with results, and nobody is presenting. */
export function resultsCardShown(input: {
  readonly news: ResultsNews | null
  readonly revealedWithResults: boolean
  readonly presenting: boolean
  /** the dock’s open panel */
  readonly panel: string | null
}): boolean {
  // the panel being open ends the news (the store is told), but the very render before that must not flash the card
  return !!input.news && input.revealedWithResults && !input.presenting && input.panel !== 'voting'
}
