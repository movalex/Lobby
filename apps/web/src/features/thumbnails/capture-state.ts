// DANA2-06: boards whose stored thumbnail is the quick stand-in drawn while leaving (renderNowSync), per
// browser. The api cannot tell the two kinds apart; this browser drew it, so this browser redraws it.
// Engine-neutral (wave 3e): both boards' capture wiring use it (./capture.ts, ./ported/capture.ts).

const standInKey = (boardId: string) => `draftroom.thumbnail.stand-in.${boardId}`

export function markStandIn(boardId: string, on: boolean) {
  try {
    if (on) localStorage.setItem(standInKey(boardId), '1')
    else localStorage.removeItem(standInKey(boardId))
  } catch {
    // blocked storage: the next edit redraws it anyway
  }
}

export function hasStandIn(boardId: string): boolean {
  try {
    return localStorage.getItem(standInKey(boardId)) === '1'
  } catch {
    return false
  }
}
