// Which values of the api's enums a web build understands (migration 0024). Re-exported by ./comments.ts.
//
// The api deploys (and migrates) before the web, and a tab opened before a web deploy keeps running the
// older build until it reloads. Those builds parse responses with their own copy of the contracts, where a
// value they do not know (a new VoteScope, a new NotificationKind) fails the WHOLE response: the workshop
// state or the bell would stop updating. So the web sends its revision on every api request, and the api
// leaves out of its answers what an older revision cannot read. A request without the header is
// revision 0 (every build from before 0024, scripts and other API clients).
//
// - rev 1 (0024): VoteScope 'selection' with `VoteSession.selection` (RETRO-10), and NotificationKind
//   'access_granted' with `NotificationItem.accessGranted` (PRI-09b). For revision 0 the api answers a
//   selection vote as a board vote (it still applies the selection to every cast, so a stale tab's click
//   outside it is refused with NOT_ELIGIBLE) and lists no access_granted item (nor counts it as unread).
// - rev 2 (0026, wave J outside markers): NotificationKind 'outsider_joined' with
//   `NotificationItem.outsiderJoined`. Revisions 0 and 1 get no outsider_joined item (nor its count).
//
// Raise LOBBY_CLIENT_REV when an enum of a response gains a value; the api keeps answering older
// revisions what they can read.

/** The request header (lower case, as Node exposes it) that carries the web build's revision. */
export const LOBBY_CLIENT_HEADER = 'x-lobby-client'
/** This build's revision (see the list above). */
export const LOBBY_CLIENT_REV = 2

/** The revision a request declares: 0 without the header, or for a value that is not a small integer. */
export function clientRevOf(value: string | readonly string[] | undefined): number {
  const raw = typeof value === 'string' ? value : value?.[0]
  if (typeof raw !== 'string' || !/^[0-9]{1,4}$/.test(raw.trim())) return 0
  return Number(raw.trim())
}

/** A revision that knows the 0024 values (vote scope 'selection', notification kind 'access_granted'). */
export const knowsRev1 = (rev: number) => rev >= 1

/** A revision that knows the 0026 value (notification kind 'outsider_joined'). */
export const knowsRev2 = (rev: number) => rev >= 2
