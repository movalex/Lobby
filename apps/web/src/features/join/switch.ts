// OWNER: WS3 (wave V). Whether this page offers join codes: the web switch (LIVE_FLAGS.joinCodes) and the api's
// (GET /api/auth/config `live.joinCodes`). A hook that redraws when the api's answer arrives. Kept apart from the card
// so the sign-in page's "Have a code?" does not load the QR library.
import { useValue } from '../../lib/signals.ts'
import { liveEnabled, liveSwitches } from '../live/index.ts'

export function useJoinCodesOn(): boolean {
  const server = useValue(liveSwitches)
  return liveEnabled('joinCodes', undefined, server)
}
